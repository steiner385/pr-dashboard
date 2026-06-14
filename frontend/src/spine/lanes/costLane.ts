import type { DashboardState, LaneStatus } from '../../types';

/** Display label per stage in the percent split (scheduled → 'nightly'). */
const STAGE_LABEL: Record<'pr' | 'queue' | 'main' | 'scheduled', string> = {
  pr: 'PR', queue: 'queue', main: 'main', scheduled: 'nightly',
};

/**
 * Advisory Cost-lane derivation (Spec 3). Cross-cutting, so it reads the
 * top-level `state.cost` (NOT `repos`). NEVER red/amber — cost is advisory and
 * gating:false. Blind (and rendered not-wired → excluded from the rollup) when
 * no rates are configured (no `cost`, or every stage dollar is null —
 * minutes-only mode), so the lane can never show a false $0. Otherwise green
 * with the 7-day total and a priced per-stage percent split.
 */
export function costLane(cost: DashboardState['cost']): { status: LaneStatus; summary: string } {
  const stages = cost?.byStage ?? [];
  const priced = stages.filter((s) => s.dollars != null);
  const total = priced.reduce((sum, s) => sum + (s.dollars ?? 0), 0);
  if (!cost || priced.length === 0 || total <= 0) {
    return { status: 'blind', summary: 'cost — no rates configured' };
  }
  const split = priced
    .map((s) => `${STAGE_LABEL[s.stage]} ${Math.round((s.dollars! / total) * 100)}%`)
    .join(' · ');
  return { status: 'green', summary: `$${Math.round(total)}·${cost.days}d · ${split}` };
}
