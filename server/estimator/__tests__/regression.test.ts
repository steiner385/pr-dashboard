import { describe, it, expect } from 'vitest';
import {
  measureDurationStep, flagsRegression, holdsRegression, regressionDetail,
  REGRESSION_RECENT_K, REGRESSION_PRIOR_N, REGRESSION_MIN_SAMPLES,
  REGRESSION_FLAG_RATIO, REGRESSION_FLAG_MIN_DELTA_SECS, REGRESSION_CLEAR_RATIO,
  type DurationSample,
} from '../regression';

/** Build a newest-first sample list: `recent` (newest K) then `prior` durations.
 *  Timestamps descend one minute per sample from 2026-06-12T12:00Z. */
function samples(recent: number[], prior: number[]): DurationSample[] {
  return [...recent, ...prior].map((durationSecs, i) => ({
    durationSecs,
    completedAt: new Date(Date.parse('2026-06-12T12:00:00Z') - i * 60_000).toISOString(),
  }));
}

const flat = (n: number, v: number): number[] => Array(n).fill(v);

describe('measureDurationStep', () => {
  it('measures a clean step up: medians, ratio, sinceApprox', () => {
    const s = samples(flat(REGRESSION_RECENT_K, 600), flat(REGRESSION_PRIOR_N, 240));
    const m = measureDurationStep(s)!;
    expect(m.priorP50).toBe(240);
    expect(m.recentP50).toBe(600);
    expect(m.ratio).toBeCloseTo(2.5);
    // sinceApprox = the OLDEST sample of the recent window (the step's onset)
    expect(m.sinceApprox).toBe(s[REGRESSION_RECENT_K - 1]!.completedAt);
  });

  it('returns null below the minimum sample count (29 of 30)', () => {
    const s = samples(flat(REGRESSION_RECENT_K, 600), flat(REGRESSION_PRIOR_N - 1, 240));
    expect(s).toHaveLength(REGRESSION_MIN_SAMPLES - 1);
    expect(measureDurationStep(s)).toBeNull();
  });

  it('measures at exactly the minimum sample count (30)', () => {
    const s = samples(flat(REGRESSION_RECENT_K, 600), flat(REGRESSION_PRIOR_N, 240));
    expect(s).toHaveLength(REGRESSION_MIN_SAMPLES);
    expect(measureDurationStep(s)).not.toBeNull();
  });

  it('ignores samples beyond the 10+20 window (extra old rows change nothing)', () => {
    const s = samples(flat(REGRESSION_RECENT_K, 600),
      [...flat(REGRESSION_PRIOR_N, 240), ...flat(15, 9999)]);
    const m = measureDurationStep(s)!;
    expect(m.priorP50).toBe(240);
    expect(m.recentP50).toBe(600);
  });

  it('medians are robust to outliers inside each window', () => {
    // one 1-hour spot-retry outlier in the prior window must not mask the step
    const prior = [...flat(REGRESSION_PRIOR_N - 1, 240), 3600];
    const m = measureDurationStep(samples(flat(REGRESSION_RECENT_K, 600), prior))!;
    expect(m.priorP50).toBe(240);
  });

  it('returns null when the prior median is not positive (degenerate input)', () => {
    expect(measureDurationStep(samples(flat(REGRESSION_RECENT_K, 600),
      flat(REGRESSION_PRIOR_N, 0)))).toBeNull();
  });
});

describe('flagsRegression — both guards', () => {
  const measure = (recent: number, prior: number) =>
    measureDurationStep(samples(flat(REGRESSION_RECENT_K, recent), flat(REGRESSION_PRIOR_N, prior)))!;

  it('flags when ratio ≥ 1.5 AND absolute delta ≥ 60s', () => {
    expect(flagsRegression(measure(600, 240))).toBe(true);   // ×2.5, +6m
    expect(flagsRegression(measure(180, 120))).toBe(true);   // ×1.5 exactly, +60s exactly
  });

  it('does NOT flag short-job noise: 3s → 5s is ×1.67 but only +2s', () => {
    expect(flagsRegression(measure(5, 3))).toBe(false);
  });

  it('does NOT flag a big absolute delta at a small ratio: 20m → 22m', () => {
    expect(flagsRegression(measure(1320, 1200))).toBe(false); // ×1.1, +2m
  });

  it('does NOT flag a step DOWN (improvement)', () => {
    expect(flagsRegression(measure(240, 600))).toBe(false);
  });

  it('threshold constants are what the issue specifies', () => {
    expect(REGRESSION_FLAG_RATIO).toBe(1.5);
    expect(REGRESSION_FLAG_MIN_DELTA_SECS).toBe(60);
    expect(REGRESSION_MIN_SAMPLES).toBe(30);
  });
});

describe('holdsRegression — hysteresis clear threshold', () => {
  const measure = (recent: number, prior: number) =>
    measureDurationStep(samples(flat(REGRESSION_RECENT_K, recent), flat(REGRESSION_PRIOR_N, prior)))!;

  it('an already-flagged condition holds while ratio ≥ 1.2', () => {
    const m = measure(312, 240); // ×1.3, +72s — below flag, above clear
    expect(flagsRegression(m)).toBe(false);
    expect(holdsRegression(m)).toBe(true);
  });

  it('clears below ratio 1.2 (eligible to re-fire on the next step)', () => {
    const m = measure(264, 240); // ×1.1
    expect(holdsRegression(m)).toBe(false);
    expect(REGRESSION_CLEAR_RATIO).toBe(1.2);
  });
});

describe('regressionDetail', () => {
  it('renders prior → recent with ratio, event, and onset time', () => {
    const m = measureDurationStep(samples(flat(REGRESSION_RECENT_K, 600),
      flat(REGRESSION_PRIOR_N, 240)))!;
    const d = regressionDetail(m, 'merge_group');
    expect(d).toContain('4m → 10m');
    expect(d).toContain('×2.5');
    expect(d).toContain('merge_group');
    expect(d).toContain(m.sinceApprox);
  });
});
