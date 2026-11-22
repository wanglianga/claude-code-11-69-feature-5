/**
 * 全局领域类型定义。
 * 所有持久化对象均带版本字段，结构解析器/提取器升级时可区分解析版本。
 */

// ---------- 计算模式 ----------
export type ComputeMode = 'full' | 'incremental';

// ---------- 文档结构 ----------
export type SectionKind =
  | 'announcement' // 公告正文
  | 'attachment' // 附件摘要
  | 'noise'; // 站点噪声（导航、页脚、版权、广告等）

export interface TextSpan {
  /** 相对原文的字符偏移（基于规范化前原文） */
  start: number;
  end: number;
  /** 片段原文，可直接在界面高亮定位 */
  text: string;
}

export interface StructuredSection {
  kind: SectionKind;
  heading: string;
  span: TextSpan;
}

export interface StructuredDocument {
  parserVersion: string;
  /** 去掉站点噪声后、用于事实提取的正文纯文本 */
  bodyText: string;
  sections: StructuredSection[];
  noiseSpans: TextSpan[];
  /** 原始文件名中的扩展名/来源线索 */
  sourceKind: 'webpage' | 'print' | 'copytext' | 'attachment';
}

// ---------- 快照仓 ----------
export interface FileSource {
  /** 导入时的文件名 */
  fileName: string;
  /** 导入批次 id */
  batchId: string;
  /** 导入时间戳（由调用方传入，保证可复跑） */
  importedAt: number;
  /** 文件大小（字节） */
  size: number;
  /** 可选的来源 URL（网页归档） */
  originUrl?: string;
}

export interface Snapshot {
  id: string;
  /** 内容指纹 SHA-256（十六进制），相同内容不同文件名合并的依据 */
  contentHash: string;
  /** 规范化文本哈希，用于识别空白/排版差异导致的“同件副本” */
  normalizedHash: string;
  /** 原始文本内容 */
  rawText: string;
  /** 合并保存的全部来源记录（同一内容可有多条来源） */
  sources: FileSource[];
  /** 解析结果（首次导入时生成并冻结） */
  parsed: StructuredDocument;
  createdAt: number;
}

export interface ImportBatch {
  id: string;
  label: string;
  createdAt: number;
  /** 本批尝试导入的文件数 */
  inputCount: number;
  /** 新建快照数 */
  newSnapshotCount: number;
  /** 因内容指纹相同而合并来源的文件数 */
  mergedCount: number;
  /** 启动时快照冻结后到达、被推迟到后续批次的文件数 */
  deferredCount: number;
  snapshotIds: string[];
}

// ---------- 事实提取 ----------
export type FactType =
  | 'project_code'
  | 'purchaser'
  | 'lot'
  | 'amount'
  | 'date'
  | 'stage'
  | 'result'
  // 以下为“疑似拆分采购组合分析”的需求特征事实
  | 'title' // 项目/标段标题
  | 'category' // 品类
  | 'delivery' // 交付/实施地点
  | 'unit' // 数量单位
  | 'purchaser_level' // 采购人层级（省级/市级/区县级）
  | 'region' // 地区（用于匹配政策目录）
  | 'method' // 采购方式
  | 'plan' // 采购计划编号（明确独立计划）
  | 'joint'; // 联合采购标记（跨部门联合采购）

export type ProcurementStage =
  | 'intention' // 意向
  | 'announcement' // 招标/采购公告
  | 'correction' // 更正
  | 'extension' // 延期
  | 'cancellation' // 撤销
  | 'result'; // 中标/成交结果

export interface ExtractionRule {
  id: string;
  ruleVersion: string;
  /** 规则可读描述，发布字段回溯用 */
  description: string;
}

export interface Fact {
  id: string;
  snapshotId: string;
  sectionKind: SectionKind;
  type: FactType;
  /** 规范化值（编号去空格、金额统一为元数值等） */
  value: string;
  /** 金额事实的数值（单位：元），其余类型为 undefined */
  amountCny?: number;
  /** 标段事实携带的标段号 */
  lotCode?: string;
  /** 日期事实携带的 ISO 日期 */
  isoDate?: string;
  /** 阶段事实携带的阶段枚举 */
  stage?: ProcurementStage;
  /** 结果事实携带的中标人 */
  winner?: string;
  evidence: TextSpan;
  /** 由哪条提取规则产生 */
  ruleId: string;
  ruleVersion: string;
  extractorVersion: string;
}

