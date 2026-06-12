import { describe, it, expect } from 'vitest';
import { evaluateStarvation, nextStarving, starvationDetail,
  STARVATION_MIN_SAMPLES, STARVATION_FLOOR_SECS } from '../starvation';

const waits = (n: number, v: number): number[] => Array(n).fill(v) as number[];

describe('evaluateStarvation (issue #45)', () => {
  it('enters when last-hour p90 > 4× baseline p90 with enough samples', () => {
    const e = evaluateStarvation(waits(6, 500), waits(20, 100));
    expect(e.lastHourP90).toBe(500);
    expect(e.baselineP90).toBe(100);
    expect(e.n).toBe(6);
    expect(e.enters).toBe(true);
    expect(e.holds).toBe(true);
  });

  it('does NOT enter between 2× and 4× baseline — but holds (hysteresis band)', () => {
    const e = evaluateStarvation(waits(6, 350), waits(20, 100)); // enter at 400, clear at 300
    expect(e.enters).toBe(false);
    expect(e.holds).toBe(true);
  });

  it('neither enters nor holds below 2× baseline (and below the floor)', () => {
    const e = evaluateStarvation(waits(6, 150), waits(20, 100));
    expect(e.enters).toBe(false);
    expect(e.holds).toBe(false);
  });

  it('min-samples gate: under 5 last-hour samples never enters (but can hold)', () => {
    const e = evaluateStarvation(waits(STARVATION_MIN_SAMPLES - 1, 9_999), waits(20, 100));
    expect(e.enters).toBe(false);
    expect(e.holds).toBe(true); // an already-active pool with thin pickups stays active
  });

  it('empty baseline: the 5-minute absolute floor is the threshold', () => {
    expect(evaluateStarvation(waits(5, STARVATION_FLOOR_SECS + 1), []).enters).toBe(true);
    expect(evaluateStarvation(waits(5, STARVATION_FLOOR_SECS - 1), []).enters).toBe(false);
  });

  it('the floor also guards a tiny baseline (4×2s = 8s must not alarm)', () => {
    // baseline p90 2s → 4× = 8s, but the floor keeps the bar at 5min
    expect(evaluateStarvation(waits(6, 120), waits(20, 2)).enters).toBe(false);
    expect(evaluateStarvation(waits(6, 301), waits(20, 2)).enters).toBe(true);
  });

  it('zero last-hour samples: nulls, never enters, never holds (idle/recovered)', () => {
    const e = evaluateStarvation([], waits(20, 100));
    expect(e.lastHourP90).toBeNull();
    expect(e.enters).toBe(false);
    expect(e.holds).toBe(false);
  });
});

describe('nextStarving (hysteresis state machine)', () => {
  const HOLD_ONLY = evaluateStarvation(waits(6, 350), waits(20, 100));
  const COLD = evaluateStarvation(waits(6, 150), waits(20, 100));
  const HOT = evaluateStarvation(waits(6, 500), waits(20, 100));

  it('inactive pool in the hold band stays inactive (no entry below 4×)', () => {
    expect(nextStarving(HOLD_ONLY, false)).toBe(false);
  });

  it('active pool in the hold band stays active (no flapping while decaying)', () => {
    expect(nextStarving(HOLD_ONLY, true)).toBe(true);
  });

  it('active pool below the clear bar clears', () => {
    expect(nextStarving(COLD, true)).toBe(false);
  });

  it('entry works regardless of prior state', () => {
    expect(nextStarving(HOT, false)).toBe(true);
    expect(nextStarving(HOT, true)).toBe(true);
  });
});

describe('starvationDetail', () => {
  it('names the pool and both p90s', () => {
    const e = evaluateStarvation(waits(6, 600), waits(20, 30));
    const d = starvationDetail('kindash-runner', e);
    expect(d).toContain("pool 'kindash-runner'");
    expect(d).toContain('10m');           // 600s last-hour p90
    expect(d).toContain('baseline 30s');  // 30s baseline p90
    expect(d).toContain('n=6');
  });

  it('reads "baseline none" for a pool with no baseline yet', () => {
    const e = evaluateStarvation(waits(5, 400), []);
    expect(starvationDetail('p', e)).toContain('baseline none');
  });
});
