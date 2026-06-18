import { describe, it, expect } from 'vitest';
import { evaluateBudgets, alertsFrom, type Budget } from '../analytics/budgets';

const budgets: Budget[] = [
  { kind: 'minutes', threshold: 50000, unit: 'min' },
  { kind: 'flake', threshold: 5, warnFraction: 0.6 },
  { kind: 'cost', threshold: 100, unit: 'USD' },
];

describe('evaluateBudgets (Group J2/J3 / FR-037 / SC-015)', () => {
  it('classifies ok / warn / breach against thresholds', () => {
    const s = evaluateBudgets({ minutes: 60000, flake: 4, cost: 50 }, budgets);
    expect(s.find((x) => x.kind === 'minutes')!.state).toBe('breach'); // 120%
    expect(s.find((x) => x.kind === 'flake')!.state).toBe('warn');     // 4/5 = 80% ≥ 0.6 warn
    expect(s.find((x) => x.kind === 'cost')!.state).toBe('ok');        // 50%
  });

  it('warns BEFORE the breach (default 80% warn band)', () => {
    const s = evaluateBudgets({ minutes: 45000 }, [{ kind: 'minutes', threshold: 50000 }]);
    expect(s[0].state).toBe('warn'); // 90% — alerts before hitting the cap
  });

  it('treats a missing current value as 0 (ok)', () => {
    expect(evaluateBudgets({}, budgets).every((s) => s.state === 'ok')).toBe(true);
  });

  it('alertsFrom returns only warn/breach, most-exceeded first', () => {
    const s = evaluateBudgets({ minutes: 60000, flake: 4, cost: 50 }, budgets);
    const a = alertsFrom(s);
    expect(a.map((x) => x.kind)).toEqual(['minutes', 'flake']); // breach(1.2) before warn(0.8); cost ok excluded
  });
});
