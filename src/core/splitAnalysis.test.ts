/**
 * 疑似拆分采购组合分析验收测试。
 *
 * 覆盖：
 *  - 金额门槛切换：按公告日适用政策区间，不用当前门槛重判历史；
 *  - 同类短期采购：合计金额达到门槛才进入候选；
 *  - 明确独立计划 / 跨部门联合采购 / 不可比品类：被排除且理由可回查；
 *  - 重叠处理：同一项目出现在多组候选时代表组合金额去重、不重复累计；
 *  - 链路裁决更正：被拆为独立标段的组合失效并生成新案件版本；
 *  - 历史案件回放：离线复跑与历史发布一致。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkbenchEngine, type ImportFileInput } from './engine';
import { MemoryRepository } from './memoryRepository';
import { DEFAULT_POLICY_CATALOG, cloneCatalog, applicableBand, findPolicyEntry } from './policy';
import type { CaseSelectionMode, PolicyCatalog, SplitAnalysis } from './types';

const SPLIT_DIR = join(process.cwd(), 'sample-archive', 'split');

function loadSplitSamples(): ImportFileInput[] {
  return readdirSync(SPLIT_DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((fileName) => ({ fileName, text: readFileSync(join(SPLIT_DIR, fileName), 'utf-8') }));
}

let clockValue = 1_720_000_000_000;
const clock = () => clockValue;

async function setup(opts: { policyCatalog?: PolicyCatalog; mode?: CaseSelectionMode } = {}) {
  const repo = new MemoryRepository();
  const engine = new WorkbenchEngine(repo, undefined, clock);
  if (opts.policyCatalog) await engine.setPolicyCatalog(opts.policyCatalog);
  if (opts.mode) await engine.setSplitSelectionMode(opts.mode);
  clockValue += 1000;
  await engine.importBatch('拆分样例', loadSplitSamples());
  const publication = await engine.recomputeAndPublish('full');
  return { repo, engine, publication, analysis: publication.splitAnalysis! };
}

function caseByProjectCode(analysis: SplitAnalysis, code: string) {
  return analysis.cases.find((c) => c.candidates.some((cand) => cand.projectCodes.includes(code)));
}

/** 把浙江 2024-01-01 起的公开招标门槛替换为指定值（其余保持） */
function withZhejiangThreshold(thresholdCny: number): PolicyCatalog {
  const catalog = cloneCatalog(DEFAULT_POLICY_CATALOG);
  const entry = catalog.entries.find((e) => e.id === 'ZJ-OPEN')!;
  entry.bands = entry.bands.map((b) =>
    b.effectiveFrom === '2024-01-01'
      ? { ...b, thresholdCny, citation: `演示门槛 ${thresholdCny}（虚构对照）` }
      : b,
  );
  return catalog;
}

describe('政策目录：按公告日分段适用', () => {
  it('同一地区不同公告日选择不同门槛版本，未用当前门槛重判历史', () => {
    const entry = findPolicyEntry(DEFAULT_POLICY_CATALOG, 'ZJ-OPEN')!;
    const old = applicableBand(entry, '2023-09-10')!;
    const recent = applicableBand(entry, '2024-03-15')!;
    expect(old.band.thresholdCny).toBe(1_100_000);
    expect(recent.band.thresholdCny).toBe(1_300_000);
    expect(old.bandId).not.toBe(recent.bandId);
  });

  it('跨政策区间的项目对不合并，并留痕说明分段适用', async () => {
    const { analysis } = await setup();
    // 2023 年（门槛 110 万）与 2024 年（门槛 130 万）的同采购人同品类项目分属不同区间
    const mismatch = analysis.excluded.filter((e) => e.reason === 'policy_band_mismatch');
    expect(mismatch.some((e) => e.projectCodes.includes('ZJ2023-1002') && e.projectCodes.includes('ZJ2024-1003'))).toBe(true);
    expect(mismatch.every((e) => e.detail.includes('按各自公告日'))).toBe(true);
    // 同一候选组合内的金额来源只属于一个政策区间（候选本身即由单一区间生成）
    for (const c of analysis.cases.flatMap((x) => x.candidates)) {
      expect(c.policyBandId).toBeTruthy();
      expect(c.amountSources.length).toBe(c.projectCodes.length);
    }
  });

  it('同一合计金额在旧门槛下达标、在新门槛下不达标：证明未用当前门槛重判历史', async () => {
    const { analysis } = await setup();
    const pair = caseByProjectCode(analysis, 'ZJ2023-1001')!.candidates.find(
      (c) => c.projectCodes.length === 2 && c.projectCodes.includes('ZJ2023-1001'),
    )!;
    // 该对项目公告日在 2023 区间（门槛 110 万），合计 120 万 → 达标成为候选
    expect(pair.policyBandId).toBe('ZJ-OPEN#0');
    expect(pair.totalAmountCny).toBe(1_200_000);
    expect(pair.totalAmountCny).toBeGreaterThanOrEqual(1_100_000);
    // 同一金额若按 2024 区间门槛（130 万）衡量则不达标——说明不能拿当前门槛重判历史
    expect(pair.totalAmountCny).toBeLessThan(1_300_000);
  });
});

