/**
 * IndexedDB 快照仓与派生数据仓储。
 *
 * 库结构（单库 procurement_workbench，版本 1）：
 *  snapshots     keyPath=id，contentHash 唯一索引
 *  batches       keyPath=id
 *  facts         keyPath=id，snapshotId 索引
 *  edges         keyPath=id
 *  adjudications keyPath=id，edgeId 索引
 *  withdrawn     keyPath=edgeId
 *  publications  keyPath=id，version 索引
 *  meta          keyPath=id（单条 'meta'）
 *
 * 全部数据驻留浏览器本地，无任何网络请求，满足离线运行。
 */
import type {
  Adjudication,
  Fact,
  ImportBatch,
  Publication,
  RelationEdge,
  Snapshot,
  WithdrawnEdgeRecord,
} from './types';
import type { EngineMeta } from './engine';

const DB_NAME = 'procurement_workbench';
const DB_VERSION = 1;
const STORES = [
  'snapshots',
  'batches',
  'facts',
  'edges',
  'adjudications',
  'withdrawn',
  'publications',
  'meta',
] as const;
type StoreName = (typeof STORES)[number];

export interface Repository {
  getAllSnapshots(): Promise<Snapshot[]>;
  getSnapshot(id: string): Promise<Snapshot | undefined>;
  getSnapshotByContentHash(hash: string): Promise<Snapshot | undefined>;
  putSnapshot(snapshot: Snapshot): Promise<void>;
  putBatch(batch: ImportBatch): Promise<void>;
  getAllBatches(): Promise<ImportBatch[]>;

  getAllFacts(): Promise<Fact[]>;
  putFacts(facts: Fact[]): Promise<void>;
  replaceAllFacts(facts: Fact[]): Promise<void>;

  getAllEdges(): Promise<RelationEdge[]>;
  putEdge(edge: RelationEdge): Promise<void>;
  replaceAllEdges(edges: RelationEdge[]): Promise<void>;

  putAdjudication(adjudication: Adjudication): Promise<void>;
  getAllAdjudications(): Promise<Adjudication[]>;
  getAdjudicationByEdge(edgeId: string): Promise<Adjudication | undefined>;

  putWithdrawn(record: WithdrawnEdgeRecord): Promise<void>;
  getAllWithdrawn(): Promise<WithdrawnEdgeRecord[]>;

  putPublication(publication: Publication): Promise<void>;
  getLatestPublication(): Promise<Publication | null>;
  getAllPublications(): Promise<Publication[]>;

  getMeta(): Promise<EngineMeta | null>;
  putMeta(meta: EngineMeta): Promise<void>;

