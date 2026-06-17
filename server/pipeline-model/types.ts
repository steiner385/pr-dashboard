/** Confidence in a statically-derived fact. 'low' means a construct could not be
 *  fully resolved (complex if:, unexpandable matrix, unresolved uses:) and the
 *  broadest interpretation was kept (spec §5.5: parse gaps → drift, not failure). */
export type Confidence = 'high' | 'low';

export type TriggerEvent =
  | { kind: 'pull_request' }
  | { kind: 'merge_group' }
  | { kind: 'push'; branches?: string[] }
  | { kind: 'schedule'; cron: string }
  | { kind: 'workflow_dispatch' }
  | { kind: 'workflow_run'; workflows: string[]; types: string[] };

export interface TriggerSpec {
  events: TriggerEvent[];
}

/** One job exactly as written in a single workflow file, before any expansion. */
export interface RawJob {
  /** The job key under `jobs:`. */
  id: string;
  /** The `name:` field, or null. */
  name: string | null;
  /** `needs:` normalized to an array (string form → single element). */
  needs: string[];
  /** Raw `if:` expression string, or null. */
  if: string | null;
  /** Reusable-workflow path from `uses:` (e.g. `./.github/workflows/_x.yml`), or null. */
  uses: string | null;
  /** `strategy.matrix` dimensions (dim → values), or null. Raw values kept verbatim. */
  matrix: Record<string, unknown[]> | null;
}

/** The concrete matrix values for one expanded job instance (dim → value). */
export type MatrixCoord = Record<string, unknown>;

/** One step in the path from a check to its definition. */
export interface ProvenanceAnchor {
  file: string;                 // workflow basename, e.g. 'ci.yml'
  jobId: string;                // job key in that file
  matrixCoord?: MatrixCoord;    // present for matrix-expanded instances
}

/** A concrete leaf check (one GitHub check run name), after uses+matrix expansion. */
export interface CheckNode {
  checkName: string;            // GitHub check display name (best-effort)
  callerJobId: string;          // the rollup-file job that owns this leaf
  triggers: TriggerSpec;        // owning workflow triggers, narrowed by caller if:
  provenance: ProvenanceAnchor[];
  confidence: Confidence;
}

export interface StaticGraph {
  rollupFile: string;
  checks: CheckNode[];
  /** caller (rollup-file) jobId → its needs (for the gating closure). */
  callerNeeds: Record<string, string[]>;
}