describe('候选生成与金额门槛', () => {
  it('同类短期采购合计金额达到门槛才进入候选，且金额来源可回查', async () => {
    const { analysis } = await setup();
    const target = caseByProjectCode(analysis, 'ZJ2023-1001')!;
    expect(target).toBeTruthy();
    const pair = target.candidates.find(
      (c) => c.projectCodes.includes('ZJ2023-1001') && c.projectCodes.includes('ZJ2023-1002') && c.projectCodes.length === 2,
    )!;
    expect(pair).toBeTruthy();
    expect(pair.totalAmountCny).toBe(1_200_000);
    expect(pair.totalAmountCny).toBeGreaterThanOrEqual(target.thresholdCny);
    // 每笔金额都能回溯到事实与快照
    for (const src of pair.amountSources) {
      expect(src.factId).toMatch(/^fact_/);
      expect(src.snapshotId).toMatch(/^snap_/);
      expect(src.amountCny).toBeGreaterThan(0);
    }
    // 时间跨度在允许合并时间窗内
    expect(pair.timeSpanDays).toBeLessThanOrEqual(target.mergeWindowDays);
    // 特征重叠包含品类/标题等可回查证据
    expect(pair.featureOverlap.some((o) => o.key === 'category' && o.matched)).toBe(true);
    expect(pair.supportingEvidence.every((e) => typeof e.text === 'string')).toBe(true);
  });

  it('提高当前门槛后，单对项目因未达门槛被排除而非强行拼成候选', async () => {
    const high = withZhejiangThreshold(1_600_000);
    const { analysis } = await setup({ policyCatalog: high });
    // 浙江 2024 区间门槛提升到 160 万后，任意两项（约 120–135 万）均未达门槛
    const below = analysis.excluded.filter((e) => e.reason === 'below_threshold');
    expect(below.some((e) => e.projectCodes.join(',').includes('ZJ2024-2003') || e.projectCodes.join(',').includes('ZJ2024-2001'))).toBe(true);
    // 2023 年区间保持 110 万，不受 2024 门槛切换影响
    const older = caseByProjectCode(analysis, 'ZJ2023-1001');
    expect(older?.thresholdCny).toBe(1_100_000);
  });

  it('提高门槛后同一区间的候选组合减少（门槛切换可验证）', async () => {
    const normal = await setup();
    const high = await setup({ policyCatalog: withZhejiangThreshold(1_600_000) });
    const normalCount = normal.analysis.cases
      .filter((c) => c.policyBandId === 'ZJ-OPEN#1')
      .reduce((n, c) => n + c.candidates.length, 0);
    const highCount = high.analysis.cases
      .filter((c) => c.policyBandId === 'ZJ-OPEN#1')
      .reduce((n, c) => n + c.candidates.length, 0);
    expect(highCount).toBeLessThan(normalCount);
    // 单对未达门槛的组进入排除记录而非静默丢弃
    expect(high.analysis.excluded.some((e) => e.reason === 'below_threshold')).toBe(true);
  });
});

