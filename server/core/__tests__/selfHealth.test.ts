import { describe, it, expect } from 'vitest';
import { buildSelfHealth } from '../model/selfHealth';

const cache = { hits: 8, misses: 2, hitRate: 0.8, size: 3 };

describe('buildSelfHealth (Group O / FR-043)', () => {
  it('ok when ingestion is fresh and rate-limit is healthy', () => {
    const h = buildSelfHealth({ ingestionFreshnessSecs: 30, derivationCache: cache, apiRateLimit: { remaining: 4000, limit: 5000 } });
    expect(h.status).toBe('ok');
    expect(h.reasons).toEqual([]);
    expect(h.derivationCache.hitRate).toBe(0.8);
  });

  it('degraded when ingestion is stale past the threshold', () => {
    const h = buildSelfHealth({ ingestionFreshnessSecs: 600, derivationCache: cache, apiRateLimit: { remaining: 4000, limit: 5000 } });
    expect(h.status).toBe('degraded');
    expect(h.reasons[0]).toMatch(/ingestion is 600s stale/);
  });

  it('degraded when the API rate-limit budget is nearly exhausted (<10%)', () => {
    const h = buildSelfHealth({ ingestionFreshnessSecs: 10, derivationCache: cache, apiRateLimit: { remaining: 200, limit: 5000 } });
    expect(h.status).toBe('degraded');
    expect(h.reasons[0]).toMatch(/API budget low: 200\/5000/);
  });

  it('tolerates unknown ingestion + absent rate-limit (ok with no reasons)', () => {
    const h = buildSelfHealth({ ingestionFreshnessSecs: null, derivationCache: cache, apiRateLimit: null });
    expect(h.status).toBe('ok');
  });
});
