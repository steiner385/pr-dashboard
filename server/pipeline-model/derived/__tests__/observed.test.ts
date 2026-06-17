import { describe, it, expect } from 'vitest';
import { joinObserved, observedKey } from '../observed';
import type { SuccessStat, FlakeStat } from '../../../history';

const succ = (o: Partial<SuccessStat>): SuccessStat => ({ name: 'c', event: 'pull_request', totalRuns: 100, failingRuns: 5, sumDurationSecs: 60_000, ...o });
const flake = (o: Partial<FlakeStat>): FlakeStat => ({ name: 'c', event: 'pull_request', flakeEvents: 2, totalRuns: 100, flakeRatePct: 2, flakeAts: [], runAts: [], ...o });

describe('joinObserved', () => {
  it('joins by (name,event) and computes realFailures = failingRuns − flakeEvents', () => {
    const m = joinObserved([succ({})], [flake({})]);
    const cell = m.get(observedKey('c', 'pull_request'))!;
    expect(cell).toMatchObject({ ran: true, runs: 100, realFailures: 3, flakeRatePct: 2, minutes: 1000 });
    expect(cell.failRatePct).toBe(5); // 5/100
  });

  it('clamps realFailures at 0 when flakeEvents exceeds failingRuns', () => {
    const m = joinObserved([succ({ failingRuns: 1 })], [flake({ flakeEvents: 4 })]);
    expect(m.get(observedKey('c', 'pull_request'))!.realFailures).toBe(0);
  });

  it('a success stat with no matching flake stat → flakeRatePct 0, realFailures = failingRuns', () => {
    const m = joinObserved([succ({ name: 'd', failingRuns: 7 })], []);
    const cell = m.get(observedKey('d', 'pull_request'))!;
    expect(cell).toMatchObject({ realFailures: 7, flakeRatePct: 0 });
  });
});