// ---------- 关系求值 ----------
export type EdgeType =
  | 'duplicate' // 同件副本
  | 'stage_chain' // 同一项目阶段演进
  | 'suspected_correction' // 疑似更正
  | 'suspected_restart' // 疑似重启
  | 'conflict'; // 互斥冲突（只能待裁决，禁止自动合并）

export type EdgeStatus = 'pending' | 'confirmed' | 'rejected';

export interface RelationEdge {
  id: string;
  type: EdgeType;
  status: EdgeStatus;
  fromSnapshotId: string;
  toSnapshotId: string;
  /** 求值器给出的可读理由（命中了哪些事实/指纹） */
  reasons: string[];
  /** 共享/冲突的事实键，便于人工复核 */
  evidenceFactIds: string[];
  /** 求值器版本与输入快照水位，保证可复算 */
  evaluatorVersion: string;
  /** 参与计算的全部快照 id（固定快照集） */
  inputSnapshotIds: string[];
  createdAt: number;
}

// ---------- 裁决 ----------
export interface Adjudication {
  id: string;
  edgeId: string;
  decision: 'confirm' | 'reject' | 'split';
  /** 审核结论说明 */
  note: string;
  /** 审核员（本地工作台默认 default-reviewer） */
  reviewer: string;
  /** 裁决适用的证据（事实 id 列表） */
  appliedFactIds: string[];
  createdAt: number;
  /** 被本裁决撤回的旧裁决 id（重新裁决时） */
  supersedesAdjudicationId?: string;
}

export interface WithdrawnEdgeRecord {
  edgeId: string;
  reason: string;
  adjudicationId: string;
  withdrawnAt: number;
}

// ---------- 发布 ----------
export interface PublishedLot {
  lotCode: string;
  lotName: string;
  budgetCny: number | null;
  winner: string | null;
  /** 每个字段都能回溯到事实 → 快照 */
  fieldProvenance: Record<string, { factId: string; snapshotId: string }>;
}

export interface PublishedProject {
  projectCode: string;
  purchaser: string;
  /** 项目链：按日期排序的阶段快照序列 */
  stageChain: { stage: ProcurementStage; snapshotId: string; isoDate: string | null }[];
  lots: PublishedLot[];
  /** 当前适用预算（元），取最新已确认阶段证据 */
  currentBudgetCny: number | null;
  /** 预算变动轨迹（含被更正覆盖的历史值及其依据） */
 BudgetHistory: { amountCny: number; snapshotId: string; isoDate: string | null; ruleId: string }[];
  /** 项目分组合法性依据：确认边与裁决 id */
  supportingEdgeIds: string[];
  supportingAdjudicationIds: string[];
  /** 组内被驳回/拆分的冲突边，留痕说明为何没有自动合并 */
  conflictEdgeIds: string[];
  fieldProvenance: Record<string, { factId: string; snapshotId: string }>;
  /**
   * 链内共享同一编号但被裁决拆分为独立标段的独立单元。
   * 拆分采购分析据此把“明确独立计划”的采购单元排除出候选组合。
   */
  independentUnits?: { edgeId: string; adjudicationId: string; lotSets: string[][] }[];
}

export interface PublicationStats {
  projectCount: number;
  lotCount: number;
  totalBudgetCny: number;
  resultCount: number;
  /** 按省份/采购人维度的简单统计 */
  byPurchaser: Record<string, { projects: number; budgetCny: number }>;
}

export interface Publication {
  id: string;
  version: number;
  createdAt: number;
  /** 发布时的裁决水位（裁决 id 排序集） */
  adjudicationWatermark: string[];
  /** 参与计算的快照水位 */
  snapshotWatermark: string[];
  computeMode: ComputeMode;
  /** 全量：null；增量：实际重算的连通分量 id 与跳过分量数 */
  computeScope: {
    recomputedComponents: string[];
    skippedComponents: number;
    dependencyHash: string;
  };
  evaluatorVersion: string;
  extractorVersion: string;
  parserVersion: string;
  projects: PublishedProject[];
  stats: PublicationStats;
  /** 疑似拆分采购组合分析（发布时同一水位计算，供案件视图与历史回放） */
  splitAnalysis?: SplitAnalysis;
}

