/**
 * 增量规划器：维护文档关系图的连通分量，
 * 只重算受新快照或新裁决影响的连通分量。
 *
 * 依赖追踪的关键不变量：
 *  1. 每个快照、每条边都归属一个连通分量；
 *  2. 分量内任一快照的指纹/事实变化，或任一边的裁决变化，
 *     整个分量标记为 dirty，必须重算；
 *  3. 新快照先作为孤立分量加入，求值后按候选边合并分量；
 *  4. 发布版本记录 dependencyHash 与实际重算范围，保证可审计。
 */
import type { Adjudication, RelationEdge, Snapshot } from './types';
import { stableStringify } from './hash';

export interface ComponentModel {
  /** componentId -> 成员快照 */
  members: Record<string, string[]>;
  /** snapshotId -> componentId */
  snapshotIndex: Record<string, string>;
  /** componentId -> 该分量依赖的边 id */
  edgeIndex: Record<string, string[]>;
  /** componentId -> 输入依赖指纹（快照哈希 + 裁决结论） */
  dependencyHashes: Record<string, string>;
  /** 单调分量序号，保证 id 确定性 */
  seq: number;
}

export function emptyModel(): ComponentModel {
  return { members: {}, snapshotIndex: {}, edgeIndex: {}, dependencyHashes: {}, seq: 0 };
}

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/**
 * 由当前全部边（仅确认边参与分量合并；待裁决/驳回不连通）重建分量模型。
 * 冲突边即使被确认，也只做“关联”而不合并项目——发布器另行处理，
 * 但分量层面仍需同组追踪依赖，因此冲突边也参与 union。
 */
export function buildComponents(
  snapshots: Snapshot[],
  edges: RelationEdge[],
  adjudications: Adjudication[],
): ComponentModel {
  const uf = new UnionFind();
  for (const s of snapshots) uf.find(s.id);

  const decisionByEdge = new Map(adjudications.map((a) => [a.edgeId, a]));
  const effectiveEdges: RelationEdge[] = [];
  for (const e of edges) {
    const decision = decisionByEdge.get(e.id);
    const connected =
      e.status === 'confirmed' || decision?.decision === 'confirm';
    const rejected = e.status === 'rejected' || decision?.decision === 'reject';
    if (connected && !rejected) {
      uf.union(e.fromSnapshotId, e.toSnapshotId);
      effectiveEdges.push(e);
    }
  }

  const groups = new Map<string, string[]>();
  for (const s of snapshots) {
    const root = uf.find(s.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(s.id);
  }

  const model = emptyModel();
  const rootToComponent = new Map<string, string>();
  const sortedGroups = [...groups.values()].map((g) => [...g].sort()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const members of sortedGroups) {
    const componentId = `comp_${model.seq.toString(10).padStart(4, '0')}`;
    model.seq += 1;
    rootToComponent.set(members[0], componentId);
    model.members[componentId] = members;
    for (const m of members) model.snapshotIndex[m] = componentId;
    model.edgeIndex[componentId] = [];
  }

  for (const e of effectiveEdges) {
    const cid = model.snapshotIndex[e.fromSnapshotId];
    if (cid) model.edgeIndex[cid].push(e.id);
  }

  // 依赖指纹：分量成员的内容/规范化哈希 + 边裁决集合
  const hashOf = new Map(snapshots.map((s) => [s.id, { c: s.contentHash, n: s.normalizedHash }]));
  for (const [cid, members] of Object.entries(model.members)) {
    const payload = {
      snapshots: members.map((id) => hashOf.get(id)).sort((a, b) => (a!.c < b!.c ? -1 : 1)),
      edges: (model.edgeIndex[cid] ?? [])
        .map((eid) => {
          const edge = edges.find((e) => e.id === eid)!;
          return { id: eid, status: edge.status, decision: decisionByEdge.get(eid)?.decision ?? null };
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
    model.dependencyHashes[cid] = stableStringify(payload);
  }
  return model;
}

export interface IncrementalPlan {
  /** 需要重算的分量 id */
  dirtyComponents: string[];
  /** 这些分量包含的全部快照（关系求值的输入） */
  affectedSnapshotIds: string[];
  /** 未受影响、可直接复用上一轮发布结果的分量数 */
  skippedComponents: number;
}

/**
 * 依据旧模型与新一轮输入变化计算增量计划。
 * changedSnapshotIds：新增或内容变化的快照；
 * changedAdjudicationEdgeIds：裁决发生变化的边；
 * nextModel：按新状态构建的分量模型（新边已并入）。
 */
export function planIncremental(
  previous: ComponentModel,
  next: ComponentModel,
  changedSnapshotIds: string[],
  changedAdjudicationEdgeIds: string[],
): IncrementalPlan {
  const dirty = new Set<string>();

  for (const sid of changedSnapshotIds) {
    const cid = next.snapshotIndex[sid];
    if (cid) dirty.add(cid);
  }
  for (const eid of changedAdjudicationEdgeIds) {
    for (const [cid, edgeIds] of Object.entries(next.edgeIndex)) {
      if (edgeIds.includes(eid)) dirty.add(cid);
    }
  }

  // 依赖指纹变化（理论上被上面的变化覆盖，这里做防御性兜底，
  // 防止“补进材料但未显式登记”导致过时项目链遗留）
  for (const [cid, hash] of Object.entries(next.dependencyHashes)) {
    if (previous.dependencyHashes[cid] !== undefined && previous.dependencyHashes[cid] !== hash) {
      dirty.add(cid);
    }
  }

  const affectedSnapshotIds = [...dirty].flatMap((cid) => next.members[cid] ?? []);
  return {
    dirtyComponents: [...dirty].sort(),
    affectedSnapshotIds: [...new Set(affectedSnapshotIds)].sort(),
    skippedComponents: Object.keys(next.members).length - dirty.size,
  };
}
