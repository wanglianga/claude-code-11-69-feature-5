/**
 * 端到端验收测试（Node 环境 + 内存仓储）：
 * 覆盖导入去重、证据定位、互斥标段待裁决、裁决撤回、
 * 版本化项目链、统计快照、双模式一致性、增量依赖追踪与离线复跑。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkbenchEngine, type ImportFileInput } from './engine';
import { MemoryRepository } from './memoryRepository';
import { parseDocument, PARSER_VERSION } from './parser';
import { EXTRACTION_RULES } from './extractor';
import type { RelationEdge, Snapshot, Publication } from './types';

const SAMPLE_DIR = join(process.cwd(), 'sample-archive');

function loadSamples(prefix?: string): ImportFileInput[] {
  return readdirSync(SAMPLE_DIR)
    .filter((f) => f.endsWith('.txt') && (prefix ? f.startsWith(prefix) : true))
    .map((fileName) => ({
      fileName,
      text: readFileSync(join(SAMPLE_DIR, fileName), 'utf-8'),
    }));
}

let clockValue = 1_700_000_000_000;
const clock = () => clockValue;

async function newEngine() {
  const repo = new MemoryRepository();
  const engine = new WorkbenchEngine(repo, undefined, clock);
  return { repo, engine };
}

async function importAll(engine: WorkbenchEngine) {
  clockValue += 1000;
  return engine.importBatch('批次1-全量示例', loadSamples());
}

function edgesByType(edges: RelationEdge[], type: RelationEdge['type']) {
  return edges.filter((e) => e.type === type);
}

async function confirmAllPending(engine: WorkbenchEngine, repo: MemoryRepository, opts: { skipConflict?: boolean } = {}) {
  const edges = await repo.getAllEdges();
  for (const e of edges) {
    if (e.status !== 'pending') continue;
    if (opts.skipConflict && e.type === 'conflict') continue;
    clockValue += 1;
    await engine.adjudicate({
      edgeId: e.id,
      decision: 'confirm',
      note: '测试审核：确认关系',
      reviewer: 'tester',
      appliedFactIds: e.evidenceFactIds,
    });
  }
}

describe('结构解析器', () => {
  it('区分公告正文、附件摘要与站点噪声', () => {
    const text = loadSamples().find((f) => f.fileName.startsWith('06'))!.text;
    const doc = parseDocument(text, 'webpage');
    expect(doc.parserVersion).toBe(PARSER_VERSION);
    expect(doc.sections.some((s) => s.kind === 'announcement')).toBe(true);
    expect(doc.sections.some((s) => s.kind === 'attachment')).toBe(true);
    expect(doc.noiseSpans.length).toBeGreaterThan(0);
    expect(doc.bodyText).not.toContain('版权所有');
    expect(doc.bodyText).toContain('中标供应商');
  });
});

describe('快照仓导入', () => {
  it('字节级相同内容只产生一个快照并合并来源，不形成两个项目', async () => {
    const { repo, engine } = await newEngine();
    const batch = await importAll(engine);
    const snapshots = await repo.getAllSnapshots();
    // 12 份输入；02 与 03 仅规范化相同（排版差异），保留两个快照由关系求值器识别副本
    expect(batch.inputCount).toBe(12);
    expect(snapshots.length).toBe(12);
    const nearDupPair = snapshots.filter((s) =>
      s.sources[0].fileName.startsWith('02') || s.sources[0].fileName.startsWith('03'),
    );
    expect(nearDupPair.length).toBe(2);
    expect(nearDupPair[0].normalizedHash).toBe(nearDupPair[1].normalizedHash);
    expect(nearDupPair[0].contentHash).not.toBe(nearDupPair[1].contentHash);
  });

  it('字节级相同内容以不同文件名并发导入：快照仓合并来源记录，仅一个快照', async () => {
    const { repo, engine } = await newEngine();
    const text = loadSamples('04')[0].text;
    clockValue += 1000;
    const batch = await engine.importBatch('并发批', [
      { fileName: 'a.txt', text },
      { fileName: 'b.txt', text },
    ]);
    expect(batch.newSnapshotCount).toBe(1);
    expect(batch.mergedCount).toBe(1);
    const snaps = await repo.getAllSnapshots();
    expect(snaps.length).toBe(1);
    expect(snaps[0].sources.map((s) => s.fileName).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('解析期间替换源文件不影响启动时快照，新内容进入后续批次', async () => {
    const { repo, engine } = await newEngine();
    const original = loadSamples('01')[0];
    clockValue += 1000;
    await engine.importBatch('旧批', [original]);
    const before = await repo.getAllSnapshots();
    expect(before.length).toBe(1);
    // 同名文件内容被替换后再次导入：旧快照原样保留，产生新快照与新批次
    clockValue += 1000;
    const batch2 = await engine.importBatch('新批', [{ fileName: original.fileName, text: original.text + '\n新增一行更正说明\n' }]);
    const after = await repo.getAllSnapshots();
    expect(after.length).toBe(2);
    expect(batch2.newSnapshotCount).toBe(1);
    expect(after[0].rawText).toBe(original.text);
  });
});

describe('事实提取与证据定位', () => {
  it('每条事实的证据区间可在快照原文精确定位，金额万元统一换算为元', async () => {
    const { repo, engine } = await newEngine();
    await importAll(engine);
    await engine.recomputeAndPublish('full');
    const facts = await repo.getAllFacts();
    const snapshots = await repo.getAllSnapshots();
    const snapById = new Map(snapshots.map((s) => [s.id, s]));

    expect(facts.length).toBeGreaterThan(50);
    for (const fact of facts) {
      const snap = snapById.get(fact.snapshotId)!;
      expect(snap.rawText.slice(fact.evidence.start, fact.evidence.end)).toBe(fact.evidence.text);
      expect(EXTRACTION_RULES.some((r) => r.id === fact.ruleId)).toBe(true);
    }

    const correction = snapshots.find((s) => s.sources[0].fileName.startsWith('04'))!;
    const amounts = facts.filter((f) => f.snapshotId === correction.id && f.type === 'amount');
    expect(amounts.map((f) => f.amountCny)).toContain(1_355_000);
    expect(amounts.map((f) => f.amountCny)).toContain(1_200_000);
  });
});

describe('关系求值器', () => {
  it('同件副本自动确认；互斥标段只能产生待裁决 conflict 边', async () => {
    const { repo, engine } = await newEngine();
    await importAll(engine);
    await engine.recomputeAndPublish('full');
    const edges = await repo.getAllEdges();

    const dup = edgesByType(edges, 'duplicate');
    expect(dup.length).toBe(1);
    expect(dup[0].status).toBe('confirmed');

    const conflicts = edgesByType(edges, 'conflict');
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    for (const c of conflicts) {
      expect(c.status).toBe('pending');
      expect(c.reasons.join(' ')).toContain('互斥');
    }
  });

  it('识别预算变动的疑似更正边与撤销后的疑似重启边', async () => {
    const { repo, engine } = await newEngine();
    await importAll(engine);
    await engine.recomputeAndPublish('full');
    const edges = await repo.getAllEdges();

    const corrections = edgesByType(edges, 'suspected_correction');
    expect(corrections.some((e) => e.reasons.join(' ').includes('预算'))).toBe(true);

    const restarts = edgesByType(edges, 'suspected_restart');
    expect(restarts.length).toBeGreaterThanOrEqual(1);
    expect(restarts.every((e) => e.status === 'pending')).toBe(true);
  });

  it('候选边在固定快照上全量重建具有确定性（相同输入相同 id）', async () => {
    const files = loadSamples();
    const { evaluateRelations } = await import('./evaluator');
    const { extractAll } = await import('./extractor');
    const { parseDocument, inferSourceKind } = await import('./parser');
    const build = async () => {
      const snaps: Snapshot[] = [];
      for (const f of files) {
        const { sha256Hex, normalizeText, deterministicId } = await import('./hash');
        const ch = await sha256Hex(f.text);
        const nh = await sha256Hex(normalizeText(f.text));
        snaps.push({
          id: deterministicId('snap', [ch.slice(0, 24)]),
          contentHash: ch,
          normalizedHash: nh,
          rawText: f.text,
          sources: [{ fileName: f.fileName, batchId: 'b', importedAt: 1, size: f.text.length }],
          parsed: parseDocument(f.text, inferSourceKind(f.fileName)),
          createdAt: 1,
        });
      }
      return evaluateRelations(snaps, extractAll(snaps), 123).map((e) => e.id).sort();
    };
    const a = await build();
    const b = await build();
    expect(a).toEqual(b);
  });
});

describe('裁决与版本化项目链', () => {
  it('裁决前互斥/待确认关系不合并；确认后项目链接入，预算变动轨迹保留历史依据', async () => {
    const { repo, engine } = await newEngine();
    await importAll(engine);
    const pub0 = await engine.recomputeAndPublish('full');
    // 裁决前：待裁决边不连通，浙江项目链尚未合并为一条
    const zjBefore = pub0.projects.filter((p) => p.projectCode.includes('ZC2024-017'));
    expect(zjBefore.length).toBeGreaterThan(1);

    await confirmAllPending(engine, repo, { skipConflict: true });
    const pub1 = await engine.recomputeAndPublish('full');
    expect(pub1.version).toBe(2);

    const zj = pub1.projects.find((p) => p.projectCode === 'ZC2024-017')!;
    expect(zj).toBeTruthy();
    const stages = zj.stageChain.map((n) => n.stage);
    expect(stages).toContain('intention');
    expect(stages).toContain('announcement');
    expect(stages).toContain('correction');
    expect(stages).toContain('extension');
    expect(stages).toContain('result');
    // 预算历史保留被更正覆盖的 120 万与新值 135.5 万
    const historyAmounts = zj.BudgetHistory.map((h) => h.amountCny);
    expect(historyAmounts).toContain(1_200_000);
    expect(historyAmounts).toContain(1_355_000);
    // 同件副本在项目链中折叠为一个代表节点
    const chainSnapshots = new Set(zj.stageChain.map((n) => n.snapshotId));
    expect(chainSnapshots.size).toBe(zj.stageChain.length);
  });

  it('标段互斥 conflict 边即使被确认也绝不自动合并项目', async () => {
    const { repo, engine } = await newEngine();
    await importAll(engine);
    await engine.recomputeAndPublish('full');
    // 先确认所有非冲突关系（A 包公告→A 包结果的阶段链由此合并）
    await confirmAllPending(engine, repo, { skipConflict: true });
    const conflict = (await repo.getAllEdges()).find((e) => e.type === 'conflict')!;
    clockValue += 1;
    await engine.adjudicate({
      edgeId: conflict.id,
      decision: 'confirm',
      note: '人工确认两公告属同编号不同标段，但应拆分呈现',
      reviewer: 'tester',
      appliedFactIds: conflict.evidenceFactIds,
    });
    const pub = await engine.recomputeAndPublish('full');
    const scProjects = pub.projects.filter((p) => p.projectCode === 'SC2024-WZ-305');
    expect(scProjects.length).toBe(2);
    const lotSets = scProjects.map((p) => p.lots.map((l) => l.lotCode).join(','));
    expect(lotSets.some((s) => s.includes('第一标段'))).toBe(true);
    expect(lotSets.some((s) => s.includes('第二标段'))).toBe(true);
    // 冲突留痕可在发布结果中回溯
    expect(scProjects.some((p) => p.conflictEdgeIds.length > 0)).toBe(true);
  });

  it('重新裁决撤回旧结论并保留撤回记录', async () => {
    const { repo, engine } = await newEngine();
    await importAll(engine);
    await engine.recomputeAndPublish('full');
    const edge = (await repo.getAllEdges()).find((e) => e.status === 'pending')!;
    clockValue += 1;
    const first = await engine.adjudicate({
      edgeId: edge.id, decision: 'confirm', note: '初审确认', reviewer: 'tester', appliedFactIds: [],
    });
    clockValue += 1;
    const second = await engine.adjudicate({
      edgeId: edge.id, decision: 'reject', note: '复审驳回', reviewer: 'tester', appliedFactIds: [],
    });
    expect(second.supersedesAdjudicationId).toBe(first.id);
    const withdrawn = await repo.getAllWithdrawn();
    expect(withdrawn.some((w) => w.edgeId === edge.id && w.adjudicationId === second.id)).toBe(true);
    const refreshed = (await repo.getAllEdges()).find((e) => e.id === edge.id)!;
    expect(refreshed.status).toBe('rejected');
  });

  it('任一发布字段均可回溯到快照与提取规则', async () => {
    const { repo, engine } = await newEngine();
    await importAll(engine);
    await confirmAllPending(engine, repo, { skipConflict: true });
    const pub = await engine.recomputeAndPublish('full');
    const facts = await repo.getAllFacts();
    const snapshots = await repo.getAllSnapshots();
    const factById = new Map(facts.map((f) => [f.id, f]));
    const snapById = new Map(snapshots.map((s) => [s.id, s]));

    for (const project of pub.projects) {
      for (const [field, prov] of Object.entries(project.fieldProvenance)) {
        const fact = factById.get(prov.factId)!;
        const snap = snapById.get(prov.snapshotId)!;
        expect(fact).toBeTruthy();
        expect(snap).toBeTruthy();
        expect(fact.snapshotId).toBe(prov.snapshotId);
        expect(snap.rawText.slice(fact.evidence.start, fact.evidence.end)).toBe(fact.evidence.text);
        expect(EXTRACTION_RULES.some((r) => r.id === fact.ruleId)).toBe(true);
        expect(['projectCode', 'purchaser', 'currentBudgetCny']).toContain(field);
      }
      for (const lot of project.lots) {
        for (const prov of Object.values(lot.fieldProvenance)) {
          const fact = factById.get(prov.factId)!;
          expect(snapById.get(prov.snapshotId)!.rawText.slice(fact.evidence.start, fact.evidence.end)).toBe(fact.evidence.text);
        }
      }
    }
  });
});

describe('统计快照', () => {
  it('统计数字与发布项目集合一致', async () => {
    const { repo, engine } = await newEngine();
    await importAll(engine);
    await confirmAllPending(engine, repo, { skipConflict: true });
    const pub = await engine.recomputeAndPublish('full');
    expect(pub.stats.projectCount).toBe(pub.projects.length);
    expect(pub.stats.lotCount).toBe(pub.projects.reduce((n, p) => n + p.lots.length, 0));
    expect(pub.stats.totalBudgetCny).toBeCloseTo(
      pub.projects.reduce((n, p) => n + (p.currentBudgetCny ?? 0), 0),
      2,
    );
    expect(pub.stats.resultCount).toBe(
      pub.projects.filter((p) => p.stageChain.some((s) => s.stage === 'result')).length,
    );
  });
});

describe('全量/增量一致性与离线复跑', () => {
  it('同一快照与裁决水位下两种计算模式得到相同已确认事实', async () => {
    const { engine } = await newEngine();
    await importAll(engine);
    await engine.recomputeAndPublish('full');
    const report = await engine.checkConsistency();
    expect(report.equal).toBe(true);
    expect(report.diffs).toEqual([]);
  });

  it('增量模式只重算脏连通分量，干净分量的项目链逐字段不变', async () => {
    const { repo, engine } = await newEngine();
    // 第一批：安徽与四川两个项目组
    const firstBatch = loadSamples().filter((f) =>
      f.fileName.startsWith('07') || f.fileName.startsWith('08') ||
      f.fileName.startsWith('09') || f.fileName.startsWith('10') || f.fileName.startsWith('11'),
    );
    clockValue += 1000;
    await engine.importBatch('第一批', firstBatch);
    const pubFull = await engine.recomputeAndPublish('full');
    expect(pubFull.computeMode).toBe('full');
    const hfBefore = pubFull.projects.find((p) => p.projectCode.includes('HF2024'));
    expect(hfBefore).toBeTruthy();

    // 第二批：补入浙江更正材料所在项目组
    const secondBatch = loadSamples().filter((f) =>
      ['01', '02', '03', '04', '05', '06', '12'].some((p) => f.fileName.startsWith(p)),
    );
    clockValue += 1000;
    await engine.importBatch('第二批', secondBatch);
    const pubInc = await engine.recomputeAndPublish('incremental');
    expect(pubInc.computeMode).toBe('incremental');
    expect(pubInc.computeScope.skippedComponents).toBeGreaterThan(0);
    expect(pubInc.computeScope.recomputedComponents.length).toBeGreaterThan(0);

    // 安徽项目作为干净分量，项目链与预算逐字段保持
    const hfAfter = pubInc.projects.find((p) => p.projectCode.includes('HF2024'))!;
    expect(hfAfter.stageChain).toEqual(hfBefore!.stageChain);
    expect(hfAfter.currentBudgetCny).toBe(hfBefore!.currentBudgetCny);
    expect(pubInc.snapshotWatermark.length).toBeGreaterThan(pubFull.snapshotWatermark.length);

    // 元数据中分量依赖被持久化
    const meta = await repo.getMeta();
    expect(meta).not.toBeNull();
    expect(Object.keys(meta!.componentModel.members).length).toBeGreaterThan(0);
  });

  it('离线复跑（完整流程）', async () => {
    const { repo, engine } = await newEngine();
    await importAll(engine);
    await confirmAllPending(engine, repo, { skipConflict: true });
    const published = await engine.recomputeAndPublish('full');
    const report = await engine.replay();
    expect(report.equal).toBe(true);
    expect(report.originalPublicationId).toBe(published.id);
    expect(report.diffs).toEqual([]);
    // 复跑后事实与边数量恢复
    expect((await repo.getAllFacts()).length).toBeGreaterThan(0);
    expect((await repo.getAllEdges()).length).toBeGreaterThan(0);
  });

  it('发布版本记录计算范围与解析/提取/求值版本水位', async () => {
    const { engine } = await newEngine();
    await importAll(engine);
    const pub: Publication = await engine.recomputeAndPublish('auto');
    expect(['full', 'incremental']).toContain(pub.computeMode);
    expect(pub.computeScope.dependencyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pub.parserVersion).toBe(PARSER_VERSION);
    expect(pub.extractorVersion).toMatch(/^extractor-/);
    expect(pub.evaluatorVersion).toMatch(/^evaluator-/);
    expect(pub.adjudicationWatermark).toEqual([...pub.adjudicationWatermark].sort());
    expect(pub.snapshotWatermark).toEqual([...pub.snapshotWatermark].sort());
  });
});