// ---------- 疑似拆分采购组合分析 ----------
/**
 * 说明：本模块只产出“待人工核查的候选组合”，不下任何违法结论。
 * 每次分析都记录政策版本、规则版本与项目公告日适用的政策区间。
 */

export type ProcurementMethod =
  | 'open_tender' // 公开招标
  | 'invited' // 邀请招标
  | 'competitive_negotiation' // 竞争性磋商/谈判
  | 'inquiry' // 询价
  | 'single_source'; // 单一来源

export interface PolicyBand {
  /** 生效起止（ISO 日期，含端点）；null 表示无下/上界 */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** 该期间的金额门槛（元）：合计金额达到该值即达到须合并/招标的参考值 */
  thresholdCny: number;
  /** 允许合并的统计时间窗（天） */
  mergeWindowDays: number;
  /** 政策引用依据（文件号/条款摘要） */
  citation: string;
}

export interface PolicyEntry {
  id: string;
  version: string;
  region: string;
  method: ProcurementMethod;
  methodLabel: string;
  bands: PolicyBand[];
  /** 该政策条目自身声明的不确定点（如“本地区未公布细则，取省级参考”） */
  uncertainties?: string[];
}

export interface PolicyCatalog {
  version: string;
  entries: PolicyEntry[];
}

/** 从标段标题、品类、交付地点、数量单位、采购人层级形成的可回查相似性特征 */
export interface DemandFeature {
  projectId: string;
  /** 采购单元（项目链）在发布中的编号 */
  projectCode: string;
  /** 采购人（规范化）与其来源事实，用于分组 */
  purchaser: FeatureValue;
  /** 特征值（规范化后）与其证据，便于回查原文 */
  category: FeatureValue;
  title: FeatureValue;
  deliveryLocation: FeatureValue;
  unit: FeatureValue;
  purchaserLevel: FeatureValue;
  /** 政策解析所需的地区与采购方式（同样带证据） */
  region: FeatureValue;
  method: FeatureValue;
  /** 特征整体不确定字段（如缺标题/缺单位） */
  uncertainFields: string[];
  /** 可核对的项目公告日（ISO） */
  announcementDate: string | null;
  /** 公告日来源事实（可回查） */
  announcementFactId: string | null;
  /** 该项目适用的政策条目 id 与区间 id（无公告日/地区时为空） */
  policyEntryId: string | null;
  policyBandId: string | null;
  /** 是否被裁决标记为独立计划/独立标段 */
  independentUnit: boolean;
  /** 独立计划依据（裁决 id） */
  independentEvidence: string[];
}

export interface FeatureValue {
  /** 规范化特征值；null 表示证据缺失 */
  value: string | null;
  /** 来源事实 id（项目事实或需求特征事实，可回查） */
  factId: string | null;
  snapshotId: string | null;
  /** 证据在原文中的字符区间（回查原文用） */
  span?: { start: number; end: number; text: string };
  /** 产生该特征值的规则 id */
  ruleId?: string;
}

export type FeatureKey =
  | 'category'
  | 'title'
  | 'deliveryLocation'
  | 'unit'
  | 'purchaserLevel'
  | 'region'
  | 'method';

export interface FeatureOverlap {
  key: FeatureKey;
  /** 两项目该特征是否一致（缺失时不计一致） */
  matched: boolean;
  /** 是否因证据缺失而被视为不确定 */
  uncertain: boolean;
  valueA: string | null;
  valueB: string | null;
}

export interface SplitEvidenceRef {
  projectCode: string;
  snapshotId: string;
  factId: string | null;
  kind: 'support' | 'rebut';
  text: string;
  ruleId?: string;
}

export interface SplitCandidate {
  id: string;
  /** 组内项目编号（发布项目链） */
  projectCodes: string[];
  /** 组内项目的可读标签（编号 + 标段，解决同编号多标段重名） */
  projectLabels: string[];
  /** 组内项目 id（与 features.projectId 一致） */
  projectIds: string[];
  /** 合计金额（元） */
  totalAmountCny: number;
  /** 时间跨度（天）：最早与最晚公告日之差 */
  timeSpanDays: number;
  /** 特征重叠：哪些特征一致/不确定 */
  featureOverlap: FeatureOverlap[];
  /** 一致特征数（用于证据强度排序） */
  overlapScore: number;
  /** 不确定字段 */
  uncertainFields: string[];
  /** 支持证据 */
  supportingEvidence: SplitEvidenceRef[];
  /** 反驳证据 */
  rebuttingEvidence: SplitEvidenceRef[];
  /** 每项金额来源（事实 id / 快照 / 公告日） */
  amountSources: { projectCode: string; amountCny: number; factId: string; snapshotId: string; isoDate: string | null }[];
  /** 适用的政策区间 id（entryId#bandIndex）与规则版本 */
  policyBandId: string;
  ruleVersion: string;
  /** 替代分组：同一组合其他可解释的分段方式 */
  alternativeGroupings: SplitAlternative[];
  /** 是否为代表组合（按证据强度互不重叠）；否则为“保留的相连候选” */
  isRepresentative: boolean;
  /** 与代表组合共享的项目（重叠说明） */
  overlapsWithRepresentative?: string[];
}

