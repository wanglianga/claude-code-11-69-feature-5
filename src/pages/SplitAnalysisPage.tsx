import { useMemo, useState } from 'react';
import type {
  CaseSelectionMode,
  Fact,
  FeatureKey,
  PolicyCatalog,
  Publication,
  Snapshot,
  SplitCandidate,
} from '../core/types';
import { Badge, Drawer, Empty, KeyVal } from '../components/ui';
import { EvidenceDrawer } from '../components/EvidenceDrawer';
import { EXCLUSION_LABELS, featureLabel } from '../core/splitAnalysis';
import { DEFAULT_POLICY_CATALOG, POLICY_VERSION } from '../core/policy';
import { formatCny, formatTime } from '../state/labels';

const FEATURE_ORDER: FeatureKey[] = ['category', 'title', 'deliveryLocation', 'unit', 'purchaserLevel', 'region', 'method'];

export function SplitAnalysisPage(props: {
  publications: Publication[];
  snapshots: Snapshot[];
  facts: Fact[];
  policyCatalog: PolicyCatalog;
  selectionMode: CaseSelectionMode;
  busy: boolean;
  onSelectionMode: (mode: CaseSelectionMode) => Promise<void>;
  onPolicyCatalog: (catalog: PolicyCatalog, label: string) => Promise<void>;
  onRecompute: () => Promise<void>;
}) {
  const [version, setVersion] = useState<number | null>(null);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [openCandidateId, setOpenCandidateId] = useState<string | null>(null);
  const [evidenceTarget, setEvidenceTarget] = useState<{ snapshotId: string; factId?: string } | null>(null);
  const [showInvalidated, setShowInvalidated] = useState(false);

  const publication = useMemo(() => {
    const withAnalysis = props.publications.filter((p) => p.splitAnalysis);
    if (!withAnalysis.length) return null;
    if (version !== null) return withAnalysis.find((p) => p.version === version) ?? withAnalysis[withAnalysis.length - 1];
    return [...withAnalysis].sort((a, b) => b.version - a.version)[0];
  }, [props.publications, version]);

  const analysis = publication?.splitAnalysis ?? null;
  const openCase = analysis && openCaseId ? analysis.cases.find((c) => c.id === openCaseId) ?? null : null;
  const openCandidate = openCase && openCandidateId ? openCase.candidates.find((c) => c.id === openCandidateId) ?? null : null;

  function evidenceButton(ev: { snapshotId: string; factId: string | null }) {
    if (!ev.snapshotId) return <span className="muted small-text">无原文</span>;
    return (
      <button className="ghost small" onClick={() => setEvidenceTarget({ snapshotId: ev.snapshotId, factId: ev.factId ?? undefined })}>
        定位原文
      </button>
    );
  }

  const visibleCases = analysis
    ? analysis.cases.filter((c) => showInvalidated || c.status === 'pending_review')
    : [];
  const pendingCount = analysis?.cases.filter((c) => c.status === 'pending_review').length ?? 0;
  const invalidatedCount = analysis?.cases.filter((c) => c.status === 'invalidated').length ?? 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>疑似拆分采购组合分析（只供排查）</h2>
          <div className="desc">
            政策目录按公告日分段适用门槛与时间窗；在同一政策区间内生成候选组合并计算合计金额、时间跨度与特征重叠，
            约束求值器排除独立计划、不同采购主体与不可比品类。<b>金额相近不等于违规</b>，本视图只输出待核组合与可回查证据。
          </div>
        </div>
        {analysis && (
          <select value={publication?.version ?? ''} onChange={(e) => setVersion(Number(e.target.value))} style={{ width: 260 }}>
            {props.publications
              .filter((p) => p.splitAnalysis)
              .sort((a, b) => b.version - a.version)
              .map((p) => (
                <option key={p.id} value={p.version}>
                  v{p.version} · 分析 #{p.splitAnalysis!.version} · {formatTime(p.createdAt)}
                </option>
              ))}
          </select>
        )}
      </div>

      {!analysis ? (
        <div className="panel"><Empty text="尚无拆分采购分析。请先导入样例并在“流水线”页执行重算与发布。" /></div>
      ) : (
        <>
          <div className="panel" style={{ background: '#fff8e6', borderColor: '#f0d98c' }}>
            <strong>只供审计排查，不下违法结论。</strong>
            <div className="small-text" style={{ marginTop: 6 }}>
              {analysis.cases[0]?.disclaimer ?? '同一项目可能出现在多组候选中；代表组合的合计金额已按项目去重，避免重复累计。'}
            </div>
          </div>

          <div className="tiles">
            <div className="tile"><div className="label">参与分析项目</div><div className="num">{analysis.analyzedProjects}</div></div>
            <div className="tile"><div className="label">待核案件</div><div className="num" style={{ color: 'var(--amber)' }}>{pendingCount}</div></div>
            <div className="tile"><div className="label">已失效案件</div><div className="num">{invalidatedCount}</div></div>
            <div className="tile"><div className="label">被排除组合 / 项目</div><div className="num">{analysis.excluded.length}</div></div>
            <div className="tile"><div className="label">政策目录版本</div><div className="num" style={{ fontSize: 15 }}>{analysis.policyVersion}</div></div>
          </div>

          <div className="panel">
            <h3>① 候选呈现策略（审计团队按召回或核查容量取舍）</h3>
            <div className="flex">
              <button
                className={props.selectionMode === 'recall' ? 'primary' : ''}
                disabled={props.busy}
                onClick={() => props.onSelectionMode('recall')}
              >
                保留全部相连候选（召回优先）
              </button>
              <button
                className={props.selectionMode === 'capacity' ? 'primary' : ''}
                disabled={props.busy}
                onClick={() => props.onSelectionMode('capacity')}
              >
                仅呈现代理组合（有限核查容量）
              </button>
              <span className="spacer" />
              <button className="primary" disabled={props.busy} onClick={props.onRecompute}>按当前政策与策略重算</button>
            </div>
            <div className="small-text muted" style={{ marginTop: 8 }}>
              当前：<b>{props.selectionMode === 'recall' ? '召回优先' : '有限容量'}</b>。
              recall 会保留同一项目出现在多组候选，覆盖更全、待核工作量更大；capacity 只呈互不重叠代表组合，队列更短、金额不重复，
              但边界项目和次优解释留在“未分组范围”。两种方式都只展示候选，不下定性结论。
              {props.selectionMode !== analysis.selectionMode && (
                <div style={{ color: 'var(--amber)' }}>策略已切换，点击「按当前政策与策略重算」后案件视图生效（历史发布保留）。</div>
              )}
            </div>
          </div>

          <div className="panel">
            <h3>② 政策目录与适用区间（政策目录版本 {props.policyCatalog.version}）</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>政策条目</th><th>地区 / 方式</th><th>生效期间</th><th>金额门槛</th><th>合并时间窗</th><th>引用依据</th></tr></thead>
                <tbody>
                  {props.policyCatalog.entries.map((entry) =>
                    entry.bands.map((band, i) => (
                      <tr key={`${entry.id}#${i}`}>
                        <td className="mono">{entry.id}#{i}</td>
                        <td>{entry.region} / {entry.methodLabel}</td>
                        <td className="small-text">{band.effectiveFrom ?? '—'} ~ {band.effectiveTo ?? '至今'}</td>
                        <td className="mono">{formatCny(band.thresholdCny)}</td>
                        <td>{band.mergeWindowDays} 天</td>
                        <td className="small-text">{band.citation}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            <div className="small-text muted" style={{ marginTop: 8 }}>
              候选生成按每个项目公告日选择适用区间，<b>不会用当前门槛重判历史项目</b>；同一地区不同期间的项目会分段评估。
            </div>
            <div className="flex" style={{ marginTop: 10 }}>
              <span className="muted small-text">门槛切换演示：</span>
              <button
                className="small"
                disabled={props.busy}
                onClick={() => props.onPolicyCatalog(DEFAULT_POLICY_CATALOG, '默认目录（2024 年起 130 万）')}
              >
                默认目录（浙江 2024 起 130 万）
              </button>
              <button
                className="small"
                disabled={props.busy}
                onClick={() => props.onPolicyCatalog(
                  withThreshold({
                    region: '浙江',
                    from: '2024-01-01',
                    to: null,
                    thresholdCny: 1_000_000,
                    mergeWindowDays: 180,
                    citation: '演示：假设 2024 年起浙江公开招标门槛调整为 100 万元（虚构对照）',
                  }),
                  '浙江 2024 起门槛 100 万（对照）',
                )}
              >
                对照：浙江 2024 起门槛 100 万
              </button>
              <button
                className="small"
                disabled={props.busy}
                onClick={() => props.onPolicyCatalog(
                  withThreshold({
                    region: '浙江',
                    from: '2024-01-01',
                    to: null,
                    thresholdCny: 1_600_000,
                    mergeWindowDays: 180,
                    citation: '演示：假设 2024 年起浙江公开招标门槛调整为 160 万元（虚构对照）',
                  }),
                  '浙江 2024 起门槛 160 万（对照）',
                )}
              >
                对照：浙江 2024 起门槛 160 万
              </button>
              <span className="spacer" />
              <button className="primary small" disabled={props.busy} onClick={props.onRecompute}>应用并重算</button>
            </div>
            <div className="small-text muted" style={{ marginTop: 6 }}>
              注意：切换门槛只影响后续重算的新版本；历史发布版本仍按原门槛评估，可在上方版本选择器中回放对照。
            </div>
          </div>

          <div className="panel">
            <div className="flex">
              <h3 style={{ margin: 0 }}>③ 案件队列（{visibleCases.length} 件）</h3>
              <span className="spacer" />
              <label style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={showInvalidated} onChange={(e) => setShowInvalidated(e.target.checked)} />
                显示已失效案件（历史回放）
              </label>
            </div>
            <div className="small-text muted" style={{ marginBottom: 10 }}>
              {analysis.selectionMode === 'recall'
                ? `召回优先：列出全部 ${analysis.cases.filter((c) => c.status === 'pending_review').reduce((n, c) => n + c.candidates.length, 0)} 组相连候选（同一项目可能重复出现），覆盖更全面但待核工作量更大。`
                : `有限容量：仅列出 ${analysis.cases.filter((c) => c.status === 'pending_review').reduce((n, c) => n + c.representatives.length, 0)} 组互不重叠代表组合，金额不重复；次优解释留在案件详情的未分组范围。`}
            </div>
            {visibleCases.length === 0 ? (
              <Empty text="当前策略下没有待核案件（或样例不含可组合项目）。" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>采购人 / 品类</th><th>政策区间</th><th>队列条目（{analysis.selectionMode === 'recall' ? '全部相连候选' : '代表组合'}）</th><th>金额</th><th>重叠/未分组</th><th></th></tr>
                  </thead>
                  <tbody>
                    {visibleCases.map((c) => (
                      <tr key={c.id} style={c.status === 'invalidated' ? { opacity: 0.6 } : undefined}>
                        <td>
                          <div>{c.title.split(' · ').slice(0, 2).join(' · ')}</div>
                          <Badge className={c.status === 'pending_review' ? 'pending' : 'rejected'}>
                            {c.status === 'pending_review' ? '待人工核查' : '已失效'}
                          </Badge>
                          <div className="small-text">v{c.versions[c.versions.length - 1]?.version ?? 1}</div>
                        </td>
                        <td className="small-text">
                          <div className="mono">{c.policyBandId}</div>
                          <div className="muted">门槛 {formatCny(c.thresholdCny)} · 窗口 {c.mergeWindowDays} 天</div>
                        </td>
                        <td className="small-text">
                          {(analysis.selectionMode === 'recall' ? c.candidates : c.representatives).map((cand) => (
                            <div key={cand.id}>
                              {cand.projectLabels.join(' + ')}
                              <span className="mono"> = {formatCny(cand.totalAmountCny)}</span>
                              {!cand.isRepresentative && <span className="muted">（重叠/次优）</span>}
                            </div>
                          ))}
                        </td>
                        <td className="mono small-text">
                          <div>去重 {formatCny(c.representativeTotalCny)}</div>
                          {c.connectedCandidateSumCny > c.representativeTotalCny && (
                            <div className="muted">全候选合计 {formatCny(c.connectedCandidateSumCny)}</div>
                          )}
                        </td>
                        <td className="small-text">
                          {c.overlap.length === 0 ? <span className="muted">无</span> : c.overlap.map((o) => (
                            <div key={o.projectId}>{o.projectCode} 出现在 {o.candidateIds.length} 组</div>
                          ))}
                          {c.ungroupedProjectCodes.length > 0 && (
                            <div className="muted">未分组：{c.ungroupedProjectCodes.join('、')}</div>
                          )}
                        </td>
                        <td><button className="small" onClick={() => setOpenCaseId(c.id)}>查看案件</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h3>④ 排除与不确定（约束求值器留痕，不静默丢弃）</h3>
            {analysis.excluded.length === 0 ? <span className="muted small-text">无排除记录</span> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>理由</th><th>涉及项目</th><th>说明</th></tr></thead>
                  <tbody>
                    {analysis.excluded.map((e, i) => (
                      <tr key={i}>
                        <td><Badge className="rejected">{EXCLUSION_LABELS[e.reason]}</Badge></td>
                        <td className="mono small-text">{e.projectCodes.join('、')}</td>
                        <td className="small-text">{e.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {analysis.uncertainties.length > 0 && (
              <div className="small-text" style={{ marginTop: 10 }}>
                <strong>不确定项：</strong>
                <ul className="reason-list">{analysis.uncertainties.map((u, i) => <li key={i}>{u}</li>)}</ul>
              </div>
            )}
          </div>

          <div className="panel">
            <h3>⑤ 需求特征（可回查相似性证据）</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>项目</th><th>公告日</th>{FEATURE_ORDER.map((k) => <th key={k}>{featureLabel(k)}</th>)}<th>不确定字段</th></tr>
                </thead>
                <tbody>
                  {analysis.features.map((f) => (
                    <tr key={f.projectId}>
                      <td className="mono">{f.projectCode}</td>
                      <td className="small-text">{f.announcementDate ?? '—'}</td>
                      {FEATURE_ORDER.map((k) => (
                        <td key={k} className="small-text">{f[k].value ?? <span className="muted">缺失</span>}</td>
                      ))}
                      <td className="small-text">{f.uncertainFields.length ? f.uncertainFields.join('、') : <span className="muted">无</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <h3>⑥ 历史案件回放</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>分析版本</th><th>时间</th><th>当时待核案件</th><th>当轮失效案件</th></tr></thead>
                <tbody>
                  {analysis.history.map((h) => (
                    <tr key={h.version}>
                      <td>#{h.version}</td>
                      <td className="small-text">{formatTime(h.createdAt)}</td>
                      <td className="small-text">{h.caseIds.length} 件</td>
                      <td className="small-text">{h.invalidatedCaseIds.length ? h.invalidatedCaseIds.join('、') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="small-text muted" style={{ marginTop: 8 }}>
              若某条项目链后来被裁决拆为独立标段，依赖它的组合会失效并生成新的案件版本，旧版本保留在版本历史中。
            </div>
          </div>
        </>
      )}

      {openCase && (
        <Drawer title={`案件详情 · ${openCase.title}`} onClose={() => { setOpenCaseId(null); setOpenCandidateId(null); }}>
          <div className="flex" style={{ marginBottom: 8 }}>
            <Badge className={openCase.status === 'pending_review' ? 'pending' : 'rejected'}>
              {openCase.status === 'pending_review' ? '待人工核查' : '已失效'}
            </Badge>
            <span className="muted small-text">政策 {openCase.policyBandId} · {openCase.policyVersion}</span>
          </div>
          <div className="panel" style={{ background: '#fff8e6', borderColor: '#f0d98c' }}>{openCase.disclaimer}</div>

          <div className="field-grid">
            <KeyVal k="政策引用依据">{openCase.citation}</KeyVal>
            <KeyVal k="门槛 / 时间窗">{formatCny(openCase.thresholdCny)} / {openCase.mergeWindowDays} 天</KeyVal>
            <KeyVal k="代表组合去重合计">{formatCny(openCase.representativeTotalCny)}</KeyVal>
            <KeyVal k="全部候选合计（含重复）">{formatCny(openCase.connectedCandidateSumCny)}</KeyVal>
            <KeyVal k="未分组项目">{openCase.ungroupedProjectCodes.length ? openCase.ungroupedProjectCodes.join('、') : '—'}</KeyVal>
            <KeyVal k="重叠处理">{openCase.overlap.length ? openCase.overlap.map((o) => `${o.projectCode}（${o.candidateIds.length} 组）`).join('、') : '无重叠'}</KeyVal>
          </div>

          <hr className="sep" />
          <h3>代表组合（互不重叠，金额不重复累计）</h3>
          {openCase.representatives.length === 0 ? <span className="muted small-text">无代表组合（案件已失效）</span> : openCase.representatives.map((r) => (
            <CandidateBlock key={r.id} candidate={r} representative onOpen={() => setOpenCandidateId(r.id)} />
          ))}

          <hr className="sep" />
          <h3>
            全部相连候选（{openCase.candidates.length}，含重叠与次优解释）
            {analysis?.selectionMode === 'capacity' && <span className="muted small-text"> · 有限容量模式下次优解释默认折叠</span>}
          </h3>
          {(analysis?.selectionMode === 'capacity' ? openCase.candidates.filter((c) => c.isRepresentative) : openCase.candidates).map((r) => (
            <CandidateBlock key={r.id} candidate={r} onOpen={() => setOpenCandidateId(r.id)} />
          ))}
          {analysis?.selectionMode === 'capacity' && openCase.candidates.length > openCase.representatives.length && (
            <div className="small-text muted" style={{ marginTop: 6 }}>
              其余 {openCase.candidates.length - openCase.representatives.length} 组相连候选未进入代表队列（边界项目/次优解释）。
              切换到“召回优先”可查看全部候选及其重叠说明。
            </div>
          )}

          <hr className="sep" />
          <h3>案件版本历史</h3>
          <table>
            <thead><tr><th>版本</th><th>状态</th><th>说明</th><th>时间</th></tr></thead>
            <tbody>
              {openCase.versions.map((v) => (
                <tr key={v.version}>
                  <td>v{v.version}</td>
                  <td><Badge className={v.status === 'active' ? 'confirmed' : 'rejected'}>{v.status === 'active' ? '生效' : '失效'}</Badge></td>
                  <td className="small-text">{v.reason}</td>
                  <td className="small-text">{formatTime(v.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Drawer>
      )}

      {openCandidate && (
        <Drawer title={`候选组合详情`} onClose={() => setOpenCandidateId(null)}>
          <div className="flex" style={{ marginBottom: 8 }}>
            <Badge className={openCandidate.isRepresentative ? 'confirmed' : 'neutral'}>
              {openCandidate.isRepresentative ? '代表组合' : '相连候选（次优/重叠解释）'}
            </Badge>
            <span className="muted small-text">规则 {openCandidate.ruleVersion}</span>
          </div>
          <div className="field-grid">
            <KeyVal k="项目">{openCandidate.projectLabels.join('、')}</KeyVal>
            <KeyVal k="合计金额">{formatCny(openCandidate.totalAmountCny)}</KeyVal>
            <KeyVal k="时间跨度">{openCandidate.timeSpanDays} 天</KeyVal>
            <KeyVal k="一致特征数">{openCandidate.overlapScore}</KeyVal>
          </div>

          {openCandidate.overlapsWithRepresentative && openCandidate.overlapsWithRepresentative.length > 0 && (
            <div className="small-text" style={{ marginTop: 6, color: 'var(--amber)' }}>
              与代表组合共享项目；其金额不计入代表组合去重合计，避免重复展示。
            </div>
          )}

          <h3 style={{ marginTop: 14 }}>特征重叠</h3>
          <table>
            <thead><tr><th>特征</th><th>是否一致</th><th>值</th></tr></thead>
            <tbody>
              {openCandidate.featureOverlap.map((o) => (
                <tr key={o.key}>
                  <td>{featureLabel(o.key)}</td>
                  <td>
                    {o.uncertain ? <Badge className="pending">不确定</Badge> : o.matched ? <Badge className="confirmed">一致</Badge> : <Badge className="rejected">不一致</Badge>}
                  </td>
                  <td className="small-text">{o.valueA ?? '—'} / {o.valueB ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 14 }}>金额来源（可回查）</h3>
          <table>
            <thead><tr><th>项目</th><th>金额</th><th>公告日</th><th>证据</th></tr></thead>
            <tbody>
              {openCandidate.amountSources.map((a) => (
                <tr key={a.projectCode + a.factId}>
                  <td className="mono">{a.projectCode}</td>
                  <td className="mono">{formatCny(a.amountCny)}</td>
                  <td className="small-text">{a.isoDate ?? '—'}</td>
                  <td>{a.snapshotId ? evidenceButton({ snapshotId: a.snapshotId, factId: a.factId }) : <span className="muted small-text">无</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 14 }}>支持证据（{openCandidate.supportingEvidence.length}）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>项目</th><th>原文片段</th><th>规则</th><th></th></tr></thead>
              <tbody>
                {openCandidate.supportingEvidence.map((e, i) => (
                  <tr key={i}>
                    <td className="mono small-text">{e.projectCode}</td>
                    <td className="small-text">{e.text}</td>
                    <td className="small-text">{e.ruleId ?? '—'}</td>
                    <td>{evidenceButton(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 style={{ marginTop: 14 }}>反驳证据（{openCandidate.rebuttingEvidence.length}）</h3>
          {openCandidate.rebuttingEvidence.length === 0 ? <span className="muted small-text">无</span> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>项目</th><th>原文片段 / 依据</th><th>规则</th><th></th></tr></thead>
                <tbody>
                  {openCandidate.rebuttingEvidence.map((e, i) => (
                    <tr key={i}>
                      <td className="mono small-text">{e.projectCode}</td>
                      <td className="small-text">{e.text}</td>
                      <td className="small-text">{e.ruleId ?? '—'}</td>
                      <td>{evidenceButton(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ marginTop: 14 }}>替代分组</h3>
          {openCandidate.alternativeGroupings.map((alt, i) => (
            <div key={i} className="panel" style={{ marginBottom: 8 }}>
              <div className="flex"><strong>{alt.label}</strong><span className="spacer" /><span className="mono small-text">{alt.projectCodes.join('、')}</span></div>
              <div className="small-text muted" style={{ marginTop: 4 }}>{alt.rationale}</div>
            </div>
          ))}
        </Drawer>
      )}

      {evidenceTarget && (() => {
        const snap = props.snapshots.find((s) => s.id === evidenceTarget.snapshotId);
        if (!snap) return null;
        return (
          <EvidenceDrawer
            snapshot={snap}
            facts={props.facts.filter((f) => f.snapshotId === snap.id)}
            focusFactId={evidenceTarget.factId}
            onClose={() => setEvidenceTarget(null)}
          />
        );
      })()}
    </div>
  );
}

function CandidateBlock({ candidate, representative, onOpen }: { candidate: SplitCandidate; representative?: boolean; onOpen: () => void }) {  return (
    <div className="panel" style={{ marginBottom: 8, borderColor: representative ? '#9ed6b6' : undefined }}>
      <div className="flex">
        <strong className="mono">{candidate.projectLabels.join('、')}</strong>
        {representative && <Badge className="confirmed">代表</Badge>}
        {!representative && candidate.overlapsWithRepresentative && candidate.overlapsWithRepresentative.length > 0 && (
          <Badge className="pending">与代表组合重叠</Badge>
        )}
        <span className="spacer" />
        <span>合计 {formatCny(candidate.totalAmountCny)}</span>
        <span className="small-text">跨度 {candidate.timeSpanDays} 天</span>
        <span className="small-text">一致特征 {candidate.overlapScore}</span>
        <button className="small" onClick={onOpen}>详情</button>
      </div>
      {candidate.uncertainFields.length > 0 && (
        <div className="small-text muted" style={{ marginTop: 4 }}>不确定字段：{candidate.uncertainFields.join('、')}</div>
      )}
    </div>
  );
}

/** 门槛切换演示：替换指定地区 2024-01-01 起的公开招标区间，其余区间保持不变 */
function withThreshold(band: {
  region: string;
  from: string;
  to: string | null;
  thresholdCny: number;
  mergeWindowDays: number;
  citation: string;
}): PolicyCatalog {
  const catalog: PolicyCatalog = JSON.parse(JSON.stringify(DEFAULT_POLICY_CATALOG));
  for (const entry of catalog.entries) {
    if (entry.region !== band.region || entry.method !== 'open_tender') continue;
    entry.bands = entry.bands
      .filter((b) => !(b.effectiveFrom === band.from))
      .concat({
        effectiveFrom: band.from,
        effectiveTo: band.to,
        thresholdCny: band.thresholdCny,
        mergeWindowDays: band.mergeWindowDays,
        citation: band.citation,
      })
      .sort((a, b) => (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? ''));
    entry.version = `${POLICY_VERSION}-demo-${band.thresholdCny}`;
  }
  return catalog;
}
