import { useMemo, useState } from 'react';
import type { Adjudication, Fact, RelationEdge, Snapshot, WithdrawnEdgeRecord } from '../core/types';
import { Badge, Drawer, Empty } from '../components/ui';
import { EvidenceDrawer } from '../components/EvidenceDrawer';
import { EDGE_STATUS_LABELS, EDGE_TYPE_LABELS, fileNameOf, latestAdjudication, ruleDescription } from '../state/labels';

export function AdjudicationPage(props: {
  edges: RelationEdge[];
  snapshots: Snapshot[];
  facts: Fact[];
  adjudications: Adjudication[];
  withdrawn: WithdrawnEdgeRecord[];
  busy: boolean;
  onAdjudicate: (input: { edgeId: string; decision: 'confirm' | 'reject' | 'split'; note: string; reviewer: string; appliedFactIds: string[] }) => Promise<void>;
}) {
  const [filter, setFilter] = useState<'all' | RelationEdge['status']>('all');
  const [activeEdgeId, setActiveEdgeId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [reviewer, setReviewer] = useState('default-reviewer');
  const [evidenceSnapshotId, setEvidenceSnapshotId] = useState<{ snapshotId: string; factId?: string } | null>(null);

  const filtered = useMemo(
    () => props.edges.filter((e) => filter === 'all' || e.status === filter),
    [props.edges, filter],
  );
  const activeEdge = props.edges.find((e) => e.id === activeEdgeId) ?? null;
  const activeAdj = activeEdge ? latestAdjudication(props.adjudications, activeEdge.id) : undefined;

  const counts = useMemo(() => {
    return {
      all: props.edges.length,
      pending: props.edges.filter((e) => e.status === 'pending').length,
      confirmed: props.edges.filter((e) => e.status === 'confirmed').length,
      rejected: props.edges.filter((e) => e.status === 'rejected').length,
    };
  }, [props.edges]);

  async function decide(decision: 'confirm' | 'reject' | 'split') {
    if (!activeEdge) return;
    await props.onAdjudicate({
      edgeId: activeEdge.id,
      decision,
      note: note || `${decision}（工作台默认结论）`,
      reviewer,
      appliedFactIds: activeEdge.evidenceFactIds,
    });
    setNote('');
    setActiveEdgeId(null);
  }

  const evidenceSnap = evidenceSnapshotId ? props.snapshots.find((s) => s.id === evidenceSnapshotId.snapshotId) ?? null : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>关系裁决</h2>
          <div className="desc">
            候选边由求值器在固定快照集上生成并附理由；互斥冲突边只能待裁决、禁止自动合并。
            重新裁决会撤回旧结论并在“撤回留痕”中保留记录。
          </div>
        </div>
      </div>

      <div className="tiles">
        <div className="tile"><div className="label">候选边总数</div><div className="num">{counts.all}</div></div>
        <div className="tile"><div className="label">待裁决</div><div className="num" style={{ color: 'var(--amber)' }}>{counts.pending}</div></div>
        <div className="tile"><div className="label">已确认</div><div className="num" style={{ color: 'var(--green)' }}>{counts.confirmed}</div></div>
        <div className="tile"><div className="label">已驳回</div><div className="num" style={{ color: 'var(--red)' }}>{counts.rejected}</div></div>
      </div>

      <div className="panel">
        <div className="flex">
          {(['all', 'pending', 'confirmed', 'rejected'] as const).map((f) => (
            <button key={f} className={filter === f ? 'primary small' : 'small'} onClick={() => setFilter(f)}>
              {f === 'all' ? '全部' : EDGE_STATUS_LABELS[f]}（{counts[f]}）
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        {filtered.length === 0 ? <Empty text="没有候选边，请先在“流水线”页执行重算" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>类型</th><th>状态</th><th>关联快照</th><th>求值理由</th><th>操作</th></tr></thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td><Badge className={e.type}>{EDGE_TYPE_LABELS[e.type]}</Badge></td>
                    <td><Badge className={e.status}>{EDGE_STATUS_LABELS[e.status]}</Badge></td>
                    <td className="small-text" style={{ maxWidth: 260 }}>
                      {fileNameOf(props.snapshots.find((s) => s.id === e.fromSnapshotId)!)}
                      <div className="muted">→ {fileNameOf(props.snapshots.find((s) => s.id === e.toSnapshotId)!)}</div>
                    </td>
                    <td className="small-text" style={{ maxWidth: 420 }}>
                      <ul className="reason-list">{e.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                    </td>
                    <td><button className="small" onClick={() => setActiveEdgeId(e.id)}>裁决 / 查看</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>撤回留痕（{props.withdrawn.length}）</h3>
        {props.withdrawn.length === 0 ? <span className="muted small-text">暂无重新裁决</span> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>关系边</th><th>撤回原因</th><th>新裁决</th><th>时间</th></tr></thead>
              <tbody>
                {props.withdrawn.map((w) => (
                  <tr key={w.edgeId}>
                    <td className="mono small-text">{w.edgeId}</td>
                    <td className="small-text">{w.reason}</td>
                    <td className="mono small-text">{w.adjudicationId}</td>
                    <td className="small-text">{new Date(w.withdrawnAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {activeEdge && (
        <Drawer title={`裁决 · ${EDGE_TYPE_LABELS[activeEdge.type]}`} onClose={() => setActiveEdgeId(null)}>
          <div className="flex" style={{ marginBottom: 8 }}>
            <Badge className={activeEdge.type}>{EDGE_TYPE_LABELS[activeEdge.type]}</Badge>
            <Badge className={activeEdge.status}>{EDGE_STATUS_LABELS[activeEdge.status]}</Badge>
            <span className="spacer" />
            <span className="muted small-text">求值器 {activeEdge.evaluatorVersion}</span>
          </div>

          <h3>求值理由</h3>
          <ul className="reason-list">{activeEdge.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>

          <h3 style={{ marginTop: 16 }}>适用证据（{activeEdge.evidenceFactIds.length}）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>事实</th><th>值 / 规则</th><th>来源快照</th><th></th></tr></thead>
              <tbody>
                {activeEdge.evidenceFactIds.map((fid) => {
                  const fact = props.facts.find((f) => f.id === fid);
                  if (!fact) return null;
                  const snap = props.snapshots.find((s) => s.id === fact.snapshotId)!;
                  return (
                    <tr key={fid}>
                      <td className="small-text">{fact.evidence.text}</td>
                      <td className="small-text">{fact.value}<div className="muted">{fact.ruleId} · {ruleDescription(fact.ruleId)}</div></td>
                      <td className="small-text">{fileNameOf(snap)}</td>
                      <td><button className="small" onClick={() => setEvidenceSnapshotId({ snapshotId: snap.id, factId: fid })}>定位原文</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {activeAdj && (
            <>
              <hr className="sep" />
              <div className="small-text muted">
                已有裁决：{activeAdj.decision}（{activeAdj.reviewer}）— {activeAdj.note}
                {activeAdj.supersedesAdjudicationId && <div>取代旧裁决 {activeAdj.supersedesAdjudicationId}</div>}
              </div>
            </>
          )}

          <hr className="sep" />
          <label>审核员</label>
          <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
          <label>审核结论说明</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="记录裁决依据，将随裁决持久化" />
          <div className="flex" style={{ marginTop: 12 }}>
            <button className="primary" disabled={props.busy} onClick={() => decide('confirm')}>确认关系</button>
            <button className="danger" disabled={props.busy} onClick={() => decide('reject')}>驳回关系</button>
            {activeEdge.type === 'conflict' && (
              <button disabled={props.busy} onClick={() => decide('split')}>标记拆分（互斥不合并）</button>
            )}
          </div>
          {activeEdge.type === 'conflict' && (
            <div className="small-text" style={{ marginTop: 8, color: 'var(--red)' }}>
              硬规则：标段互斥冲突即使确认也不会自动合并项目，发布器仅做留痕并拆分呈现。
            </div>
          )}
        </Drawer>
      )}

      {evidenceSnap && (
        <EvidenceDrawer
          snapshot={evidenceSnap}
          facts={props.facts.filter((f) => f.snapshotId === evidenceSnap.id)}
          focusFactId={evidenceSnapshotId?.factId}
          onClose={() => setEvidenceSnapshotId(null)}
        />
      )}
    </div>
  );
}
