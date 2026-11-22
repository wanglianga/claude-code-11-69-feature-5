import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkerClient } from './workers/workerClient';
import type { WorkbenchState } from './state/state';
import type { ComputeMode, ImportBatch, PipelineProgress, Adjudication, CaseSelectionMode, PolicyCatalog } from './core/types';
import type { ImportFileInput } from './core/engine';
import { INCREMENTAL_THRESHOLD } from './core/engine';
import { DEFAULT_POLICY_CATALOG } from './core/policy';
import { OverviewPage } from './pages/OverviewPage';
import { ImportPage } from './pages/ImportPage';
import { SnapshotsPage } from './pages/SnapshotsPage';
import { AdjudicationPage } from './pages/AdjudicationPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { PipelinePage } from './pages/PipelinePage';
import { SplitAnalysisPage } from './pages/SplitAnalysisPage';

type NavKey = 'overview' | 'import' | 'snapshots' | 'adjudication' | 'projects' | 'split' | 'pipeline';

const NAV: { key: NavKey; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'import', label: '快照导入' },
  { key: 'snapshots', label: '快照与证据' },
  { key: 'adjudication', label: '关系裁决' },
  { key: 'projects', label: '项目发布' },
  { key: 'split', label: '拆分采购分析' },
  { key: 'pipeline', label: '计算流水线' },
];

export default function App() {
  const clientRef = useRef<WorkerClient | null>(null);
  if (!clientRef.current) clientRef.current = new WorkerClient();
  const client = clientRef.current;

  const [nav, setNav] = useState<NavKey>('overview');
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'error' | 'success' } | null>(null);

  const showToast = useCallback((text: string, kind: 'info' | 'error' | 'success' = 'info') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refresh = useCallback(async () => {
    const next = (await client.call('getState', undefined)) as WorkbenchState;
    setState(next);
  }, [client]);

  useEffect(() => {
    const off = client.onProgress(setProgress);
    refresh().catch((e) => showToast(e.message, 'error'));
    return () => { off(); };
  }, [client, refresh, showToast]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const result = await fn();
        await refresh();
        if (success) showToast(success, 'success');
        return result;
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [refresh, showToast],
  );

  const handleImport = (label: string, files: ImportFileInput[]) =>
    run(() => client.call('importBatch', { label, files }) as Promise<ImportBatch>, '批次导入完成');

  const handleAdjudicate = async (input: {
    edgeId: string;
    decision: Adjudication['decision'];
    note: string;
    reviewer: string;
    appliedFactIds: string[];
  }): Promise<void> => {
    await run(() => client.call('adjudicate', input), '裁决已保存');
  };

  const handleRecompute = async (mode: ComputeMode | 'auto'): Promise<void> => {
    await run(() => client.call('recompute', { mode }), `重算与发布完成（${mode}）`);
  };

  const handleSelectionMode = async (mode: CaseSelectionMode): Promise<void> => {
    await run(() => client.call('setSplitSelectionMode', { mode }), `候选呈现策略：${mode === 'recall' ? '召回优先' : '有限容量'}`);
  };

  const handlePolicyCatalog = async (catalog: PolicyCatalog, label: string): Promise<void> => {
    await run(() => client.call('setPolicyCatalog', { catalog }), `政策目录已切换：${label}（重算后生效）`);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>采购归档证据图工作台</h1>
        <p className="subtitle">本地 · 离线 · 可复算</p>
        {NAV.map((n) => (
          <button key={n.key} className={`nav-btn ${nav === n.key ? 'active' : ''}`} onClick={() => setNav(n.key)}>
            {n.label}
          </button>
        ))}
        <div className="footer">
          React + TypeScript<br />IndexedDB + WebWorker<br />所有数据不离开浏览器
        </div>
      </aside>

      <main className="main">
        {nav === 'overview' && <OverviewPage state={state} />}
        {nav === 'import' && (
          <ImportPage busy={busy} progress={progress} onImport={handleImport} batches={state?.batches ?? []} />
        )}
        {nav === 'snapshots' && state && <SnapshotsPage snapshots={state.snapshots} facts={state.facts} />}
        {nav === 'adjudication' && state && (
          <AdjudicationPage
            edges={state.edges}
            snapshots={state.snapshots}
            facts={state.facts}
            adjudications={state.adjudications}
            withdrawn={state.withdrawn}
            busy={busy}
            onAdjudicate={handleAdjudicate}
          />
        )}
        {nav === 'projects' && state && (
          <ProjectsPage publications={state.publications} snapshots={state.snapshots} facts={state.facts} />
        )}
        {nav === 'split' && state && (
          <SplitAnalysisPage
            publications={state.publications}
            snapshots={state.snapshots}
            facts={state.facts}
            policyCatalog={state.meta?.policyCatalog ?? DEFAULT_POLICY_CATALOG}
            selectionMode={state.meta?.splitSelectionMode ?? 'recall'}
            busy={busy}
            onSelectionMode={handleSelectionMode}
            onPolicyCatalog={handlePolicyCatalog}
            onRecompute={() => handleRecompute('full')}
          />
        )}
        {nav === 'pipeline' && state && (
          <PipelinePage
            busy={busy}
            progress={progress}
            onRecompute={handleRecompute}
            onCheck={() => run(() => client.call('checkConsistency', undefined) as Promise<any>)}
            onReplay={() => run(() => client.call('replay', undefined) as Promise<any>)}
            onClear={() => run(async () => { await client.call('clearAll', undefined); }, '本地数据已清空')}
            publications={state.publications}
            threshold={INCREMENTAL_THRESHOLD}
            snapshotCount={state.snapshots.length}
          />
        )}
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
