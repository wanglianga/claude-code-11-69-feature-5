/**
 * 项目发布器：只从指定裁决水位生成项目链、标段事实与统计快照。
 *
 * 硬规则：
 *  - 仅 status=confirmed 或被裁决 confirm 的边参与项目分组；
 *  - conflict（标段互斥）边在任何情况下都不合并项目，
 *    裁决 split 显式留痕；reject 表示无关系；
 *  - duplicate 边把同件副本折叠为同一节点，来源记录仍可回溯；
 *  - 任一发布字段都带 factId + snapshotId，配合事实的 ruleId 可完整溯源。
 */
import type {
  Adjudication,
  CaseSelectionMode,
  ComputeMode,
  Fact,
  PolicyCatalog,
  Publication,
  PublishedLot,
  PublishedProject,
  PublicationStats,
  RelationEdge,
  Snapshot,
} from './types';
import { EXTRACTOR_VERSION, primaryStage } from './extractor';
import { PARSER_VERSION } from './parser';
import { EVALUATOR_VERSION } from './evaluator';
import { deterministicId, stableStringify, sha256Hex } from './hash';
import { DEFAULT_POLICY_CATALOG } from './policy';
import { analyzeSplitProcurement } from './splitAnalysis';

class UF {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function pickMostFrequent(values: string[]): string | null {
  if (values.length === 0) return null;
  const count = new Map<string, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export interface PublishInput {
  snapshots: Snapshot[];
  facts: Fact[];
  edges: RelationEdge[];
  adjudications: Adjudication[];
  mode: ComputeMode;
  recomputedComponents: string[];
  skippedComponents: number;
  now: number;
  previousPublication?: Publication | null;
  /** 政策目录（缺失时使用示例目录；不改变既有项目链结论） */
  policyCatalog?: PolicyCatalog;
  /** 候选呈现策略：recall 保留全部相连候选，capacity 优先互不重叠代表组合 */
  splitSelectionMode?: CaseSelectionMode;
}

export async function publish(input: PublishInput): Promise<Publication> {
  const { snapshots, facts, edges, adjudications, now } = input;
  const decisionByEdge = new Map(adjudications.map((a) => [a.edgeId, a]));

  const isConfirmed = (e: RelationEdge) =>
    e.status === 'confirmed' || decisionByEdge.get(e.id)?.decision === 'confirm';
  const isRejected = (e: RelationEdge) =>
    e.status === 'rejected' || decisionByEdge.get(e.id)?.decision === 'reject';

  // ---- 1. 项目分组：非冲突的确认边才合并 ----
  const uf = new UF();
  for (const s of snapshots) uf.find(s.id);

  for (const e of edges) {
    if (isRejected(e)) continue;
    // 互斥冲突：即使被确认也只留痕，不合并
    if (e.type === 'conflict') continue;
    if (!isConfirmed(e)) continue;
    uf.union(e.fromSnapshotId, e.toSnapshotId);
  }

  const groups = new Map<string, string[]>();
  for (const s of snapshots) {
    const root = uf.find(s.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(s.id);
  }

  // 分组定型后按最终 root 汇总合法性依据与冲突留痕
  const supportingByRoot = new Map<string, { edges: Set<string>; adjudications: Set<string>; conflicts: Set<string> }>();
  const ensureMeta = (root: string) => {
    if (!supportingByRoot.has(root)) {
      supportingByRoot.set(root, { edges: new Set(), adjudications: new Set(), conflicts: new Set() });
    }
    return supportingByRoot.get(root)!;
  };
  for (const e of edges) {
    const decision = decisionByEdge.get(e.id)?.decision;
    if (e.type === 'conflict') {
      // 冲突边永不合并项目；确认与拆分都保留留痕。
      // split（人工判定为相互独立标段）也进入留痕，并作为“独立计划”依据。
      if (decision !== 'split' && (isRejected(e) || !isConfirmed(e))) continue;
      ensureMeta(uf.find(e.fromSnapshotId)).conflicts.add(e.id);
      ensureMeta(uf.find(e.toSnapshotId)).conflicts.add(e.id);
      continue;
    }
    if (isRejected(e) || !isConfirmed(e)) continue;
    const meta = ensureMeta(uf.find(e.fromSnapshotId));
    meta.edges.add(e.id);
    const adj = decisionByEdge.get(e.id);
    if (adj) meta.adjudications.add(adj.id);
  }

  const factsBySnapshot = new Map<string, Fact[]>();
  for (const f of facts) {
    if (!factsBySnapshot.has(f.snapshotId)) factsBySnapshot.set(f.snapshotId, []);
    factsBySnapshot.get(f.snapshotId)!.push(f);
  }

  // ---- 2. 每个分组构造发布项目 ----
  const projects: PublishedProject[] = [];
  for (const [root, memberIds] of groups) {
    const members = memberIds.sort();
    const groupFacts = members.flatMap((id) => factsBySnapshot.get(id) ?? []);

    // ---- 2a. 折叠同件副本：duplicate 确认边连通的快照只保留代表节点 ----
    const dupUf = new UF();
    members.forEach((id) => dupUf.find(id));
    for (const e of edges) {
      if (e.type === 'duplicate' && isConfirmed(e) && members.includes(e.fromSnapshotId) && members.includes(e.toSnapshotId)) {
        dupUf.union(e.fromSnapshotId, e.toSnapshotId);
      }
    }
    const canonical = new Map<string, string>();
    for (const id of members) {
      const r = dupUf.find(id);
      if (!canonical.has(r)) canonical.set(r, id);
    }
    const canonicalIds = [...new Set(members.map((id) => canonical.get(dupUf.find(id))!))].sort();

    // ---- 2b. 编号与采购人（保留原始写法，附规范化键） ----
    const codeFacts = groupFacts.filter((f) => f.type === 'project_code');
    const purchaserFacts = groupFacts.filter((f) => f.type === 'purchaser');
    const projectCode = pickMostFrequent(codeFacts.map((f) => f.value)) ?? canonicalIds[0] ?? root;
    const purchaser = pickMostFrequent(purchaserFacts.map((f) => f.value)) ?? '';

    // 没有任何编号事实的孤立噪声快照不发布为项目
    if (codeFacts.length === 0 && members.length === 1 && (factsBySnapshot.get(members[0]) ?? []).every((f) => f.type !== 'project_code')) {
      // 仍保留发布，但标记为“未识别编号”——这里选择跳过，避免噪声进入事实集
      continue;
    }

    // ---- 2c. 项目链：代表节点按日期排序 ----
    const stageChain = canonicalIds.map((sid) => {
      const sf = factsBySnapshot.get(sid) ?? [];
      const stage = primaryStage(sf.filter((f) => f.type === 'stage' && f.stage).map((f) => f.stage!));
      const dateFact = sf.filter((f) => f.type === 'date' && f.isoDate).sort((a, b) => a.isoDate!.localeCompare(b.isoDate!))[0];
      return {
        stage: stage ?? 'announcement',
        snapshotId: sid,
        isoDate: dateFact?.isoDate ?? null,
      };
    }).sort((a, b) =>
      (a.isoDate ?? '9999').localeCompare(b.isoDate ?? '9999') || a.snapshotId.localeCompare(b.snapshotId),
    );

    // ---- 2d. 标段事实 ----
    // 先收集全部标段（canonicalIds 已排序，事实按证据位置排序，保证与存储顺序无关）
    const lotMap = new Map<string, PublishedLot>();
    for (const sid of canonicalIds) {
      const sf = (factsBySnapshot.get(sid) ?? []).slice().sort((a, b) => a.evidence.start - b.evidence.start);
      const lotFacts = sf.filter((f) => f.type === 'lot' && f.lotCode);
      const amountFacts = sf.filter((f) => f.type === 'amount');
      for (const lot of lotFacts) {
        const code = lot.lotCode!;
        if (!lotMap.has(code)) {
          // 单标段快照可把金额归到该标段；多标段快照不做臆测
          const budgetFact = lotFacts.length === 1 ? amountFacts.sort((a, b) => b.amountCny! - a.amountCny!)[0] : undefined;
          lotMap.set(code, {
            lotCode: code,
            lotName: lot.value,
            budgetCny: budgetFact ? budgetFact.amountCny! : null,
            winner: null,
            fieldProvenance: {
              lotCode: { factId: lot.id, snapshotId: sid },
              lotName: { factId: lot.id, snapshotId: sid },
              ...(budgetFact ? { budgetCny: { factId: budgetFact.id, snapshotId: sid } } : {}),
            },
          });
        }
      }
    }
    // 第二遍：按证据位置顺序行走，把中标人关联到其前方最近的标段标题
    for (const sid of canonicalIds) {
      const sf = (factsBySnapshot.get(sid) ?? []).slice().sort((a, b) => a.evidence.start - b.evidence.start);
      let currentLotCode: string | null = null;
      for (const fact of sf) {
        if (fact.type === 'lot' && fact.lotCode) {
          currentLotCode = fact.lotCode;
          continue;
        }
        if (fact.type === 'result' && fact.winner && currentLotCode) {
          const lot = lotMap.get(currentLotCode);
          if (lot && !lot.winner) {
            lot.winner = fact.winner;
            lot.fieldProvenance.winner = { factId: fact.id, snapshotId: sid };
          }
        }
      }
    }

    // ---- 2e. 预算变动轨迹（含被更正覆盖的历史值） ----
    // 排序完全确定：日期 → 快照 id → 金额，消除同日多金额的存储顺序依赖
    const budgetHistory = groupFacts
      .filter((f) => f.type === 'amount' && typeof f.amountCny === 'number')
      .map((f) => {
        const dateFact = (factsBySnapshot.get(f.snapshotId) ?? []).filter((d) => d.type === 'date' && d.isoDate).sort((a, b) => a.isoDate!.localeCompare(b.isoDate!))[0];
        return { amountCny: f.amountCny!, snapshotId: f.snapshotId, isoDate: dateFact?.isoDate ?? null, ruleId: f.ruleId };
      })
      .sort((a, b) =>
        (a.isoDate ?? '9999').localeCompare(b.isoDate ?? '9999') ||
        a.snapshotId.localeCompare(b.snapshotId) ||
        a.amountCny - b.amountCny,
      );

    const latestDated = [...stageChain].reverse().find((node) =>
      (factsBySnapshot.get(node.snapshotId) ?? []).some((f) => f.type === 'amount'),
    );
    const currentBudget = latestDated
      ? Math.max(...(factsBySnapshot.get(latestDated.snapshotId) ?? []).filter((f) => f.type === 'amount').map((f) => f.amountCny!))
      : null;

    const meta = ensureMeta(root);

    // 链内被裁决（确认/拆分）的互斥冲突边：视为“独立标段”，不参与拆分采购组合
    const independentUnits: NonNullable<PublishedProject['independentUnits']> = [];
    for (const eid of [...meta.conflicts].sort()) {
      const edge = edges.find((e) => e.id === eid);
      const adj = decisionByEdge.get(eid);
      if (!edge || !adj) continue;
      if (adj.decision !== 'confirm' && adj.decision !== 'split') continue;
      const pickLots = (sid: string) =>
        [...new Set((factsBySnapshot.get(sid) ?? []).filter((f) => f.type === 'lot' && f.lotCode).map((f) => f.lotCode!))].sort();
      independentUnits.push({
        edgeId: eid,
        adjudicationId: adj.id,
        lotSets: [pickLots(edge.fromSnapshotId), pickLots(edge.toSnapshotId)],
      });
    }

    const provenance: PublishedProject['fieldProvenance'] = {};
    const codeFactSorted = [...codeFacts].sort((a, b) => a.value.localeCompare(b.value) || a.id.localeCompare(b.id));
    const purchaserFactSorted = [...purchaserFacts].sort((a, b) => a.value.localeCompare(b.value) || a.id.localeCompare(b.id));
    if (codeFactSorted[0]) provenance.projectCode = { factId: codeFactSorted[0].id, snapshotId: codeFactSorted[0].snapshotId };
    if (purchaserFactSorted[0]) provenance.purchaser = { factId: purchaserFactSorted[0].id, snapshotId: purchaserFactSorted[0].snapshotId };
    const budgetFactForCurrent = [...groupFacts]
      .filter((f) => f.type === 'amount')
      .sort((a, b) => (b.isoDate ?? '').localeCompare(a.isoDate ?? '') || b.id.localeCompare(a.id))[0];
    if (budgetFactForCurrent) provenance.currentBudgetCny = { factId: budgetFactForCurrent.id, snapshotId: budgetFactForCurrent.snapshotId };

    projects.push({
      projectCode,
      purchaser,
      stageChain,
      lots: [...lotMap.values()].sort((a, b) => a.lotCode.localeCompare(b.lotCode)),
      currentBudgetCny: currentBudget,
      BudgetHistory: budgetHistory,
      supportingEdgeIds: [...meta.edges].sort(),
      supportingAdjudicationIds: [...meta.adjudications].sort(),
      conflictEdgeIds: [...meta.conflicts].sort(),
      fieldProvenance: provenance,
      ...(independentUnits.length ? { independentUnits } : {}),
    });
  }

  // ---- 3. 统计快照 ----
  const stats: PublicationStats = {
    projectCount: projects.length,
    lotCount: projects.reduce((n, p) => n + p.lots.length, 0),
    totalBudgetCny: projects.reduce((n, p) => n + (p.currentBudgetCny ?? 0), 0),
    resultCount: projects.filter((p) => p.stageChain.some((s) => s.stage === 'result')).length,
    byPurchaser: {},
  };
  for (const p of projects) {
    const key = p.purchaser || '未识别采购人';
    if (!stats.byPurchaser[key]) stats.byPurchaser[key] = { projects: 0, budgetCny: 0 };
    stats.byPurchaser[key].projects += 1;
    stats.byPurchaser[key].budgetCny += p.currentBudgetCny ?? 0;
  }

  // ---- 4. 水位与计算范围 ----
  const snapshotWatermark = snapshots.map((s) => s.id).sort();
  const adjudicationWatermark = adjudications.map((a) => a.id).sort();
  const dependencyHash = await sha256Hex(
    stableStringify({
      snapshots: snapshotWatermark,
      adjudications: adjudicationWatermark,
      edges: edges.map((e) => ({ id: e.id, status: e.status })),
    }),
  );

  const version = input.previousPublication ? input.previousPublication.version + 1 : 1;
  const sortedProjects = projects.sort((a, b) => a.projectCode.localeCompare(b.projectCode));

  // ---- 5. 疑似拆分采购组合分析（同一发布水位） ----
  const splitAnalysis = analyzeSplitProcurement({
    projects: sortedProjects,
    facts,
    snapshots,
    catalog: input.policyCatalog ?? DEFAULT_POLICY_CATALOG,
    mode: input.splitSelectionMode ?? 'recall',
    now,
    previous: input.previousPublication?.splitAnalysis ?? null,
  });

  const publication: Publication = {
    id: deterministicId('pub', [dependencyHash.slice(0, 16), version]),
    version,
    createdAt: now,
    adjudicationWatermark,
    snapshotWatermark,
    computeMode: input.mode,
    computeScope: {
      recomputedComponents: [...input.recomputedComponents].sort(),
      skippedComponents: input.skippedComponents,
      dependencyHash,
    },
    evaluatorVersion: EVALUATOR_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    parserVersion: PARSER_VERSION,
    projects: sortedProjects,
    stats,
    splitAnalysis,
  };
  return publication;
}
