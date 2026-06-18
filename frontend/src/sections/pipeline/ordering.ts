// Pipeline ordering (roadmap 1.3) — the PR pipeline must lead with what needs eyes,
// not bury 3 running/overdue PRs under 48 identical "awaiting prod" rows. Pure +
// testable. `attentionSort` ranks failed > running > queued > idle > deploy (with
// overdue bumping a PR up within its tier); `splitCohort` peels the non-overdue
// awaiting-prod herd into a collapsible cohort so the lead stays scannable.
import type { PrView } from '../../types';
import { bucketPr, type Bucket } from '../../StatusStrip';

const RANK: Record<Bucket, number> = { failed: 0, running: 1, queued: 2, idle: 3, deploy: 4 };

/** Lower = needs more attention. Overdue bumps up by half a tier. */
export function attentionRank(pr: PrView): number {
  const base = RANK[bucketPr(pr)];
  return pr.stage.overdue ? base - 0.5 : base;
}

export function attentionSort(prs: PrView[]): PrView[] {
  return [...prs].sort((a, b) => attentionRank(a) - attentionRank(b) || a.number - b.number);
}

/** The collapsible "awaiting prod" set: merged PRs awaiting the prod deploy that are
 *  NOT overdue (overdue ones stay in the lead — they need attention). */
function inCohort(pr: PrView): boolean {
  return bucketPr(pr) === 'deploy' && !pr.stage.overdue;
}

export function splitCohort(prs: PrView[]): { lead: PrView[]; cohort: PrView[] } {
  return {
    lead: attentionSort(prs.filter((p) => !inCohort(p))),
    cohort: prs.filter(inCohort),
  };
}

/** Split a deploy cohort into its disjoint stages so the two aren't lumped under
 *  one "awaiting prod" label: a PR still rolling out to QA (`qa-deploy`) is
 *  awaiting QA; one live on QA but not prod (`awaiting-prod`) is awaiting prod. */
export function deployBreakdown(prs: PrView[]): { awaitingQa: number; awaitingProd: number } {
  let awaitingQa = 0;
  let awaitingProd = 0;
  for (const p of prs) {
    if (p.stage.stage === 'qa-deploy') awaitingQa += 1;
    else if (p.stage.stage === 'awaiting-prod') awaitingProd += 1;
  }
  return { awaitingQa, awaitingProd };
}
