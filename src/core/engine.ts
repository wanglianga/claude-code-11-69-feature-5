/**
 * 工作台引擎：编排快照仓 → 解析 → 提取 → 关系求值 → 裁决 → 发布 的完整流水线。
 *
 * 关键语义：
 *  - 导入批次开始时冻结当前快照水位；解析期间到达的新文件进入后续批次；
 *  - 相同内容指纹（SHA-256）只建一个快照，来源记录合并，绝不会变成两个项目；
 *  - 全量模式：固定快照上重算全部事实、候选边与项目链；
 *  - 增量模式：仅解析/提取新快照、仅重算受影响配对、仅标记脏连通分量，
 *    并对未受影响分量做发布结果一致性断言，防止更正遗留过时项目链；
 *  - 两种模式从同一快照+裁决水位必须得到相同的已确认事实。
 */
import type {
  Adjudication,
  CaseSelectionMode,
  ComputeMode,
  Fact,
  ImportBatch,
  PipelineProgress,
  PolicyCatalog,
  Publication,
  RelationEdge,
  Snapshot,
  FileSource,
  WithdrawnEdgeRecord,
} from './types';
import { inferSourceKind, parseDocument, PARSER_VERSION } from './parser';
import { EXTRACTOR_VERSION, extractFacts } from './extractor';
import { EVALUATOR_VERSION, evaluateRelations, evaluateRelationsIncremental } from './evaluator';
import { buildComponents, emptyModel, planIncremental, type ComponentModel } from './incremental';
import { publish } from './publisher';
import { DEFAULT_POLICY_CATALOG } from './policy';
import { splitAnalysisFingerprint } from './splitAnalysis';
import { deterministicId, normalizeText, sha256Hex, stableStringify } from './hash';
import type { Repository } from './repository';

/** 归档规模阈值：超过该快照数默认采用增量模式 */
export const INCREMENTAL_THRESHOLD = 30;

export interface ImportFileInput {
  fileName: string;
  text: string;
  originUrl?: string;
}

export interface EngineMeta {
  id: 'meta';
  componentModel: ComponentModel;
  lastMode: ComputeMode;
  lastPublicationId: string | null;
  totalImports: number;
  /** 拆分采购分析：当前政策目录（可切换标签）、候选呈现策略、生成寿命（时间） */
  policyCatalog: PolicyCatalog;
  splitSelectionMode: CaseSelectionMode;
}

export interface ConsistencyReport {
  equal: boolean;
  comparedAt: number;
  fullPublicationId: string;
  incrementalPublicationId: string;
  diffs: string[];
}

export interface ReplayReport {
  equal: boolean;
  rebuiltAt: number;
  originalPublicationId: string | null;
  rebuiltPublicationId: string | null;
  diffs: string[];
}

function defaultMeta(): EngineMeta {
  return {
    id: 'meta',
    componentModel: emptyModel(),
    lastMode: 'full',
    lastPublicationId: null,
    totalImports: 0,
    policyCatalog: DEFAULT_POLICY_CATALOG,
    splitSelectionMode: 'recall',
  };
}

export class WorkbenchEngine {
  constructor(
    private repo: Repository,
    private onProgress?: (p: PipelineProgress) => void,
    private clock: () => number = () => Date.now(),
  ) {}

  private progress(phase: PipelineProgress['phase'], current: number, total: number, message: string) {
    this.onProgress?.({ phase, current, total, message });
  }

  private async getMeta(): Promise<EngineMeta> {
    const stored = await this.repo.getMeta();
    if (!stored) return defaultMeta();
    // 防御旧版本 meta（缺少拆分采购设置）：补默认值但不覆盖已有设置
    return {
      ...defaultMeta(),
      ...stored,
      policyCatalog: stored.policyCatalog ?? DEFAULT_POLICY_CATALOG,
      splitSelectionMode: stored.splitSelectionMode ?? 'recall',
    };
  }

  // ---------------- 导入 ----------------

