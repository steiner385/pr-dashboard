// Fleet leaderboard (spec 001, Group N1 / FR-041). Pure cross-pipeline comparison
// from the live state — ranks repos by the signals the live tier carries (flaky
// checks, open PRs). A comparative lens distinct from the attention-sorted rollup
// (which answers "what's on fire now"); this answers "which pipeline is worst
// over time". Cross-repo period deltas need Tier-3 history (Tune) — out of scope here.
import type { DashboardState } from '../../types';

export interface LeaderboardRow { repo: string; flakyChecks: number; openPrs: number }

/** Repos ranked flakiest-first (then busiest). */
export function fleetLeaderboard(state: DashboardState): LeaderboardRow[] {
  return state.repos
    .map((r): LeaderboardRow => ({ repo: r.repo, flakyChecks: r.flake?.flakyCount ?? 0, openPrs: r.prs.length }))
    .sort((a, b) => b.flakyChecks - a.flakyChecks || b.openPrs - a.openPrs || a.repo.localeCompare(b.repo));
}