describe('约束求值器：排除理由可回查', () => {
  it('已有明确独立计划（采购计划编号）的项目不并入组合', async () => {
    const { analysis } = await setup();
    const indep = analysis.excluded.find((e) => e.reason === 'independent_plan' && e.projectCodes.includes('ZJ2024-1003'));
    expect(indep).toBeTruthy();
    expect(indep!.evidenceFactIds.length).toBeGreaterThan(0);
    // 该项目不出现在任何候选组合
    expect(analysis.cases.flatMap((c) => c.candidates).some((c) => c.projectCodes.includes('ZJ2024-1003'))).toBe(false);
  });

  it('跨部门联合采购项目被排除，理由引用联合采购原文', async () => {
    const { analysis } = await setup();
    const joint = analysis.excluded.find((e) => e.reason === 'different_entity' && e.projectCodes.includes('SC2024-4002'));
    expect(joint).toBeTruthy();
    expect(joint!.detail).toContain('联合采购');
    expect(analysis.cases.flatMap((c) => c.candidates).some((c) => c.projectCodes.includes('SC2024-4002'))).toBe(false);
  });

  it('不同采购主体不合并，即使同期同品类', async () => {
    const { analysis } = await setup();
    const cross = analysis.excluded.find((e) => e.reason === 'different_entity' && e.projectCodes.includes('ZJ2024-1003') && e.projectCodes.includes('ZJ2024-5001'));
    expect(cross).toBeTruthy();
    expect(cross!.detail).toContain('多个采购主体');
  });

  it('无法比较品类不同时不合并，并给出品类差异说明', async () => {
    const { analysis } = await setup();
    const incomparable = analysis.excluded.find(
      (e) => e.reason === 'incomparable_category' && e.projectCodes.includes('SC2024-4001') && e.projectCodes.includes('SC2024-4003'),
    );
    expect(incomparable).toBeTruthy();
    expect(incomparable!.detail).toContain('品类不同');
  });
});

describe('重叠处理与代表组合', () => {
  it('同一项目出现在多组候选时，代表组合金额按项目去重、不重复累计', async () => {
    const { analysis } = await setup();
    const multi = analysis.cases.find((c) => c.overlap.length > 0)!;
    expect(multi).toBeTruthy();
    // 全部候选合计 > 代表组合去重合计（因为重叠导致重复展示）
    expect(multi.connectedCandidateSumCny).toBeGreaterThan(multi.representativeTotalCny);
    // 代表组合之间互不重叠
    const used = new Set<string>();
    for (const r of multi.representatives) {
      for (const id of r.projectIds) {
        expect(used.has(id)).toBe(false);
        used.add(id);
      }
    }
    // 去重合计 = 代表组合内各项目金额之和（项目不重复）
    const expected = multi.representatives
      .flatMap((r) => r.projectIds.map((id, i) => ({ id, amount: r.amountSources[i].amountCny })))
      .filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i)
      .reduce((s, x) => s + x.amount, 0);
    expect(multi.representativeTotalCny).toBe(expected);
    // 重叠明细明确列出每个共享项目所在的候选
    for (const o of multi.overlap) {
      expect(o.candidateIds.length).toBeGreaterThan(1);
    }
  });

  it('代表组合按证据强度选择且互不重叠；connectedCandidateSumCny 可用于比较召回成本', async () => {
    const { analysis } = await setup();
    for (const c of analysis.cases.filter((x) => x.status === 'pending_review')) {
      const reps = c.representatives;
      const ids = reps.flatMap((r) => r.projectIds);
      expect(new Set(ids).size).toBe(ids.length);
      // 未被代表的候选必须标记 overlapsWithRepresentative
      for (const cand of c.candidates.filter((x) => !x.isRepresentative)) {
        expect(Array.isArray(cand.overlapsWithRepresentative)).toBe(true);
      }
    }
  });

  it('capacity 模式下案件队列更短：未分组项目被明确列出', async () => {
    const recall = await setup({ mode: 'recall' });
    const capacity = await setup({ mode: 'capacity' });
    expect(recall.analysis.selectionMode).toBe('recall');
    expect(capacity.analysis.selectionMode).toBe('capacity');
    const recallCandidates = recall.analysis.cases.reduce((n, c) => n + c.candidates.length, 0);
    const capacityCandidates = capacity.analysis.cases.reduce((n, c) => n + c.candidates.length, 0);
    const recallQueue = recall.analysis.cases.reduce((n, c) => n + c.candidates.length, 0);
    const capacityQueue = capacity.analysis.cases.reduce((n, c) => n + c.representatives.length, 0);
    // 两种模式的候选池相同，但 capacity 的实际队列是互不重叠代表组合，因此比 recall 短
    expect(capacityCandidates).toBe(recallCandidates);
    expect(capacityQueue).toBeLessThan(recallQueue);
    const multi = capacity.analysis.cases.find((c) => c.candidates.length > c.representatives.length);
    expect(multi).toBeTruthy();
    // 次优/边界候选不进入代表组合，但仍保留在全部候选池中并标注重叠关系
    const folded = multi!.candidates.filter((c) => !c.isRepresentative);
    expect(folded.length).toBeGreaterThan(0);
    expect(folded.every((c) => Array.isArray(c.overlapsWithRepresentative) && c.overlapsWithRepresentative.length > 0)).toBe(true);
    // 代表组合之间金额不重复累计
    expect(multi!.representativeTotalCny).toBeLessThan(multi!.connectedCandidateSumCny);
  });
});

