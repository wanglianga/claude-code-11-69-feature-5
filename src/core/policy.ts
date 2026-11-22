/**
 * 政策目录：保存不同地区、采购方式、生效期间的金额门槛、允许合并时间窗与引用依据。
 *
 * 硬规则：
 *  - 门槛按项目公告日选择适用版本，绝不用“当前门槛”重判历史项目；
 *  - 每个区间显式记录引用依据（文件号/条款摘要），供案件视图回查；
 *  - 未知地区/方式不臆造门槛：返回 null 并在案件视图中标记为不确定。
 *
 * 纯函数、确定性：相同输入返回相同结果。
 */
import type { PolicyBand, PolicyCatalog, PolicyEntry, ProcurementMethod } from './types';

export const POLICY_VERSION = 'policy-2024.1';

/** 政策区间 id：entryId#bandIndex */
export function policyBandId(entryId: string, bandIndex: number): string {
  return `${entryId}#${bandIndex}`;
}

export function parseBandId(id: string): { entryId: string; bandIndex: number } | null {
  const idx = id.lastIndexOf('#');
  if (idx <= 0) return null;
  const bandIndex = Number(id.slice(idx + 1));
  if (!Number.isInteger(bandIndex) || bandIndex < 0) return null;
  return { entryId: id.slice(0, idx), bandIndex };
}

function isoInBand(iso: string, band: PolicyBand): boolean {
  if (band.effectiveFrom && iso < band.effectiveFrom) return false;
  if (band.effectiveTo && iso > band.effectiveTo) return false;
  return true;
}

/** 选择公告日适用的政策区间；无公告日或不在任何区间内时返回 null */
export function applicableBand(entry: PolicyEntry, announcementDate: string | null): { band: PolicyBand; bandId: string } | null {
  if (!announcementDate) return null;
  for (let i = 0; i < entry.bands.length; i++) {
    if (isoInBand(announcementDate, entry.bands[i])) {
      return { band: entry.bands[i], bandId: policyBandId(entry.id, i) };
    }
  }
  return null;
}

export function findPolicyEntry(catalog: PolicyCatalog, entryId: string): PolicyEntry | undefined {
  return catalog.entries.find((e) => e.id === entryId);
}

export function findPolicyBand(catalog: PolicyCatalog, bandId: string): { entry: PolicyEntry; band: PolicyBand; bandIndex: number } | null {
  const parsed = parseBandId(bandId);
  if (!parsed) return null;
  const entry = findPolicyEntry(catalog, parsed.entryId);
  if (!entry) return null;
  const band = entry.bands[parsed.bandIndex];
  if (!band) return null;
  return { entry, band, bandIndex: parsed.bandIndex };
}

/** 地区 + 采购方式 → 政策条目（未匹配返回 null，由调用方标记不确定） */
export function resolvePolicyEntry(catalog: PolicyCatalog, region: string | null, method: ProcurementMethod | null): PolicyEntry | null {
  if (!region || !method) return null;
  return catalog.entries.find((e) => e.region === region && e.method === method) ?? null;
}

/**
 * 示例政策目录（虚构，仅用于演示与测试）。
 *
 * 设计要点：
 *  - 浙江 2024-01-01 起公开招标门槛由 110 万上调至 130 万，制造“采购期间调整”场景；
 *  - 同一地区/方式有多条区间时按公告日选择，历史项目沿用旧门槛。
 */
export const DEFAULT_POLICY_CATALOG: PolicyCatalog = {
  version: POLICY_VERSION,
  entries: [
    {
      id: 'ZJ-OPEN',
      version: POLICY_VERSION,
      region: '浙江',
      method: 'open_tender',
      methodLabel: '公开招标',
      bands: [
        {
          effectiveFrom: null,
          effectiveTo: '2023-12-31',
          thresholdCny: 1_100_000,
          mergeWindowDays: 180,
          citation: '浙财采〔2022〕18号 第12条：公开招标数额标准 110 万元（虚构示例）',
        },
        {
          effectiveFrom: '2024-01-01',
          effectiveTo: null,
          thresholdCny: 1_300_000,
          mergeWindowDays: 180,
          citation: '浙财采〔2023〕27号 第9条：自 2024-01-01 起公开招标数额标准调整为 130 万元（虚构示例）',
        },
      ],
    },
    {
      id: 'AH-OPEN',
      version: POLICY_VERSION,
      region: '安徽',
      method: 'open_tender',
      methodLabel: '公开招标',
      bands: [
        {
          effectiveFrom: null,
          effectiveTo: null,
          thresholdCny: 1_000_000,
          mergeWindowDays: 120,
          citation: '皖财购〔2023〕6号：公开招标数额标准 100 万元（虚构示例）',
        },
      ],
    },
    {
      id: 'SC-OPEN',
      version: POLICY_VERSION,
      region: '四川',
      method: 'open_tender',
      methodLabel: '公开招标',
      bands: [
        {
          effectiveFrom: null,
          effectiveTo: null,
          thresholdCny: 1_500_000,
          mergeWindowDays: 180,
          citation: '川财采〔2023〕21号：公开招标数额标准 150 万元（虚构示例）',
        },
      ],
      uncertainties: ['省级标准已明确，市县级细则不在本地样例范围内'],
    },
    {
      id: 'JS-OPEN',
      version: POLICY_VERSION,
      region: '江苏',
      method: 'open_tender',
      methodLabel: '公开招标',
      bands: [
        {
          effectiveFrom: null,
          effectiveTo: null,
          thresholdCny: 1_200_000,
          mergeWindowDays: 150,
          citation: '苏财购〔2023〕11号：公开招标数额标准 120 万元（虚构示例）',
        },
      ],
    },
  ],
};

export function cloneCatalog(catalog: PolicyCatalog): PolicyCatalog {
  return JSON.parse(JSON.stringify(catalog)) as PolicyCatalog;
}
