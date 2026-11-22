import type { WorkbenchState } from '../state/state';
import { Badge } from '../components/ui';
import { EXTRACTION_RULES } from '../core/extractor';
import { formatCny, formatTime } from '../state/labels';

export function OverviewPage(props: { state: WorkbenchState | null }) {
  const s = props.state;
  const pub = s?.latestPublication;
  return (
    <div>
      <div className="page-head">
        <div>
          <h2>工作台总览</h2>
          <div className="desc">
            完全浏览器本地运行：数据持久化于 IndexedDB，解析、提取、求值与发布均在 WebWorker 中完成，无任何网络请求。
          </div>
        </div>
      </div>

      <div className="tiles">
        <div className="tile"><div className="label">快照</div><div className="num">{s?.snapshots.length ?? 0}</div></div>
        <div className="tile"><div className="label">事实</div><div className="num">{s?.facts.length ?? 0}</div></div>
        <div className="tile"><div className="label">候选边</div><div className="num">{s?.edges.length ?? 0}</div></div>
        <div className="tile"><div className="label">裁决</div><div className="num">{s?.adjudications.length ?? 0}</div></div>
        <div className="tile"><div className="label">待核拆分案件</div><div className="num" style={{ color: 'var(--amber)' }}>{pub?.splitAnalysis?.cases.filter((c) => c.status === 'pending_review').length ?? 0}</div></div>
        <div className="tile"><div className="label">发布版本</div><div className="num">{s?.publications.length ?? 0}</div></div>
      </div>

      {pub && (
        <div className="panel">
          <h3>最新发布 v{pub.version} <Badge className={pub.computeMode}>{pub.computeMode === 'full' ? '全量' : '增量'}</Badge></h3>
          <div className="field-grid">
            <div className="field"><div className="k">项目数 / 标段数</div>{pub.stats.projectCount} / {pub.stats.lotCount}</div>
            <div className="field"><div className="k">预算合计</div>{formatCny(pub.stats.totalBudgetCny)}</div>
            <div className="field"><div className="k">已出结果项目</div>{pub.stats.resultCount}</div>
            <div className="field"><div className="k">发布时间</div>{formatTime(pub.createdAt)}</div>
            <div className="field"><div className="k">重算/跳过连通分量</div>{pub.computeScope.recomputedComponents.length} / {pub.computeScope.skippedComponents}</div>
            <div className="field"><div className="k">依赖指纹</div><span className="hash">{pub.computeScope.dependencyHash.slice(0, 24)}…</span></div>
          </div>
        </div>
      )}

      <div className="panel">
        <h3>解析 / 提取 / 求值版本水位</h3>
        <table>
          <tbody>
            <tr><td>结构解析器</td><td className="mono">{s?.versions.PARSER_VERSION ?? '—'}</td></tr>
            <tr><td>事实提取器</td><td className="mono">{s?.versions.EXTRACTOR_VERSION ?? '—'}</td></tr>
            <tr><td>关系求值器</td><td className="mono">{s?.versions.EVALUATOR_VERSION ?? '—'}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>事实提取规则（{EXTRACTION_RULES.length} 条，发布字段可回溯）</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>规则 id</th><th>版本</th><th>说明</th></tr></thead>
            <tbody>
              {EXTRACTION_RULES.map((r) => (
                <tr key={r.id}><td className="mono">{r.id}</td><td className="small-text">{r.ruleVersion}</td><td className="small-text">{r.description}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
