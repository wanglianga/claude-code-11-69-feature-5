/**
 * 主线程 RPC 客户端：封装 Worker 消息为 Promise，
 * 并把进度事件推给订阅回调。
 */
import type { PipelineProgress } from '../core/types';
import type { WorkerRequest, WorkerResponse } from './pipeline.worker';

type ReqType = WorkerRequest['type'];
type PayloadOf<T extends ReqType> = Extract<WorkerRequest, { type: T }>['payload'];

export class WorkerClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private progressListeners = new Set<(p: PipelineProgress) => void>();

  constructor() {
    this.worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        this.progressListeners.forEach((fn) => fn(msg.payload));
        return;
      }
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.type === 'result') p.resolve(msg.payload);
      else p.reject(new Error(msg.payload));
    };
    this.worker.onerror = (ev) => {
      for (const [, p] of this.pending) p.reject(new Error(ev.message));
      this.pending.clear();
    };
  }

  onProgress(fn: (p: PipelineProgress) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  call<T extends ReqType>(type: T, payload: PayloadOf<T>): Promise<unknown> {
    const reqId = `req_${(this.seq += 1)}`;
    const req = { reqId, type, payload } as WorkerRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.worker.postMessage(req);
    });
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}
