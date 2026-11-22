/**
 * 事实提取器：基于规则从结构化文档中抽取
 * 编号、采购人、标段、金额、日期、阶段、结果七类事实，
 * 每条事实携带原文字符级证据与提取规则标识。
 *
 * 纯函数、确定性输出；规则版本随提取器升级而变化。
 */
import type { Fact, Snapshot, StructuredSection, ExtractionRule, ProcurementStage, FactType } from './types';
import { deterministicId } from './hash';

export const EXTRACTOR_VERSION = 'extractor-1.0.0';

export const EXTRACTION_RULES: ExtractionRule[] = [
  { id: 'R-CODE-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配“项目编号/采购编号/招标编号”等标签后的编号' },
  { id: 'R-CODE-02', ruleVersion: EXTRACTOR_VERSION, description: '匹配无标签但形如 ZC2024-017 的编号串（兜底）' },
  { id: 'R-PUR-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配“采购人/招标人/采购单位”标签后的机构名称' },
  { id: 'R-LOT-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配“第X标段/标包/包件/包”形式的标段' },
  { id: 'R-LOT-02', ruleVersion: EXTRACTOR_VERSION, description: '匹配“包件01”形式的数字包件' },
  { id: 'R-AMT-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配预算/限价/中标金额并统一换算为人民币元' },
  { id: 'R-DATE-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配 YYYY年M月D日 中文日期' },
  { id: 'R-DATE-02', ruleVersion: EXTRACTOR_VERSION, description: '匹配 YYYY-MM-DD ISO 日期' },
  { id: 'R-STAGE-01', ruleVersion: EXTRACTOR_VERSION, description: '依据标题关键词判定采购意向阶段' },
  { id: 'R-STAGE-02', ruleVersion: EXTRACTOR_VERSION, description: '依据标题关键词判定更正阶段' },
  { id: 'R-STAGE-03', ruleVersion: EXTRACTOR_VERSION, description: '依据标题关键词判定延期阶段' },
  { id: 'R-STAGE-04', ruleVersion: EXTRACTOR_VERSION, description: '依据标题关键词判定撤销/终止阶段' },
  { id: 'R-STAGE-05', ruleVersion: EXTRACTOR_VERSION, description: '依据标题关键词判定中标/成交结果阶段' },
  { id: 'R-STAGE-06', ruleVersion: EXTRACTOR_VERSION, description: '依据标题关键词判定招标/采购公告阶段（兜底）' },
  { id: 'R-RESULT-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配中标/成交供应商名称' },
  // ---- 疑似拆分采购组合分析：需求特征事实 ----
  { id: 'R-TITLE-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配“项目名称/项目标题”标签后的标题，用于标段标题相似性特征' },
  { id: 'R-CAT-01', ruleVersion: EXTRACTOR_VERSION, description: '依据品类关键词（智慧教室、网络改造、政务云等）形成品类特征并记录关键词原文' },
  { id: 'R-DEL-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配“交付/实施/供货地点”标签后的地点，形成交付地点特征' },
  { id: 'R-UNIT-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配“数量：N 台/套/…”中的数量单位，形成数量单位特征' },
  { id: 'R-LEVEL-01', ruleVersion: EXTRACTOR_VERSION, description: '依据采购人名称中的省/市/区县/厅/局等词推断采购人层级' },
  { id: 'R-REGION-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配正文中的省级行政区名称，用于选择适用政策目录' },
  { id: 'R-METHOD-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配“采购方式”后的公开招标/询价等，用于选择适用政策条目' },
  { id: 'R-PLAN-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配“采购计划编号/计划号”，作为“已有明确独立计划”的证据' },
  { id: 'R-JOINT-01', ruleVersion: EXTRACTOR_VERSION, description: '匹配“联合采购/联合体采购/共同采购”标记，作为跨部门联合采购的反驳证据' },
];

const STAGE_KEYWORDS: { stage: ProcurementStage; ruleId: string; patterns: RegExp[] }[] = [
  { stage: 'intention', ruleId: 'R-STAGE-01', patterns: [/采购意向|意向公开|意向公告/] },
  { stage: 'correction', ruleId: 'R-STAGE-02', patterns: [/更正公告|澄清(?:公告|修改)|修改公告|变更公告/] },
  { stage: 'extension', ruleId: 'R-STAGE-03', patterns: [/延期公告|延长(?:投标|响应|报名|递交).*截止|投标截止.*顺延|时间调整/] },
  { stage: 'cancellation', ruleId: 'R-STAGE-04', patterns: [/撤销公告|终止公告|废标公告|采购终止|项目撤销/] },
  { stage: 'result', ruleId: 'R-STAGE-05', patterns: [/中标公告|成交公告|结果公告|中标结果|成交结果/] },
  { stage: 'announcement', ruleId: 'R-STAGE-06', patterns: [/招标公告|竞争性(?:磋商|谈判|谈判)公告|采购公告|公开招标|询价公告|单一来源/] },
];

