import { describe, it, expect, vi } from 'vitest';
import { WarmedCache } from '../analytics/cache';

describe('WarmedCache (Tier-3 warmed analytics cache)', () => {
  it('cachedOnly never computes — returns null before the first warm, value after', async () => {
    const compute = vi.fn(async (k: string) => `v:${k}`);
    let t = 0;
    const c = new WarmedCache(compute, 1000, () => t);
    expect(c.cachedOnly('a')).toBeNull();
    expect(compute).not.toHaveBeenCalled(); // request path never blocks on compute
    await c.refresh('a');
    expect(c.cachedOnly('a')).toBe('v:a');
  });

  it('get() serves from cache within TTL, recomputes after expiry', async () => {
    const compute = vi.fn(async (k: string) => `${k}@${compute.mock.calls.length}`);
    let t = 0;
    const c = new WarmedCache(compute, 1000, () => t);
    expect(await c.get('a')).toBe('a@1'); // miss → compute
    expect(await c.get('a')).toBe('a@1'); // hit within TTL → no recompute
    expect(compute).toHaveBeenCalledTimes(1);
    t = 1500;
    await c.get('a'); // expired → recompute
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('de-dupes concurrent misses for the same key (computes once)', async () => {
    let resolve!: (v: string) => void;
    const compute = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const c = new WarmedCache(compute, 1000);
    const [p1, p2] = [c.get('a'), c.get('a')];
    resolve('shared');
    expect(await p1).toBe('shared');
    expect(await p2).toBe('shared');
    expect(compute).toHaveBeenCalledTimes(1); // thundering-herd guard
  });

  it('ageMs + invalidate', async () => {
    let t = 100;
    const c = new WarmedCache(async () => 1, 1000, () => t);
    expect(c.ageMs('a')).toBeNull();
    await c.refresh('a');
    t = 350;
    expect(c.ageMs('a')).toBe(250);
    c.invalidate('a');
    expect(c.cachedOnly('a')).toBeNull();
  });
});
