import { describe, it, expect } from 'vitest';
import { expandMatrix } from '../expand-matrix';

describe('expandMatrix', () => {
  it('no matrix → a single empty coordinate', () => {
    expect(expandMatrix(null)).toEqual([{}]);
  });

  it('one dimension → one instance per value', () => {
    expect(expandMatrix({ shard: [1, 2, 3] })).toEqual([{ shard: 1 }, { shard: 2 }, { shard: 3 }]);
  });

  it('two dimensions → cartesian product (stable order)', () => {
    expect(expandMatrix({ os: ['linux', 'mac'], node: [18, 20] })).toEqual([
      { os: 'linux', node: 18 }, { os: 'linux', node: 20 },
      { os: 'mac', node: 18 }, { os: 'mac', node: 20 },
    ]);
  });
});
