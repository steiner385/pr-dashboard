// Auto-remediation proposals (spec roadmap 5.5). The flake-vs-real overlay
// (blockingCheck) tells you which single PR is held by a flake; this composes the
// FLEET-WIDE pattern into an actionable proposal: a REQUIRED gate that is failing
// as a likely flake across multiple open PRs is blocking merges without signalling
// real breakage — the canonical quarantine candidate. Pure over the live state so
// it's testable without the act wiring; approval routes through the existing
// quarantine draft-PR flow (Optimize), keeping a human in the loop.
import type { DashboardState, CheckView } from '../../types';

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);

export interface RemediationProposal {
  check: string;
  /** Distinct open PRs currently failing on this check (blast radius). */
  blockedPrCount: number;
  /** Of those, how many look like flakes (drives the "8/10" framing). */
  flakeCount: number;
  /** Repos the check is failing across, sorted. */
  repos: string[];
  isRequired: boolean;
  /** One-line why-this-fires, naming the flake ratio and blast radius. */
  rationale: string;
  /** The recommended governed action (executed via the quarantine flow). */
  action: string;
}

/**
 * Compose ranked quarantine proposals from the live state. A check qualifies only
 * when it is (a) a required gate, (b) blocking ≥ `minBlocked` distinct PRs, and
 * (c) failing as a likely flake on a MAJORITY of those — so a genuinely-failing
 * gate is never proposed for quarantine. Ranked by blast radius (PRs blocked).
 */
export function remediationProposals(state: DashboardState, minBlocked = 2,
  quarantined?: ReadonlySet<string>): RemediationProposal[] {
  const byCheck = new Map<string, { prs: Set<string>; flake: number; required: boolean; repos: Set<string> }>();
  for (const r of state.repos) {
    for (const pr of r.prs) {
      const seen = new Set<string>(); // count each check once per PR (shards share a name)
      for (const c of pr.checks as CheckView[]) {
        if (c.conclusion == null || !FAILED.has(c.conclusion) || seen.has(c.name)) continue;
        seen.add(c.name);
        const e = byCheck.get(c.name) ?? { prs: new Set<string>(), flake: 0, required: false, repos: new Set<string>() };
        e.prs.add(`${pr.repo}#${pr.number}`);
        if (c.likelyFlake) e.flake++;
        if (c.isRequired) e.required = true;
        e.repos.add(pr.repo);
        byCheck.set(c.name, e);
      }
    }
  }

  const proposals: RemediationProposal[] = [];
  for (const [check, e] of byCheck) {
    if (quarantined?.has(check)) continue; // already quarantined (roadmap 4.5) — don't re-propose
    const blocked = e.prs.size;
    if (!e.required || blocked < minBlocked) continue;
    if (e.flake < 2 || e.flake / blocked < 0.5) continue; // majority must look flaky
    proposals.push({
      check, blockedPrCount: blocked, flakeCount: e.flake, repos: [...e.repos].sort(), isRequired: true,
      rationale: `Required gate “${check}” is failing as a likely flake on ${e.flake}/${blocked} blocked PR${blocked === 1 ? '' : 's'}${e.repos.size > 1 ? ` across ${e.repos.size} repos` : ''} — blocking merges without signalling real breakage.`,
      action: 'Quarantine 48h (continue-on-error) and open a fix issue.',
    });
  }
  return proposals.sort((a, b) => b.blockedPrCount - a.blockedPrCount || a.check.localeCompare(b.check));
}
