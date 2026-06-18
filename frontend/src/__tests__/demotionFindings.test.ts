import { describe, it, expect } from 'vitest';
import { demotionFindings } from '../sections/optimize/findings';
import type { DerivedModelLike } from '../sections/optimize/types';

const cell = (check: string, tierId: string, minutes: number, realFailures: number) =>
  ({ check, tierId, intent: { runs: true, gates: false, conditional: false }, observed: { runs: 10, minutes, realFailures, flakeRatePct: 0 }, state: 'advisory' });

const model = (cells: ReturnType<typeof cell>[]): DerivedModelLike =>
  ({ tiers: [], checks: [...new Set(cells.map((c) => c.check))], cells, checkMeta: [] } as unknown as DerivedModelLike);

describe('demotionFindings (findings-first — rank always-green waste)', () => {
  it('flags always-green checks (cost>0, zero real failures), ranked by cost', () => {
    const f = demotionFindings(model([
      cell('cheap', 'pr', 100, 0),
      cell('expensive', 'pr', 5000, 0),
      cell('useful', 'pr', 3000, 4), // real failures → NOT waste
    ]));
    expect(f.map((x) => x.check)).toEqual(['expensive', 'cheap']);
    expect(f[0]).toMatchObject({ check: 'expensive', minutes: 5000 });
  });

  it('aggregates a check across tiers', () => {
    const f = demotionFindings(model([cell('e2e', 'pr', 2000, 0), cell('e2e', 'queue', 1000, 0)]));
    expect(f[0]).toMatchObject({ check: 'e2e', minutes: 3000 });
  });

  it('returns nothing when every expensive check earns its keep', () => {
    expect(demotionFindings(model([cell('x', 'pr', 9000, 2)]))).toEqual([]);
  });
});
