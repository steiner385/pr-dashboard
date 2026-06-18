// Current values for every measurable budget kind (spec roadmap 5.6c). The
// budgets evaluator (budgets.ts) classifies spend vs threshold; this supplies the
// SPEND side for each kind from the trailing-window aggregates, so a minutes /
// flake / wait-p90 budget is functional (not stuck at 0). Kinds we don't yet
// measure (artifact, cache) are omitted — they stay 0 and never falsely breach.
// Pure over the gathered inputs so it's testable without the history store.
import type { BudgetKind } from './budgets';
import { percentile } from '../../math';

export interface BudgetCurrentInputs {
  /** Trailing-window fleet cost actuals ($). */
  costDollars: number;
  /** Sum of all observed check durations (seconds) — the minutes basis. */
  totalDurationSecs: number;
  /** Per-check flake rates (%) over the window, already filtered to ≥ min runs. */
  flakeRatesPct: number[];
  /** Observed runner waits (seconds) over the window — the wait-p90 basis. */
  runnerWaitSecs: number[];
}

export function budgetCurrents(inp: BudgetCurrentInputs): Partial<Record<BudgetKind, number>> {
  const current: Partial<Record<BudgetKind, number>> = { cost: inp.costDollars };
  if (inp.totalDurationSecs > 0) current.minutes = Math.round(inp.totalDurationSecs / 60);
  // The flake budget guards "no check flakier than X%" → the worst offender.
  if (inp.flakeRatesPct.length > 0) current.flake = Math.max(...inp.flakeRatesPct);
  // wait-p90 budget is expressed in minutes; p90 of observed runner waits.
  // percentile() wants a sorted array and a 0–1 fraction.
  if (inp.runnerWaitSecs.length > 0) {
    const sorted = [...inp.runnerWaitSecs].sort((a, b) => a - b);
    current['wait-p90'] = Math.round(percentile(sorted, 0.9) / 60);
  }
  return current;
}
