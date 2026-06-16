/**
 * Pure detector for CI checks that should be PROMOTED — shifted left so their
 * failures are caught at an earlier, cheaper tier. The complement of
 * demotion-candidates.ts: demotion moves reliably-green expensive checks DOWN
 * (run less often); promotion moves real-failing checks UP (run earlier).
 *
 * The signal is NOT "fails often" — a check failing at PR time is working as
 * intended (catching bugs at the cheapest point). The candidate is narrower:
 * a **real (non-flaky) failure rate at a LATE tier** (push:main / merge_group)
 * for a check that does **not already run at the earlier tier**.
 *
 * Two rules keep it honest (and distinguish it from the flake lane and the
 * demotion lane):
 *  - FLAKES EXCLUDED. `realFailures` = failing runs that were NOT resolved by a
 *    SUCCESS on the same sha (i.e. a genuine red, fixed on a new sha or still
 *    red) — a flaky check is the flake lane's problem, not a promotion target.
 *  - MERGE-EMERGENT BOUND. A `merge_group` failure can come from two PRs that
 *    each pass at PR time but conflict when merged — that failure only exists
 *    post-merge and can't be shifted to the PR. So a merge_group check that
 *    ALREADY runs on pull_request is NOT promotable (its remaining late
 *    failures are merge-emergent). The strongest, unambiguous case is a
 *    push:main real failure with no merge_group gate → promote to the queue.
 *
 * Promotion is LOWER-risk than demotion: its worst case is wasted cost (running
 * a check earlier that rarely catches anything), never removing a gate. And it
 * is mutually exclusive with demotion by construction — demotion needs ≥99%
 * green, promotion needs a real failure rate.
 */

/** History confidence floor — enough runs for the failure count to mean something. */
export const PROMOTION_MIN_RUNS = 30;
/** A check must have caught at least this many REAL (non-flaky) failures late to
 *  be worth shifting left — filters one-offs. */
export const PROMOTION_MIN_REAL_FAILURES = 3;
/** Cap on rows surfaced (advisory panel). */
export const PROMOTION_TOP_N = 12;

/**
 * Per-(check, event) failure aggregate over the metrics window. `realFailures`
 * is failing distinct-(sha, attempt) runs MINUS same-sha-resolved flakes (the
 * caller computes it by joining successStats with the flake engine).
 * `sumDurationSecs` is the runner-seconds spent — used only as a tiebreak.
 */
export interface PromotionStat {
  name: string;
  event: string;
  totalRuns: number;
  realFailures: number;
  sumDurationSecs: number;
}

export interface PromotionCandidate {
  name: string;
  event: string;
  currentTier: string;
  suggestedTier: string;
  /** Real (non-flaky) failures in the window — the rank key. */
  realFailures: number;
  /** Real-failure rate over the window, 1-decimal percent. */
  failRatePct: number;
  runsInWindow: number;
  minutesInWindow: number;
  reason: string;
}

export interface PromotionConfig { minRuns: number; minRealFailures: number; topN: number; }
export const PROMOTION_DEFAULTS: PromotionConfig = {
  minRuns: PROMOTION_MIN_RUNS, minRealFailures: PROMOTION_MIN_REAL_FAILURES, topN: PROMOTION_TOP_N,
};

interface Ladder { currentTier: string; suggestedTier: string; }
/**
 * The earlier tier to shift a late-failing check to, or null when there is no
 * safe/useful promotion:
 *  - push: promote to the merge queue UNLESS it already gates there.
 *  - merge_group: promote to PR UNLESS it already runs on PRs (remaining
 *    failures are merge-emergent — unpreventable upstream).
 *  - pull_request (and anything else): already earliest — nothing to promote.
 */
function promotionTarget(stat: PromotionStat, onMergeGroup: Set<string>, onPr: Set<string>): Ladder | null {
  if (stat.event === 'push') {
    if (onMergeGroup.has(stat.name)) return null;
    return { currentTier: 'every push to main (post-merge)', suggestedTier: 'merge queue (pre-merge gate)' };
  }
  if (stat.event === 'merge_group') {
    if (onPr.has(stat.name)) return null;
    return { currentTier: 'merge queue only', suggestedTier: 'every PR push (catch pre-enqueue)' };
  }
  return null;
}

export function computePromotionCandidates(
  stats: PromotionStat[], cfg: PromotionConfig = PROMOTION_DEFAULTS,
): PromotionCandidate[] {
  // Earlier-tier presence — a check already running there can't be promoted into
  // it. Built from the FULL stats list (presence, not pass/fail).
  const onMergeGroup = new Set(stats.filter((s) => s.event === 'merge_group' && s.totalRuns > 0).map((s) => s.name));
  const onPr = new Set(stats.filter((s) => s.event === 'pull_request' && s.totalRuns > 0).map((s) => s.name));

  const out: PromotionCandidate[] = [];
  for (const s of stats) {
    if (s.totalRuns < cfg.minRuns) continue;
    if (s.realFailures < cfg.minRealFailures) continue;
    const ladder = promotionTarget(s, onMergeGroup, onPr);
    if (!ladder) continue;
    const failRatePct = s.totalRuns ? Math.round((s.realFailures / s.totalRuns) * 1000) / 10 : 0;
    out.push({
      name: s.name,
      event: s.event,
      currentTier: ladder.currentTier,
      suggestedTier: ladder.suggestedTier,
      realFailures: s.realFailures,
      failRatePct,
      runsInWindow: s.totalRuns,
      minutesInWindow: Math.round(s.sumDurationSecs / 60),
      reason: `${s.realFailures} real (non-flaky) failures in ${s.totalRuns} runs (${failRatePct}%) — caught late`,
    });
  }
  // Rank by how often it really fails late (impact), tiebreak by cost then name.
  out.sort((a, b) => b.realFailures - a.realFailures
    || b.minutesInWindow - a.minutesInWindow
    || a.name.localeCompare(b.name));
  return out.slice(0, cfg.topN);
}
