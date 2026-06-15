/**
 * Pure cost-model optimizer for routing CI jobs to spot vs on-demand runners.
 * No I/O — consumed by a controller that has already gathered p90 duration
 * history and the current spot reclaim rate.
 */

export const SPOT = 'kindash-arc-spot';
export const ONDEMAND = 'kindash-arc';
export type RunnerLabel = typeof SPOT | typeof ONDEMAND;

/** The PR-tier job keys ci.yml routes. Each maps to a regex over the check NAME
 *  used in history (shards collapse to one key). KEEP IN SYNC with ci.yml. */
export const RUNNER_JOB_KEYS = {
  unit:         /\btest: unit\b/i,
  integration:  /\btest: integration\b/i,
  server:       /\btest: server\b/i,
  tsc:          /\btypes: tsc\b/i,
  build:        /\bbuild: production\b/i,
  'build-test': /\bbuild: test bundle\b/i,
  db:           /\bdb: migrations\b/i,
  eslint:       /\blint: eslint\b/i,
  security:     /\bsecurity: audit\b/i,
} as const;
export type RunnerJobKey = keyof typeof RUNNER_JOB_KEYS;

export interface RunnerJobInput { key: string; p90Secs: number | null; }
export interface RunnerPlanConfig {
  shedThresholdMinutes: number;
  overrides: Record<string, 'spot' | 'ondemand'>;
}
export interface PlanRow {
  key: string; p90Secs: number | null; scoreMinutes: number;
  decision: RunnerLabel; reason: string; source: 'auto' | 'override'; collecting: boolean;
}
export interface RunnerPlan { map: Record<string, RunnerLabel>; plan: PlanRow[]; }

/** Cost model: a job sheds to on-demand when a reclaim would be expected to waste
 *  >= shedThreshold minutes of it. reclaimRate is a FRACTION (0..1); null = 0. */
export function computeRunnerPlan(
  jobs: RunnerJobInput[], reclaimRate: number | null, cfg: RunnerPlanConfig): RunnerPlan {
  const rate = reclaimRate == null || !Number.isFinite(reclaimRate) ? 0 : Math.max(0, reclaimRate);
  const map: Record<string, RunnerLabel> = {};
  const plan: PlanRow[] = jobs.map((j) => {
    const override = cfg.overrides[j.key];
    if (override === 'spot' || override === 'ondemand') {
      const decision = override === 'ondemand' ? ONDEMAND : SPOT;
      if (decision === ONDEMAND) map[j.key] = ONDEMAND;
      return { key: j.key, p90Secs: j.p90Secs, scoreMinutes: 0, decision,
        reason: `manual override → ${override}`, source: 'override', collecting: j.p90Secs == null };
    }
    if (j.p90Secs == null) {
      return { key: j.key, p90Secs: null, scoreMinutes: 0, decision: SPOT,
        reason: 'no duration history yet — staying on spot', source: 'auto', collecting: true };
    }
    const scoreMinutes = (rate * j.p90Secs) / 60;
    const onDemand = scoreMinutes >= cfg.shedThresholdMinutes;
    if (onDemand) map[j.key] = ONDEMAND;
    return { key: j.key, p90Secs: j.p90Secs, scoreMinutes: Math.round(scoreMinutes * 100) / 100,
      decision: onDemand ? ONDEMAND : SPOT,
      reason: onDemand
        ? `${scoreMinutes.toFixed(1)} expected-rework-min ≥ ${cfg.shedThresholdMinutes} → on-demand`
        : `${scoreMinutes.toFixed(1)} expected-rework-min < ${cfg.shedThresholdMinutes} → spot`,
      source: 'auto', collecting: false };
  });
  return { map, plan };
}

/** Canonical (sorted-key) JSON for change-detection hashing. */
export function canonicalMap(map: Record<string, RunnerLabel>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))));
}