export interface SplitAlternative {
  label: string;
  projectCodes: string[];
  /** 该替代解释为何同样成立或需比较 */
  rationale: string;
}

export type ExclusionReason =
  | 'independent_plan' // 已有明确独立计划
  | 'different_entity' // 不同采购主体（跨部门联合采购等）
  | 'incomparable_category' // 无法比较品类
  | 'outside_window' // 超出允许合并时间窗
  | 'below_threshold' // 合计未达到门槛
  | 'policy_band_mismatch'; // 项目公告日不落在同一适用政策区间

export interface ExcludedGroup {
  projectCodes: string[];
  reason: ExclusionReason;
  detail: string;
  /** 依据的裁决 id / 证据事实 id */
  evidenceFactIds: string[];
}

export interface SplitCaseVersion {
  version: number;
  reason: string;
  createdAt: number;
  status: 'active' | 'invalidated';
  candidateIds: string[];
  /** 该版本所依赖的项目单元指纹（裁决拆分后变化 → 新版本并失效旧组合） */
  fingerprint: string;
}

export interface SplitCase {
  id: string;
  /** 案件标题（以采购人 + 品类 + 区间构成） */
  title: string;
  /** 政策条目与区间 */
  policyEntryId: string;
  policyBandId: string;
  policyVersion: string;
  /** 政策引用依据 */
  citation: string;
  /** 门槛（元）与时间窗（天） */
  thresholdCny: number;
  mergeWindowDays: number;
  publishers: string[];
  /** 状态：pending_review 只是“待核”，绝不表示违规 */
  status: 'pending_review' | 'invalidated';
  /** 当前版本依赖的项目单元指纹 */
  fingerprint: string;
  /** 代表组合（按证据强度选择，互不重叠） */
  representatives: SplitCandidate[];
  /** 全部相连候选（保留更多解释） */
  candidates: SplitCandidate[];
  /** 重叠汇总：同一项目在多组候选中出现时，不得重复累计金额 */
  overlap: { projectId: string; projectCode: string; candidateIds: string[] }[];
  /** 去重后的合计金额（代表组合之间不重复计同一项目） */
  representativeTotalCny: number;
  /** 保留全部候选时的“金额被重复展示”量（供审计比较） */
  connectedCandidateSumCny: number;
  /** 未被任何代表组合覆盖的项目（capacity 模式下留在未分组范围/次优解释） */
  ungroupedProjectCodes: string[];
  /** 版本历史（链路裁决更正后生成新版本，旧版本标记 invalidated） */
  versions: SplitCaseVersion[];
  /** 说明：只供审计排查，不下违法结论 */
  disclaimer: string;
}

export type CaseSelectionMode = 'recall' | 'capacity';

export interface SplitAnalysis {
  id: string;
  version: number;
  createdAt: number;
  ruleVersion: string;
  policyVersion: string;
  selectionMode: CaseSelectionMode;
  /** 参与分析的项目数 */
  analyzedProjects: number;
  /** 每个项目的特征 */
  features: DemandFeature[];
  cases: SplitCase[];
  /** 被约束求值器排除的组（含理由，供复核） */
  excluded: ExcludedGroup[];
  /** 不确定性汇总 */
  uncertainties: string[];
  /** 历史案件回放：按版本顺序记录每轮案件 id 与状态 */
  history: { version: number; createdAt: number; caseIds: string[]; invalidatedCaseIds: string[] }[];
}

// ---------- 运行状态 ----------
export interface PipelineProgress {
  phase: 'idle' | 'parsing' | 'extracting' | 'evaluating' | 'publishing';
  current: number;
  total: number;
  message: string;
}
