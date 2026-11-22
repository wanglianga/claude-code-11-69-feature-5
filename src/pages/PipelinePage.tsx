import { useState } from 'react';
import type { ComputeMode, PipelineProgress, Publication } from '../core/types';
import { Badge, Empty } from '../components/ui';
import { formatTime } from '../state/labels';

interface ConsistencyReport { equal: boolean; comparedAt: number; fullPublicationId: string; incrementalPublicationId: string; diffs: string[] }
interface ReplayReport { equal: boolean; rebuiltAt: number; originalPublicationId: string | null; rebuiltPublicationId: string | null; diffs: string[] }

export function PipelinePage(props: {
  busy: boolean;
  progress: PipelineProgress | null;
  onRecompute: (mode: ComputeMode | 'auto') => Promise<void>;
  onCheck: () => Promise<ConsistencyReport | undefined>;
  onReplay: () => Promise<ReplayReport | undefined>;
  onClear: () => Promise<void>;
  publications: Publication[];
  threshold: number;
  snapshotCount: number;
}) {
  const [consistency, setConsistency] = useState<ConsistencyReport | null>(null);
  const [replay, setReplay] = useState<ReplayReport | null>(null);

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>计算流水线</h2>
          <div className="desc">
            全量模式在固定快照上重建全部候选边与项目链；增量模式只重算受影响连通分量。
            两种模式从同一快照与裁决水位必须得到相同的已确认事实，可用下方校验按钮验证。
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>① 重算与发布（当前 {props.snapshotCount} 个快照；规模阈值 {props.threshold}，auto 模式据此选择）</h3>
        <div className="flex">
          <button className="primary" disabled={props.busy} onClick={() => props.onRecompute('full')}>全量重建</button>
          <button className="primary" disabled={props.busy} onClick={() => props.onRecompute('incremental')}>增量重算</button>
          <button disabled={props.busy} onClick={() => props.onRecompute('auto')}>auto（按规模自动选择）</button>
        </div>
        {props.progress && props.progress.phase !== 'idle' && (
          <div style={{ marginTop: 12 }}>
            <div className="small-text muted">
              {props.progress.message}（{props.progress.current}/{props.progress.total}）
            </div>
            <div className="progress">
              <div style={{ width: `${props.progress.total ? (props.progress.current / props.progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>② 一致性与可复算性验证</h3>
        <div className="flex">
          <button disabled={props.busy || props.snapshotCount === 0} onClick={async () => setConsistency((await props.onCheck()) ?? null)}>
            双模式一致性校验
          </button>
          <button disabled={props.busy || props.snapshotCount === 0} onClick={async () => setReplay((await props.onReplay()) ?? null)}>
            离线复跑（清空派生数据后重建）
          </button>
          <span className="spacer" />
          <button className="danger" disabled={props.busy} onClick={props.onClear}>清空本地全部数据</button>
        </div>

        {consistency && (
          <div className="panel" style={{ marginTop: 14, background: consistency.equal ? 'var(--green-soft)' : 'var(--red-soft)', borderColor: consistency.equal ? '#9ed6b6' : '#f0b4ad' }}>
            <div className="flex">
              <Badge className={consistency.equal ? 'confirmed' : 'reject'}>{consistency.equal ? '一致' : '不一致'}</Badge>
              <span className="small-text">校验时间 {formatTime(consistency.comparedAt)}</span>
            </div>
            {!consistency.equal && <ul className="reason-list">{consistency.diffs.map((d, i) => <li key={i}>{d}</li>)}</ul>}
            <div className="prov" style={{ marginTop: 6 }}>
              全量发布 {consistency.fullPublicationId} ／ 增量发布 {consistency.incrementalPublicationId}
            </div>
          </div>
        )}

        {replay && (
          <div className="panel" style={{ marginTop: 14, background: replay.equal ? 'var(--green-soft)' : 'var(--red-soft)', borderColor: replay.equal ? '#9ed6b6' : '#f0b4ad' }}>
            <div className="flex">
              <Badge className={replay.equal ? 'confirmed' : 'reject'}>{replay.equal ? '复跑一致' : '复跑不一致'}</Badge>
              <span className="small-text">复跑时间 {formatTime(replay.rebuiltAt)}</span>
            </div>
            {!replay.equal && <ul className="reason-list">{replay.diffs.map((d, i) => <li key={i}>{d}</li>)}</ul>}
            <div className="prov" style={{ marginTop: 6 }}>
              历史发布 {replay.originalPublicationId ?? '无'} ／ 重建发布 {replay.rebuiltPublicationId}
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>发布版本历史（{props.publications.length}）</h3>
        {props.publications.length === 0 ? <Empty text="尚未发布" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>版本</th><th>模式</th><th>重算分量</th><th>跳过分量</th><th>项目/标段</th><th>拆分案件</th><th>依赖指纹</th><th>时间</th></tr></thead>
              <tbody>
                {[...props.publications].sort((a, b) => b.version - a.version).map((p) => (
                  <tr key={p.id}>
                    <td>v{p.version}</td>
                    <td><Badge className={p.computeMode}>{p.computeMode === 'full' ? '全量' : '增量'}</Badge></td>
                    <td>{p.computeScope.recomputedComponents.length}</td>
                    <td>{p.computeScope.skippedComponents}</td>
                    <td>{p.stats.projectCount} / {p.stats.lotCount}</td>
                    <td className="small-text">
                      分析 #{p.splitAnalysis?.version ?? '—'}
                      {p.splitAnalysis && (
                        <div className="muted">
                          待核 {p.splitAnalysis.cases.filter((c) => c.status === 'pending_review').length} · 失效 {p.splitAnalysis.cases.filter((c) => c.status === 'invalidated').length}
                        </div>
                      )}
                    </td>
                    <td className="hash">{p.computeScope.dependencyHash.slice(0, 18)}…</td>
                    <td className="small-text">{formatTime(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
