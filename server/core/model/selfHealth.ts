// Self-observability (spec 001, Group O / FR-043): the tool's own health. Pure
// aggregator over ingestion freshness, the derivation-cache stats, and the GitHub
// API rate-limit budget — the operator needs this BEFORE the API-heavy features
// (ruleset/security) lean on the rate-limit. Status is degraded when ingestion is
// stale or the rate-limit budget is nearly exhausted.
export interface ApiRateLimit { remaining: number; limit: number; resetAt?: string }
export interface CacheStats { hits: number; misses: number; hitRate: number; size: number }
export interface ToolHealth {
  ingestionFreshnessSecs: number | null;
  derivationCache: CacheStats;
  apiRateLimit: ApiRateLimit | null;
  status: 'ok' | 'degraded';
  reasons: string[];
}

export interface SelfHealthInput {
  ingestionFreshnessSecs: number | null;
  derivationCache: CacheStats;
  apiRateLimit: ApiRateLimit | null;
  /** ingestion is "stale" past this many seconds (default 300 — 5 poll cycles). */
  staleAfterSecs?: number;
  /** rate-limit "low" below this fraction of the limit (default 0.1). */
  lowRateFraction?: number;
}

export function buildSelfHealth(input: SelfHealthInput): ToolHealth {
  const staleAfter = input.staleAfterSecs ?? 300;
  const lowFrac = input.lowRateFraction ?? 0.1;
  const reasons: string[] = [];

  if (input.ingestionFreshnessSecs != null && input.ingestionFreshnessSecs > staleAfter) {
    reasons.push(`ingestion is ${input.ingestionFreshnessSecs}s stale (poller may be lagging)`);
  }
  const rl = input.apiRateLimit;
  if (rl && rl.limit > 0 && rl.remaining < rl.limit * lowFrac) {
    reasons.push(`GitHub API budget low: ${rl.remaining}/${rl.limit} remaining`);
  }

  return {
    ingestionFreshnessSecs: input.ingestionFreshnessSecs,
    derivationCache: input.derivationCache,
    apiRateLimit: rl,
    status: reasons.length ? 'degraded' : 'ok',
    reasons,
  };
}
