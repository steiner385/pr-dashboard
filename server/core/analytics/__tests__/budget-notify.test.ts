import { describe, it, expect, vi } from 'vitest';
import { budgetBreachDetail, notifyBudgetBreaches } from '../budget-notify';
import type { BudgetStatus } from '../budgets';

const gauge = (over: Partial<BudgetStatus>): BudgetStatus =>
  ({ kind: 'cost', threshold: 1000, current: 0, unit: '$', fractionUsed: 0, state: 'ok', ...over });

describe('budgetBreachDetail (roadmap 5.6c)', () => {
  it('renders kind, current/threshold, percent, and unit', () => {
    const d = budgetBreachDetail(gauge({ kind: 'minutes', current: 12000, threshold: 10000, unit: 'min', fractionUsed: 1.2 }));
    expect(d).toMatch(/minutes/);
    expect(d).toMatch(/12,000 of 10,000/);
    expect(d).toMatch(/120%/);
    expect(d).toMatch(/min/);
  });
});

describe('notifyBudgetBreaches (roadmap 5.6c)', () => {
  it('signals active=true for a breached budget, false for ok/warn (clears the debounce)', () => {
    const calls: { kind: string; active: boolean }[] = [];
    const notify = vi.fn((_s: string, kind: string, active: boolean) => { calls.push({ kind, active }); });
    notifyBudgetBreaches('fleet', [
      gauge({ kind: 'cost', state: 'breach', current: 1400, fractionUsed: 1.4 }),
      gauge({ kind: 'minutes', state: 'warn', current: 8500, threshold: 10000, fractionUsed: 0.85 }),
      gauge({ kind: 'flake', state: 'ok', current: 2, threshold: 10, fractionUsed: 0.2 }),
    ], notify);
    expect(calls).toEqual([
      { kind: 'cost', active: true },
      { kind: 'minutes', active: false },
      { kind: 'flake', active: false },
    ]);
    expect(notify).toHaveBeenCalledWith('fleet', 'cost', true, expect.stringContaining('140%'));
  });

  it('does nothing with no gauges', () => {
    const notify = vi.fn();
    notifyBudgetBreaches('fleet', [], notify);
    expect(notify).not.toHaveBeenCalled();
  });
});
