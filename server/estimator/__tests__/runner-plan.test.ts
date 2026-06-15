import { describe, it, expect } from 'vitest';
import { computeRunnerPlan, SPOT, ONDEMAND } from '../runner-plan';

const cfg = { shedThresholdMinutes: 1, overrides: {} as Record<string, 'spot' | 'ondemand'> };

describe('computeRunnerPlan', () => {
  it('routes everything to spot when the reclaim rate is 0 (healthy spot)', () => {
    const { map, plan } = computeRunnerPlan(
      [{ key: 'unit', p90Secs: 480 }, { key: 'eslint', p90Secs: 30 }], 0, cfg);
    expect(plan.every((r) => r.decision === SPOT)).toBe(true);
    expect(map).toEqual({}); // only non-default (on-demand) entries are emitted
  });

  it('null reclaim rate is treated as 0 (assume healthy)', () => {
    const { plan } = computeRunnerPlan([{ key: 'unit', p90Secs: 480 }], null, cfg);
    expect(plan[0]!.decision).toBe(SPOT);
  });

  it('sheds the longest jobs first as the rate climbs (cost model)', () => {
    const { plan } = computeRunnerPlan(
      [{ key: 'unit', p90Secs: 8 * 60 }, { key: 'integration', p90Secs: 12 * 60 }], 0.09, cfg);
    expect(plan.find((r) => r.key === 'unit')!.decision).toBe(SPOT);
    expect(plan.find((r) => r.key === 'integration')!.decision).toBe(ONDEMAND);
  });

  it('decision is on-demand exactly at the boundary (>=)', () => {
    const { plan } = computeRunnerPlan([{ key: 'unit', p90Secs: 600 }], 0.1, cfg);
    expect(plan[0]!.decision).toBe(ONDEMAND);
  });

  it('a manual override beats the auto decision and is marked source=override', () => {
    const { map, plan } = computeRunnerPlan([{ key: 'unit', p90Secs: 8 * 60 }], 0.0,
      { shedThresholdMinutes: 1, overrides: { unit: 'ondemand' } });
    const row = plan.find((r) => r.key === 'unit')!;
    expect(row.decision).toBe(ONDEMAND);
    expect(row.source).toBe('override');
    expect(map.unit).toBe(ONDEMAND);
  });

  it('omits cold-start jobs (no p90) from the map and marks them collecting', () => {
    const { map, plan } = computeRunnerPlan([{ key: 'unit', p90Secs: null }], 0.5, cfg);
    expect(map.unit).toBeUndefined();
    expect(plan[0]!.decision).toBe(SPOT);
    expect(plan[0]!.collecting).toBe(true);
  });
});
