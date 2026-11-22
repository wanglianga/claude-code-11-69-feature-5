import { useRef, useState } from 'react';
import type { ImportBatch, PipelineProgress } from '../core/types';
import type { ImportFileInput } from '../core/engine';
import { SAMPLE_FILES, SPLIT_SAMPLE_FILES } from '../state/samples';

export function ImportPage(props: {
  busy: boolean;
  progress: PipelineProgress | null;
  onImport: (label: string, files: ImportFileInput[]) => Promise<ImportBatch | undefined>;
  batches: ImportBatch[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState(`导入批次 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  const [picked, setPicked] = useState<ImportFileInput[]>([]);

  async function readFiles(fileList: FileList | null): Promise<ImportFileInput[]> {
    if (!fileList) return [];
    const out: ImportFileInput[] = [];
    for (const file of Array.from(fileList)) {
      // 批次载荷在启动时一次性读完并冻结；解析期间替换源文件不会影响本批
      const text = await file.text();
      out.push({ fileName: file.name, text });
    }
    return out;
  }

  async function submit(files: ImportFileInput[], batchLabel: string) {
    if (!files.length) return;
    const batch = await props.onImport(batchLabel, files);
    if (batch) setPicked([]);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>快照仓导入</h2>
          <div className="desc">
            批次启动时冻结导入载荷：解析期间替换源文件不影响本批，新文件进入后续批次；
            相同内容指纹（SHA-256）自动合并来源记录，不会产生两个项目。
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>① 选择本地归档文本（.txt，可多选）</h3>
        <input
          ref={inputRef}
          type="file"
          accept=".txt,text/plain"
          multiple
          style={{ display: 'none' }}
          onChange={async (e) => setPicked(await readFiles(e.target.files))}
        />
        <div className="flex">
          <button onClick={() => inputRef.current?.click()}>选择文件…</button>
          <button onClick={() => setPicked(SAMPLE_FILES.map((f) => ({ ...f })))}>
            一键载入 12 份虚构示例归档
          </button>
          <button onClick={() => setPicked(SPLIT_SAMPLE_FILES.map((f) => ({ ...f })))}>
            一键载入 16 份「疑似拆分采购」样例
          </button>
        </div>
        <label>批次标签</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
        <div style={{ marginTop: 10 }} className="flex">
          <button className="primary" disabled={props.busy || picked.length === 0} onClick={() => submit(picked, label)}>
            ② 导入 {picked.length} 份文件（{picked.length} 份已冻结读取）
          </button>
          <span className="muted small-text">
            已选：{picked.slice(0, 4).map((f) => f.fileName).join('、')}{picked.length > 4 ? ` 等 ${picked.length} 份` : ''}
          </span>
        </div>
        {props.progress && props.progress.phase !== 'idle' && (
          <div style={{ marginTop: 12 }}>
            <div className="small-text muted">{props.progress.message}（{props.progress.current}/{props.progress.total}）</div>
            <div className="progress">
              <div style={{ width: `${props.progress.total ? (props.progress.current / props.progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>导入批次记录</h3>
        {props.batches.length === 0 ? (
          <div className="muted">尚无批次</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>批次</th><th>时间</th><th>输入</th><th>新建快照</th><th>合并来源</th><th>推迟</th><th>快照 id</th></tr>
              </thead>
              <tbody>
                {props.batches.map((b) => (
                  <tr key={b.id}>
                    <td>{b.label}</td>
                    <td className="small-text">{new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td>{b.inputCount}</td>
                    <td>{b.newSnapshotCount}</td>
                    <td>{b.mergedCount}</td>
                    <td>{b.deferredCount}</td>
                    <td className="hash">{b.snapshotIds.length} 个</td>
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
