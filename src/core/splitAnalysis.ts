/**
 * 疑似拆分采购组合分析产品。
 *
 * 流水线：
 *  1. 需求特征器（demandFeatures.ts）→ 可回查特征
 *  2. 候选生成器：在同一适用政策区间内，按采购人/品类分桶枚举项目组合，
 *     计算合计金额、时间跨度、特征重叠与不确定字段
 *  3. 约束求值器：排除已有明确独立计划、不同采购主体、无法比较品类的组合；
 *     不合门槛或超出时间窗的组记录理由而非静默丢弃
 *  4. 案件视图：代表组合（互不重叠）+ 全部相连候选 + 支持/反驳证据 +
 *     替代分组 + 规则版本；同一项目在多组候选中明确重叠，不重复累计金额
 *  5. 版本化：政策按公告日分段；依赖项目链被裁决拆分/更正后组合失效并生成新案件版本
 *
 * 本模块只产出“待人工核查的候选组合”，不下任何违法结论。
 */
import type {
  CaseSelectionMode,
  DemandFeature,
  ExcludedGroup,
  ExclusionReason,
  Fact,
  FeatureKey,
  FeatureOverlap,
  PolicyCatalog,
  PublishedProject,
  SplitAlternative,
  SplitAnalysis,
  SplitCandidate,
  SplitCase,
  SplitCaseVersion,
  SplitEvidenceRef,
} from './types';
import { findPolicyBand, POLICY_VERSION } from './policy';
import { buildDemandFeatures, projectUnitId, type FeatureBuildInput } from './demandFeatures';
import { deterministicId, stableStringify } from './hash';

export const SPLIT_RULE_VERSION = 'split-rules-1.0.0';
export const DISCLAIMER =
  '本视图仅提供待人工核查的候选组合与可回查证据，不下任何违法或违规结论；' +
  '金额相近不等于规避程序，联合采购、正常分批交付与后补更正均可能造成表面聚集。';

/** 参与相似性比较的特征（顺序即展示顺序） */
export const COMPARED_FEATURES: FeatureKey[] = [
  'category',
  'title',
  'deliveryLocation',
  'unit',
  'purchaserLevel',
  'region',
  'method',
];

const FEATURE_LABELS: Record<FeatureKey, string> = {
  category: '品类',
  title: '标段标题',
  deliveryLocation: '交付地点',
  unit: '数量单位',
  purchaserLevel: '采购人层级',
  region: '地区',
  method: '采购方式',
};

export function featureLabel(key: FeatureKey): string {
  return FEATURE_LABELS[key];
}

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  independent_plan: '已有明确独立计划',
  different_entity: '不同采购主体 / 联合采购',
  incomparable_category: '无法比较品类',
  outside_window: '超出合并时间窗',
  below_threshold: '合计未达门槛',
  policy_band_mismatch: '适用政策区间不一致',
};

const MAX_COMBO_SIZE = 4;

function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(db - da) / 86_400_000);
}

function normalizeName(v: string | null): string {
  return (v ?? '').replace(/\s+/g, '');
}

interface Unit {
  feature: DemandFeature;
  project: PublishedProject;
  amountCny: number | null;
  amountFactId: string | null;
  amountSnapshotId: string | null;
  amountIsoDate: string | null;
  date: string | null;
}

function toUnit(feature: DemandFeature, project: PublishedProject): Unit {
  const prov = project.fieldProvenance.currentBudgetCny;
  return {
    feature,
    project,
    amountCny: project.currentBudgetCny,
    amountFactId: prov?.factId ?? null,
    amountSnapshotId: prov?.snapshotId ?? null,
    amountIsoDate: project.stageChain.map((n) => n.isoDate).filter(Boolean).sort().pop() ?? null,
    date: feature.announcementDate,
  };
}

/** 可读单元标签：编号 + 标段（同编号多标段时避免显示为重名） */
function unitLabel(unit: Unit): string {
  const lots = unit.project.lots.map((l) => l.lotCode).filter(Boolean);
  return lots.length ? `${unit.feature.projectCode}（${lots.join('、')}）` : unit.feature.projectCode;
}

/** 特征值一致的判定：双方都有值且相等才算一致；任一缺失视为不确定 */
function overlapFor(units: Unit[], key: FeatureKey): FeatureOverlap {
  const values = units.map((u) => u.feature[key].value);
  const present = values.filter((v): v is string => !!v);
  const uncertain = present.length !== values.length;
  const matched = !uncertain && present.length > 0 && present.every((v) => v === present[0]);
  return {
    key,
    matched,
    uncertain,
    valueA: values[0] ?? null,
    valueB: values.length > 1 ? values[1] ?? null : null,
  };
}

