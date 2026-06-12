import type { StageResult } from '../types';

/**
 * Conformal-lite ETA range calibration (issue #35, part 2).
 *
 * The poller scores every first stage-ETA prediction against the actual stage
 * duration (`eta_accuracy`). `HistoryStore.calibrationFactor` distills the
 * last 30 samples per (repo, stage) into the 90th percentile of
 * actual/predicted ratios; this module applies that factor to the stage's
 * displayed range, so the band is empirically grounded where data exists.
 */

/** Stages whose first ETA is accuracy-scored — and therefore calibratable.
 *  Single source of truth shared with the poller's stage tracker. */
export const CALIBRATED_STAGES: ReadonlySet<string> = new Set(['ci', 'queue', 'qa-deploy']);

/** Factors at/below this are tiny corrections — not worth churning the display. */
export const CALIBRATION_MIN_FACTOR = 1.15;

/**
 * Widen/set the displayed ETA range from an observed calibration factor:
 * `etaRangeSeconds = [etaSeconds, round(etaSeconds × factor)]` when
 * `factor > 1.15`. Widens but never narrows an existing heuristic range
 * (the wider upper bound wins); keeps the stage untouched when there's no
 * factor, the stage isn't ETA-tracked, or it carries no ETA.
 */
export function applyEtaCalibration(stage: StageResult, factor: number | null): StageResult {
  if (factor == null || factor <= CALIBRATION_MIN_FACTOR) return stage;
  if (!CALIBRATED_STAGES.has(stage.stage) || stage.etaSeconds == null) return stage;
  const high = Math.max(Math.round(stage.etaSeconds * factor), stage.etaRangeSeconds?.[1] ?? 0);
  if (high <= stage.etaSeconds) return stage; // a degenerate [x, x] band is no band
  return { ...stage, etaRangeSeconds: [stage.etaSeconds, high] };
}
