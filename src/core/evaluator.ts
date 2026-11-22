/**
 * 关系求值器：在固定快照集上全量求值候选边。
 *
 * 边类型：
 *  - duplicate             同件副本（规范化哈希一致，自动确认，可被裁决驳回）
 *  - stage_chain           同一项目的阶段演进（待裁决）
 *  - suspected_correction  疑似更正（待裁决，附预算/时限变化线索）
 *  - suspected_restart     疑似重启（撤销后重新公告，待裁决）
 *  - conflict              同编号但标段范围互斥（只能待裁决，禁止自动合并）
 *
 * 纯函数：相同快照水位 + 相同版本 ⇒ 相同候选边集合（id 确定性生成）。
 */
import type { Fact, ProcurementStage, RelationEdge, Snapshot } from './types';
import { deterministicId } from './hash';
import { primaryStage } from './extractor';

export const EVALUATOR_VERSION = 'evaluator-1.0.0';

/** 项目编号规范化：去空白、统一分隔符、大写，吸收“编号写法不一致” */
export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[–—_]/g, '-')
    .replace(/[（）()]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 采购人名称规范化：去空白与常见标点差异 */
export function normalizePurchaser(name: string): string {
  return name.replace(/\s+/g, '').replace(/[（）()]/g, '');
}

interface SnapshotView {
  snapshot: Snapshot;
  facts: Fact[];
  codes: Set<string>;
  purchasers: Set<string>;
  lots: Set<string>;
  amounts: number[];
  stages: ProcurementStage[];
  dates: string[];
  winners: string[];
  planNos: string[];
}

function buildView(snapshot: Snapshot, facts: Fact[]): SnapshotView {
  const mine = facts.filter((f) => f.snapshotId === snapshot.id);
  const view: SnapshotView = {
    snapshot,
    facts: mine,
    codes: new Set(),
    purchasers: new Set(),
    lots: new Set(),
    amounts: [],
    stages: [],
    dates: [],
    winners: [],
    planNos: [],
  };
  for (const f of mine) {
    if (f.type === 'project_code') view.codes.add(normalizeCode(f.value));
    if (f.type === 'purchaser') view.purchasers.add(normalizePurchaser(f.value));
    if (f.type === 'lot' && f.lotCode) view.lots.add(f.lotCode);
    if (f.type === 'amount' && typeof f.amountCny === 'number') view.amounts.push(f.amountCny);
    if (f.type === 'stage' && f.stage) view.stages.push(f.stage);
    if (f.type === 'date' && f.isoDate) view.dates.push(f.isoDate);
    if (f.type === 'result' && f.winner) view.winners.push(f.winner);
    if (f.type === 'plan') view.planNos.push(f.value);
  }
  return view;
}

function factIds(view: SnapshotView, type: Fact['type']): string[] {
  return view.facts.filter((f) => f.type === type).map((f) => f.id);
}

function edgeId(type: RelationEdge['type'], a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return deterministicId('edge', [type, x, y]);
}

function makeEdge(
  type: RelationEdge['type'],
  a: SnapshotView,
  b: SnapshotView,
  reasons: string[],
  evidenceFactIds: string[],
  inputSnapshotIds: string[],
  now: number,
  status: RelationEdge['status'] = 'pending',
): RelationEdge {
  return {
    id: edgeId(type, a.snapshot.id, b.snapshot.id),
    type,
    status,
    fromSnapshotId: a.snapshot.id,
    toSnapshotId: b.snapshot.id,
    reasons,
    evidenceFactIds: [...new Set(evidenceFactIds)],
    evaluatorVersion: EVALUATOR_VERSION,
    inputSnapshotIds: [...inputSnapshotIds].sort(),
    createdAt: now,
  };
}

function isDisjoint<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const v of a) if (b.has(v)) return false;
  return true;
}

function earliestDate(view: SnapshotView): string | null {
  return view.dates.length ? [...view.dates].sort()[0] : null;
}

/**
 * 全量求值。now 由调用方注入（发布复跑时保持确定性）。
 */