describe('链路裁决更正与历史案件回放', () => {
  it('项目链被裁决拆为两个独立标段后，依赖它的组合失效并生成新案件版本', async () => {
    const { repo, engine, analysis: before } = await setup();
    const beforeCase = before.cases.find((c) => c.candidates.some((cand) => cand.projectCodes.includes('ZJ2024-5001')));
    expect(beforeCase).toBeTruthy();
    expect(beforeCase!.status).toBe('pending_review');
    expect(beforeCase!.versions.some((v) => v.status === 'active')).toBe(true);

    const conflict = (await repo.getAllEdges()).find((e) => e.type === 'conflict')!;
    expect(conflict).toBeTruthy();
    clockValue += 1;
    await engine.adjudicate({
      edgeId: conflict.id,
      decision: 'split',
      note: '裁决：同编号但确为两个独立标段',
      reviewer: 'tester',
      appliedFactIds: conflict.evidenceFactIds,
    });

    const after = (await engine.recomputeAndPublish('full')).splitAnalysis!;
    const afterCase = after.cases.find((c) => c.id === beforeCase!.id)!;
    expect(afterCase).toBeTruthy();
    // 旧组合失效
    expect(afterCase.status).toBe('invalidated');
    expect(afterCase.versions[afterCase.versions.length - 1].status).toBe('invalidated');
    expect(afterCase.versions.length).toBeGreaterThan(beforeCase!.versions.length);
    // 依赖它的组合不再出现在待核候选里，并作为独立计划被排除
    expect(after.cases.filter((c) => c.status === 'pending_review').flatMap((c) => c.candidates).some((c) => c.projectCodes.includes('ZJ2024-5001'))).toBe(false);
    const indep = after.excluded.find((e) => e.reason === 'independent_plan' && e.projectCodes.includes('ZJ2024-5001'));
    expect(indep).toBeTruthy();
    expect(indep!.evidenceFactIds.some((id) => id.startsWith('adj_'))).toBe(true);
    // 历史回放记录该轮失效
    expect(after.history[after.history.length - 1].invalidatedCaseIds).toContain(beforeCase!.id);
  });

  it('离线复跑在同一水位重建相同的拆分采购案件（历史案件回放）', async () => {
    const { repo, engine, publication } = await setup();
    // 先做一次裁决变更，制造案件版本历史
    const pending = (await repo.getAllEdges()).find((e) => e.status === 'pending' && e.type === 'stage_chain');
    if (pending) {
      clockValue += 1;
      await engine.adjudicate({
        edgeId: pending.id, decision: 'reject', note: '复跑测试：驳回', reviewer: 'tester', appliedFactIds: [],
      });
      await engine.recomputeAndPublish('full');
    }
    const report = await engine.replay();
    expect(report.equal).toBe(true);
    expect(report.diffs).toEqual([]);
    expect(report.originalPublicationId).toBeTruthy();
    // 原始发布仍在，可回放
    expect(publication.splitAnalysis).toBeTruthy();
  });

  it('双模式一致性校验包含拆分采购候选组合', async () => {
    const { engine } = await setup();
    const report = await engine.checkConsistency();
    expect(report.equal).toBe(true);
    expect(report.diffs).toEqual([]);
  });
});

describe('纯函数：analyzeSplitProcurement 确定性', () => {
  it('相同输入确定性输出：项目集与政策目录不变则案件与候选 id 稳定', async () => {
    const { engine, publication } = await setup();
    const again = (await engine.recomputeAndPublish('full')).splitAnalysis!;
    const first = publication.splitAnalysis!;
    expect(again.cases.map((c) => c.id)).toEqual(first.cases.map((c) => c.id));
    expect(again.cases.map((c) => c.candidates.map((x) => x.id))).toEqual(first.cases.map((c) => c.candidates.map((x) => x.id)));
    // 项目单元指纹稳定 → 未变更案件沿用同一版本
    for (const c of again.cases.filter((x) => x.status === 'pending_review')) {
      expect(c.versions[c.versions.length - 1].status).toBe('active');
    }
  });
});