  /** 测试与“清空重建”使用 */
  clearAll(): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('snapshots')) {
        const snap = db.createObjectStore('snapshots', { keyPath: 'id' });
        snap.createIndex('contentHash', 'contentHash', { unique: true });
      }
      if (!db.objectStoreNames.contains('batches')) db.createObjectStore('batches', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('facts')) {
        const facts = db.createObjectStore('facts', { keyPath: 'id' });
        facts.createIndex('snapshotId', 'snapshotId', { unique: false });
      }
      if (!db.objectStoreNames.contains('edges')) db.createObjectStore('edges', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('adjudications')) {
        const adj = db.createObjectStore('adjudications', { keyPath: 'id' });
        adj.createIndex('edgeId', 'edgeId', { unique: false });
      }
      if (!db.objectStoreNames.contains('withdrawn')) db.createObjectStore('withdrawn', { keyPath: 'edgeId' });
      if (!db.objectStoreNames.contains('publications')) {
        const pub = db.createObjectStore('publications', { keyPath: 'id' });
        pub.createIndex('version', 'version', { unique: true });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbRepository implements Repository {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = openDb();
  }

  private tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.dbPromise.then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const transaction = db.transaction(store, mode);
          const req = fn(transaction.objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  private async bulkPut(store: StoreName, items: object[]): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readwrite');
      const os = transaction.objectStore(store);
      for (const item of items) os.put(item);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private async clearStore(store: StoreName): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readwrite');
      transaction.objectStore(store).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private getAll<T>(store: StoreName): Promise<T[]> {
    return this.tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  }

  // snapshots
  getAllSnapshots() {
    return this.getAll<Snapshot>('snapshots');
  }
  getSnapshot(id: string) {
    return this.tx<Snapshot | undefined>('snapshots', 'readonly', (s) => s.get(id) as IDBRequest<Snapshot | undefined>);
  }
  getSnapshotByContentHash(hash: string) {
    return this.dbPromise.then(
      (db) =>
        new Promise<Snapshot | undefined>((resolve, reject) => {
          const tx = db.transaction('snapshots', 'readonly');
          const req = tx.objectStore('snapshots').index('contentHash').get(hash);
          req.onsuccess = () => resolve(req.result as Snapshot | undefined);
          req.onerror = () => reject(req.error);
        }),
    );
  }
  async putSnapshot(snapshot: Snapshot) {
    await this.bulkPut('snapshots', [snapshot]);
  }
  putBatch(batch: ImportBatch) {
    return this.bulkPut('batches', [batch]);
  }
  getAllBatches() {
    return this.getAll<ImportBatch>('batches');
  }

  // facts
  getAllFacts() {
    return this.getAll<Fact>('facts');
  }
  async putFacts(facts: Fact[]) {
    if (facts.length) await this.bulkPut('facts', facts);
  }
  async replaceAllFacts(facts: Fact[]) {
    await this.clearStore('facts');
    if (facts.length) await this.bulkPut('facts', facts);
  }

  // edges
  getAllEdges() {
    return this.getAll<RelationEdge>('edges');
  }
  async putEdge(edge: RelationEdge) {
    await this.bulkPut('edges', [edge]);
  }
  async replaceAllEdges(edges: RelationEdge[]) {
    await this.clearStore('edges');
    if (edges.length) await this.bulkPut('edges', edges);
  }

  // adjudications
  async putAdjudication(adjudication: Adjudication) {
    await this.bulkPut('adjudications', [adjudication]);
  }
  getAllAdjudications() {
    return this.getAll<Adjudication>('adjudications');
  }
  getAdjudicationByEdge(edgeId: string) {
    return this.dbPromise.then(
      (db) =>
        new Promise<Adjudication | undefined>((resolve, reject) => {
          const tx = db.transaction('adjudications', 'readonly');
          const req = tx.objectStore('adjudications').index('edgeId').getAll(edgeId);
          req.onsuccess = () => {
            const list = req.result as Adjudication[];
            resolve(list.sort((a, b) => b.createdAt - a.createdAt)[0]);
          };
          req.onerror = () => reject(req.error);
        }),
    );
  }

  // withdrawn
  async putWithdrawn(record: WithdrawnEdgeRecord) {
    await this.bulkPut('withdrawn', [record]);
  }
  getAllWithdrawn() {
    return this.getAll<WithdrawnEdgeRecord>('withdrawn');
  }

  // publications
  async putPublication(publication: Publication) {
    await this.bulkPut('publications', [publication]);
  }
  async getLatestPublication(): Promise<Publication | null> {
    const all = await this.getAll<Publication>('publications');
    if (!all.length) return null;
    return all.sort((a, b) => b.version - a.version)[0];
  }
  getAllPublications() {
    return this.getAll<Publication>('publications');
  }

  // meta
  async getMeta(): Promise<EngineMeta | null> {
    return this.tx<EngineMeta | undefined>('meta', 'readonly', (s) => s.get('meta') as IDBRequest<EngineMeta | undefined>).then(
      (v) => v ?? null,
    );
  }
  async putMeta(meta: EngineMeta) {
    await this.bulkPut('meta', [meta]);
  }

  async clearAll() {
    for (const store of STORES) await this.clearStore(store);
  }
}
