import { describe, it, expect } from 'vitest';
import { laneLayout } from '../sections/build/laneLayout';
import type { DerivedModelLike } from '../sections/optimize/types';

const cell = (check: string, tierId: string, runs: boolean, gates: boolean, conditional = false) =>
  ({ check, tierId, intent: { runs, gates, conditional }, observed: null, state: 'x' });

const MODEL: DerivedModelLike = {
  tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }],
  checks: ['e2e', 'build', 'lint'],
  cells: [
    cell('lint', 'pr', true, false),
    cell('e2e', 'pr', true, true),
    cell('build', 'queue', true, true),
    cell('e2e', 'queue', false, false), // does not run here → excluded
    cell('flaky', 'queue', true, false, true), // conditional
  ],
  checkMeta: [],
};

describe('laneLayout (canvas data foundation)', () => {
  it('produces one lane per tier with the checks that RUN there, gating flagged, sorted', () => {
    const lanes = laneLayout(MODEL);
    expect(lanes.map((l) => l.tierId)).toEqual(['pr', 'queue']);
    expect(lanes[0].nodes.map((n) => n.check)).toEqual(['e2e', 'lint']); // sorted; both run at PR
    expect(lanes[0].nodes.find((n) => n.check === 'e2e')!.gates).toBe(true);
    expect(lanes[0].nodes.find((n) => n.check === 'lint')!.gates).toBe(false);
  });

  it('excludes a cell where the check does not run at that tier', () => {
    const queue = laneLayout(MODEL).find((l) => l.tierId === 'queue')!;
    expect(queue.nodes.map((n) => n.check)).not.toContain('e2e'); // e2e@queue runs:false
    expect(queue.nodes.map((n) => n.check)).toEqual(['build', 'flaky']);
  });

  it('marks a conditional node', () => {
    const queue = laneLayout(MODEL).find((l) => l.tierId === 'queue')!;
    expect(queue.nodes.find((n) => n.check === 'flaky')!.conditional).toBe(true);
  });
});
