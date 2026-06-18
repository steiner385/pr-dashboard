import { describe, it, expect } from 'vitest';
import { forecastTrend, type Point } from '../analytics/forecast';

const line = (n: number, a: number, b: number): Point[] => Array.from({ length: n }, (_, i) => ({ day: i, value: a + b * i }));

describe('forecastTrend (Group J1 / FR-037 / SC-015)', () => {
  it('recovers the slope of a clean linear series (R²≈1, high confidence)', () => {
    const f = forecastTrend(line(30, 100, 10), { horizonDays: 10 });
    expect(f.slopePerDay).toBeCloseTo(10);
    expect(f.rSquared).toBeCloseTo(1);
    expect(f.confidence).toBe('high');
    // last day = 29 (value 390); +10 days → 100 + 10*39 = 490
    expect(f.projectedAt).toBeCloseTo(490);
  });

  it('computes days-to-threshold for a rising trend', () => {
    // value = 100 + 10*day; last day 29 → 390. threshold 500 → (500-390)/10 = 11 days
    const f = forecastTrend(line(30, 100, 10), { thresholdValue: 500 });
    expect(f.daysToThreshold).toBe(11);
  });

  it('reports 0 days when already at/over threshold', () => {
    expect(forecastTrend(line(30, 100, 10), { thresholdValue: 200 }).daysToThreshold).toBe(0);
  });

  it('never crosses a threshold on a flat/declining trend → daysToThreshold null', () => {
    expect(forecastTrend(line(30, 100, 0), { thresholdValue: 500 }).daysToThreshold).toBeNull();
    expect(forecastTrend(line(30, 500, -5), { thresholdValue: 999 }).daysToThreshold).toBeNull();
  });

  it('low confidence on a short or noisy window', () => {
    expect(forecastTrend(line(5, 100, 10)).confidence).toBe('low'); // too few days
    const noisy: Point[] = Array.from({ length: 25 }, (_, i) => ({ day: i, value: (i % 2 ? 0 : 1000) }));
    expect(forecastTrend(noisy).confidence).toBe('low'); // poor fit
  });

  it('degrades safely with < 2 points', () => {
    expect(forecastTrend([]).projectedAt).toBeNull();
    expect(forecastTrend([{ day: 0, value: 5 }]).confidence).toBe('low');
  });
});