  /**
   * 导入一个批次。files 为调用方在批次启动时读取完毕的冻结载荷——
   * 解析期间用户替换/新增的源文件不会进入本批，需再次调用形成后续批次。
   */
  async importBatch(label: string, files: ImportFileInput[]): Promise<ImportBatch> {
    const now = this.clock();
    const batchId = deterministicId('batch', [label, now, files.length]);
    this.progress('parsing', 0, files.length, `批次 ${label}：冻结导入载荷并计算内容指纹`);

    // 启动时快照水位（冻结基线，用于审计说明）
    const batch: ImportBatch = {
      id: batchId,
      label,
      createdAt: now,
      inputCount: files.length,
      newSnapshotCount: 0,
      mergedCount: 0,
      deferredCount: 0,
      snapshotIds: [],
    };
    // 批内去重：相同内容不同文件名并发导入只产生一个快照
    const inBatchHashes = new Map<string, string>();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      this.progress('parsing', i + 1, files.length, `解析 ${file.fileName}`);
      const contentHash = await sha256Hex(file.text);
      const normalizedHash = await sha256Hex(normalizeText(file.text));
      const source: FileSource = {
        fileName: file.fileName,
        batchId,
        importedAt: now,
        size: file.text.length,
        ...(file.originUrl ? { originUrl: file.originUrl } : {}),
      };

      const existing = await this.repo.getSnapshotByContentHash(contentHash);
      if (existing) {
        // 同一内容只合并来源，绝不当作两个项目
        existing.sources.push(source);
        await this.repo.putSnapshot(existing);
        batch.mergedCount += 1;
        batch.snapshotIds.push(existing.id);
        continue;
      }
      if (inBatchHashes.has(contentHash)) {
        const sid = inBatchHashes.get(contentHash)!;
        const snap = await this.repo.getSnapshot(sid);
        snap!.sources.push(source);
        await this.repo.putSnapshot(snap!);
        batch.mergedCount += 1;
        batch.snapshotIds.push(sid);
        continue;
      }

      // 解析版本在导入时固化进快照
      const parsed = parseDocument(file.text, inferSourceKind(file.fileName));
      const snapshot: Snapshot = {
        id: deterministicId('snap', [contentHash.slice(0, 24)]),
        contentHash,
        normalizedHash,
        rawText: file.text,
        sources: [source],
        parsed,
        createdAt: now,
      };
      await this.repo.putSnapshot(snapshot);
      inBatchHashes.set(contentHash, snapshot.id);
      batch.snapshotIds.push(snapshot.id);
      batch.newSnapshotCount += 1;
    }

