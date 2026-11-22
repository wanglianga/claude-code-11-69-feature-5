import { useMemo, useState } from 'react';
import type { Fact, Publication, PublishedProject, Snapshot } from '../core/types';
import { Badge, Drawer, Empty, KeyVal } from '../components/ui';
import { STAGE_LABELS, fileNameOf, formatCny, formatTime, ruleDescription, shortHash } from '../state/labels';

export function ProjectsPage(props: {
  publications: Publication[];
  snapshots: Snapshot[];
  facts: Fact[];
}) {
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);

  const publication = useMemo(() => {
    if (!props.publications.length) return null;
    const target = selectedVersion ?? props.publications.map((p) => p.version).sort((a, b) => b - a)[0];
    return props.publications.find((p) => p.version === target) ?? null;
  }, [props.publications, selectedVersion]);

  const openProject: PublishedProject | null = openCode ? publication?.projects.find((p) => p.projectCode === openCode) ?? null : null;

  function provenanceLine(factId: string | undefined, snapshotId: string | undefined) {
    if (!factId || !snapshotId) return null;
    const fact = props.facts.find((f) => f.id === factId);
    const snap = props.snapshots.find((s) => s.id === snapshotId);
    if (!fact || !snap) return <span className="prov">溯源缺失</span>;
    return (
      <div className="prov">
        溯源：{fact.ruleId}（{ruleDescription(fact.ruleId)}）→ 事实 {shortHash(fact.id)} → 快照 {fileNameOf(snap)} → 原文[{fact.evidence.start},{fact.evidence.end})「{fact.evidence.text}」
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>版本化项目链与发布</h2>
          <div className="desc">
            发布只从裁决水位生成；每个字段均可回溯到事实、提取规则与快照原文。
          </div>
        </div>
        {props.publications.length > 0 && (
          <select value={publication?.version ?? ''} onChange={(e) => setSelectedVersion(Number(e.target.value))} style={{ width: 220 }}>
            {[...props.publications].sort((a, b) => b.version - a.version).map((p) => (
              <option key={p.id} value={p.version}>
                v{p.version} · {p.computeMode === 'full' ? '全量' : '增量'} · {formatTime(p.createdAt)}
              </option>
            ))}
          </select>
        )}
      </div>

      {!publication ? (
        <div className="panel"><Empty text="尚无发布版本，请先在“流水线”页执行重算与发布" /></div>
      ) : (
        <>
          <div className="tiles">
            <div className="tile"><div className="label">发布版本</div><div className="num">v{publication.version}</div></div>
            <div className="tile"><div className="label">项目数</div><div className="num">{publication.stats.projectCount}</div></div>
            <div className="tile"><div className="label">标段数</div><div className="num">{publication.stats.lotCount}</div></div>
            <div className="tile"><div className="label">已出结果</div><div className="num">{publication.stats.resultCount}</div></div>
            <div className="tile"><div className="label">预算合计</div><div className="num" style={{ fontSize: 18 }}>{formatCny(publication.stats.totalBudgetCny)}</div></div>
          </div>

          <div className="panel">
            <h3>发布水位与计算范围</h3>
            <div className="field-grid">
              <KeyVal k="计算模式"><Badge className={publication.computeMode}>{publication.computeMode === 'full' ? '全量重建' : '增量重算'}</Badge></KeyVal>
              <KeyVal k="重算连通分量">{publication.computeScope.recomputedComponents.length} 个；跳过 {publication.computeScope.skippedComponents} 个</KeyVal>
              <KeyVal k="依赖指纹"><span className="hash">{publication.computeScope.dependencyHash}</span></KeyVal>
              <KeyVal k="快照水位">{publication.snapshotWatermark.length} 个快照</KeyVal>
              <KeyVal k="裁决水位">{publication.adjudicationWatermark.length} 条裁决</KeyVal>
              <KeyVal k="版本水位">解析 {publication.parserVersion} ／ 提取 {publication.extractorVersion} ／ 求值 {publication.evaluatorVersion}</KeyVal>
            </div>
          </div>

          <div className="panel">
            <h3>项目（{publication.projects.length}）</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>项目编号</th><th>采购人</th><th>阶段链</th><th>标段</th><th>当前预算</th><th>依据/冲突</th><th></th></tr></thead>
                <tbody>
                  {publication.projects.map((p) => (
                    <tr key={`${publication.id}-${p.projectCode}-${p.stageChain[0]?.snapshotId}`}>
                      <td className="mono">{p.projectCode}</td>
                      <td>{p.purchaser || <span className="muted">未识别</span>}</td>
                      <td>
                        <div className="chain">
                          {p.stageChain.map((node, i) => (
                            <span key={node.snapshotId} className="chain-node">
                              {i > 0 && <span className="chain-arrow"> → </span>}
                              {STAGE_LABELS[node.stage]}{node.isoDate ? ` ${node.isoDate.slice(5)}` : ''}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>{p.lots.map((l) => l.lotCode).join('、') || '—'}</td>
                      <td className="mono">{formatCny(p.currentBudgetCny)}</td>
                      <td className="small-text">
                        <div>{p.supportingEdgeIds.length} 条确认边 ／ {p.supportingAdjudicationIds.length} 条裁决</div>
                        {p.conflictEdgeIds.length > 0 && <Badge className="conflict">{p.conflictEdgeIds.length} 条互斥留痕</Badge>}
                      </td>
                      <td><button className="small" onClick={() => setOpenCode(p.projectCode)}>项目详情</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <h3>按采购人统计快照</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>采购人</th><th>项目数</th><th>预算合计</th></tr></thead>
                <tbody>
                  {Object.entries(publication.stats.byPurchaser).map(([name, s]) => (
                    <tr key={name}><td>{name}</td><td>{s.projects}</td><td className="mono">{formatCny(s.budgetCny)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {openProject && (
        <Drawer title={`项目详情 · ${openProject.projectCode}`} onClose={() => setOpenCode(null)}>
          <h3>项目链（{openProject.stageChain.length} 个阶段节点，同件副本已折叠）</h3>
          <div className="chain">
            {openProject.stageChain.map((node, i) => {
              const snap = props.snapshots.find((s) => s.id === node.snapshotId);
              return (
                <span key={node.snapshotId} className="chain-node">
                  {i > 0 && <span className="chain-arrow">→</span>}
                  <Badge className="neutral">{STAGE_LABELS[node.stage]}</Badge>
                  <div>{node.isoDate ?? '日期未知'}</div>
                  <div className="prov">{snap ? fileNameOf(snap) : node.snapshotId}</div>
                </span>
              );
            })}
          </div>

          <hr className="sep" />
          <h3>字段溯源</h3>
          <div className="field-grid">
            <KeyVal k="项目编号">{openProject.projectCode}{provenanceLine(openProject.fieldProvenance.projectCode?.factId, openProject.fieldProvenance.projectCode?.snapshotId)}</KeyVal>
            <KeyVal k="采购人">{openProject.purchaser}{provenanceLine(openProject.fieldProvenance.purchaser?.factId, openProject.fieldProvenance.purchaser?.snapshotId)}</KeyVal>
            <KeyVal k="当前预算">{formatCny(openProject.currentBudgetCny)}{provenanceLine(openProject.fieldProvenance.currentBudgetCny?.factId, openProject.fieldProvenance.currentBudgetCny?.snapshotId)}</KeyVal>
            <KeyVal k="合法性依据">{openProject.supportingEdgeIds.length} 边 ／ {openProject.supportingAdjudicationIds.length} 裁决</KeyVal>
          </div>

          <hr className="sep" />
          <h3>预算变动轨迹（保留被更正覆盖的历史值）</h3>
          {openProject.BudgetHistory.length === 0 ? <span className="muted">无金额事实</span> : (
            <table>
              <thead><tr><th>金额</th><th>日期</th><th>依据快照 / 规则</th></tr></thead>
              <tbody>
                {openProject.BudgetHistory.map((h, i) => (
                  <tr key={i}>
                    <td className="mono">{formatCny(h.amountCny)}</td>
                    <td>{h.isoDate ?? '—'}</td>
                    <td className="small-text">{fileNameOf(props.snapshots.find((s) => s.id === h.snapshotId)!)} · {h.ruleId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <hr className="sep" />
          <h3>标段事实（{openProject.lots.length}）</h3>
          {openProject.lots.map((lot) => (
            <div key={lot.lotCode} className="panel" style={{ marginBottom: 8 }}>
              <div className="flex">
                <strong>{lot.lotCode} · {lot.lotName}</strong>
                <span className="spacer" />
                <span>预算 {formatCny(lot.budgetCny)}</span>
                <span>中标 {lot.winner ?? '—'}</span>
              </div>
              {Object.entries(lot.fieldProvenance).map(([field, prov]) => (
                <div key={field} className="prov">【{field}】{provenanceLine(prov.factId, prov.snapshotId)}</div>
              ))}
            </div>
          ))}

          {openProject.conflictEdgeIds.length > 0 && (
            <>
              <hr className="sep" />
              <h3>互斥冲突留痕</h3>
              {openProject.conflictEdgeIds.map((id) => (
                <div key={id} className="prov">冲突边 {id}：同编号标段范围互斥，未参与自动合并</div>
              ))}
            </>
          )}

          {openProject.independentUnits && openProject.independentUnits.length > 0 && (
            <>
              <hr className="sep" />
              <h3>独立标段（裁决拆分依据）</h3>
              {openProject.independentUnits.map((u) => (
                <div key={u.edgeId} className="prov">
                  冲突边 {u.edgeId} · 裁决 {u.adjudicationId}：已判定为相互独立标段
                  {u.lotSets.map((s, i) => <div key={i}>独立单元 {i + 1}：{`{${s.join('、')}}`}</div>)}
                  <div>拆分采购分析会将本单元作为“已有明确独立计划”排除出组合</div>
                </div>
              ))}
            </>
          )}
        </Drawer>
      )}
    </div>
  );
}
