// Self-observability indicator (spec 001, Group O / FR-043) — a small spine dot
// showing the tool's own health (ingestion freshness, derivation cache, API
// rate-limit budget). Polls /self; degraded state surfaces the reasons on hover.
// App-global per the persona IA decision (lives in the spine, not a section).
import { useEffect, useState } from 'react';
import type { WorkspaceApi, ToolHealthDto } from './workspaceApi';

export function SelfHealthDot({ api, pollMs = 30_000 }: { api: WorkspaceApi; pollMs?: number }) {
  const [health, setHealth] = useState<ToolHealthDto | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.self().then((h) => { if (alive) setHealth(h); }).catch(() => { if (alive) setHealth(null); });
    load();
    const t = setInterval(load, pollMs);
    return () => { alive = false; clearInterval(t); };
  }, [api, pollMs]);

  if (!health) return <span className="self-health unknown" title="tool health unknown">◌</span>;

  // Surface ingestion freshness visibly (roadmap 4.3) — stale data degrades trust
  // even when the tool itself reports ok (e.g. the poller lags but the API is up).
  const STALE_SECS = 120;
  const fresh = health.ingestionFreshnessSecs;
  const stale = fresh != null && fresh > STALE_SECS;
  const age = fresh == null ? null
    : fresh < 60 ? `${fresh}s`
    : fresh < 3600 ? `${Math.round(fresh / 60)}m`
    : `${Math.round(fresh / 3600)}h`;
  const effStatus: 'ok' | 'degraded' = stale || health.status !== 'ok' ? 'degraded' : 'ok';

  const title = health.status !== 'ok'
    ? `Tool degraded — ${health.reasons.join('; ')}`
    : stale
      ? `Data is stale — last ingested ${age} ago (the poller may be lagging)`
      : `Tool healthy · data ${age} fresh · cache ${Math.round(health.derivationCache.hitRate * 100)}% hit`;

  return (
    <span className={`self-health ${effStatus}${stale ? ' stale' : ''}`} role="status" title={title} aria-label={title}>
      {effStatus === 'ok' ? '●' : '⚠'} tool{age != null && <span className="self-health-age"> · {stale ? `stale ${age}` : age}</span>}
    </span>
  );
}
