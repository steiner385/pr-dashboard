import { describe, it, expect } from 'vitest';
import { deployChain } from '../deploy-status';

const m = (number: number, mergedAt: string, qaLiveAt: string | null, prodLiveAt: string | null) =>
  ({ number, mergeCommitSha: `sha${number}`, mergedAt, qaLiveAt, prodLiveAt });

describe('deployChain (roadmap 4.4c — QA→prod chain + SHA supersession)', () => {
  it('classifies each merge by the furthest stage it reached', () => {
    const c = deployChain([
      m(3, '2026-06-18T03:00:00Z', '2026-06-18T03:10:00Z', '2026-06-18T03:20:00Z'), // prod
      m(2, '2026-06-18T02:00:00Z', '2026-06-18T02:10:00Z', null),                    // qa
      m(1, '2026-06-18T01:00:00Z', null, null),                                       // merged
    ]);
    expect(c.entries.map((e) => [e.prNumber, e.stage])).toEqual([[3, 'prod'], [2, 'qa'], [1, 'merged']]);
  });

  it('marks an older awaiting-prod SHA superseded once a NEWER one reaches prod', () => {
    const c = deployChain([
      m(2, '2026-06-18T02:00:00Z', '2026-06-18T02:10:00Z', '2026-06-18T02:20:00Z'), // newer → prod
      m(1, '2026-06-18T01:00:00Z', '2026-06-18T01:10:00Z', null),                    // older, awaiting prod
    ]);
    const older = c.entries.find((e) => e.prNumber === 1)!;
    expect(older.superseded).toBe(true); // prod jumped past it — it'll never deploy on its own
    expect(c.entries.find((e) => e.prNumber === 2)!.superseded).toBe(false);
  });

  it('does NOT supersede the front-runner (newest, still flowing toward prod)', () => {
    const c = deployChain([
      m(3, '2026-06-18T03:00:00Z', '2026-06-18T03:10:00Z', null),                    // front-runner, awaiting prod
      m(2, '2026-06-18T02:00:00Z', '2026-06-18T02:10:00Z', '2026-06-18T02:20:00Z'), // prod
    ]);
    expect(c.entries.find((e) => e.prNumber === 3)!.superseded).toBe(false);
    expect(c.inFlight?.prNumber).toBe(3); // the SHA actively progressing
  });

  it('reports inFlight=null and supersededCount=0 when everything is live on prod', () => {
    const c = deployChain([
      m(2, '2026-06-18T02:00:00Z', '2026-06-18T02:10:00Z', '2026-06-18T02:20:00Z'),
      m(1, '2026-06-18T01:00:00Z', '2026-06-18T01:10:00Z', '2026-06-18T01:20:00Z'),
    ]);
    expect(c.inFlight).toBeNull();
    expect(c.supersededCount).toBe(0);
  });

  it('orders newest-merge first and caps to the limit', () => {
    const rows = Array.from({ length: 12 }, (_, i) => m(i + 1, `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`, null, null));
    const c = deployChain(rows, 5);
    expect(c.entries).toHaveLength(5);
    expect(c.entries[0].prNumber).toBe(12); // newest
  });
});
