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
