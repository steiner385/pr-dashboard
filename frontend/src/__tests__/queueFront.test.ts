import { describe, it, expect } from 'vitest';
import { nextToMerge } from '../sections/pipeline/queueFront';
import type { RepoQueueView } from '../types';

const q = (over: Partial<RepoQueueView>): RepoQueueView =>
  ({ groups: [], waiting: [], unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 1, ...over });

describe('nextToMerge (front-of-queue — "what merges next")', () => {
  it('returns the building train closest to done', () => {
    const r = nextToMerge(q({ groups: [
      { oid: 'a', prNumbers: [1, 2], percent: 40, etaSeconds: 600, failed: false },
      { oid: 'b', prNumbers: [3], percent: 85, etaSeconds: 120, failed: false },
    ] }));
    expect(r).toEqual({ prNumbers: [3], percent: 85, etaSeconds: 120, building: true });
  });

  it('ignores a failed (ejecting) train', () => {
    const r = nextToMerge(q({ groups: [{ oid: 'a', prNumbers: [9], percent: 99, etaSeconds: 10, failed: true }] }));
    expect(r).toBeNull();
  });

  it('falls back to the position-1 waiting entry with its p50 ETA', () => {
    const r = nextToMerge(q({ waiting: [
      { prNumber: 7, position: 2, sim: null },
      { prNumber: 5, position: 1, sim: { p50Secs: 300, p90Secs: 600, trainsAhead: 1, assumesEjects: false } as never },
    ] }));
    expect(r).toEqual({ prNumbers: [5], percent: null, etaSeconds: 300, building: false });
  });

  it('returns null for an empty or absent queue', () => {
    expect(nextToMerge(q({}))).toBeNull();
    expect(nextToMerge(null)).toBeNull();
  });
});
