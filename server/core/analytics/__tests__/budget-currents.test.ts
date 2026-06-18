import { describe, it, expect } from 'vitest';
import { budgetCurrents } from '../budget-currents';

describe('budgetCurrents (roadmap 5.6c — current values for every measurable budget kind)', () => {
  it('always reports cost; derives minutes from total CI seconds', () => {
    const c = budgetCurrents({ costDollars: 1400, totalDurationSecs: 600_000, flakeRatesPct: [], runnerWaitSecs: [] });
    expect(c.cost).toBe(1400);
    expect(c.minutes).toBe(10_000); // 600,000s / 60
  });

  it('reports flake as the WORST per-check rate (the budget guards the worst offender)', () => {
    const c = budgetCurrents({ costDollars: 0, totalDurationSecs: 0, flakeRatesPct: [2, 18, 7], runnerWaitSecs: [] });
    expect(c.flake).toBe(18);
  });

  it('reports wait-p90 in minutes (p90 of observed runner waits, unsorted input ok)', () => {
    // 10 samples → sorted [60,60,60,60,120,120,300,600,900,1800]; p90 = index 8 = 900s
    const waits = [60, 60, 60, 120, 120, 300, 600, 900, 1800, 60];
    const c = budgetCurrents({ costDollars: 0, totalDurationSecs: 0, flakeRatesPct: [], runnerWaitSecs: waits });
    expect(c['wait-p90']).toBe(15); // 900s → 15 min
  });

  it('omits kinds with no data (they stay 0 → never falsely breach)', () => {
    const c = budgetCurrents({ costDollars: 0, totalDurationSecs: 0, flakeRatesPct: [], runnerWaitSecs: [] });
    expect(c.minutes).toBeUndefined();
    expect(c.flake).toBeUndefined();
    expect(c['wait-p90']).toBeUndefined();
    expect('artifact' in c).toBe(false);
    expect('cache' in c).toBe(false);
  });
});