/**
 * 阶段优先级：与 STAGE_KEYWORDS 命中顺序一致。
 * 一个快照可能同时含多个阶段关键词（如终止公告引用原招标公告），
 * 统一以优先级最小者为准，避免事实数组存储顺序（IndexedDB 按主键返回）影响结论。
 */
export const STAGE_PRIORITY: Record<ProcurementStage, number> = {
  intention: 0,
  correction: 1,
  extension: 2,
  cancellation: 3,
  result: 4,
  announcement: 5,
};

export function primaryStage(stages: ProcurementStage[]): ProcurementStage | null {
  if (stages.length === 0) return null;
  return [...stages].sort((a, b) => STAGE_PRIORITY[a] - STAGE_PRIORITY[b])[0];
}

/** 品类关键词 → 规范品类（用于需求相似性特征；命中位置即证据） */
export const CATEGORY_KEYWORDS: [string, string][] = [
  ['智慧教室', '智慧教室设备'],
  ['网络改造', '网络改造工程'],
  ['政务云', '政务云资源'],
  ['应急物资', '应急物资'],
  ['库房', '仓储设施'],
  ['货架', '仓储设施'],
  ['办公家具', '办公家具'],
  ['打印机', '办公设备'],
  ['服务器', '信息化设备'],
  ['系统集成', '系统集成'],
  ['空调', '空调设备'],
  ['电梯', '电梯设备'],
];

/** 省级行政区（用于匹配政策目录；示例目录只覆盖浙江/安徽/四川/江苏） */
export const REGION_NAMES = ['浙江', '安徽', '四川', '江苏', '上海', '广东', '山东'];

/** 由采购人机构名称推断层级（越具体的层级优先） */
export function inferPurchaserLevel(name: string): string | null {
  if (/(?:省|自治区|直辖市)/.test(name)) return '省级';
  if (/(?:区|县)/.test(name)) return '区县级';
  if (/(?:市)(?!场)/.test(name)) return '市级';
  if (/(?:镇|街道|乡)/.test(name)) return '乡镇级';
  return null;
}

interface Match {
  value: string;
  localStart: number;
  localEnd: number;
  matchedText: string;
  ruleId: string;
  extra?: Partial<Fact>;
}

function toIso(y: string, m: string, d: string): string {
  return `${y}-${Number(m).toString().padStart(2, '0')}-${Number(d).toString().padStart(2, '0')}`;
}

function parseAmount(num: string, unit: string | undefined): number {
  const normalized = num.replace(/[,，]/g, '');
  const value = Number.parseFloat(normalized);
  if (unit === '万元' || unit === '万') return Math.round(value * 10000 * 100) / 100;
  return value;
}

