// Train-killer reason taxonomy (spec roadmap 4.4b). The leaderboard already
// counts ejects per check; this classifies WHY each eject happened from the
// failing check's conclusion, so the surface can lead with the right remedy
// (rerun vs fix) instead of a bare count. Pure + dependency-free.
//
// group_failures only records the three FAILING_CONCLUSIONS (FAILURE/TIMED_OUT/
// STARTUP_FAILURE) — a merge CONFLICT is not a check verdict and is surfaced via
// the separate unmergeable (→ rebase) path, not here.

export type EjectReason = 'timeout' | 'test-fail' | 'infra' | 'unknown';

export interface EjectClassification {
  reason: EjectReason;
  /** The lead remedy an operator should try for this reason. */
  remedy: string;
}

const REMEDY: Record<EjectReason, string> = {
  timeout: 'rerun (raise the timeout if it’s chronic)',
  'test-fail': 'fix the failing check',
  infra: 'rerun (transient runner/setup error)',
  unknown: 'investigate the eject',
};

/** The lead remedy for a reason (the surface shows this next to the eject count). */
export function remedyForReason(reason: EjectReason): string {
  return REMEDY[reason];
}

/** Classify a single eject from its GHA check conclusion (uppercase, as stored). */
export function classifyEject(conclusion: string | null | undefined): EjectClassification {
  const c = (conclusion ?? '').toUpperCase();
  const reason: EjectReason =
    c === 'TIMED_OUT' ? 'timeout'
    : c === 'FAILURE' ? 'test-fail'
    : c === 'STARTUP_FAILURE' ? 'infra'
    : 'unknown';
  return { reason, remedy: REMEDY[reason] };
}

/** Most actionable reason first on ties — a real test-fail is worth surfacing
 *  over a flaky timeout when both occur equally often. */
const TIE_ORDER: EjectReason[] = ['test-fail', 'timeout', 'infra', 'unknown'];

/** The reason to lead with for a check, given its per-reason eject counts.
 *  Returns null when the check has no recorded ejects. */
export function dominantReason(counts: Record<EjectReason, number>): EjectReason | null {
  const total = TIE_ORDER.reduce((s, r) => s + (counts[r] ?? 0), 0);
  if (total === 0) return null;
  return TIE_ORDER.reduce((best, r) =>
    (counts[r] ?? 0) > (counts[best] ?? 0) ? r : best, TIE_ORDER[0]);
}