function factsOfTypes(unit: Unit, facts: Fact[], types: Fact['type'][]): Fact[] {
  const snapshotIds = new Set(unit.project.stageChain.map((n) => n.snapshotId));
  return facts.filter((f) => snapshotIds.has(f.snapshotId) && types.includes(f.type));
}

interface Bucket {
  bandId: string;
  entryId: string;
  policyVersion: string;
  citation: string;
  thresholdCny: number;
  mergeWindowDays: number;
  purchaser: string;
  category: string;
  units: Unit[];
}

interface Ctx {
  facts: Fact[];
  factsById: Map<string, Fact>;
  catalog: PolicyCatalog;
}

function buildEvidence(units: Unit[], ctx: Ctx): { support: SplitEvidenceRef[]; rebut: SplitEvidenceRef[] } {
  const support: SplitEvidenceRef[] = [];
  const rebut: SplitEvidenceRef[] = [];

  const pushValue = (list: SplitEvidenceRef[], unit: Unit, value: { factId: string | null; snapshotId: string | null; span?: { text: string }; ruleId?: string; value: string | null }, fallback: string) => {
    const fact = value.factId ? ctx.factsById.get(value.factId) : undefined;
    list.push({
      projectCode: unit.feature.projectCode,
      snapshotId: value.snapshotId ?? fact?.snapshotId ?? '',
      factId: value.factId,
      kind: list === support ? 'support' : 'rebut',
      text: fact?.evidence.text ?? value.span?.text ?? fallback,
      ruleId: value.ruleId ?? fact?.ruleId,
    });
  };

  for (const unit of units) {
    const f = unit.feature;
    pushValue(support, unit, f.category, `品类：${f.category.value ?? '缺失'}`);
    pushValue(support, unit, f.title, `标题：${f.title.value ?? '缺失'}`);
    pushValue(support, unit, f.purchaser, `采购人：${f.purchaser.value ?? '缺失'}`);
    pushValue(support, unit, f.purchaserLevel, `采购人层级：${f.purchaserLevel.value ?? '缺失'}`);
    pushValue(support, unit, f.deliveryLocation, `交付地点：${f.deliveryLocation.value ?? '缺失'}`);
    pushValue(support, unit, f.unit, `数量单位：${f.unit.value ?? '缺失'}`);
    pushValue(support, unit, f.region, `地区：${f.region.value ?? '缺失'}`);
    pushValue(support, unit, f.method, `采购方式：${f.method.value ?? '缺失'}`);

    if (unit.amountCny !== null) {
      const fact = unit.amountFactId ? ctx.factsById.get(unit.amountFactId) : undefined;
      support.push({
        projectCode: f.projectCode,
        snapshotId: unit.amountSnapshotId ?? fact?.snapshotId ?? '',
        factId: unit.amountFactId,
        kind: 'support',
        text: fact?.evidence.text ?? `金额 ${unit.amountCny}`,
        ruleId: fact?.ruleId,
      });
    }
    if (unit.date) {
      const fact = f.announcementFactId ? ctx.factsById.get(f.announcementFactId) : undefined;
      support.push({
        projectCode: f.projectCode,
        snapshotId: fact?.snapshotId ?? '',
        factId: f.announcementFactId,
        kind: 'support',
        text: fact?.evidence.text ?? `公告日 ${unit.date}`,
        ruleId: fact?.ruleId,
      });
    }

    // 反驳：独立计划/拆分依据（事实 id 或裁决 id）
    for (const ev of f.independentEvidence) {
      const fact = ctx.factsById.get(ev);
      const projEvidence = unit.project.independentUnits?.find((u) => u.edgeId === ev);
      rebut.push({
        projectCode: f.projectCode,
        snapshotId: fact?.snapshotId ?? (projEvidence ? unit.project.stageChain[0]?.snapshotId ?? '' : ''),
        factId: ev,
        kind: 'rebut',
        text: fact?.evidence.text ?? (projEvidence
          ? `链路裁决 ${projEvidence.adjudicationId} 已拆分出的独立标段：${projEvidence.lotSets.map((s) => `{${s.join('、')}}`).join(' ／ ')}`
          : `独立计划/拆分依据 ${ev}`),
        ruleId: fact?.ruleId,
      });
    }
    for (const fact of factsOfTypes(unit, ctx.facts, ['joint'])) {
      rebut.push({
        projectCode: f.projectCode,
        snapshotId: fact.snapshotId,
        factId: fact.id,
        kind: 'rebut',
        text: fact.evidence.text,
        ruleId: fact.ruleId,
      });
    }
  }
  return { support, rebut };
}

