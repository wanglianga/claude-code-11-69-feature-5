/** UI 使用的聚合状态结构，与 worker getState 返回保持一致 */
import type {
  Adjudication,
  Fact,
  ImportBatch,
  PipelineProgress,
  Publication,
  RelationEdge,
  Snapshot,
  WithdrawnEdgeRecord,
} from '../core/types';
import type { EngineMeta } from '../core/engine';

export interface WorkbenchState {
  snapshots: Snapshot[];
  batches: ImportBatch[];
  facts: Fact[];
  edges: RelationEdge[];
  adjudications: Adjudication[];
  withdrawn: WithdrawnEdgeRecord[];
  publications: Publication[];
  latestPublication: Publication | null;
  meta: EngineMeta | null;
  versions: { PARSER_VERSION: string; EXTRACTOR_VERSION: string; EVALUATOR_VERSION: string };
}

export type { PipelineProgress };
