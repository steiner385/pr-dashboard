import { describe, it, expect } from 'vitest';
import { countMergeTrains, TRAIN_GAP_MS } from '../trains';

const T0 = Date.parse('2026-06-10T12:00:00Z');
const s = (secs: number) => T0 + secs * 1000;

describe('countMergeTrains', () => {
  it('returns 0 for no merges', () => {
    expect(countMergeTrains([])).toBe(0);
  });

  it('a single merge is a train of one', () => {
    expect(countMergeTrains([T0])).toBe(1);
  });

  it('merges within 90s of each other collapse into one train', () => {
    expect(countMergeTrains([s(0), s(30), s(60)])).toBe(1);
  });

  it('a gap of exactly 90s still joins the same train (inclusive boundary)', () => {
    expect(countMergeTrains([s(0), s(90)])).toBe(1);
  });

  it('a gap of 90s + 1ms starts a new train', () => {
    expect(countMergeTrains([T0, T0 + TRAIN_GAP_MS + 1])).toBe(2);
  });

  it('clusters by consecutive-gap, not by distance to cluster start', () => {
    // 0s, 80s, 160s: each consecutive gap ≤90s → one chained train,
    // even though first→last exceeds 90s.
    expect(countMergeTrains([s(0), s(80), s(160)])).toBe(1);
  });

  it('counts singletons between clusters as trains of one', () => {
    // [0,30] = train, [600] = train, [1200,1260] = train
    expect(countMergeTrains([s(0), s(30), s(600), s(1200), s(1260)])).toBe(3);
  });

  it('is order-insensitive (sorts internally)', () => {
    expect(countMergeTrains([s(600), s(30), s(0), s(1260), s(1200)])).toBe(3);
  });

  it('ignores non-finite timestamps', () => {
    expect(countMergeTrains([NaN, T0, Infinity])).toBe(1);
  });
});