/** 同一政策区间内的候选生成 + 约束求值 */
function analyzeBucket(bucket: Bucket, ctx: Ctx): { candidates: SplitCandidate[]; excluded: ExcludedGroup[] } {
  const candidates: SplitCandidate[] = [];
  const excluded: ExcludedGroup[] = [];
  const excludedSeen = new Set<string>();

  const exclude = (units: Unit[], reason: ExclusionReason, detail: string, evidence: string[] = []) => {
    const codes = units.map((u) => u.feature.projectCode).sort();
    const key = `${reason}|${codes.join(',')}|${detail}`;
    if (excludedSeen.has(key)) return;
    excludedSeen.add(key);
    excluded.push({ projectCodes: codes, reason, detail, evidenceFactIds: [...new Set(evidence.filter(Boolean))].sort() });
  };

  const eligible: Unit[] = [];
  for (const unit of bucket.units) {
    const f = unit.feature;
    if (!unit.date) {
      exclude([unit], 'policy_band_mismatch', '缺少可核对的公告日，无法确定适用政策区间', f.independentEvidence);
      continue;
    }
    if (unit.amountCny === null) {
      exclude([unit], 'below_threshold', '缺少可核对的金额事实，无法参与合计金额比较', f.independentEvidence);
      continue;
    }
    if (f.independentEvidence.length > 0) {
      exclude([unit], 'independent_plan', '该采购单元已有明确独立计划或已被裁决拆分为独立标段，不并入组合', f.independentEvidence);
      continue;
    }
    const jointFacts = factsOfTypes(unit, ctx.facts, ['joint']);
    if (jointFacts.length > 0) {
      exclude([unit], 'different_entity', `存在联合采购标记（${jointFacts[0].evidence.text}），按联合采购解释而非拆分`, jointFacts.map((x) => x.id));
      continue;
    }
    eligible.push(unit);
  }

  const subsetLimit = Math.min(eligible.length, MAX_COMBO_SIZE);
  for (let size = 2; size <= subsetLimit; size++) {
    for (const subset of combinations(eligible, size)) {
      const dates = subset.map((u) => u.date!).sort();
      const span = daysBetween(dates[0], dates[dates.length - 1]);
      const total = subset.reduce((s, u) => s + (u.amountCny ?? 0), 0);

      const categories = subset.map((u) => u.feature.category.value);
      if (categories.some((c) => !c)) {
        exclude(subset, 'incomparable_category', '存在缺少品类证据的项目，无法证明需求可比');
        continue;
      }
      if (new Set(categories).size > 1) {
        exclude(subset, 'incomparable_category', `品类不一致（${[...new Set(categories)].join('、')}），不构成同类采购`);
        continue;
      }
      if (span > bucket.mergeWindowDays) {
        exclude(subset, 'outside_window', `公告日跨度 ${span} 天 > 允许合并时间窗 ${bucket.mergeWindowDays} 天`);
        continue;
      }
      if (total < bucket.thresholdCny) {
        exclude(subset, 'below_threshold', `合计金额 ${total.toLocaleString('zh-CN')} 元 < 门槛 ${bucket.thresholdCny.toLocaleString('zh-CN')} 元`);
        continue;
      }
      candidates.push(buildCandidate(bucket, subset, span, total, ctx));
    }
  }

  // 任意两项跨窗也留痕，便于审计解释
  for (const [a, b] of combinations(bucket.units, 2)) {
    if (a.date && b.date) {
      const span = daysBetween(a.date, b.date);
      if (span > bucket.mergeWindowDays) {
        exclude([a, b], 'outside_window', `公告日跨度 ${span} 天 > 时间窗 ${bucket.mergeWindowDays} 天`);
      }
    }
  }

  return { candidates: dedupeCandidates(candidates), excluded };
}

