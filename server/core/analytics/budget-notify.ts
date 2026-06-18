// Budget-breach alert wiring (spec roadmap 5.6c). The budgets module classifies
// spend vs threshold (ok/warn/breach); this maps each evaluated gauge to a
// notifier signal so a breach pushes an alert (host command / webhook / SSE),
// not just a coloured gauge in the Budgets panel. Pure over the `notify` sink so
// it's testable without the Notifier.
import type { BudgetStatus } from './budgets';

/** One-line breach detail: "minutes — 12,000 of 10,000 (120%) over the trailing 30d". */
export function budgetBreachDetail(g: BudgetStatus): string {
  const pct = Math.round(g.fractionUsed * 100);
  const unit = g.unit ? ` ${g.unit}` : '';
  return `${g.kind} — ${g.current.toLocaleString()} of ${g.threshold.toLocaleString()}${unit} (${pct}%) over the trailing 30d`;
}

/**
 * Drive the notifier from a set of evaluated budget gauges: active=true for a
 * breach (fires once per breach entry), active=false for ok/warn (clears the
 * debounce so a later re-breach re-fires). Idempotent — safe to call every tick.
 */
export function notifyBudgetBreaches(
  scope: string,
  gauges: readonly BudgetStatus[],
  notify: (scope: string, kind: string, active: boolean, detail: string) => void,
): void {
  for (const g of gauges) notify(scope, g.kind, g.state === 'breach', budgetBreachDetail(g));
}
