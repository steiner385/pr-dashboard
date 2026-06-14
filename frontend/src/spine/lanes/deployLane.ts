import type { DashboardState, LaneStatus } from '../../types';

/**
 * Advisory Deploy-lane derivation (Spec 2). Reliable signals only — NEVER
 * red/amber: deploy state is not a CI failure and manual-prod drift is
 * expected. The lane is rendered gating:false and (when no deploy data) as
 * wiredness:'not-wired' so it is excluded from the rollup.
 *
 *  - No repo carries a `deploy` field → 'blind' / 'not wired'.
 *  - No env across repos is reachable → 'blind' (can't tell what's live).
 *  - Otherwise 'green', summarising the live shas + the awaiting-prod drift.
 */
export function deployLane(repos: DashboardState['repos']): { status: LaneStatus; summary: string } {
  const deploys = repos.map((r) => r.deploy).filter(Boolean) as NonNullable<DashboardState['repos'][number]['deploy']>[];
  if (deploys.length === 0) return { status: 'blind', summary: 'not wired — no deploy environments' };

  const envs = deploys.flatMap((d) => d.envs);
  const reachable = envs.filter((e) => e.reachable);
  if (reachable.length === 0) return { status: 'blind', summary: 'no signal — /health unreachable' };

  const awaitingProd = deploys.reduce((n, d) => n + d.awaitingProd, 0);
  const short = (sha: string | null) => (sha ? sha.slice(0, 6) : '—');
  const envParts = reachable.map((e) => `${e.name} ${short(e.liveSha)}`);
  const parts = [...envParts];
  if (awaitingProd > 0) parts.push(`${awaitingProd} awaiting prod`);
  return { status: 'green', summary: parts.join(' · ') };
}