function combinations<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]) => {
    if (acc.length === size) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

function dedupeCandidates(candidates: SplitCandidate[]): SplitCandidate[] {
  const byKey = new Map<string, SplitCandidate>();
  for (const c of candidates) {
    const key = [...c.projectIds].sort().join(',');
    const existing = byKey.get(key);
    if (!existing || c.totalAmountCny > existing.totalAmountCny) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildCandidate(bucket: Bucket, units: Unit[], span: number, total: number, ctx: Ctx): SplitCandidate {
  const sorted = [...units].sort((a, b) => a.feature.projectCode.localeCompare(b.feature.projectCode));
  const overlaps = COMPARED_FEATURES.map((k) => overlapFor(sorted, k));
  const overlapScore = overlaps.filter((o) => o.matched).length;
  const uncertainFields = [...new Set(sorted.flatMap((u) => u.feature.uncertainFields))].sort();
  const { support, rebut } = buildEvidence(sorted, ctx);

  // 补充反驳证据：交付地点/采购人层级不一致
  for (const o of overlaps) {
    if (o.uncertain || o.matched) continue;
    if (o.key !== 'deliveryLocation' && o.key !== 'purchaserLevel') continue;
    for (const u of sorted) {
      const v = u.feature[o.key];
      if (!v.factId) continue;
      rebut.push({
        projectCode: u.feature.projectCode,
        snapshotId: v.snapshotId ?? '',
        factId: v.factId,
        kind: 'rebut',
        text: `${featureLabel(o.key)}不一致：${v.value}`,
        ruleId: v.ruleId,
      });
    }
  }

  const amountSources = sorted.map((u) => ({
    projectCode: u.feature.projectCode,
    amountCny: u.amountCny ?? 0,
    factId: u.amountFactId ?? '',
    snapshotId: u.amountSnapshotId ?? '',
    isoDate: u.amountIsoDate,
  }));

  return {
    id: deterministicId('cand', [bucket.bandId, ...sorted.map((u) => u.feature.projectId)]),
    projectCodes: sorted.map((u) => u.feature.projectCode),
    projectLabels: sorted.map((u) => unitLabel(u)),
    projectIds: sorted.map((u) => u.feature.projectId),
    totalAmountCny: total,
    timeSpanDays: span,
    featureOverlap: overlaps,
    overlapScore,
    uncertainFields,
    supportingEvidence: support,
    rebuttingEvidence: rebut,
    amountSources,
    policyBandId: bucket.bandId,
    ruleVersion: SPLIT_RULE_VERSION,
    alternativeGroupings: buildAlternatives(sorted, bucket),
    isRepresentative: false,
  };
}

function buildAlternatives(units: Unit[], bucket: Bucket): SplitAlternative[] {
  const sorted = [...units].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  const alts: SplitAlternative[] = [];
  if (sorted.length >= 3) {
    const cut = Math.floor(sorted.length / 2);
    const early = sorted.slice(0, cut).map((u) => u.feature.projectCode);
    const late = sorted.slice(cut).map((u) => u.feature.projectCode);
    alts.push({
      label: '按时间分段',
      projectCodes: [...early, ...late],
      rationale: `可比解释：较早 ${early.join('、')} 与较晚 ${late.join('、')} 可能属于两次独立安排，需分别核对计划与交付节点`,
    });
  } else {
    const within = bucket.units.filter(
      (u) => !units.some((x) => x.feature.projectId === u.feature.projectId) && u.date && u.amountCny !== null,
    );
    const nearest = within
      .filter((u) => sorted[0].date && u.date && daysBetween(sorted[0].date, u.date) <= bucket.mergeWindowDays)
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))[0];
    if (nearest) {
      alts.push({
        label: '纳入相邻同期项目',
        projectCodes: [...sorted.map((u) => u.feature.projectCode), nearest.feature.projectCode],
        rationale: `替代解释：若不拆分，${nearest.feature.projectCode} 也可能并入同一需求，应比较两种分组的合计金额`,
      });
    } else {
      alts.push({
        label: '无更细分段',
        projectCodes: sorted.map((u) => u.feature.projectCode),
        rationale: '组内仅两项且无相邻同期项目，任何替代分组都不改变合计金额',
      });
    }
  }
  return alts;
}

/** 证据强度：重叠特征数优先，其次时间跨度越短越集中 */
function strength(a: SplitCandidate): number {
  return a.overlapScore * 1_000_000_000_000 + a.totalAmountCny - a.timeSpanDays;
}

/** 按证据强度选择互不重叠的代表组合 */
function selectRepresentatives(candidates: SplitCandidate[]): SplitCandidate[] {
  const sorted = [...candidates].sort((a, b) => strength(b) - strength(a) || a.id.localeCompare(b.id));
  const used = new Set<string>();
  const reps: SplitCandidate[] = [];
  for (const c of sorted) {
    if (c.projectIds.some((id) => used.has(id))) continue;
    reps.push({ ...c, isRepresentative: true, overlapsWithRepresentative: [] });
    c.projectIds.forEach((id) => used.add(id));
  }
  return reps;
}

export interface AnalyzeInput extends FeatureBuildInput {
  mode: CaseSelectionMode;
  now: number;
  previous?: SplitAnalysis | null;
}

/** 主入口：从发布项目集与政策目录生成拆分采购分析 */
export function analyzeSplitProcurement(input: AnalyzeInput): SplitAnalysis {
  const { projects, facts, snapshots, catalog, mode, now, previous } = input;
  const features = buildDemandFeatures({ projects, facts, snapshots, catalog });
  const factsById = new Map(facts.map((f) => [f.id, f]));
  const projectById = new Map(projects.map((p) => [projectUnitId(p), p]));

  const units: Unit[] = [];
  for (const f of features) {
    const project = projectById.get(f.projectId);
    if (!project) continue;
    units.push(toUnit(f, project));
  }

  // 按适用政策区间 + 采购人 + 品类分桶
  const buckets = new Map<string, Bucket>();
  const excluded: ExcludedGroup[] = [];
  const uncertainties = new Set<string>();

  for (const unit of units) {
    const f = unit.feature;
    if (!f.policyBandId || !f.policyEntryId) {
      excluded.push({
        projectCodes: [f.projectCode],
        reason: 'policy_band_mismatch',
        detail: !f.region.value
          ? '缺少地区证据，无法匹配政策目录'
          : !f.method.value
            ? '缺少采购方式证据，无法匹配政策条目'
            : f.announcementDate
              ? `公告日 ${f.announcementDate} 不在任何政策区间内`
              : '缺少公告日，无法确定适用政策区间',
        evidenceFactIds: [f.region.factId, f.method.factId, f.announcementFactId].filter((x): x is string => !!x),
      });
      if (f.policyEntryId === null) uncertainties.add(`${f.projectCode}：无法解析适用政策条目`);
      continue;
    }
    const band = findPolicyBand(catalog, f.policyBandId);
    if (!band) continue;
    const purchaser = normalizeName(f.purchaser.value);
    const category = f.category.value ?? '(品类缺失)';
    const key = [f.policyBandId, purchaser, category].join('|');
    if (!buckets.has(key)) {
      buckets.set(key, {
        bandId: f.policyBandId,
        entryId: band.entry.id,
        policyVersion: band.entry.version ?? POLICY_VERSION,
        citation: band.band.citation,
        thresholdCny: band.band.thresholdCny,
        mergeWindowDays: band.band.mergeWindowDays,
        purchaser,
        category,
        units: [],
      });
    }
    buckets.get(key)!.units.push(unit);
  }

  // 同一区间/品类下跨采购主体：不合并，按“区间 + 品类”汇总说明（跨部门联合采购/不同主体）
  const byBandCategory = new Map<string, Bucket[]>();
  for (const b of buckets.values()) {
    const k = `${b.bandId}|${b.category}`;
    if (!byBandCategory.has(k)) byBandCategory.set(k, []);
    byBandCategory.get(k)!.push(b);
  }
  for (const list of byBandCategory.values()) {
    if (list.length <= 1) continue;
    const names = list.map((b) => b.purchaser || '未识别采购人');
    const codes = list.flatMap((b) => b.units.map((u) => u.feature.projectCode)).sort();
    excluded.push({
      projectCodes: codes,
      reason: 'different_entity',
      detail: `同一政策区间与品类下存在多个采购主体（${names.join('、')}）；除联合采购依据外不跨主体合并，需人工确认是否同一需求`,
      evidenceFactIds: list
        .flatMap((b) => b.units.map((u) => u.feature.purchaser.factId))
        .filter((x): x is string => !!x),
    });
  }

  // 同一区间、同一采购人但品类不同：无法比较，逐对记录（不静默丢弃）
  const byBandPurchaser = new Map<string, Bucket[]>();
  for (const b of buckets.values()) {
    const k = `${b.bandId}|${b.purchaser}`;
    if (!byBandPurchaser.has(k)) byBandPurchaser.set(k, []);
    byBandPurchaser.get(k)!.push(b);
  }
  for (const list of byBandPurchaser.values()) {
    if (list.length <= 1) continue;
    for (const [x, y] of combinations(list, 2)) {
      if (x.category === y.category) continue;
      const pairs: Unit[][] = [];
      for (const a of x.units) for (const b of y.units) pairs.push([a, b]);
      for (const [a, b] of pairs) {
        if (!a.date || !b.date) continue;
        const catA = a.feature.category.value ?? '(品类缺失)';
        const catB = b.feature.category.value ?? '(品类缺失)';
        const span = Math.abs(Date.parse(a.date) - Date.parse(b.date)) / 86_400_000;
        const window = Math.max(x.mergeWindowDays, y.mergeWindowDays);
        if (span > window) continue;
        excluded.push({
          projectCodes: [a.feature.projectCode, b.feature.projectCode].sort(),
          reason: 'incomparable_category',
          detail: `品类不同（${catA} ／ ${catB}），即使同期同采购人也不作为同类需求合并`,
          evidenceFactIds: [a.feature.category.factId, b.feature.category.factId].filter((z): z is string => !!z),
        });
      }
    }
  }

  // 同一政策条目、同一采购人/品类但公告日分属不同政策区间：按各自区间分段，禁止用同一门槛重判
  const byEntryPurchaserCategory = new Map<string, Bucket[]>();
  for (const b of buckets.values()) {
    const k = `${b.entryId}|${b.purchaser}|${b.category}`;
    if (!byEntryPurchaserCategory.has(k)) byEntryPurchaserCategory.set(k, []);
    byEntryPurchaserCategory.get(k)!.push(b);
  }
  for (const list of byEntryPurchaserCategory.values()) {
    if (list.length <= 1) continue;
    for (const [x, y] of combinations(list, 2)) {
      if (x.bandId === y.bandId) continue;
      for (const a of x.units) {
        for (const b of y.units) {
          if (!a.date || !b.date) continue;
          const span = Math.abs(Date.parse(a.date) - Date.parse(b.date)) / 86_400_000;
          if (span > Math.max(x.mergeWindowDays, y.mergeWindowDays)) continue;
          excluded.push({
            projectCodes: [a.feature.projectCode, b.feature.projectCode].sort(),
            reason: 'policy_band_mismatch',
            detail: `公告日分别落在不同政策区间（${x.bandId} 门槛 ${x.thresholdCny.toLocaleString('zh-CN')} 元 ／ ${y.bandId} 门槛 ${y.thresholdCny.toLocaleString('zh-CN')} 元），按各自公告日适用版本分段，不得用同一门槛重判`,
            evidenceFactIds: [a.feature.announcementFactId, b.feature.announcementFactId].filter((z): z is string => !!z),
          });
        }
      }
    }
  }

  const ctx: Ctx = { facts, factsById, catalog };
  const caseResults: SplitCase[] = [];

  const orderedBuckets = [...buckets.values()].sort((a, b) =>
    `${a.bandId}|${a.purchaser}|${a.category}`.localeCompare(`${b.bandId}|${b.purchaser}|${b.category}`),
  );
  for (const bucket of orderedBuckets) {
    const { candidates, excluded: ex } = analyzeBucket(bucket, ctx);
    excluded.push(...ex);
    if (!candidates.length) continue;

    const allCandidates = candidates.map((c) => ({ ...c, isRepresentative: false, overlapsWithRepresentative: [] as string[] }));
    // 代表组合始终是“按证据强度选择的互不重叠集合”；
    // selectionMode 只影响案件队列的默认呈现：
    //   recall   → 主队列展示全部相连候选，代表组合用于去重金额
    //   capacity → 主队列仅展示互不重叠代表组合，其余候选折叠为“未分组/次优解释”
    const reps = selectRepresentatives(allCandidates);
    const repIds = new Set(reps.map((r) => r.id));
    for (const c of allCandidates) {
      if (repIds.has(c.id)) {
        c.isRepresentative = true;
        c.overlapsWithRepresentative = [];
        continue;
      }
      const shared = new Set(c.projectIds);
      c.overlapsWithRepresentative = reps.filter((r) => r.projectIds.some((id) => shared.has(id))).map((r) => r.id);
    }

    const projectToCandidates = new Map<string, string[]>();
    for (const c of allCandidates) {
      for (const code of c.projectCodes) {
        if (!projectToCandidates.has(code)) projectToCandidates.set(code, []);
        projectToCandidates.get(code)!.push(c.id);
      }
    }
    // 重叠按“项目单元”（编号 + 链上快照指纹）计：同编号但链被拆分后是两个不同单元
    const idToCode = new Map<string, string[]>();
    for (const c of allCandidates) {
      for (let i = 0; i < c.projectIds.length; i++) {
        const id = c.projectIds[i];
        if (!idToCode.has(id)) idToCode.set(id, []);
        if (!idToCode.get(id)!.includes(c.projectCodes[i])) idToCode.get(id)!.push(c.projectCodes[i]);
      }
    }
    const unitToCandidates = new Map<string, string[]>();
    for (const c of allCandidates) {
      for (const id of c.projectIds) {
        if (!unitToCandidates.has(id)) unitToCandidates.set(id, []);
        unitToCandidates.get(id)!.push(c.id);
      }
    }

    // 代表组合的合计金额按“项目单元”去重累计：同一单元只计一次，避免重叠重复展示
    const unitAmount = new Map<string, number>();
    for (const c of reps) {
      c.projectIds.forEach((id, i) => {
        if (!unitAmount.has(id)) unitAmount.set(id, c.amountSources[i]?.amountCny ?? 0);
      });
    }
    const representativeTotalCny = [...unitAmount.values()].reduce((s, v) => s + v, 0);
    const connectedCandidateSumCny = allCandidates.reduce((s, c) => s + c.totalAmountCny, 0);

    // 未进入任何代表组合、但在候选池中出现过的项目（边界/次优解释）
    const repUnits = new Set(reps.flatMap((r) => r.projectIds));
    const ungrouped = [...new Set([...unitToCandidates.keys()].filter((id) => !repUnits.has(id)))]
      .map((id) => (idToCode.get(id) ?? [id])[0])
      .sort();

    const caseId = deterministicId('case', [bucket.bandId, bucket.purchaser, bucket.category]);
    const fingerprint = deterministicId('fp', [
      bucket.bandId,
      bucket.purchaser,
      bucket.category,
      ...allCandidates.flatMap((c) => [...c.projectIds, ...c.projectCodes]).sort(),
      ...reps.map((r) => r.id).sort(),
    ]);

    const previousCase = previous?.cases.find((c) => c.id === caseId && c.status === 'pending_review');
    const versions = resolveVersions(previousCase, fingerprint, allCandidates.map((c) => c.id), now);

    caseResults.push({
      id: caseId,
      title: `${bucket.purchaser || '未识别采购人'} · ${bucket.category} · 区间 ${bucket.bandId}`,
      policyEntryId: bucket.entryId,
      policyBandId: bucket.bandId,
      policyVersion: bucket.policyVersion,
      citation: bucket.citation,
      thresholdCny: bucket.thresholdCny,
      mergeWindowDays: bucket.mergeWindowDays,
      publishers: [bucket.purchaser || '未识别采购人'],
      status: 'pending_review',
      fingerprint,
      representatives: reps,
      candidates: allCandidates,
      overlap: [...unitToCandidates.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([projectId, candidateIds]) => ({ projectId, projectCode: (idToCode.get(projectId) ?? [projectId])[0], candidateIds: [...candidateIds].sort() }))
        .sort((a, b) => a.projectId.localeCompare(b.projectId)),
      representativeTotalCny,
      connectedCandidateSumCny,
      ungroupedProjectCodes: ungrouped,
      versions,
      disclaimer: DISCLAIMER,
    });
  }

  // 上一轮存在、本轮不再满足条件或依赖链已变化的案件：失效并生成新的失效版本，保留历史
  const activeIds = new Set(caseResults.map((c) => c.id));
  for (const prevCase of previous?.cases ?? []) {
    if (activeIds.has(prevCase.id)) continue;
    if (prevCase.status === 'invalidated') {
      // 已失效案件原样保留，便于历史回放
      caseResults.push(prevCase);
      continue;
    }
    const lastVersion = prevCase.versions[prevCase.versions.length - 1];
    const superseded = prevCase.versions.map((v) =>
      v.version === lastVersion.version
        ? { ...v, status: 'invalidated' as const, reason: `${v.reason}；依赖项目链经裁决更正/拆分，组合已失效` }
        : v,
    );
    const invalidatedVersions: SplitCaseVersion[] = [
      ...superseded,
      {
        version: lastVersion.version + 1,
        reason: '重算后不再存在满足约束的候选组合（如链路被裁决拆为独立标段），案件整体失效；保留旧版本供历史回放',
        createdAt: now,
        status: 'invalidated',
        candidateIds: [],
        fingerprint: deterministicId('fp', ['invalidated', prevCase.id, lastVersion.version + 1]),
      },
    ];
    caseResults.push({
      ...prevCase,
      status: 'invalidated',
      fingerprint: invalidatedVersions[invalidatedVersions.length - 1].fingerprint,
      representatives: [],
      overlap: [],
      representativeTotalCny: 0,
      connectedCandidateSumCny: prevCase.connectedCandidateSumCny,
      ungroupedProjectCodes: [],
      versions: invalidatedVersions,
    });
  }

  caseResults.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending_review' ? -1 : 1;
    return b.representativeTotalCny - a.representativeTotalCny || a.id.localeCompare(b.id);
  });

  const fingerprint = deterministicId('analysis', [
    ...features.map((f) => f.projectId).sort(),
    POLICY_VERSION,
    SPLIT_RULE_VERSION,
    mode,
  ]);
  const version = previous ? previous.version + 1 : 1;
  const invalidatedCaseIds = caseResults.filter((c) => c.status === 'invalidated').map((c) => c.id);

  return {
    id: deterministicId('split', [fingerprint.slice(0, 16), version]),
    version,
    createdAt: now,
    ruleVersion: SPLIT_RULE_VERSION,
    policyVersion: POLICY_VERSION,
    selectionMode: mode,
    analyzedProjects: features.length,
    features,
    cases: caseResults,
    excluded: dedupeExclusions(excluded),
    uncertainties: [...uncertainties].sort(),
    history: [
      ...(previous?.history ?? []),
      {
        version,
        createdAt: now,
        caseIds: caseResults.filter((c) => c.status === 'pending_review').map((c) => c.id),
        invalidatedCaseIds,
      },
    ],
  };
}

