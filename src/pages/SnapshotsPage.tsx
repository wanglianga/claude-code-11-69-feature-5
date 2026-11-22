import { useMemo, useState } from 'react';
import type { Fact, Snapshot } from '../core/types';
import { EvidenceDrawer } from '../components/EvidenceDrawer';
import { Badge, Empty } from '../components/ui';
import { FACT_TYPE_LABELS, fileNameOf, formatTime, shortHash } from '../state/labels';

export function SnapshotsPage(props: { snapshots: Snapshot[]; facts: Fact[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.snapshots;
    return props.snapshots.filter(
      (s) =>
        fileNameOf(s).toLowerCase().includes(q) ||
        s.contentHash.includes(q) ||
        s.rawText.toLowerCase().includes(q),
    );
  }, [props.snapshots, query]);

  const open = openId ? props.snapshots.find((s) => s.id === openId) ?? null : null;
  const openFacts = open ? props.facts.filter((f) => f.snapshotId === open.id) : [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>快照仓与证据定位</h2>
          <div className="desc">
            每条快照保存来源记录、SHA-256 内容指纹、规范化指纹、解析版本与原文；点击“查看证据”可在原文上定位全部事实片段。
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="flex">
          <input placeholder="按文件名 / 指纹 / 正文内容检索…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 360 }} />
          <span className="spacer" />
          <span className="muted small-text">共 {props.snapshots.length} 个快照，{props.facts.length} 条事实</span>
        </div>
      </div>

      <div className="panel">
        {filtered.length === 0 ? <Empty text="没有匹配的快照" /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>来源文件</th><th>内容指纹</th><th>结构（正文/附件/噪声）</th><th>事实数</th><th>导入时间</th><th></th></tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const facts = props.facts.filter((f) => f.snapshotId === s.id);
                  const ann = s.parsed.sections.filter((x) => x.kind === 'announcement').length;
                  const att = s.parsed.sections.filter((x) => x.kind === 'attachment').length;
                  return (
                    <tr key={s.id}>
                      <td>
                        <div>{fileNameOf(s)}</div>
                        {s.sources.length > 1 && <Badge className="duplicate">{s.sources.length} 个来源合并</Badge>}
                        <div className="small-text muted">{s.sources.map((x) => x.batchId).join('、')}</div>
                      </td>
                      <td className="hash">{shortHash(s.contentHash)}<div>{shortHash(s.normalizedHash)}（规范化）</div></td>
                      <td className="small-text">
                        正文 {ann} · 附件 {att} · 噪声 {s.parsed.noiseSpans.length}
                        <div>解析版本 {s.parsed.parserVersion}</div>
                      </td>
                      <td>
                        {facts.length}
                        <div className="tag-list" style={{ marginTop: 4 }}>
                          {[...new Set(facts.map((f) => f.type))].map((t) => (
                            <span key={t} className="badge neutral">{FACT_TYPE_LABELS[t]}</span>
                          ))}
                        </div>
                      </td>
                      <td className="small-text">{formatTime(s.createdAt)}</td>
                      <td><button className="small" onClick={() => setOpenId(s.id)}>查看证据</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && <EvidenceDrawer snapshot={open} facts={openFacts} onClose={() => setOpenId(null)} />}
    </div>
  );
}
