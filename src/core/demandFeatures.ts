/**
 * 需求特征器：从已发布项目链形成可回查的相似性证据。
 *
 * 特征维度：标段标题、品类、交付地点、数量单位、采购人层级，
 * 另附采购人、地区、采购方式与公告日（用于政策区间选择）。
 *
 * 每一项特征值都携带事实 id + 快照 id + 原文区间 + 规则 id，
 * 案件视图可据此直接定位原文，避免把“金额相近”直接当作违规。
 */
import type {
  DemandFeature,
  Fact,
  FeatureValue,
  PolicyCatalog,
  ProcurementMethod,
  PublishedProject,
  Snapshot,
  FactType,
} from './types';
import { applicableBand, resolvePolicyEntry } from './policy';
import { deterministicId } from './hash';

export const FEATURE_VERSION = 'features-1.0.0';

export function normalizeFeature(value: string): string {
  return value.replace(/\s+/g, '').replace(/[（）()【】\[\]、，,。；;：:]/g, '').toLowerCase();
}

function emptyValue(): FeatureValue {
  return { value: null, factId: null, snapshotId: null };
}

function factValue(fact: Fact): FeatureValue {
  return {
    value: normalizeFeature(fact.value),
    factId: fact.id,
    snapshotId: fact.snapshotId,
    span: { ...fact.evidence },
    ruleId: fact.ruleId,
  };
}

const METHOD_TO_ENUM: Record<string, ProcurementMethod> = {
  公开招标: 'open_tender',
  邀请招标: 'invited',
  竞争性磋商: 'competitive_negotiation',
  竞争性谈判: 'competitive_negotiation',
  询价: 'inquiry',
  单一来源: 'single_source',
};

export interface FeatureBuildInput {
  projects: PublishedProject[];
  facts: Fact[];
  snapshots: Snapshot[];
  catalog: PolicyCatalog;
}

/** 项目稳定 id：编号 + 链上快照集合。链路被裁决拆分后指纹随之变化。 */
export function projectUnitId(project: PublishedProject): string {
  const snapshotIds = [...project.stageChain.map((n) => n.snapshotId)].sort();
  return deterministicId('unit', [project.projectCode, ...snapshotIds]);
}

function pickFact(facts: Fact[], type: FactType): Fact | undefined {
  return facts
    .filter((f) => f.type === type)
    .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId) || a.evidence.start - b.evidence.start)[0];
}

/** 公告日：优先取公告/意向阶段的最早日期，否则取链上最早日期 */
function announcementOf(project: PublishedProject): { iso: string | null; factId: string | null; snapshotId: string | null } {
  const dated = [...project.stageChain]
    .filter((n) => n.isoDate)
    .sort((a, b) => (a.isoDate ?? '').localeCompare(b.isoDate ?? '') || a.snapshotId.localeCompare(b.snapshotId));
  if (!dated.length) return { iso: null, factId: null, snapshotId: null };
  const announcement = dated.find((n) => n.stage === 'announcement' || n.stage === 'intention');
  const node = announcement ?? dated[0];
  return { iso: node.isoDate, factId: null, snapshotId: node.snapshotId };
}