function resolveVersions(previousCase: SplitCase | undefined, fingerprint: string, candidateIds: string[], now: number): SplitCaseVersion[] {
  if (!previousCase) {
    return [{ version: 1, reason: '初次生成的候选组合', createdAt: now, status: 'active', candidateIds: [...candidateIds].sort(), fingerprint }];
  }
  if (previousCase.fingerprint === fingerprint) {
    return previousCase.versions.map((v, i, arr) => (i === arr.length - 1 ? { ...v, status: 'active' as const } : v));
  }
  const nextVersion = Math.max(...previousCase.versions.map((v) => v.version)) + 1;
  const superseded = previousCase.versions.map((v) =>
    v.status === 'active'
      ? { ...v, status: 'invalidated' as const, reason: `${v.reason}；依赖项目链经裁决更正/拆分，组合已失效` }
      : v,
  );
  return [
    ...superseded,
    {
      version: nextVersion,
      reason: '依赖项目链经裁决更正或拆分为独立标段，按新事实重新生成案件版本',
      createdAt: now,
      status: 'active',
      candidateIds: [...candidateIds].sort(),
      fingerprint,
    },
  ];
}

function dedupeExclusions(list: ExcludedGroup[]): ExcludedGroup[] {
  const seen = new Set<string>();
  const out: ExcludedGroup[] = [];
  for (const e of list) {
    const key = `${e.reason}|${[...e.projectCodes].sort().join(',')}|${e.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, projectCodes: [...e.projectCodes].sort(), evidenceFactIds: [...new Set(e.evidenceFactIds)].sort() });
  }
  return out.sort((a, b) => a.reason.localeCompare(b.reason) || a.projectCodes.join(',').localeCompare(b.projectCodes.join(',')));
}

/** 分析指纹：案件历史回放与复跑校验用 */
export function splitAnalysisFingerprint(a: SplitAnalysis): string {
  return stableStringify({
    rule: a.ruleVersion,
    policy: a.policyVersion,
    features: a.features.map((f) => [f.projectId, f.policyBandId]),
    cases: a.cases.map((c) => ({
      id: c.id,
      status: c.status,
      fp: c.fingerprint,
      reps: c.representatives.map((r) => r.id),
      cands: c.candidates.map((r) => r.id),
    })),
    excluded: a.excluded.map((e) => [e.reason, e.projectCodes]),
  });
}