/** 在单个 section 文本上运行全部正则规则 */
function collectMatches(section: StructuredSection): Match[] {
  const text = section.span.text;
  const out: Match[] = [];
  const push = (m: RegExpMatchArray, ruleId: string, value: string, extra?: Partial<Fact>) => {
    const localStart = m.index ?? 0;
    out.push({
      value,
      localStart,
      localEnd: localStart + m[0].length,
      matchedText: m[0],
      ruleId,
      extra,
    });
  };

  // 编号（带标签）
  const labeledCode = /(?:项目编号|采购编号|招标编号|项目编码|标段编号)[：:]\s*([A-Za-z0-9][A-Za-z0-9\-_/（）()]*[A-Za-z0-9])/g;
  const labeledRanges: [number, number][] = [];
  for (const m of text.matchAll(labeledCode)) {
    labeledRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    push(m, 'R-CODE-01', m[1].replace(/[（）()]/g, '').trim());
  }
  // 编号（兜底）：消费完整的多段连字符编号，且不与带标签命中重叠
  const bareCode = /\b[A-Z]{2,}\d{4}[-–][A-Za-z0-9]+(?:[-–][A-Za-z0-9]+)*/g;
  for (const m of text.matchAll(bareCode)) {
    const start = m.index ?? 0;
    const insideLabeled = labeledRanges.some(([s, e]) => start >= s && start + m[0].length <= e);
    if (!insideLabeled) push(m, 'R-CODE-02', m[0]);
  }
  // 采购人
  const purchaser = /(?:采购人|招标人|采购单位|招标人名称)(?:[（(]名称[）)])?(?:名称)?[：:]\s*([^\n，,。；;]{2,40}?(?:公司|中心|局|院|校|厅|办公室|管委会|政府|大学|医院|站|所|集团|联合会))/g;
  for (const m of text.matchAll(purchaser)) {
    push(m, 'R-PUR-01', m[1].trim());
  }
  // 标段（中文序号）
  const lotCn = /(第[一二三四五六七八九十百0-9]+(?:标段|标包|包件|包))(?:[：:]\s*|[\s，,]+)?([^\n，,。；;]{0,40})?/g;
  for (const m of text.matchAll(lotCn)) {
    const name = (m[2] ?? '').trim();
    push(m, 'R-LOT-01', name || m[1], { lotCode: m[1] });
  }
  // 包件（数字）
  const lotNum = /(包件\s*[0-9A-Za-z]+)[：:\s]+([^\n，,。；;]{0,40})?/g;
  for (const m of text.matchAll(lotNum)) {
    const code = m[1].replace(/\s+/g, '');
    push(m, 'R-LOT-02', (m[2] ?? '').trim() || code, { lotCode: code });
  }
  // 金额
  const amount = /(预算金额|最高限价|采购预算|预算价|中标金额|成交金额|合同金额)[（(]?[人民币万元元]*[）)]?[：:]?\s*([0-9][0-9,，.]*)\s*(万元|万|元)?/g;
  for (const m of text.matchAll(amount)) {
    const cny = parseAmount(m[2], m[3]);
    if (Number.isFinite(cny) && cny > 0) {
      push(m, 'R-AMT-01', `${m[1]}:${cny}元`, { amountCny: cny });
    }
  }
  // 中文日期
  const dateCn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  for (const m of text.matchAll(dateCn)) {
    push(m, 'R-DATE-01', m[0], { isoDate: toIso(m[1], m[2], m[3]) });
  }
  // ISO 日期
  const dateIso = /\d{4}-\d{2}-\d{2}/g;
  for (const m of text.matchAll(dateIso)) {
    push(m, 'R-DATE-02', m[0], { isoDate: m[0] });
  }
  // 结果：中标/成交供应商
  const winner = /(?:中标(?:供应商|人|单位|公司)|成交(?:供应商|人|单位|公司))(?:名称)?[：:]\s*([^\n，,。；;]{2,40})/g;
  for (const m of text.matchAll(winner)) {
    push(m, 'R-RESULT-01', m[1].trim(), { winner: m[1].trim() });
  }

  // ---- 需求特征事实（疑似拆分采购组合分析） ----
  // 标题：项目名称 / 项目标题 / 采购项目名称
  const title = /(?:项目名称|项目标题|采购项目名称)[：:]\s*([^\n]{2,80})/g;
  for (const m of text.matchAll(title)) {
    push(m, 'R-TITLE-01', m[1].trim());
  }
  // 品类：依据关键词命中，价值观范围为关键词本身（可回查）
  for (const [keyword, canonical] of CATEGORY_KEYWORDS) {
    const idx = text.indexOf(keyword);
    if (idx >= 0) {
      out.push({
        value: canonical,
        localStart: idx,
        localEnd: idx + keyword.length,
        matchedText: keyword,
        ruleId: 'R-CAT-01',
      });
    }
  }
  // 交付/实施地点
  const delivery = /(?:交付|实施|供货|施工|服务)地点[：:]\s*([^\n，,。；;]{2,40})/g;
  for (const m of text.matchAll(delivery)) {
    push(m, 'R-DEL-01', m[1].trim());
  }
  // 数量单位
  const unit = /数量[（(]?[^：:）)]*[）)]?[：:]?\s*([0-9]+)\s*(台|套|个|批|件|项|间|台套|千米|公里|平方米|㎡)/g;
  for (const m of text.matchAll(unit)) {
    push(m, 'R-UNIT-01', m[2]);
  }
  // 采购人层级：由采购人标签后的机构名称推断
  for (const m of text.matchAll(purchaser)) {
    const level = inferPurchaserLevel(m[1].trim());
    if (level) {
      out.push({
        value: level,
        localStart: m.index ?? 0,
        localEnd: (m.index ?? 0) + m[0].length,
        matchedText: m[0],
        ruleId: 'R-LEVEL-01',
      });
    }
  }
  // 地区：优先“所属地区/所属省份”标签，其次正文中的省级行政区名称
  const regionLabeled = /(?:所属地区|所属省份|地区)[：:]\s*([^\n，,。；;]{2,20})/g;
  const regionLabeledRanges: [number, number][] = [];
  for (const m of text.matchAll(regionLabeled)) {
    const idx = m.index ?? 0;
    regionLabeledRanges.push([idx, idx + m[0].length]);
    const name = REGION_NAMES.find((r) => m[1].includes(r));
    if (name) {
      out.push({
        value: name,
        localStart: idx,
        localEnd: idx + m[0].length,
        matchedText: m[0],
        ruleId: 'R-REGION-01',
      });
    }
  }
  for (const regionName of REGION_NAMES) {
    const idx = text.indexOf(regionName);
    if (idx < 0) continue;
    if (regionLabeledRanges.some(([s, e]) => idx >= s && idx < e)) continue;
    out.push({
      value: regionName,
      localStart: idx,
      localEnd: idx + regionName.length,
      matchedText: regionName,
      ruleId: 'R-REGION-01',
    });
  }
  // 采购方式
  const method = /采购方式[：:]\s*(公开招标|邀请招标|竞争性磋商|竞争性谈判|询价|单一来源)/g;
  for (const m of text.matchAll(method)) {
    push(m, 'R-METHOD-01', m[1]);
  }
  // 采购计划编号（明确独立计划）
  const plan = /(?:采购计划编号|采购计划号|计划编号)[：:]\s*([^\n，,。；;]{2,40})/g;
  for (const m of text.matchAll(plan)) {
    push(m, 'R-PLAN-01', m[1].trim());
  }
  // 联合采购标记
  const joint = /(?:联合采购|联合体采购|跨部门联合采购|共同采购)/g;
  for (const m of text.matchAll(joint)) {
    push(m, 'R-JOINT-01', m[0]);
  }

  // 阶段：按优先级取每个 section 的首个命中
  for (const rule of STAGE_KEYWORDS) {
    for (const re of rule.patterns) {
      const m = re.exec(text);
      if (m) {
        push(m, rule.ruleId, rule.stage, { stage: rule.stage });
        break;
      }
    }
  }
  return out;
}

