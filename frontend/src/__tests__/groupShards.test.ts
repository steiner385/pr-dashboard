import { describe, it, expect } from 'vitest';
import { groupShards } from '../sections/model/groupShards';

describe('groupShards (collapse matrix/list fan-out)', () => {
  it('groups N shards of one base into a single shard group, preserving order', () => {
    const rows = groupShards([
      'lint',
      'static-checks / test: unit (shard 1/8)',
      'static-checks / test: unit (shard 2/8)',
      'static-checks / test: unit (shard 3/8)',
      'build',
    ]);
    expect(rows).toEqual([
      { kind: 'single', check: 'lint' },
      { kind: 'shard', base: 'static-checks / test: unit', members: [
        'static-checks / test: unit (shard 1/8)',
        'static-checks / test: unit (shard 2/8)',
        'static-checks / test: unit (shard 3/8)',
      ] },
      { kind: 'single', check: 'build' },
    ]);
  });

  it('does not group a lone shard (1 member is just a single)', () => {
    expect(groupShards(['x / test (shard 1/4)'])).toEqual([{ kind: 'single', check: 'x / test (shard 1/4)' }]);
  });

  it('recognises "(shard N of M)" and "(N/M)" variants', () => {
    const rows = groupShards(['e2e (shard 1 of 3)', 'e2e (shard 2 of 3)', 'jest (1/2)', 'jest (2/2)']);
    expect(rows.filter((r) => r.kind === 'shard')).toHaveLength(2);
  });

  it('passes non-sharded checks through untouched', () => {
    expect(groupShards(['a', 'b'])).toEqual([{ kind: 'single', check: 'a' }, { kind: 'single', check: 'b' }]);
  });
});
