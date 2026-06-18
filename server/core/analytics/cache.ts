// Tier-3 of the unified-workspace data spine (spec 001, FR-024 / research D3): the
// warmed analytics cache. Heavy analyses (findings, metrics, fleet rollups) are
// recomputed on a background cadence and SERVED FROM CACHE on the request path —
// so a slow analysis never blocks the live (Tier-1) or on-demand (Tier-2) surfaces
// (P5/SC-007). Keyed by an arbitrary string (e.g. repo + window). Pure + injected
// clock; index.ts schedules refresh(), request handlers call cachedOnly().

interface Entry<V> { at: number; value: V }

export class WarmedCache<V> {
  private store = new Map<string, Entry<V>>();
  private inflight = new Map<string, Promise<V>>();

  constructor(
    private compute: (key: string) => Promise<V>,
    private ttlMs: number,
    private now: () => number = () => Date.now(),
  ) {}

  /** Request-path read: the cached value if present, else null. NEVER computes —
   *  guarantees the request path can't block on a heavy analysis (P5/SC-007). */
  cachedOnly(key: string): V | null {
    return this.store.get(key)?.value ?? null;
  }

  /** Cached value if fresh; otherwise (re)compute. De-dupes concurrent misses for
   *  the same key so a thundering herd computes once. Use off the request path. */
  async get(key: string): Promise<V> {
    const hit = this.store.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    return this.refresh(key);
  }

  /** Force a recompute (background cadence). Concurrent refreshes share one compute. */
  async refresh(key: string): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.compute(key)
      .then((value) => { this.store.set(key, { at: this.now(), value }); return value; })
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  /** Age (ms) of a key's cached value, or null if absent — feeds staleness display. */
  ageMs(key: string): number | null {
    const e = this.store.get(key);
    return e ? this.now() - e.at : null;
  }

  invalidate(key?: string): void {
    if (key) this.store.delete(key); else this.store.clear();
  }
}
