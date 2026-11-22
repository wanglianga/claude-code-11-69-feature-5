/**
 * 真实 IndexedDB 仓储集成测试（fake-indexeddb 提供浏览器同名 API），
 * 验证 IndexedDbRepository + WorkbenchEngine 全链路：
 * 导入 → 重算发布 → 裁决 → 增量 → 复跑 → 清空。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IndexedDbRepository } from './repository';
import { WorkbenchEngine, type ImportFileInput } from './engine';

const SAMPLE_DIR = join(process.cwd(), 'sample-archive');
const samples: ImportFileInput[] = readdirSync(SAMPLE_DIR)
  .filter((f) => f.endsWith('.txt'))
  .map((fileName) => ({ fileName, text: readFileSync(join(SAMPLE_DIR, fileName), 'utf-8') }));

let t = 1_710_000_000_000;
const clock = () => t;

describe('IndexedDbRepository 端到端', () => {
  it('完整工作流持久化与重开等价', async () => {
    const repo = new IndexedDbRepository();
    const engine = new WorkbenchEngine(repo, undefined, clock);

    t += 1000;
    const batch = await engine.importBatch('IDB批次', samples);
    expect(batch.inputCount).toBe(12);

    const pub1 = await engine.recomputeAndPublish('full');
    expect(pub1.projects.length).toBeGreaterThan(0);
    expect(pub1.computeMode).toBe('full');

    // 裁决全部待确认非冲突边
    for (const e of await repo.getAllEdges()) {
      if (e.status === 'pending' && e.type !== 'conflict') {
        t += 1;
        await engine.adjudicate({
          edgeId: e.id, decision: 'confirm', note: 'IDB 集成测试确认',
          reviewer: 'idb-tester', appliedFactIds: e.evidenceFactIds,
        });
      }
    }
    const pub2 = await engine.recomputeAndPublish('incremental');
    const zj = pub2.projects.find((p) => p.projectCode === 'ZC2024-017');
    expect(zj).toBeTruthy();
    expect(zj!.stageChain.map((n) => n.stage)).toContain('result');

    // 模拟“重开应用”：新建仓储实例访问同一 IndexedDB 数据
    const repo2 = new IndexedDbRepository();
    const snapshots2 = await repo2.getAllSnapshots();
    const facts2 = await repo2.getAllFacts();
    const edges2 = await repo2.getAllEdges();
    const adjs2 = await repo2.getAllAdjudications();
    const pubs2 = await repo2.getAllPublications();
    expect(snapshots2.length).toBe(12);
    expect(facts2.length).toBeGreaterThan(0);
    expect(edges2.length).toBeGreaterThan(0);
    expect(adjs2.length).toBeGreaterThan(0);
    expect(pubs2.length).toBe(2);

    const engine2 = new WorkbenchEngine(repo2, undefined, clock);
    const report = await engine2.replay();
    expect(report.equal).toBe(true);

    await repo2.clearAll();
    expect((await repo2.getAllSnapshots()).length).toBe(0);
    expect(await repo2.getLatestPublication()).toBeNull();
  }, 30000);
});