export function buildDemandFeatures(input: FeatureBuildInput): DemandFeature[] {
  const { projects, facts, catalog } = input;
  const factsBySnapshot = new Map<string, Fact[]>();
  for (const f of facts) {
    if (!factsBySnapshot.has(f.snapshotId)) factsBySnapshot.set(f.snapshotId, []);
    factsBySnapshot.get(f.snapshotId)!.push(f);
  }

  const features: DemandFeature[] = [];
  for (const project of projects) {
    const collected: Fact[] = [];
    for (const node of project.stageChain) collected.push(...(factsBySnapshot.get(node.snapshotId) ?? []));
    const seen = new Set<string>();
    const uniqueFacts = collected.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));

    const uncertainFields = new Set<string>();

    const titleFact = pickFact(uniqueFacts, 'title') ??
      uniqueFacts.filter((f) => f.type === 'lot').sort((a, b) => a.evidence.start - b.evidence.start)[0];

    const title = titleFact ? factValue(titleFact) : emptyValue();
    const category = pickFact(uniqueFacts, 'category');
    const deliveryLocation = pickFact(uniqueFacts, 'delivery');
    const unit = pickFact(uniqueFacts, 'unit');
    const purchaserLevel = pickFact(uniqueFacts, 'purchaser_level');
    const region = pickFact(uniqueFacts, 'region');
    const method = pickFact(uniqueFacts, 'method');

    let purchaser: FeatureValue = emptyValue();
    const purchaserFact = pickFact(uniqueFacts, 'purchaser');
    if (purchaserFact) purchaser = factValue(purchaserFact);
    if (!purchaser.value && project.purchaser) purchaser = { ...purchaser, value: normalizeFeature(project.purchaser) };

    const categoryV = category ? factValue(category) : emptyValue();
    const deliveryV = deliveryLocation ? factValue(deliveryLocation) : emptyValue();
    const unitV = unit ? factValue(unit) : emptyValue();
    const levelV = purchaserLevel ? factValue(purchaserLevel) : emptyValue();
    const regionV = region ? factValue(region) : emptyValue();
    const methodV = method ? factValue(method) : emptyValue();

    if (!categoryV.value) uncertainFields.add('category');
    if (!title.value) uncertainFields.add('title');
    if (!deliveryV.value) uncertainFields.add('deliveryLocation');
    if (!unitV.value) uncertainFields.add('unit');
    if (!levelV.value) uncertainFields.add('purchaserLevel');
    if (!purchaser.value) uncertainFields.add('purchaser');
    if (!regionV.value) uncertainFields.add('region');
    if (!methodV.value) uncertainFields.add('method');

    const announcement = announcementOf(project);
    if (!announcement.iso) uncertainFields.add('announcementDate');

    const methodEnum = methodV.value ? METHOD_TO_ENUM[methodV.value] ?? null : null;
    const entry = resolvePolicyEntry(catalog, regionV.value, methodEnum);
    const band = entry ? applicableBand(entry, announcement.iso) : null;
    if (!entry) uncertainFields.add('policyEntry');
    else if (!band) uncertainFields.add('policyBand');

    // 明确独立计划：采购计划编号（R-PLAN-01）或链路裁决拆分标记
    const planFacts = uniqueFacts.filter((f) => f.type === 'plan');
    const independentEvidence = [
      ...planFacts.map((f) => f.id),
      ...(project.independentUnits?.flatMap((u) => [u.edgeId, u.adjudicationId]) ?? []),
    ];

    // 公告日来源事实（回查）
    let announcementFactId: string | null = null;
    if (announcement.snapshotId) {
      const dateFact = (factsBySnapshot.get(announcement.snapshotId) ?? [])
        .filter((f) => f.type === 'date' && f.isoDate === announcement.iso)
        .sort((a, b) => a.evidence.start - b.evidence.start)[0];
      announcementFactId = dateFact?.id ?? null;
    }

    features.push({
      projectId: projectUnitId(project),
      projectCode: project.projectCode,
      purchaser,
      category: categoryV,
      title,
      deliveryLocation: deliveryV,
      unit: unitV,
      purchaserLevel: levelV,
      region: regionV,
      method: methodV,
      uncertainFields: [...uncertainFields].sort(),
      announcementDate: announcement.iso,
      announcementFactId,
      policyEntryId: entry?.id ?? null,
      policyBandId: band?.bandId ?? null,
      independentUnit: !!project.independentUnits?.length,
      independentEvidence: [...new Set(independentEvidence)].sort(),
    });
  }

  return features.sort((a, b) => a.projectId.localeCompare(b.projectId));
}
