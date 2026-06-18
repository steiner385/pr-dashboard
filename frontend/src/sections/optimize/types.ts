// Minimal frontend mirror of the server DerivedModel (spec 001) — only the fields
// the Optimize/IDE surface reads. The server is the source of truth; this is a
// structural view of its JSON, intentionally loose to tolerate payload growth.
export interface TierLike { id: string; label: string; event: string }
export interface CellLike {
  check: string; tierId: string;
  intent: { runs: boolean; gates: boolean; conditional: boolean };
  observed: { runs: number; minutes: number; realFailures: number; flakeRatePct: number } | null;
  state: string;
  drift?: boolean;
}
export interface CheckMetaLike { check: string; isRequiredMergeGate: boolean; provenance: { file: string; jobId: string }[]; needs?: string[] }
export interface DerivedModelLike {
  tiers: TierLike[];
  checks: string[];
  cells: CellLike[];
  checkMeta: CheckMetaLike[];
}
