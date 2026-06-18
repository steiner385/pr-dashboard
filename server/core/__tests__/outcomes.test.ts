import { describe, it, expect } from 'vitest';
import { attributeOutcome, summarizeAccuracy, type AppliedChange } from '../analytics/outcomes';

const ch = (o: Partial<AppliedChange> = {}): AppliedChange => ({
  prNumber: 1, check: 'e2e', projected: { costDeltaMinutes: -1000, coverageDelta: 0 },
  realized: { costDeltaMinutes: -950, coverageDelta: 0 }, windowDays: 21, ...o,
});

describe('attributeOutcome (Group H / FR-034 / SC-013)', () => {
  it('high accuracy + high confidence when realized ≈ projected over a long window', () => {
    const o = attributeOutcome(ch());
    expect(o.costAccuracy).toBeGreaterThan(0.9);
    expect(o.directionCorrect).toBe(true);
    expect(o.confidence).toBe('high');
    expect(o.caveat).toMatch(/confounded/);
  });

  it('low confidence on a short window regardless of fit', () => {
    expect(attributeOutcome(ch({ windowDays: 3 })).confidence).toBe('low');
  });

  it('flags a wrong-direction outcome (predicted savings, costs rose)', () => {
    const o = attributeOutcome(ch({ projected: { costDeltaMinutes: -1000, coverageDelta: 0 }, realized: { costDeltaMinutes: 500, coverageDelta: 0 } }));
    expect(o.directionCorrect).toBe(false);
    expect(o.confidence).toBe('low');
  });
});

describe('summarizeAccuracy (H2 → D1 feedback guard)', () => {
  it('recommender NOT usable until enough confident, accurate samples', () => {
    expect(summarizeAccuracy([]).recommenderUsable).toBe(false);
    expect(summarizeAccuracy([ch(), ch()]).recommenderUsable).toBe(false); // too few
  });

  it('recommender usable with ≥5 confident, high-accuracy, right-direction samples', () => {
    const s = summarizeAccuracy(Array.from({ length: 6 }, (_, i) => ch({ prNumber: i })));
    expect(s.count).toBe(6);
    expect(s.meanCostAccuracy).toBeGreaterThan(0.6);
    expect(s.recommenderUsable).toBe(true);
  });
});
