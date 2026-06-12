import { percentile } from '../math';

/**
 * Runner-pool starvation early-warning (issue #45) — the pure threshold math.
 *
 * A pool is STARVING when its last-hour pickup-wait p90 blows past its own
 * 7-day baseline: developers feel pickup waits long before anyone looks at a
 * fleet dashboard, so the alert fires on the leading edge of a cap-saturation
 * spike (live data showed unlabeled 2s→6,430s swings).
 *
 *  - enter:  ≥ STARVATION_MIN_SAMPLES last-hour samples AND last-hour p90 >
 *            max(STARVATION_FLOOR_SECS, STARVATION_ENTER_FACTOR × baseline p90).
 *            The floor makes a brand-new pool (empty baseline → p90 0) alarm
 *            only past 5 minutes of absolute wait — never on relative noise.
 *  - hold (hysteresis): an already-active pool stays active while last-hour
 *            p90 ≥ max(floor, STARVATION_CLEAR_FACTOR × baseline p90) — the
 *            2× clear bar stops enter/exit flapping while a spike decays.
 *            Fewer than MIN samples in the hour still hold (a starving pool
 *            can have few pickups precisely BECAUSE nothing gets picked up);
 *            ZERO samples clears (nothing waiting = recovered or idle).
 *
 * Callers split their wait series themselves: `lastHour` = samples started in
 * the trailing hour, `baseline` = the rest of the 7-day window (excluding the
 * last hour, so a spike never inflates its own baseline).
 */

export const STARVATION_MIN_SAMPLES = 5;
export const STARVATION_FLOOR_SECS = 5 * 60;
export const STARVATION_ENTER_FACTOR = 4;
export const STARVATION_CLEAR_FACTOR = 2;

export interface StarvationEval {
  /** p90 over the last-hour samples; null with no samples. */
  lastHourP90: number | null;
  /** p90 over the 7d baseline samples; null with no samples. */
  baselineP90: number | null;
  /** Last-hour sample count (the min-samples gate input). */
  n: number;
  /** Entry condition met this evaluation. */
  enters: boolean;
  /** Hysteresis condition met (an active pool stays active). */
  holds: boolean;
}

const p90 = (xs: number[]): number | null =>
  xs.length ? percentile([...xs].sort((a, b) => a - b), 0.9) : null;

export function evaluateStarvation(lastHour: number[], baseline: number[]): StarvationEval {
  const lastHourP90 = p90(lastHour);
  const baselineP90 = p90(baseline);
  const base = baselineP90 ?? 0;
  const enterAt = Math.max(STARVATION_FLOOR_SECS, STARVATION_ENTER_FACTOR * base);
  const clearAt = Math.max(STARVATION_FLOOR_SECS, STARVATION_CLEAR_FACTOR * base);
  return {
    lastHourP90, baselineP90, n: lastHour.length,
    enters: lastHour.length >= STARVATION_MIN_SAMPLES
      && lastHourP90 != null && lastHourP90 > enterAt,
    holds: lastHourP90 != null && lastHourP90 >= clearAt,
  };
}

/** Whether a pool is starving NOW, given the fresh eval and the prior state. */
export function nextStarving(e: StarvationEval, wasStarving: boolean): boolean {
  return e.enters || (wasStarving && e.holds);
}

/** Human detail string for the runner-starvation notification + journal. */
export function starvationDetail(pool: string, e: StarvationEval): string {
  const fmt = (s: number): string => s >= 90 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`;
  const base = e.baselineP90 != null ? fmt(e.baselineP90) : 'none';
  return `pool '${pool}' pickup p90 ${fmt(e.lastHourP90 ?? 0)} over the last hour `
    + `(7d baseline ${base}, n=${e.n}) — capacity starvation likely`;
}