export function evaluateRelations(snapshots: Snapshot[], facts: Fact[], now: number): RelationEdge[] {
  const inputSnapshotIds = snapshots.map((s) => s.id);
  const views = snapshots.map((s) => buildView(s, facts));
  const edges: RelationEdge[] = [];

  for (let i = 0; i < views.length; i++) {
    for (let j = i + 1; j < views.length; j++) {
      const a = views[i];
      const b = views[j];

      // 1) 同件副本：规范化哈希一致（内容哈希一致的在快照仓已合并来源）
      if (a.snapshot.normalizedHash === b.snapshot.normalizedHash) {
        edges.push(
          makeEdge(
            'duplicate',
            a,
            b,
            [
              `规范化内容指纹一致（${a.snapshot.normalizedHash.slice(0, 12)}…），判定为同件副本`,
              `来源文件名：${a.snapshot.sources.map((s) => s.fileName).join('、')} ／ ${b.snapshot.sources
                .map((s) => s.fileName)
                .join('、')}`,
            ],
            [...factIds(a, 'project_code'), ...factIds(b, 'project_code')],
            inputSnapshotIds,
            now,
            'confirmed',
          ),
        );
        continue; // 副本之间不再产生项目级关系
      }

      const sharedCodes = [...a.codes].filter((c) => b.codes.has(c));
      const sharedPurchasers = [...a.purchasers].filter((p) => b.purchasers.has(p));

      // 2) 同编号组内关系
      if (sharedCodes.length > 0) {
        const evidence = [
          ...factIds(a, 'project_code'),
          ...factIds(b, 'project_code'),
          ...factIds(a, 'lot'),
          ...factIds(b, 'lot'),
          ...factIds(a, 'amount'),
          ...factIds(b, 'amount'),
          ...factIds(a, 'stage'),
          ...factIds(b, 'stage'),
        ];

        // 2a) 标段范围互斥 ⇒ 冲突边，只能待裁决，禁止自动合并
        if (isDisjoint(a.lots, b.lots)) {
          edges.push(
            makeEdge(
              'conflict',
              a,
              b,
              [
                `项目编号 ${sharedCodes.join('、')} 同时出现，但标段范围互斥：{${[...a.lots].join('、')}} ∩ {${[...b.lots].join('、')}} = ∅`,
                '按规则禁止自动合并，保留待裁决边，由审核员确认是否拆分为不同项目',
              ],
              evidence,
              inputSnapshotIds,
              now,
              'pending',
            ),
          );
          continue;
        }

        const stageA = primaryStage(a.stages) ?? 'announcement';
        const stageB = primaryStage(b.stages) ?? 'announcement';

        // 2b) 撤销后再次公告 ⇒ 疑似重启
        const cancelled = stageA === 'cancellation' || stageB === 'cancellation';
        const reAnnounced =
          stageA === 'announcement' || stageB === 'announcement' || stageA === 'intention' || stageB === 'intention';
        if (cancelled && reAnnounced) {
          edges.push(
            makeEdge(
              'suspected_restart',
              a,
              b,
              [
                `同编号 ${sharedCodes.join('、')} 存在撤销/终止公告与新公告，疑似项目重启`,
                `日期线索：${earliestDate(a) ?? '未知'} → ${earliestDate(b) ?? '未知'}`,
              ],
              evidence,
              inputSnapshotIds,
              now,
            ),
          );
        }

        // 2c) 更正：一方为更正/延期阶段，且金额或时限存在差异
        const correcting = stageA === 'correction' || stageB === 'correction' || stageA === 'extension' || stageB === 'extension';
        const amountChanged =
          a.amounts.length > 0 &&
          b.amounts.length > 0 &&
          Math.max(...a.amounts) !== Math.max(...b.amounts);
        if (correcting && (amountChanged || stageA !== stageB)) {
          const reasons = [
            `同编号 ${sharedCodes.join('、')}，阶段由 ${stageA} 演进为 ${stageB}`,
          ];
          if (amountChanged) {
            reasons.push(
              `预算/限价发生变化：${Math.max(...a.amounts).toLocaleString()}元 → ${Math.max(...b.amounts).toLocaleString()}元，需保留两次取值的证据`,
            );
          } else {
            reasons.push('时间/投标截止等时限条款发生调整，原文可定位');
          }
          edges.push(makeEdge('suspected_correction', a, b, reasons, evidence, inputSnapshotIds, now));
        }

        // 2d) 同一项目阶段链（兜底候选边）
        edges.push(
          makeEdge(
            'stage_chain',
            a,
            b,
            [
              `共享规范化项目编号 ${sharedCodes.join('、')}${sharedPurchasers.length ? `，采购人一致（${sharedPurchasers.length} 个名称规范化后相同）` : ''}`,
              `阶段：${stageA} → ${stageB}；日期线索：${earliestDate(a) ?? '未知'} → ${earliestDate(b) ?? '未知'}`,
            ],
            evidence,
            inputSnapshotIds,
            now,
          ),
        );
        continue;
      }

      // 3) 编号不同但采购人相同、编号根相近 ⇒ 疑似重启（如 ZC2024-017 与 ZC2024-017-2）
      if (sharedPurchasers.length > 0) {
        for (const ca of a.codes) {
          for (const cb of b.codes) {
            if (ca !== cb && (ca.startsWith(`${cb}-`) || cb.startsWith(`${ca}-`))) {
              edges.push(
                makeEdge(
                  'suspected_restart',
                  a,
                  b,
                  [
                    `采购人相同且编号存在前缀派生关系：${ca} → ${cb}，撤销后重新编号的可能性`,
                    '仅为候选边，需人工裁决后才进入项目链',
                  ],
                  [...factIds(a, 'purchaser'), ...factIds(b, 'purchaser'), ...factIds(a, 'project_code'), ...factIds(b, 'project_code')],
                  inputSnapshotIds,
                  now,
                ),
              );
            }
          }
        }
      }
    }
  }

  return edges;
}

/**
 * 增量求值：仅重算受影响快照涉及的配对，其余边原样保留。
 * affectedSnapshotIds 由增量规划器根据连通分量依赖给出。
 */
export function evaluateRelationsIncremental(
  snapshots: Snapshot[],
  facts: Fact[],
  existingEdges: RelationEdge[],
  affectedSnapshotIds: Set<string>,
  now: number,
): RelationEdge[] {
  const affected = new Set(affectedSnapshotIds);
  const untouched = existingEdges.filter(
    (e) => !affected.has(e.fromSnapshotId) && !affected.has(e.toSnapshotId),
  );
  const affectedSnapshots = snapshots.filter((s) => affected.has(s.id));
  const recomputed = evaluateRelations(affectedSnapshots, facts, now);
  // 去重：重算边按确定性 id 覆盖旧边
  const byId = new Map<string, RelationEdge>();
  for (const e of untouched) byId.set(e.id, e);
  for (const e of recomputed) byId.set(e.id, e);
  return [...byId.values()];
}
