import { median } from '../math';

/**
 * Duration-regression detection (issue #41): a rolling-median step test per
 * (repo, check, event) over the SUCCESS duration series in check_durations.
 *
 * The test compares the median of the most recent K=10 SUCCESS samples against
 * the median of the 20 samples before them. A check is flagged when BOTH
 * guards trip: recent/prior ≥ 1.5 (relative step) AND recent − prior ≥ 60s
 * (absolute step) — the pair keeps 3s→5s noise on fast jobs and 20m→22m drift
 * on slow jobs from alerting. Once flagged, the condition HOLDS until the
 * ratio drops below 1.2 (hysteresis), so a regression hovering around the
 * flag threshold doesn't flap notifications.
 *
 * Why medians, not CUSUM: CUSUM needs a tuned reference mean + drift
 * allowance per series and accumulates state between scans; with ~30 samples
 * per check a pair of windowed medians detects the same persistent step,
 * is robust to single spot-retry outliers (house style — every expected
 * duration in this codebase is a median), and stays a pure function of the
 * last 30 samples. The samples themselves are trustworthy post-#61/#64:
 * ingestion drops stall-spanning SUCCESS spans, so a step here is a real
 * runtime change (cache poisoning, dep bump, cold pods), not contamination.
 */

/** One SUCCESS duration sample (newest-first ordering is the caller's contract). */
export interface DurationSample { durationSecs: number; completedAt: string }

/** The step measurement for one (check, event) series. */
export interface StepMeasurement {
  /** Median of the 20 samples preceding the recent window (secs). */
  priorP50: number;
  /** Median of the most recent 10 samples (secs). */
  recentP50: number;
  /** recentP50 / priorP50. */
  ratio: number;
  /** completed_at of the OLDEST sample in the recent window — the approximate
   *  onset of the step ("since Tue 14:00"). */
  sinceApprox: string;
}

/** Recent-window size (newest samples). */
export const REGRESSION_RECENT_K = 10;
/** Prior-window size (the baseline the recent window is compared against). */
export const REGRESSION_PRIOR_N = 20;
/** Minimum total SUCCESS samples before the step test runs. */
export const REGRESSION_MIN_SAMPLES = REGRESSION_RECENT_K + REGRESSION_PRIOR_N;
/** Relative guard: flag only when recentP50/priorP50 reaches this. */
export const REGRESSION_FLAG_RATIO = 1.5;
/** Absolute guard: flag only when recentP50 − priorP50 reaches this (secs). */
export const REGRESSION_FLAG_MIN_DELTA_SECS = 60;
/** Hysteresis: an active regression clears only when the ratio drops below
 *  this — then it is eligible to re-fire. */
export const REGRESSION_CLEAR_RATIO = 1.2;

/**
 * Measure the rolling-median step over a newest-first SUCCESS sample series.
 * Null when there are fewer than REGRESSION_MIN_SAMPLES samples, or the prior
 * median is not positive (degenerate series — ratio would be meaningless).
 * Samples beyond the first K+N are ignored.
 */
export function measureDurationStep(samplesNewestFirst: DurationSample[]): StepMeasurement | null {
  if (samplesNewestFirst.length < REGRESSION_MIN_SAMPLES) return null;
  const recent = samplesNewestFirst.slice(0, REGRESSION_RECENT_K);
  const prior = samplesNewestFirst.slice(REGRESSION_RECENT_K, REGRESSION_MIN_SAMPLES);
  const priorP50 = median(prior.map((s) => s.durationSecs));
  if (!(priorP50 > 0)) return null;
  const recentP50 = median(recent.map((s) => s.durationSecs));
  return {
    priorP50, recentP50,
    ratio: recentP50 / priorP50,
    sinceApprox: recent[recent.length - 1]!.completedAt,
  };
}

/** Entry condition: both guards (relative AND absolute) trip. */
export function flagsRegression(m: StepMeasurement): boolean {
  return m.ratio >= REGRESSION_FLAG_RATIO
    && m.recentP50 - m.priorP50 >= REGRESSION_FLAG_MIN_DELTA_SECS;
}

/** Hold condition for an ALREADY-active regression (hysteresis). */
export function holdsRegression(m: StepMeasurement): boolean {
  return m.ratio >= REGRESSION_CLEAR_RATIO;
}

/** Compact duration for server-rendered detail strings: `45s`, `4m`, `1h 5m`. */
function fmtSecs(secs: number): string {
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600), mins = Math.round((secs % 3600) / 60);
    return mins ? `${h}h ${mins}m` : `${h}h`;
  }
  if (secs >= 60) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs)}s`;
}

/** Human detail line for the notifier:
 *  `p50 4m → 10m (×2.5, merge_group) since 2026-06-12T11:51:00.000Z`. */
export function regressionDetail(m: StepMeasurement, event: string): string {
  return `p50 ${fmtSecs(m.priorP50)} → ${fmtSecs(m.recentP50)} `
    + `(×${(Math.round(m.ratio * 10) / 10).toString()}, ${event}) since ${m.sinceApprox}`;
}
