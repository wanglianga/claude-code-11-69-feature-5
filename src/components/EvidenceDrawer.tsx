import { useMemo, useState } from 'react';
import type { Fact, Snapshot } from '../core/types';
import { Drawer } from './ui';
import { FACT_TYPE_LABELS, ruleDescription } from '../state/labels';

/**
 * 证据定位抽屉：展示快照原文，
 * 高亮事实证据（黄色）与站点噪声（灰色删除线）。
 */
export function EvidenceDrawer(props: {
  snapshot: Snapshot;
  facts: Fact[];
  focusFactId?: string;
  onClose: () => void;
}) {
  const { snapshot, facts, focusFactId, onClose } = props;
  const [showNoise, setShowNoise] = useState(true);
  const focus = useMemo(() => facts.find((f) => f.id === focusFactId), [facts, focusFactId]);

  const spans = useMemo(() => {
    const out: { start: number; end: number; className: string }[] = [];
    if (showNoise) {
      for (const n of snapshot.parsed.noiseSpans) out.push({ ...n, className: 'noise' });
    }
    for (const f of facts) {
      out.push({ start: f.evidence.start, end: f.evidence.end, className: f.id === focusFactId ? 'evidence' : 'evidence' });
    }
    return out.sort((a, b) => a.start - b.start);
  }, [snapshot, facts, showNoise, focusFactId]);

  const parts = useMemo(() => {
    const out: { text: string; className?: string }[] = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.start < cursor) continue;
      if (span.start > cursor) out.push({ text: snapshot.rawText.slice(cursor, span.start) });
      out.push({ text: snapshot.rawText.slice(span.start, span.end), className: span.className });
      cursor = span.end;
    }
    if (cursor < snapshot.rawText.length) out.push({ text: snapshot.rawText.slice(cursor) });
    return out;
  }, [snapshot, spans]);

  return (
    <Drawer title={`证据定位 · ${snapshot.sources[0]?.fileName ?? snapshot.id}`} onClose={onClose}>
      <div className="flex" style={{ marginBottom: 10 }}>
        <label style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={showNoise} onChange={(e) => setShowNoise(e.target.checked)} />
          标记站点噪声
        </label>
        <span className="spacer" />
        <span className="muted small-text">解析版本 {snapshot.parsed.parserVersion}</span>
      </div>

      {focus && (
        <div className="panel" style={{ background: '#fffbe9', borderColor: '#f0d98c' }}>
          <strong>当前选中事实：{FACT_TYPE_LABELS[focus.type]}</strong>
          <div className="field-grid" style={{ marginTop: 8 }}>
            <div className="field"><div className="k">规范化值</div><span className="mono">{focus.value}</span></div>
            <div className="field"><div className="k">提取规则</div>{focus.ruleId} · {ruleDescription(focus.ruleId)}</div>
            <div className="field"><div className="k">字符区间</div><span className="mono">[{focus.evidence.start}, {focus.evidence.end})</span></div>
            <div className="field"><div className="k">所在结构</div>{focus.sectionKind === 'announcement' ? '公告正文' : focus.sectionKind === 'attachment' ? '附件摘要' : '站点噪声'}</div>
          </div>
        </div>
      )}

      <pre>
        {parts.map((p, i) =>
          p.className ? <mark key={i} className={p.className}>{p.text}</mark> : <span key={i}>{p.text}</span>,
        )}
      </pre>

      <hr className="sep" />
      <h3>本快照全部事实（{facts.length}）</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>类型</th><th>值</th><th>规则</th><th>原文片段</th></tr></thead>
          <tbody>
            {facts.map((f) => (
              <tr key={f.id} style={f.id === focusFactId ? { background: '#fffbe9' } : undefined}>
                <td>{FACT_TYPE_LABELS[f.type]}</td>
                <td className="mono">{f.value}</td>
                <td className="small-text">{f.ruleId}</td>
                <td className="small-text">{f.evidence.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Drawer>
  );
}
