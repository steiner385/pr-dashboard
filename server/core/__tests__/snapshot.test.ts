import { describe, it, expect, vi } from 'vitest';
import { LiveSnapshotStore } from '../live/snapshot';

describe('LiveSnapshotStore (Tier-1 live store)', () => {
  it('is empty before the first frame, then latest-wins on get()', () => {
    const s = new LiveSnapshotStore<{ n: number }>();
    expect(s.get()).toBeNull();
    s.set({ n: 1 }); s.set({ n: 2 });
    expect(s.get()).toEqual({ n: 2 });
  });

  it('notifies subscribers on each frame and stops after unsubscribe', () => {
    const s = new LiveSnapshotStore<number>();
    const cb = vi.fn();
    const off = s.subscribe(cb);
    s.set(1); s.set(2);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(2);
    off();
    s.set(3);
    expect(cb).toHaveBeenCalledTimes(2); // no more after unsubscribe
    expect(s.subscriberCount()).toBe(0);
  });

  it('records updatedAt from the injected clock', () => {
    let t = 1000;
    const s = new LiveSnapshotStore<number>(() => t);
    expect(s.updatedAt()).toBe(0);
    t = 5000; s.set(1);
    expect(s.updatedAt()).toBe(5000);
  });

  it('a throwing subscriber does not break fan-out to the others', () => {
    const s = new LiveSnapshotStore<number>();
    const good = vi.fn();
    s.subscribe(() => { throw new Error('bad listener'); });
    s.subscribe(good);
    expect(() => s.set(1)).not.toThrow();
    expect(good).toHaveBeenCalledWith(1);
  });
});