    await this.repo.putBatch(batch);
    const meta = await this.getMeta();
    meta.totalImports += 1;
    await this.repo.putMeta(meta);
    this.progress('idle', files.length, files.length, `批次 ${label} 导入完成`);
    return batch;
  }

  // ---------------- 裁决 ----------------

  async adjudicate(input: {
    edgeId: string;
    decision: Adjudication['decision'];
    note: string;
    reviewer: string;
    appliedFactIds: string[];
  }): Promise<Adjudication> {
    const now = this.clock();
    const edges = await this.repo.getAllEdges();
    const edge = edges.find((e) => e.id === input.edgeId);
    if (!edge) throw new Error(`关系边不存在：${input.edgeId}`);

    const previous = await this.repo.getAdjudicationByEdge(input.edgeId);
    const adjudication: Adjudication = {
      id: deterministicId('adj', [input.edgeId, now, input.decision]),
      edgeId: input.edgeId,
      decision: input.decision,
      note: input.note,
      reviewer: input.reviewer || 'default-reviewer',
      appliedFactIds: [...new Set(input.appliedFactIds)],
      createdAt: now,
      ...(previous ? { supersedesAdjudicationId: previous.id } : {}),
    };

    // 撤回旧关系结论并留痕
    if (previous) {
      const withdrawn: WithdrawnEdgeRecord = {
        edgeId: input.edgeId,
        reason: `新裁决 ${adjudication.id} 取代 ${previous.id}：${input.note}`,
        adjudicationId: adjudication.id,
        withdrawnAt: now,
      };
      await this.repo.putWithdrawn(withdrawn);
    }

    edge.status = input.decision === 'confirm' ? 'confirmed' : 'rejected';
    await this.repo.putEdge(edge);
    await this.repo.putAdjudication(adjudication);
    return adjudication;
  }

  // ---------------- 拆分采购分析设置 ----------------

  /** 切换政策目录（模拟“门槛切换”）；下一次重算生效，不回溯改写历史发布。 */
  async setPolicyCatalog(catalog: PolicyCatalog): Promise<void> {
    const meta = await this.getMeta();
    meta.policyCatalog = catalog;
    await this.repo.putMeta(meta);
  }

  /** 选择候选呈现策略：recall 保留全部相连候选；capacity 优先互不重叠代表组合。 */
  async setSplitSelectionMode(mode: CaseSelectionMode): Promise<void> {
    const meta = await this.getMeta();
    meta.splitSelectionMode = mode;
    await this.repo.putMeta(meta);
  }

  async settings(): Promise<{ policyCatalog: PolicyCatalog; splitSelectionMode: CaseSelectionMode }> {
    const meta = await this.getMeta();
    return { policyCatalog: meta.policyCatalog, splitSelectionMode: meta.splitSelectionMode };
  }

  // ---------------- 重算与发布 ----------------

  private resolveMode(requested: ComputeMode | 'auto', snapshotCount: number): ComputeMode {
    if (requested === 'auto') return snapshotCount > INCREMENTAL_THRESHOLD ? 'incremental' : 'full';
    return requested;
  }

  /** 把持久化裁决重新施加到 freshly computed 的边上（id 是确定性的） */
  private reapplyAdjudications(edges: RelationEdge[], adjudications: Adjudication[]): RelationEdge[] {
    const byEdge = new Map(adjudications.map((a) => [a.edgeId, a]));
    return edges.map((e) => {
      const adj = byEdge.get(e.id);
      if (!adj) return e;
      return { ...e, status: adj.decision === 'confirm' ? 'confirmed' : 'rejected' };
    });
  }

  async recomputeAndPublish(requestedMode: ComputeMode | 'auto'): Promise<Publication> {
    const now = this.clock();
    const meta = await this.getMeta();
    const snapshots = await this.repo.getAllSnapshots();
    const adjudications = await this.repo.getAllAdjudications();
    const mode = this.resolveMode(requestedMode, snapshots.length);
    // ---------- 1. 事实提取：全量模式重提全部；增量模式只提新快照 ----------
    this.progress('extracting', 0, snapshots.length, '事实提取');
    let facts: Fact[] = [];
    if (mode === 'full') {
      for (let i = 0; i < snapshots.length; i++) {
        facts.push(...extractFacts(snapshots[i]));
        this.progress('extracting', i + 1, snapshots.length, `提取 ${snapshots[i].sources[0]?.fileName ?? snapshots[i].id}`);
      }
      await this.repo.replaceAllFacts(facts);
    } else {
      const existingFacts = await this.repo.getAllFacts();
      const known = new Set(existingFacts.map((f) => f.snapshotId));
      const fresh: Fact[] = [];
      const targets = snapshots.filter((s) => !known.has(s.id));
      for (let i = 0; i < targets.length; i++) {
        fresh.push(...extractFacts(targets[i]));
        this.progress('extracting', i + 1, Math.max(targets.length, 1), `增量提取 ${targets[i].id}`);
      }
      if (fresh.length) await this.repo.putFacts(fresh);
      facts = [...existingFacts, ...fresh];
    }

    // ---------- 2. 关系求值 ----------
    this.progress('evaluating', 0, 1, mode === 'full' ? '全量求值候选边' : '增量求值受影响配对');
    let rawEdges: RelationEdge[];
    if (mode === 'full') {
      rawEdges = evaluateRelations(snapshots, facts, now);
    } else {
      const previousEdges = await this.repo.getAllEdges();
      // 受影响快照：无既有边的新快照 + 裁决发生变化的边端点
      const adjudicatedEdges = new Set(adjudications.map((a) => a.edgeId));
      const affected = new Set<string>();
      for (const s of snapshots) {
        const hasEdge = previousEdges.some((e) => e.fromSnapshotId === s.id || e.toSnapshotId === s.id);
        if (!hasEdge) affected.add(s.id);
      }
      for (const e of previousEdges) {
        if (adjudicatedEdges.has(e.id)) {
          affected.add(e.fromSnapshotId);
          affected.add(e.toSnapshotId);
        }
      }
      // 首次增量运行（无历史边）退化为对全量快照求值
      rawEdges =
        previousEdges.length === 0
          ? evaluateRelations(snapshots, facts, now)
          : evaluateRelationsIncremental(snapshots, facts, previousEdges, affected, now);
    }
    const edges = this.reapplyAdjudications(rawEdges, adjudications);
    await this.repo.replaceAllEdges(edges);

    // ---------- 3. 连通分量与增量计划 ----------
    const previousModel = meta.componentModel;
    const nextModel = buildComponents(snapshots, edges, adjudications);
    const changedAdjEdgeIds = adjudications.map((a) => a.edgeId);
    const changedSnapshotIds = snapshots.filter((s) => !previousModel.snapshotIndex[s.id]).map((s) => s.id);
    const plan = planIncremental(previousModel, nextModel, changedSnapshotIds, changedAdjEdgeIds);
    const effectiveRecomputed =
      mode === 'full' ? Object.keys(nextModel.members).sort() : plan.dirtyComponents;
    const effectiveSkipped = mode === 'full' ? 0 : plan.skippedComponents;

    // ---------- 4. 发布 ----------
    this.progress('publishing', 0, 1, '按裁决水位生成项目链与统计快照');
    const previousPublication = await this.repo.getLatestPublication();
    const publication = await publish({
      snapshots,
      facts,
      edges,
      adjudications,
      mode,
      recomputedComponents: effectiveRecomputed,
      skippedComponents: effectiveSkipped,
      now,
      previousPublication,
      policyCatalog: meta.policyCatalog,
      splitSelectionMode: meta.splitSelectionMode,
    });

    // 增量模式不变量校验：干净分量的发布结果必须与上一版逐字段一致
    if (mode === 'incremental' && previousPublication) {
      const dirtySnapshots = new Set(
        plan.dirtyComponents.flatMap((cid) => nextModel.members[cid] ?? []),
      );
      const cleanProjectsPrevious = this.projectsForComponents(previousPublication, dirtySnapshots);
      const cleanProjectsNow = this.projectsForComponents(publication, dirtySnapshots);
      const a = stableStringify(cleanProjectsPrevious);
      const b = stableStringify(cleanProjectsNow);
      if (a !== b) {
        throw new Error('增量依赖追踪失败：未受影响连通分量的发布结果发生变化，拒绝发布过时项目链');
      }
    }

    await this.repo.putPublication(publication);
    meta.componentModel = nextModel;
    meta.lastMode = mode;
    meta.lastPublicationId = publication.id;
    await this.repo.putMeta(meta);
    this.progress('idle', 1, 1, `发布版本 v${publication.version}（${mode}）完成`);
    return publication;
  }

  /** 依据发布项目链中的快照集合反查所属分量（用于增量不变量校验） */
  private projectsForComponents(publication: Publication, dirtySnapshots: Set<string>): unknown {
    // 干净分量 = 项目链快照均不属于任何脏分量成员
    return publication.projects
      .filter((p) => p.stageChain.every((node) => !dirtySnapshots.has(node.snapshotId)))
      .map((p) => ({ code: p.projectCode, chain: p.stageChain, budget: p.currentBudgetCny, lots: p.lots.map((l) => l.lotCode) }));
  }

  // ---------------- 一致性校验（双模式同水位） ----------------

  async checkConsistency(): Promise<ConsistencyReport> {
    const now = this.clock();
    const snapshots = await this.repo.getAllSnapshots();
    const facts = await this.repo.getAllFacts();
    const adjudications = await this.repo.getAllAdjudications();
    const storedEdges = await this.repo.getAllEdges();
    const meta = await this.getMeta();
    const fullEdges = this.reapplyAdjudications(evaluateRelations(snapshots, facts, now), adjudications);
    const diffs: string[] = [];

    if (stableStringify(fullEdges.map((e) => ({ id: e.id, s: e.status })).sort()) !==
        stableStringify(storedEdges.map((e) => ({ id: e.id, s: e.status })).sort())) {
      diffs.push('候选边集合/状态与全量重算结果不一致');
    }

    const fullPub = await publish({
      snapshots, facts, edges: fullEdges, adjudications,
      mode: 'full', recomputedComponents: [], skippedComponents: 0, now,
      policyCatalog: meta.policyCatalog, splitSelectionMode: meta.splitSelectionMode,
    });
    const incPub = await publish({
      snapshots, facts, edges: fullEdges, adjudications,
      mode: 'incremental', recomputedComponents: [], skippedComponents: 0, now,
      policyCatalog: meta.policyCatalog, splitSelectionMode: meta.splitSelectionMode,
    });
    const projectKey = (p: Publication['projects'][number]) =>
      stableStringify({ c: p.projectCode, chain: p.stageChain, lots: p.lots, budget: p.currentBudgetCny, history: p.BudgetHistory, prov: p.fieldProvenance });
    const fa = fullPub.projects.map(projectKey).sort();
    const ia = incPub.projects.map(projectKey).sort();
    if (stableStringify(fa) !== stableStringify(ia)) diffs.push('全量与增量发布的项目链/标段/预算不一致');
    if (stableStringify(fullPub.stats) !== stableStringify(incPub.stats)) diffs.push('统计快照不一致');
    if (fullPub.splitAnalysis && incPub.splitAnalysis &&
        splitAnalysisFingerprint(fullPub.splitAnalysis) !== splitAnalysisFingerprint(incPub.splitAnalysis)) {
      diffs.push('全量与增量发布的拆分采购候选组合不一致');
    }

    return {
      equal: diffs.length === 0,
      comparedAt: now,
      fullPublicationId: fullPub.id,
      incrementalPublicationId: incPub.id,
      diffs,
    };
  }

  // ---------------- 离线复跑 ----------------

  /**
   * 从快照仓 + 裁决记录重建全部派生数据（事实、边、发布），
   * 与最近一次发布在同一水位上比对，验证可复算性。
   */
  async replay(): Promise<ReplayReport> {
    const now = this.clock();
    const snapshots = await this.repo.getAllSnapshots();
    const adjudications = await this.repo.getAllAdjudications();
    const meta = await this.getMeta();
    const original = await this.repo.getLatestPublication();

    // 派生数据全部推倒重来
    await this.repo.replaceAllFacts([]);
    await this.repo.replaceAllEdges([]);
    const facts = snapshots.flatMap((s) => extractFacts(s));
    await this.repo.replaceAllFacts(facts);
    const edges = this.reapplyAdjudications(evaluateRelations(snapshots, facts, now), adjudications);
    await this.repo.replaceAllEdges(edges);
    const rebuilt = await publish({
      snapshots, facts, edges, adjudications,
      mode: 'full',
      recomputedComponents: Object.keys(buildComponents(snapshots, edges, adjudications).members).sort(),
      skippedComponents: 0,
      now,
      policyCatalog: meta.policyCatalog,
      splitSelectionMode: meta.splitSelectionMode,
      // 传入历史发布：使拆分采购案件的版本/失效记录与历史一致，便于回放比对
      previousPublication: original,
    });

    const diffs: string[] = [];
    if (original) {
      const key = (p: Publication['projects'][number]) =>
        stableStringify({ c: p.projectCode, chain: p.stageChain, lots: p.lots, budget: p.currentBudgetCny, history: p.BudgetHistory });
      const a = original.projects.map(key).sort();
      const b = rebuilt.projects.map(key).sort();
      if (stableStringify(a) !== stableStringify(b)) diffs.push('复跑项目链与历史发布不一致');
      if (stableStringify(original.stats) !== stableStringify(rebuilt.stats)) diffs.push('复跑统计快照与历史发布不一致');
      if (stableStringify(original.snapshotWatermark) !== stableStringify(rebuilt.snapshotWatermark)) diffs.push('快照水位不一致');
      if (stableStringify(original.adjudicationWatermark) !== stableStringify(rebuilt.adjudicationWatermark)) diffs.push('裁决水位不一致');
      // 历史案件回放：同一水位下拆分采购案件版本与候选必须可复现
      if (original.splitAnalysis && rebuilt.splitAnalysis &&
          splitAnalysisFingerprint(original.splitAnalysis) !== splitAnalysisFingerprint(rebuilt.splitAnalysis)) {
        diffs.push('复跑拆分采购候选组合与历史发布不一致');
      }
    }
    return {
      equal: diffs.length === 0,
      rebuiltAt: now,
      originalPublicationId: original?.id ?? null,
      rebuiltPublicationId: rebuilt.id,
      diffs,
    };
  }

  // ---------------- 版本常量（UI 展示） ----------------
  versions() {
    return { PARSER_VERSION, EXTRACTOR_VERSION, EVALUATOR_VERSION };
  }
}
