import { describe, it, expect } from 'vitest';
import {
  computePromotionCandidates, PROMOTION_DEFAULTS, PROMOTION_MIN_REAL_FAILURES,
  type PromotionStat,
} from '../promotion-candidates';

const stat = (over: Partial<PromotionStat>): PromotionStat => ({
  name: 'check', event: 'merge_group', totalRuns: 100, realFailures: 8, sumDurationSecs: 60_000, ...over,
});

describe('computePromotionCandidates — signal & bounds', () => {
  it('promotes a push:main real-failing check to the merge queue', () => {
    const [c] = computePromotionCandidates([stat({ name: 'e2e', event: 'push', realFailures: 6 })]);
    expect(c).toMatchObject({
      name: 'e2e', currentTier: 'every push to main (post-merge)',
      suggestedTier: 'merge queue (pre-merge gate)', realFailures: 6,
    });
  });

  it('does NOT promote a push check that already gates in the merge queue', () => {
    const cands = computePromotionCandidates([
      stat({ name: 'build', event: 'push', realFailures: 6 }),
      stat({ name: 'build', event: 'merge_group', totalRuns: 100, realFailures: 0 }), // already gates pre-merge
    ]);
    expect(cands).toEqual([]);
  });

  it('promotes a merge_group real-failing check to PR when it has no PR coverage', () => {
    const [c] = computePromotionCandidates([stat({ name: 'integration', event: 'merge_group', realFailures: 5 })]);
    expect(c).toMatchObject({
      currentTier: 'merge queue only', suggestedTier: 'every PR push (catch pre-enqueue)',
    });
  });

  it('does NOT promote a merge_group failure when the check already runs on PRs (merge-emergent)', () => {
    const cands = computePromotionCandidates([
      stat({ name: 'tsc', event: 'merge_group', realFailures: 7 }),
      stat({ name: 'tsc', event: 'pull_request', totalRuns: 200, realFailures: 0 }),
    ]);
    expect(cands).toEqual([]);
  });

  it('never promotes a pull_request check (already the earliest tier)', () => {
    const cands = computePromotionCandidates([stat({ name: 'lint', event: 'pull_request', realFailures: 9 })]);
    expect(cands).toEqual([]);
  });
});

describe('computePromotionCandidates — thresholds & ranking', () => {
  it('excludes one-offs below the real-failure floor', () => {
    const cands = computePromotionCandidates([stat({ event: 'push', realFailures: PROMOTION_MIN_REAL_FAILURES - 1 })]);
    expect(cands).toEqual([]);
  });

  it('excludes checks with too little history', () => {
    const cands = computePromotionCandidates([stat({ event: 'push', totalRuns: 10, realFailures: 5 })]);
    expect(cands).toEqual([]);
  });

  it('flake-only failures do not qualify (realFailures already excludes them)', () => {
    // A flaky check has failingRuns but realFailures==0 after the caller subtracts flakes.
    const cands = computePromotionCandidates([stat({ event: 'push', realFailures: 0 })]);
    expect(cands).toEqual([]);
  });

  it('ranks by real-failure count descending', () => {
    const cands = computePromotionCandidates([
      stat({ name: 'few', event: 'push', realFailures: 3 }),
      stat({ name: 'many', event: 'push', realFailures: 12 }),
      stat({ name: 'some', event: 'push', realFailures: 7 }),
    ]);
    expect(cands.map((c) => c.name)).toEqual(['many', 'some', 'few']);
  });

  it('caps at topN and computes the rate + reason', () => {
    const [c] = computePromotionCandidates([stat({ name: 'e2e', event: 'push', totalRuns: 200, realFailures: 10, sumDurationSecs: 120_000 })]);
    expect(c).toMatchObject({ failRatePct: 5, runsInWindow: 200, minutesInWindow: 2000 });
    expect(c!.reason).toBe('10 real (non-flaky) failures in 200 runs (5%) — caught late');
    const many = Array.from({ length: 20 }, (_, i) => stat({ name: `c${i}`, event: 'push', realFailures: i + 3 }));
    expect(computePromotionCandidates(many, { ...PROMOTION_DEFAULTS, topN: 5 })).toHaveLength(5);
  });
});
