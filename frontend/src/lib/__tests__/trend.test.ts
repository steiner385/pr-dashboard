import { describe, it, expect } from 'vitest';
import { computeTrend, greenRateTrend } from '../trend';

describe('greenRateTrend', () => {
  it('degrading green-rate → down, bad, significant', () => {
    // older half all green (1.0), recent half half-green (0.5) → -50%
    const t = greenRateTrend([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: false }, { ok: true }, { ok: false }]);
    expect(t).toMatchObject({ direction: 'down', polarity: 'bad', significant: true });
  });
  it('improving green-rate → up, good', () => {
    const t = greenRateTrend([{ ok: true }, { ok: false }, { ok: true }, { ok: false }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    expect(t).toMatchObject({ direction: 'up', polarity: 'good', significant: true });
  });
  it('insufficient non-null samples per half → neutral (no arrow)', () => {
    expect(greenRateTrend([{ ok: true }, { ok: true }, { ok: false }, { ok: false }])).toMatchObject({ direction: 'flat', polarity: 'neutral' });
    expect(greenRateTrend([{ ok: true }, { ok: null }, { ok: null }, { ok: null }, { ok: null }, { ok: true }])).toMatchObject({ polarity: 'neutral' });
  });
  it('stable all-green → flat, neutral', () => {
    expect(greenRateTrend([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }])).toMatchObject({ direction: 'flat', significant: false });
  });
  it('undefined / empty → neutral', () => {
    expect(greenRateTrend(undefined)).toMatchObject({ deltaPct: null, polarity: 'neutral' });
    expect(greenRateTrend([])).toMatchObject({ deltaPct: null, polarity: 'neutral' });
  });
});

describe('computeTrend', () => {
  it('null/zero baseline → flat, neutral, null deltaPct', () => {
    expect(computeTrend(10, null)).toMatchObject({ deltaPct: null, direction: 'flat', polarity: 'neutral', significant: false });
    expect(computeTrend(10, 0)).toMatchObject({ deltaPct: null, direction: 'flat', polarity: 'neutral' });
    expect(computeTrend(null, 10)).toMatchObject({ deltaPct: null, direction: 'flat' });
  });
  it('below the significance threshold → neutral (no good/bad)', () => {
    expect(computeTrend(103, 100)).toMatchObject({ direction: 'up', significant: false, polarity: 'neutral' });
  });
  it('significant increase, higher-is-better → good', () => {
    expect(computeTrend(150, 100)).toMatchObject({ deltaPct: 50, direction: 'up', significant: true, polarity: 'good' });
  });
  it('significant increase, lowerIsBetter → bad', () => {
    expect(computeTrend(150, 100, { lowerIsBetter: true })).toMatchObject({ direction: 'up', polarity: 'bad' });
  });
  it('significant decrease, lowerIsBetter → good', () => {
    expect(computeTrend(50, 100, { lowerIsBetter: true })).toMatchObject({ deltaPct: -50, direction: 'down', polarity: 'good' });
  });
  it('exact equal → flat, neutral', () => {
    expect(computeTrend(100, 100)).toMatchObject({ deltaPct: 0, direction: 'flat', significant: false, polarity: 'neutral' });
  });
  it('honors a custom significance floor', () => {
    expect(computeTrend(103, 100, { minPctForSignificance: 2 })).toMatchObject({ significant: true, polarity: 'good' });
  });
});
