// Budgets / threshold alerts / quota gauges (spec 001, Group J2/J3 / FR-037 /
// SC-015). Pure: compare current values against configured budgets → ok/warn/
// breach, so an alert fires BEFORE the breach (warn band), not only after. The
// ingest path evaluates this and fires notifications; this module is the pure
// classifier (testable without the notify wiring).
export type BudgetKind = 'minutes' | 'cost' | 'flake' | 'wait-p90' | 'artifact' | 'cache';

export interface Budget { kind: BudgetKind; threshold: number; warnFraction?: number; unit?: string }
export interface BudgetStatus {
  kind: BudgetKind; threshold: number; current: number; unit?: string;
  fractionUsed: number; state: 'ok' | 'warn' | 'breach';
}

const DEFAULT_WARN = 0.8;

export function evaluateBudgets(current: Partial<Record<BudgetKind, number>>, budgets: readonly Budget[]): BudgetStatus[] {
  return budgets.map((b) => {
    const value = current[b.kind] ?? 0;
    const warnAt = b.warnFraction ?? DEFAULT_WARN;
    const fractionUsed = b.threshold > 0 ? value / b.threshold : 0;
    const state: BudgetStatus['state'] = fractionUsed >= 1 ? 'breach' : fractionUsed >= warnAt ? 'warn' : 'ok';
    return { kind: b.kind, threshold: b.threshold, current: value, unit: b.unit, fractionUsed, state };
  });
}

/** The alert-worthy subset (warn|breach), most-exceeded first — what the ingest
 *  path turns into notifications and the spine surfaces. */
export function alertsFrom(statuses: readonly BudgetStatus[]): BudgetStatus[] {
  return statuses.filter((s) => s.state !== 'ok').sort((a, b) => b.fractionUsed - a.fractionUsed);
}
