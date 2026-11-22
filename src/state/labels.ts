/** UI 展示辅助：中文标签、溯源查找、金额与日期格式化 */
import type { Adjudication, Fact, ProcurementStage, RelationEdge, Snapshot, EdgeType, EdgeStatus, FactType } from '../core/types';
import { EXTRACTION_RULES } from '../core/extractor';

export const STAGE_LABELS: Record<ProcurementStage, string> = {
  intention: '采购意向',
  announcement: '采购公告',
  correction: '更正',
  extension: '延期',
  cancellation: '撤销/终止',
  result: '中标/成交结果',
};

export const EDGE_TYPE_LABELS: Record<EdgeType, string> = {
  duplicate: '同件副本',
  stage_chain: '阶段演进',
  suspected_correction: '疑似更正',
  suspected_restart: '疑似重启',
  conflict: '互斥冲突',
};

export const EDGE_STATUS_LABELS: Record<EdgeStatus, string> = {
  pending: '待裁决',
  confirmed: '已确认',
  rejected: '已驳回',
};

export const FACT_TYPE_LABELS: Record<FactType, string> = {
  project_code: '项目编号',
  purchaser: '采购人',
  lot: '标段',
  amount: '金额',
  date: '日期',
  stage: '阶段',
  result: '中标结果',
  title: '标题',
  category: '品类',
  delivery: '交付地点',
  unit: '数量单位',
  purchaser_level: '采购人层级',
  region: '地区',
  method: '采购方式',
  plan: '采购计划编号',
  joint: '联合采购',
};

export function ruleDescription(ruleId: string): string {
  return EXTRACTION_RULES.find((r) => r.id === ruleId)?.description ?? '未知规则';
}

export function formatCny(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function snapshotLabel(snapshots: Snapshot[], id: string): string {
  const s = snapshots.find((x) => x.id === id);
  return s?.sources[0]?.fileName ?? id;
}

export function findFact(facts: Fact[], id: string): Fact | undefined {
  return facts.find((f) => f.id === id);
}

export function findSnapshot(snapshots: Snapshot[], id: string): Snapshot | undefined {
  return snapshots.find((s) => s.id === id);
}

/** 在原文上高亮多个证据区间（区间互不重叠场景） */
export function highlightSpans(raw: string, spans: { start: number; end: number; className: string }[]): { text: string; className?: string }[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: { text: string; className?: string }[] = [];
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    if (span.start > cursor) out.push({ text: raw.slice(cursor, span.start) });
    out.push({ text: raw.slice(span.start, span.end), className: span.className });
    cursor = span.end;
  }
  if (cursor < raw.length) out.push({ text: raw.slice(cursor) });
  return out;
}

export function edgeBadgeClass(type: EdgeType): string {
  return `badge ${type}`;
}

export function fileNameOf(s: Snapshot): string {
  return s.sources.map((x) => x.fileName).join(' / ');
}

export function latestAdjudication(adjs: Adjudication[], edgeId: string): Adjudication | undefined {
  return adjs.filter((a) => a.edgeId === edgeId).sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function edgeOf(edges: RelationEdge[], id: string) {
  return edges.find((e) => e.id === id);
}