function factTypeFromRule(ruleId: string): FactType {
  if (ruleId.startsWith('R-CODE')) return 'project_code';
  if (ruleId.startsWith('R-PUR')) return 'purchaser';
  if (ruleId.startsWith('R-LOT')) return 'lot';
  if (ruleId.startsWith('R-AMT')) return 'amount';
  if (ruleId.startsWith('R-DATE')) return 'date';
  if (ruleId.startsWith('R-STAGE')) return 'stage';
  if (ruleId.startsWith('R-TITLE')) return 'title';
  if (ruleId.startsWith('R-CAT')) return 'category';
  if (ruleId.startsWith('R-DEL')) return 'delivery';
  if (ruleId.startsWith('R-UNIT')) return 'unit';
  if (ruleId.startsWith('R-LEVEL')) return 'purchaser_level';
  if (ruleId.startsWith('R-REGION')) return 'region';
  if (ruleId.startsWith('R-METHOD')) return 'method';
  if (ruleId.startsWith('R-PLAN')) return 'plan';
  if (ruleId.startsWith('R-JOINT')) return 'joint';
  return 'result';
}

/** 对单个快照执行提取，返回确定性事实列表 */
export function extractFacts(snapshot: Snapshot): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();

  for (const section of snapshot.parsed.sections) {
    if (section.kind === 'noise') continue;
    const matches = collectMatches(section);
    for (const match of matches) {
      const type = factTypeFromRule(match.ruleId);
      const dedupKey = `${type}|${match.value}|${match.extra?.lotCode ?? ''}|${match.extra?.isoDate ?? ''}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const start = section.span.start + match.localStart;
      const end = section.span.start + match.localEnd;
      const fact: Fact = {
        id: deterministicId('fact', [snapshot.id, type, match.value, start]),
        snapshotId: snapshot.id,
        sectionKind: section.kind,
        type,
        value: match.value,
        ruleId: match.ruleId,
        ruleVersion: EXTRACTOR_VERSION,
        extractorVersion: EXTRACTOR_VERSION,
        evidence: {
          start,
          end,
          text: match.matchedText,
        },
        ...match.extra,
      };
      facts.push(fact);
    }
  }
  return facts;
}

export function extractAll(snapshots: Snapshot[]): Fact[] {
  return snapshots.flatMap(extractFacts);
}
