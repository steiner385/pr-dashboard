import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { scrollBehavior } from './motion';
import type { HeadlineStat, MetricsBucket, MetricsPayload, MetricsWindow, DemotionCandidate } from './types';
import { RunnerRouting } from './RunnerRouting';
import { LEAD_TIME_SEGMENTS } from './leadtime';
import {
  AreaSeries, BandSeries, MultiLine, ScatterPlot, SignedLine,
  type BandPoint, type ChartPoint, type LineSeries, type ChartMarker,
} from './charts';
import { formatDur, formatSince } from './format';
import { NeedsGraph } from './NeedsGraph';
import { CONTROL_DEFINITIONS, DEFS, defTitle, type Definition } from './definitions';

const WINDOWS = ['24h', '3d', '7d', '14d', '30d'] as const;
const WINDOW_DAYS: Record<MetricsWindow, number> = {
  '24h': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30,
};
/** Mirrors the server clamp: hour buckets only for windows ≤ 7 days. */
const HOUR_BUCKET_MAX_DAYS = 7;

/** The window's full bucket axis (UTC keys), oldest first. */
function windowBuckets(window: MetricsWindow, bucket: MetricsBucket, now: Date): string[] {
  const days = WINDOW_DAYS[window];
  const out: string[] = [];
  if (bucket === 'day') {
    for (let i = days - 1; i >= 0; i--) {
      out.push(new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10));
    }
  } else {
    for (let i = days * 24 - 1; i >= 0; i--) {
      out.push(new Date(now.getTime() - i * 3600_000).toISOString().slice(0, 13));
    }
  }
  return out;
}

/** Align sparse buckets onto the full window axis; missing buckets → null gaps. */
function align<T extends { bucket: string }>(axis: string[], rows: T[],
  pick: (r: T) => number): ChartPoint[] {
  const by = new Map(rows.map((r) => [r.bucket, pick(r)]));
  return axis.map((bucket) => ({ bucket, value: by.get(bucket) ?? null }));
}

/** Count series: missing buckets are real zeroes, not gaps. */
function alignCounts(axis: string[], rows: { bucket: string; count: number }[]): ChartPoint[] {
  const by = new Map(rows.map((r) => [r.bucket, r.count]));
  return axis.map((bucket) => ({ bucket, value: by.get(bucket) ?? 0 }));
}

/** p50/p90 buckets onto the full axis for the band charts. */
function alignBand(axis: string[], rows: { bucket: string; p50: number; p90?: number }[]): BandPoint[] {
  const by = new Map(rows.map((r) => [r.bucket, r]));
  return axis.map((bucket) => {
    const r = by.get(bucket);
    return { bucket, p50: r?.p50 ?? null, p90: r?.p90 ?? null };
  });
}

/** "+50% vs prev" / "≈ prev"; null when the delta isn't computable. */
function deltaText(stat: HeadlineStat): string | null {
  if (stat.value == null || stat.prev == null || stat.prev === 0) return null;
  const pct = Math.round(((stat.value - stat.prev) / stat.prev) * 100);
  if (pct === 0) return '≈ prev';
  return `${pct > 0 ? '+' : ''}${pct}% vs prev`;
}

const fmtHours = (h: number): string => formatDur(h * 3600);
const fmtCount = (v: number): string => String(Math.round(v));
const fmtPct = (v: number): string => `${Math.round(v)}%`;
/** Runner-minutes (issue #43): whole minutes ≥ 10, one decimal below. */
const fmtMinutes = (m: number): string =>
  m >= 10 ? `${Math.round(m)}m` : `${Math.round(m * 10) / 10}m`;
const fmtDollars = (d: number): string => `$${d.toFixed(2)}`;

/** Line colors for the per-pool cost series (cycled when pools outnumber them). */
const POOL_COLORS = ['var(--accent)', 'var(--amber)', 'var(--purple)', 'var(--fail)', 'var(--done)'];

/**
 * Calibration headline: signed median error → plain English. POSITIVE error
 * means stages took longer than first promised (ETAs run optimistic).
 */
function calibrationHeadline(medianErrorPct: number, n: number): string {
  const pct = Math.round(Math.abs(medianErrorPct));
  if (pct === 0) return `p50 ETAs on target (n=${n})`;
  return `p50 ETAs run ${pct}% ${medianErrorPct > 0 ? 'optimistic' : 'pessimistic'} (n=${n})`;
}

// ---- Metrics sub-tabs (page cleanup): group the 20+ panels into 5 sections,
// each rendered on its own sub-tab so the page isn't one endless scroll.
type MetricsSection = 'tuning' | 'throughput' | 'performance' | 'reliability' | 'cost';
const METRICS_SECTIONS: { id: MetricsSection; label: string }[] = [
  { id: 'tuning', label: 'Tuning' },
  { id: 'throughput', label: 'Throughput & queue' },
  { id: 'performance', label: 'Performance' },
  { id: 'reliability', label: 'Reliability' },
  { id: 'cost', label: 'Cost' },
];
const SECTION_STORAGE_KEY = 'prdash.metrics.section';

/** Deep-link a Tuning recommendation to the panel that is its evidence (UX-M4):
 *  the section to switch to + the panel id to scroll/focus. lint:* kinds all map
 *  to the workflow-lint panel (handled by prefix in resolveRecLink). */
const REC_LINK: Record<string, { section: MetricsSection; panel: string }> = {
  'batch-size': { section: 'throughput', panel: 'metrics-batch-advisor' },
  'admin-bypass': { section: 'throughput', panel: 'metrics-queue-efficiency' },
  'advisory-in-merge-group': { section: 'throughput', panel: 'metrics-queue-efficiency' },
  'set-required-prefixes': { section: 'throughput', panel: 'metrics-queue-efficiency' },
};
function resolveRecLink(kind: string): { section: MetricsSection; panel: string } | null {
  return REC_LINK[kind] ?? (kind.startsWith('lint:')
    ? { section: 'reliability', panel: 'metrics-workflow-lint' } : null);
}
const ActiveSectionContext = createContext<MetricsSection>('tuning');

function Panel({ id, title, empty, emptyText = 'no data yet', section, children }: {
  id?: string; title: string; empty: boolean; emptyText?: string;
  /** Which metrics sub-tab this panel belongs to; hidden unless that tab is active. */
  section: MetricsSection; children: ReactNode;
}) {
  const active = useContext(ActiveSectionContext);
  // Hide inactive sections with a CSS class (display:none) rather than the
  // `hidden` attribute — display:none hides from screen readers too (correct for
  // an inactive tab), and it keeps the panels in the DOM for one-payload data.
  return (
    <section className={`metric-panel${section === active ? '' : ' metric-panel--inactive'}`}
      id={id} data-section={section}>
      <h2 tabIndex={id ? -1 : undefined}>{title}</h2>
      {empty ? <p className="metric-empty">{emptyText}</p> : children}
    </section>
  );
}

function MetricStat({ label, value, delta, def }: {
  label: string; value: string; delta?: string | null;
  /** What this figure means / how it's computed (issue #66) — every headline
   *  stat must carry one; rendered as the mouse tooltip AND, for screen-reader
   *  users who can't reach a title=, an aria-describedby hidden description (UX-M1). */
  def: Definition;
}) {
  const descId = useId();
  return (
    <div className="metric-stat" title={defTitle(def)} aria-describedby={descId}>
      <b>{value}</b>
      <span>{label}</span>
      {delta != null && <em className="metric-delta">{delta}</em>}
      <span id={descId} className="sr-only">{defTitle(def)}</span>
    </div>
  );
}

/** Labeled full-width chart block inside a repo sub-section. */
function ChartBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="metric-chart-block">
      <span className="metric-label">{label}</span>
      {children}
    </div>
  );
}

const TREND_SERIES = [
  { key: 'open', color: 'var(--accent)' },
  { key: 'ci', color: 'var(--amber)' },
  { key: 'queue', color: 'var(--purple)' },
  { key: 'failed', color: 'var(--fail)' },
] as const;

/** Segments need at least this many merged-PR samples before the median is
 *  trusted; below it the legend reads 'collecting'. */
const LEAD_TIME_MIN_N = 5;

/**
 * Lead-time decomposition for one repo (issue #44): DORA-lite headline tiles
 * plus one horizontal stacked bar whose segment widths are proportional to the
 * per-stage medians (hover = value + sample count). Segments without a single
 * complete timestamp pair are absent from the bar but listed in the legend.
 */
function LeadTimeRepo({ lt }: { lt: MetricsPayload['leadTime'][number] }) {
  const meta = new Map(LEAD_TIME_SEGMENTS.map((s) => [s.id, s]));
  const present = lt.segments.filter((s) => s.medianSecs != null);
  const total = present.reduce((sum, s) => sum + s.medianSecs!, 0);
  return (
    <div className="metric-repo">
      <h3>{lt.repo}</h3>
      <div className="metric-row">
        <MetricStat label="deploy frequency (prod)" def={DEFS.deployFrequency}
          value={`${(Math.round(lt.deploysPerDay * 10) / 10).toString()}/day`}
          delta={`${lt.prodDeploys} prod deploy${lt.prodDeploys === 1 ? '' : 's'} in window`} />
        <MetricStat label="lead time created → prod (p50)" def={DEFS.leadTimeTotal}
          value={lt.totalP50Secs != null ? formatDur(lt.totalP50Secs) : '–'}
          delta={lt.totalN > 0 ? `n=${lt.totalN}` : 'no PR has both timestamps yet'} />
      </div>
      {present.length === 0 || total === 0 ? (
        <div className="chart-placeholder">collecting data — segments populate as merged PRs pick up timestamps</div>
      ) : (
        <div className="leadtime-bar" data-testid={`leadtime-bar-${lt.repo}`}>
          {present.map((s) => (
            <div key={s.id} className="leadtime-seg"
              style={{ width: `${(s.medianSecs! / total) * 100}%`, background: meta.get(s.id)!.color }}
              title={`${meta.get(s.id)!.label}: ${formatDur(s.medianSecs!)} (n=${s.n})`} />
          ))}
        </div>
      )}
      <div className="chart-legend">
        {lt.segments.map((s) => {
          const m = meta.get(s.id)!;
          return (
            <span key={s.id} className="legend-item" title={`${m.label} — ${m.desc}`}>
              <i className="legend-chip" style={{ background: m.color }} aria-hidden="true" />
              {m.label}
              {s.medianSecs != null && <> {formatDur(s.medianSecs)} (n={s.n})</>}
              {s.n < LEAD_TIME_MIN_N && <em className="leadtime-collecting"> collecting</em>}
            </span>
          );
        })}
      </div>
      <p className="metric-note">
        bar = median time per stage over PRs merged in the window (each stage
        counts only PRs with both endpoint timestamps). merged → QA and QA →
        prod use historical deploy data; first-green and enqueued timestamps
        only record from new merges onward — those segments read
        &lsquo;collecting&rsquo; until n ≥ {LEAD_TIME_MIN_N}
      </p>
    </div>
  );
}

export function MetricsView({ now, focusCostNonce }: {
  /** Injectable clock (tests) — the window axis is derived from it. */
  now?: () => Date;
  /** Bumped by the global health header's Cost chip — scrolls the CI-cost panel
   *  into view and moves focus to its heading. */
  focusCostNonce?: number;
} = {}) {
  const [window, setWindow] = useState<MetricsWindow>('3d');
  const [bucketPref, setBucketPref] = useState<MetricsBucket>('hour');
  // Per-candidate demotion draft-PR state, keyed `${repo}::${name}/${event}`.
  const [demotePr, setDemotePr] = useState<Record<string, { loading?: boolean; url?: string; error?: string }>>({});
  const draftDemotionPr = async (repo: string, candidate: DemotionCandidate) => {
    const key = `${repo}::${candidate.name}/${candidate.event}`;
    setDemotePr((p) => ({ ...p, [key]: { loading: true } }));
    try {
      const res = await fetch('/api/demotion/draft-pr', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo, candidate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDemotePr((p) => ({ ...p, [key]: { url: data.url } }));
    } catch (e) {
      setDemotePr((p) => ({ ...p, [key]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  };
  const [section, setSection] = useState<MetricsSection>(() => {
    try {
      const s = localStorage.getItem(SECTION_STORAGE_KEY);
      if (s && METRICS_SECTIONS.some((x) => x.id === s)) return s as MetricsSection;
    } catch { /* private mode */ }
    // Default to the ranked Tuning Actions — the one panel that says what to fix
    // — rather than a data section, when there's no remembered preference (UX-M3).
    return 'tuning';
  });
  const selectSection = (s: MetricsSection) => {
    setSection(s);
    try { localStorage.setItem(SECTION_STORAGE_KEY, s); } catch { /* ignore */ }
  };
  // Jump from a recommendation to its evidence panel: switch section, then (after
  // the panel re-renders into view) scroll to it and move focus to its heading (UX-M4).
  const goToEvidence = (kind: string) => {
    const link = resolveRecLink(kind);
    if (!link) return;
    selectSection(link.section);
    requestAnimationFrame(() => {
      const el = document.getElementById(link.panel);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el?.querySelector('h2')?.focus?.();
    });
  };
  const [payload, setPayload] = useState<MetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const hourDisabled = WINDOW_DAYS[window] > HOUR_BUCKET_MAX_DAYS;
  const bucket: MetricsBucket = hourDisabled ? 'day' : bucketPref;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/metrics?window=${window}&bucket=${bucket}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<MetricsPayload>;
      })
      .then((data) => { if (!cancelled) setPayload(data); })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [window, bucket, refreshTick]);

  // Cost chip in the global health header → bring the CI-cost panel into view.
  // The panel only exists once the metrics payload has loaded (this view
  // lazy-mounts and fetches on first tab visit), so this also depends on
  // `payload`: a fresh click whose panel isn't rendered yet retries when the
  // data arrives. `handledCostNonce` makes each click scroll exactly once,
  // never again on a later background refresh.
  const handledCostNonce = useRef(0);
  useEffect(() => {
    if (!focusCostNonce || focusCostNonce === handledCostNonce.current) return;
    const el = document.getElementById('metrics-ci-cost');
    if (!el) return;   // panel not rendered yet — re-runs when `payload` lands
    handledCostNonce.current = focusCostNonce;
    requestAnimationFrame(() => {
      el.scrollIntoView?.({ behavior: scrollBehavior(), block: 'start' });
      el.querySelector('h2')?.focus?.();
    });
  }, [focusCostNonce, payload]);

  const controls = (
    <div className="metrics-controls">
      <div className="metrics-group" role="group" aria-label="Window">
        {WINDOWS.map((w) => (
          <button key={w} type="button" className="metrics-window-btn"
            title={defTitle(CONTROL_DEFINITIONS.window)}
            aria-pressed={window === w} onClick={() => setWindow(w)}>
            {w}
          </button>
        ))}
      </div>
      <span className="metrics-sep" aria-hidden="true" />
      <div className="metrics-group" role="group" aria-label="Bucket size">
        <button type="button" className="metrics-window-btn" disabled={hourDisabled}
          title={hourDisabled
            ? 'hourly disabled above 7d — long windows clamp to daily buckets'
            : defTitle(CONTROL_DEFINITIONS.bucketHour)}
          aria-pressed={bucket === 'hour'} onClick={() => setBucketPref('hour')}>
          hourly
        </button>
        <button type="button" className="metrics-window-btn"
          title={defTitle(CONTROL_DEFINITIONS.bucketDay)}
          aria-pressed={bucket === 'day'} onClick={() => setBucketPref('day')}>
          daily
        </button>
      </div>
      <button type="button" className="metrics-refresh" aria-label="Refresh metrics"
        title={defTitle(CONTROL_DEFINITIONS.refresh)}
        onClick={() => setRefreshTick((t) => t + 1)}>
        ↻
      </button>
    </div>
  );

  if (error) {
    return (
      <div className="metrics">
        {controls}
        <p className="metrics-error">metrics fetch failed: {error}</p>
      </div>
    );
  }
  if (!payload) {
    return (
      <div className="metrics">
        {controls}
        <p className="loading">Loading metrics…</p>
      </div>
    );
  }

  const kind = payload.bucket;
  const noun = kind === 'hour' ? 'hour' : 'day';
  const axis = windowBuckets(payload.window, payload.bucket, (now ?? (() => new Date()))());

  // Repos with zero data in a panel are omitted entirely (not zero rows).
  const trendRepos = payload.trends.filter((t) => t.points.length);
  const runnerByRepo = new Map<string, typeof payload.runnerWaits>();
  for (const rw of payload.runnerWaits) {
    if (!rw.buckets.length) continue;
    runnerByRepo.set(rw.repo, [...(runnerByRepo.get(rw.repo) ?? []), rw]);
  }
  const queueRepos = payload.queue.filter((q) =>
    q.mergesPerBucket.length || q.queueWaitBuckets.length || q.groupRunBuckets.length);
  const jobRepos = payload.slowestJobs.filter((r) => r.jobs.length);
  const velocityRepos = payload.velocity.filter((v) =>
    v.mergedPerBucket.length || v.mergeToQaBuckets.length || v.avgLifespanBuckets.length);
  const calByRepo = new Map<string, typeof payload.calibration>();
  for (const c of payload.calibration) {
    if (!c.buckets.length && !c.points.length) continue;
    calByRepo.set(c.repo, [...(calByRepo.get(c.repo) ?? []), c]);
  }
  const flakeRepos = payload.flakiness.filter((f) => f.checks.length);
  const demotionRepos = (payload.demotionCandidates ?? []).filter((d) => d.candidates.length);
  const promotionRepos = (payload.promotionCandidates ?? []).filter((p) => p.candidates.length);
  const killerRepos = payload.trainKillers.filter((t) => t.checks.length);
  const cpByRepo = new Map<string, typeof payload.criticalPath>();
  for (const cp of payload.criticalPath) {
    if (!cp.path.length) continue;
    cpByRepo.set(cp.repo, [...(cpByRepo.get(cp.repo) ?? []), cp]);
  }
  // Needs-graph (#74): group per-(repo,event) graphs by repo for the panel.
  const needsByRepo = new Map<string, NonNullable<typeof payload.needsGraph>>();
  for (const g of payload.needsGraph ?? []) {
    needsByRepo.set(g.repo, [...(needsByRepo.get(g.repo) ?? []), g]);
  }
  const lintRepos = payload.lint.filter((l) => l.findings.length);
  // ?? []: tolerate a pre-upgrade server payload while the SPA is newer
  const leadTimeRepos = payload.leadTime ?? [];
  const regressionRepos = (payload.regressions ?? []).filter((r) => r.checks.length);
  // Fleet telemetry (issues #45/#46/#47) — same pre-upgrade tolerance
  const poolsByRepo = new Map<string, typeof payload.runnerPools>();
  for (const rp of payload.runnerPools ?? []) {
    if (!rp.buckets.length && !rp.starving) continue;
    poolsByRepo.set(rp.repo, [...(poolsByRepo.get(rp.repo) ?? []), rp]);
  }
  const reclaimRepos = (payload.reclaims ?? []).filter((r) => r.total > 0);
  const concByRepo = new Map<string, typeof payload.concurrency>();
  for (const c of payload.concurrency ?? []) {
    if (!c.buckets.length) continue;
    concByRepo.set(c.repo, [...(concByRepo.get(c.repo) ?? []), c]);
  }
  const costRepos = (payload.cost ?? []).filter((c) => c.pools.length > 0);
  // Cost explorer sub-sections (?? [] tolerates a pre-upgrade server payload)
  const costJobsByRepo = new Map((payload.costJobs ?? []).map((j) => [j.repo, j.jobs]));
  const costRunsByRepo = new Map((payload.costRuns ?? []).map((r) => [r.repo, r.runs]));
  // Actuals vs attributed (phase 2): always day-keyed — bills are daily
  const costActualScopes = (payload.costActuals ?? []).filter((a) => a.days.length > 0);
  const dayAxis = windowBuckets(payload.window, 'day', (now ?? (() => new Date()))());

  const recommendations = payload.recommendations ?? [];
  // Config-change annotations (tuning tool): bucket each change like every other
  // timestamp and group by repo, so the charts can overlay markers and the
  // digest below can list "what changed when".
  const configChanges = payload.configChanges ?? [];
  const changeMarkersByRepo = new Map<string, ChartMarker[]>();
  for (const c of configChanges) {
    const b = c.at.slice(0, payload.bucket === 'hour' ? 13 : 10);
    const label = `${c.field}: ${c.oldValue ?? '∅'} → ${c.newValue ?? '∅'}`;
    if (!changeMarkersByRepo.has(c.repo)) changeMarkersByRepo.set(c.repo, []);
    changeMarkersByRepo.get(c.repo)!.push({ bucket: b, label });
  }
  return (
    <div className="metrics">
      {controls}

      {/* A group of aria-pressed toggle buttons, NOT a tablist (UX-H3): each
          button reveals MANY panels of its section, so the one-tab-one-tabpanel
          ARIA tabs contract doesn't apply. */}
      <nav className="metrics-subtabs" role="group" aria-label="Metrics sections">
        {METRICS_SECTIONS.map((s) => (
          <button key={s.id} type="button" aria-pressed={section === s.id}
            className={section === s.id ? 'metrics-subtab active' : 'metrics-subtab'}
            data-testid={`metrics-subtab-${s.id}`}
            onClick={() => selectSection(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>

      <ActiveSectionContext.Provider value={section}>

      <Panel title="Tuning actions" section="tuning" empty={recommendations.length === 0}
        emptyText="nothing to tune — every advisor is satisfied">
        <p className="metric-note">
          everything the dashboard recommends, ranked. Derived from the panels below;
          apply a change and watch its effect on the charts.
        </p>
        <ul className="rec-list" data-testid="recommendations">
          {recommendations.map((r, i) => (
            <li key={`${r.repo}-${r.kind}-${i}`} className={`rec rec-${r.priority}`}
              data-testid={`rec-${r.kind}`}>
              <span className="rec-priority" title={defTitle(DEFS.recommendationsPriority)}>{r.priority}</span>
              <span className="rec-body">
                <span className="rec-title">{r.title}</span>
                <span className="rec-detail">{r.detail}</span>
                <span className="rec-repo">{r.repo}</span>
                {resolveRecLink(r.kind) && (
                  <button type="button" className="rec-link" data-testid={`rec-link-${r.kind}`}
                    onClick={() => goToEvidence(r.kind)}>
                    view evidence →
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Recent config changes" section="tuning" empty={configChanges.length === 0}
        emptyText="no tuning-knob changes in this window">
        <p className="metric-note">
          auto-detected changes to batch size, requiredCheckPrefixes, and workflow path —
          also overlaid as <span className="cfg-marker-swatch">amber markers</span> on the queue
          charts below, so you can see each change’s effect.
        </p>
        <ul className="cfg-change-list" data-testid="config-changes">
          {[...configChanges].reverse().map((c, i) => (
            <li key={`${c.repo}-${c.field}-${c.at}-${i}`} className="cfg-change"
              data-testid={`cfg-change-${c.field}`}>
              <span className="cfg-change-when">{new Date(c.at).toLocaleString()}</span>
              <span className="cfg-change-body">
                <span className="cfg-change-field">{c.field}</span>
                {' '}<span className="cfg-change-from">{c.oldValue ?? '∅'}</span>
                {' → '}<span className="cfg-change-to">{c.newValue ?? '∅'}</span>
                <span className="rec-repo">{c.repo}</span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Duration regressions" section="performance" empty={regressionRepos.length === 0}
        emptyText="none active">
        {regressionRepos.map((r) => (
          <div key={r.repo} className="metric-repo">
            <h3>{r.repo}</h3>
            <ul className="regression-strip">
              {r.checks.map((c) => (
                <li key={`${c.check}/${c.event}`} className="regression-chip"
                  title={defTitle(DEFS.regressionRule)}>
                  <span className="regression-arrow" aria-hidden="true">↑</span>
                  <span className="metric-job-name">{c.check}</span>
                  <span className="regression-step">
                    {' '}({c.event}) p50 {formatDur(c.priorP50Secs)} → {formatDur(c.recentP50Secs)}
                    {' '}(×{(Math.round(c.ratio * 10) / 10).toString()})
                    {' '}since {formatSince(c.sinceApprox)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="metric-note">
              active p50 step-ups from the hourly scan — recent 10-run median ≥
              1.5× the prior 20-run median AND +60s; an entry clears below
              ×1.2. Live state, ignores the window selector
            </p>
          </div>
        ))}
      </Panel>

      <Panel title="Lead time" section="throughput" empty={leadTimeRepos.length === 0}>
        {leadTimeRepos.map((lt) => <LeadTimeRepo key={lt.repo} lt={lt} />)}
      </Panel>

      <Panel title="Trends" section="throughput" empty={trendRepos.length === 0}>
        {trendRepos.map((t) => {
          const latest = t.points[t.points.length - 1]!;
          const series: LineSeries[] = TREND_SERIES.map((s) => ({
            name: s.key, color: s.color,
            points: align(axis, t.points, (p) => p[s.key]),
          }));
          return (
            <div key={t.repo} className="metric-repo">
              <h3>{t.repo}</h3>
              <div className="metric-row">
                {TREND_SERIES.map((s) => (
                  <MetricStat key={s.key} label={s.key} value={String(latest[s.key])}
                    def={DEFS.trendCounts} />
                ))}
              </div>
              <ChartBlock label={`PRs by state per ${noun}`}>
                <MultiLine series={series} kind={kind}
                  label={`${t.repo} open/ci/queue/failed PR counts per ${noun}`} />
              </ChartBlock>
            </div>
          );
        })}
      </Panel>

      <Panel title="Runner-wait health" section="performance" empty={runnerByRepo.size === 0}>
        {[...runnerByRepo.entries()].map(([repo, tiers]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            <div className="metric-row">
              {tiers.map((tier) => (
                <MetricStat key={tier.event} label={`${tier.event} p50 wait`}
                  def={DEFS.runnerWaitP50}
                  value={tier.p50.value != null ? formatDur(tier.p50.value) : '–'}
                  delta={deltaText(tier.p50)} />
              ))}
            </div>
            {tiers.map((tier) => (
              <ChartBlock key={tier.event} label={`${tier.event} wait per ${noun}`}>
                <BandSeries points={alignBand(axis, tier.buckets)} kind={kind}
                  format={formatDur}
                  label={`${repo} ${tier.event} runner wait p50/p90 per ${noun}`} />
              </ChartBlock>
            ))}
          </div>
        ))}
      </Panel>

      <Panel title="Runner pools" section="performance" empty={poolsByRepo.size === 0}
        emptyText="no pool-labeled waits yet — samples label from new runs onward">
        {[...poolsByRepo.entries()].map(([repo, pools]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            <div className="metric-row">
              {pools.map((rp) => (
                <MetricStat key={rp.pool} label={`${rp.pool} p50 wait`}
                  def={DEFS.poolWaitP50}
                  value={rp.p50.value != null ? formatDur(rp.p50.value) : '–'}
                  delta={deltaText(rp.p50)} />
              ))}
            </div>
            {pools.map((rp) => (
              <div key={rp.pool}>
                <ChartBlock label={`${rp.pool} wait per ${noun}`}>
                  <BandSeries points={alignBand(axis, rp.buckets)} kind={kind}
                    format={formatDur}
                    label={`${repo} ${rp.pool} runner wait p50/p90 per ${noun}`} />
                </ChartBlock>
                {(rp.lastHourP90Secs != null || rp.baselineP90Secs != null) && (
                  <p className={rp.starving ? 'metric-note pool-starving' : 'metric-note'}
                    title={defTitle(DEFS.starvationRule)}
                    data-testid={`pool-health-${repo}-${rp.pool}`}>
                    {rp.starving && <strong>⚠ STARVING — </strong>}
                    last-hour p90 {rp.lastHourP90Secs != null ? formatDur(rp.lastHourP90Secs) : '–'}
                    {' '}vs 7d baseline p90 {rp.baselineP90Secs != null ? formatDur(rp.baselineP90Secs) : '–'}
                  </p>
                )}
              </div>
            ))}
            <p className="metric-note">
              pickup waits keyed by the job&rsquo;s runs-on pool (an &lsquo;a|b&rsquo;
              pool is a runs-on ternary — the chosen branch isn&rsquo;t knowable).
              The starvation alert enters at p90 &gt; max(5min, 4× the 7d
              baseline) with ≥5 samples/hour and clears below 2×
            </p>
          </div>
        ))}
      </Panel>

      <Panel title="Concurrency demand" section="performance" empty={concByRepo.size === 0}
        emptyText="no job intervals in window yet">
        {[...concByRepo.entries()].map(([repo, pools]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            <div className="metric-row">
              {pools.map((c) => (
                <MetricStat key={c.pool} label={`${c.pool} window peak`}
                  def={DEFS.concurrencyPeak} value={String(c.peak)} />
              ))}
            </div>
            {pools.map((c) => (
              <ChartBlock key={c.pool} label={`${c.pool} peak concurrent jobs per ${noun}`}>
                <AreaSeries points={align(axis, c.buckets, (b) => b.peak)} kind={kind}
                  format={fmtCount}
                  label={`${repo} ${c.pool} peak concurrent jobs per ${noun}`} />
              </ChartBlock>
            ))}
            <p className="metric-note">
              peak simultaneous jobs per {noun}, swept from observed check
              intervals — no fleet-cap overlay yet (the cap isn&rsquo;t known to
              the dashboard; follow-up: a per-pool cap config knob)
            </p>
          </div>
        ))}
      </Panel>

      <Panel id="metrics-ci-cost" title="CI cost" section="cost"
        empty={costRepos.length === 0 && costActualScopes.length === 0}
        emptyText="no runner-minutes in window yet">
        {/* Cost empirical auto-rate (issue #100): when enabled and derivable,
            the fully-loaded $/min used for non-github-hosted pools — fleet
            actuals ÷ tracked runner-minutes, so dollars reflect true cost. */}
        {payload.costAutoRate && (
          <p className="metric-note" data-testid="cost-auto-rate"
            title="Fully-loaded rate: the window's fleet bill spread across tracked
              EC2 runner-minutes (idle/boot/teardown included). Replaces the static
              config rate for non-github-hosted pools.">
            empirical ${payload.costAutoRate.dollarsPerMinute.toFixed(4)}/min
            {' '}(auto — fleet ÷ tracked minutes)
          </p>
        )}
        {/* Actuals vs attributed (phase 2): imported daily bills per scope,
            with the coverage headline. Day-keyed regardless of the bucket
            selector — bills are daily. */}
        {costActualScopes.map((a) => {
          const dayRows = a.days.map((d) => ({ bucket: d.date, ...d }));
          const series: LineSeries[] = [
            { name: 'actual $', color: POOL_COLORS[1]!,
              points: align(dayAxis, dayRows, (d) => d.actualDollars) },
            { name: 'attributed $', color: POOL_COLORS[0]!,
              points: align(dayAxis, dayRows.filter((d) => d.attributedDollars != null),
                (d) => d.attributedDollars!) },
          ];
          return (
            <div key={a.scope} className="metric-repo" data-testid={`cost-actuals-${a.scope}`}>
              <h3>actual spend — {a.scope}</h3>
              <div className="metric-row">
                <MetricStat label="actual spend" def={DEFS.costActualsActual}
                  value={fmtDollars(a.totalActualDollars)}
                  delta={`${a.days.length} day${a.days.length === 1 ? '' : 's'} imported`} />
                <MetricStat label="attributed" def={DEFS.costActualsAttributed}
                  value={a.totalAttributedDollars != null
                    ? fmtDollars(a.totalAttributedDollars) : '–'} />
                <MetricStat label="coverage" def={DEFS.costActualsCoverage}
                  value={a.coveragePct != null ? fmtPct(a.coveragePct) : '–'}
                  delta={a.coverageSince ? `tracked days since ${a.coverageSince}`
                    : 'no tracked days yet'} />
              </div>
              {a.coveragePct != null && (() => {
                // Re-derive the comparable window (tracked + fully billed) so the
                // headline's dollar figures match the coverage % the server
                // computed over the same days — never the mismatched full totals.
                const todayUtc = (now ?? (() => new Date()))().toISOString().slice(0, 10);
                const cmp = a.coverageSince
                  ? a.days.filter((d) => d.date >= a.coverageSince! && d.date < todayUtc) : [];
                const cmpActual = cmp.reduce((s, d) => s + d.actualDollars, 0);
                const cmpAttr = cmp.reduce((s, d) => s + (d.attributedDollars ?? 0), 0);
                const over = a.coveragePct > 100;
                return (
                  <p className="metric-note cost-coverage-headline"
                    title={defTitle(DEFS.costActualsCoverage)}
                    data-testid={`cost-coverage-${a.scope}`}>
                    over the {cmp.length} tracked day{cmp.length === 1 ? '' : 's'} since {a.coverageSince},
                    {' '}jobs explain {fmtPct(a.coveragePct)} of {a.scope} spend
                    {over
                      ? ` — attributed (${fmtDollars(cmpAttr)}) runs over actual (${fmtDollars(cmpActual)}), so the per-minute rate is pricing the fixed-capacity fleet too high (or recent days haven’t fully billed)`
                      : ` — the rest (${fmtDollars(cmpActual - cmpAttr)}) is idle runner capacity, node boot/teardown, and unpriced pools that no single job owns`}.
                    {' '}Actual spend is the bill; coverage is how completely we can explain it
                  </p>
                );
              })()}
              <ChartBlock label="actual vs attributed $ per day">
                <MultiLine series={series} kind="day" format={fmtDollars}
                  label={`${a.scope} actual vs attributed dollars per day`} />
              </ChartBlock>
              <table className="metric-table">
                <thead>
                  <tr>
                    <th>day</th>
                    <th title={defTitle(DEFS.costActualsActual)}>actual $</th>
                    <th title={defTitle(DEFS.costActualsAttributed)}>attributed $</th>
                    <th title="Coverage to date — attributed ÷ actual summed over comparable
                      days up to and including this one. Cumulative, not per-day: a single
                      day's attributed (jobs that ran × rate) and actual (what AWS billed
                      that date) aren't comparable, so this running figure is the honest one.
                      Blank for pre-tracking days and today's still-settling bill.">
                      coverage to date
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {a.days.map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td>{fmtDollars(d.actualDollars)}</td>
                      <td>{d.attributedDollars != null ? fmtDollars(d.attributedDollars) : '–'}</td>
                      <td>{d.cumulativeCoveragePct != null
                        ? fmtPct(d.cumulativeCoveragePct) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {a.totalAttributedDollars != null && (
                <p className="metric-note">
                  per-day <em>attributed</em> can exceed <em>actual</em> on a burst day — a
                  fixed-capacity fleet’s nodes cost the same whether they run 100 or 36,000
                  job-minutes, so a heavy day overshoots its flat daily bill and a quiet day
                  undershoots. Only the cumulative reconciles, which is why coverage is shown
                  to-date.
                </p>
              )}
              {a.totalAttributedDollars == null && (
                <p className="metric-note">
                  attribution needs rates — set costPerMinute or poolMeta $/min in
                  config.json to compute coverage
                </p>
              )}
            </div>
          );
        })}
        {costRepos.map((c) => {
          const maxPoolMinutes = Math.max(...c.pools.map((pl) => pl.minutes));
          const series: LineSeries[] = c.pools.map((pl, i) => ({
            name: pl.pool, color: POOL_COLORS[i % POOL_COLORS.length]!,
            points: align(axis, pl.buckets, (b) => b.minutes),
          }));
          const jobs = costJobsByRepo.get(c.repo) ?? [];
          const runs = costRunsByRepo.get(c.repo) ?? [];
          /** Instance type for a pool key, via the repo's pool rows ('–' unset). */
          const instanceTypeOf = (cc: typeof c, pool: string): string =>
            cc.pools.find((pl) => pl.pool === pool)?.instanceType ?? '–';
          return (
            <div key={c.repo} className="metric-repo">
              <h3>{c.repo}</h3>
              <div className="metric-row">
                <MetricStat label="runner-minutes" def={DEFS.costTotalMinutes}
                  value={fmtMinutes(c.totalMinutes)}
                  delta={c.totalDollars != null ? fmtDollars(c.totalDollars) : null} />
                <MetricStat label="minutes / merged PR" def={DEFS.costPerMergedPr}
                  value={c.minutesPerMergedPr != null ? fmtMinutes(c.minutesPerMergedPr) : '–'}
                  delta={`${c.mergesInWindow} merge${c.mergesInWindow === 1 ? '' : 's'} in window`} />
                <MetricStat label="retry burden" def={DEFS.costRetryBurden}
                  value={fmtMinutes(c.retryMinutes)}
                  delta={c.retryDollars != null ? fmtDollars(c.retryDollars) : null} />
              </div>
              <span className="metric-label">by pool</span>
              <ul className="cost-pools">
                {c.pools.map((pl) => (
                  <li key={pl.pool} className="cost-pool" title={defTitle(DEFS.costPoolShare)}
                    data-testid={`cost-pool-${c.repo}-${pl.pool}`}>
                    <span className="metric-job-name">{pl.pool}</span>
                    <span className="cost-pool-instance" title={defTitle(DEFS.costInstanceType)}>
                      {pl.instanceType ?? '–'}
                    </span>
                    <span className="cost-pool-track" aria-hidden="true">
                      <i className="cost-pool-bar"
                        style={{ width: `${maxPoolMinutes > 0 ? (pl.minutes / maxPoolMinutes) * 100 : 0}%` }} />
                    </span>
                    <span className="cost-pool-value">
                      {fmtMinutes(pl.minutes)}{pl.dollars != null ? ` (${fmtDollars(pl.dollars)})` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <ChartBlock label={`runner-minutes per ${noun} by pool`}>
                <MultiLine series={series} kind={kind} format={fmtMinutes}
                  label={`${c.repo} runner-minutes per ${noun} by pool`} />
              </ChartBlock>
              {jobs.length > 0 && (
                <div data-testid={`cost-jobs-${c.repo}`}>
                  <span className="metric-label">by job (top {jobs.length} by minutes)</span>
                  <table className="metric-table">
                    <thead>
                      <tr>
                        <th>job</th><th>event</th>
                        <th title={defTitle(DEFS.costPoolShare)}>pool</th>
                        <th title={defTitle(DEFS.costInstanceType)}>instance</th>
                        <th title={defTitle(DEFS.costJobMinutes)}>minutes</th>
                        <th title={defTitle(DEFS.costJobMinutes)}>$</th>
                        <th title={defTitle(DEFS.costJobSamples)}>n</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map((j) => (
                        <tr key={`${j.name}/${j.event}`}>
                          <td className="metric-job-name">{j.name}</td>
                          <td>{j.event}</td>
                          <td>{j.pool}</td>
                          <td>{instanceTypeOf(c, j.pool)}</td>
                          <td>{fmtMinutes(j.minutes)}</td>
                          <td>{j.dollars != null ? fmtDollars(j.dollars) : '–'}</td>
                          <td>{j.samples}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div data-testid={`cost-runs-${c.repo}`}>
                <span className="metric-label">
                  by run{runs.length > 0 ? ` (top ${runs.length} by minutes)` : ''}
                </span>
                {runs.length > 0 ? (
                  <table className="metric-table">
                    <thead>
                      <tr>
                        <th title={defTitle(DEFS.costRunMinutes)}>run #</th>
                        <th>event</th>
                        <th title={defTitle(DEFS.costRunPr)}>PR</th>
                        <th>sha</th>
                        <th title={defTitle(DEFS.costRunJobs)}>jobs</th>
                        <th title={defTitle(DEFS.costRunMinutes)}>minutes</th>
                        <th title={defTitle(DEFS.costRunMinutes)}>$</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={`${r.event}/${r.headShaShort}/${r.runNumber}`}>
                          <td>#{r.runNumber}</td>
                          <td>{r.event}</td>
                          <td>{r.prNumber != null
                            ? <a href={`#pr-${r.prNumber}`}>#{r.prNumber}</a> : '–'}</td>
                          <td className="metric-job-name">{r.headShaShort}</td>
                          <td>{r.jobCount}</td>
                          <td>{fmtMinutes(r.minutes)}</td>
                          <td>{r.dollars != null ? fmtDollars(r.dollars) : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="metric-note">
                    collecting — run numbers record from new ingestion onward; this
                    table fills as fresh workflow runs land
                  </p>
                )}
              </div>
              <p className="metric-note">
                {c.totalDollars != null
                  ? 'dollars = minutes × pool rate (file-only config: poolMeta $/min supersedes costPerMinute per pool, ‘default’ backs the rest, ÷ podsPerNode corrects bin-packing) — unpriced pools stay out of the $ totals. '
                  : 'minutes only — set costPerMinute or poolMeta in config.json (pool → $/min, ‘default’ fallback) to see $. '}
                retry burden = minutes on run_attempt &gt; 1 (re-runs after flakes,
                spot reclaims, manual retries)
              </p>
            </div>
          );
        })}
      </Panel>

      <Panel title="Queue throughput" section="throughput" empty={queueRepos.length === 0}>
        {queueRepos.map((q) => (
          <div key={q.repo} className="metric-repo">
            <h3>{q.repo}</h3>
            <div className="metric-row">
              <MetricStat label="merges" def={DEFS.queueMerges}
                value={String(q.merges.value ?? 0)}
                delta={deltaText(q.merges)} />
              <MetricStat label="time in queue (p50)" def={DEFS.queueWaitP50}
                value={q.queueWaitP50.value != null ? formatDur(q.queueWaitP50.value) : '–'}
                delta={deltaText(q.queueWaitP50)} />
              <MetricStat label="group run (p50)" def={DEFS.groupRunP50}
                value={q.groupRunP50.value != null ? formatDur(q.groupRunP50.value) : '–'}
                delta={deltaText(q.groupRunP50)} />
            </div>
            <ChartBlock label={`merges per ${noun}`}>
              <AreaSeries points={alignCounts(axis, q.mergesPerBucket)} kind={kind}
                format={fmtCount} populated={q.mergesPerBucket.length}
                markers={changeMarkersByRepo.get(q.repo)}
                label={`${q.repo} merges per ${noun}`} />
            </ChartBlock>
            <ChartBlock label={`time in queue (p50) per ${noun}`}>
              <AreaSeries points={align(axis, q.queueWaitBuckets, (b) => b.p50)} kind={kind}
                format={formatDur} markers={changeMarkersByRepo.get(q.repo)}
                label={`${q.repo} time in queue p50 per ${noun}`} />
            </ChartBlock>
            <ChartBlock label={`merge-group run (p50) per ${noun}`}>
              <AreaSeries points={align(axis, q.groupRunBuckets, (b) => b.p50)} kind={kind}
                format={formatDur} markers={changeMarkersByRepo.get(q.repo)}
                label={`${q.repo} merge-group run p50 per ${noun}`} />
            </ChartBlock>
          </div>
        ))}
      </Panel>

      <Panel id="metrics-queue-efficiency" title="Queue efficiency" section="throughput" empty={(payload.queueEfficiency ?? []).length === 0}
        emptyText="no merge_group runs or merges in window yet">
        {(payload.queueEfficiency ?? []).map((q) => {
          const rc = q.runConclusion;
          return (
            <div key={q.repo} className="metric-repo" data-testid={`queue-eff-${q.repo}`}>
              <h3>{q.repo}</h3>
              <div className="metric-row">
                <MetricStat label="runs / merge" def={DEFS.queueEffRunsPerMerge}
                  value={q.runsPerMerge != null ? q.runsPerMerge.toFixed(1) : '–'}
                  delta={`${q.mergeGroupRuns} run${q.mergeGroupRuns === 1 ? '' : 's'} ÷ ${q.queueMerges} merge${q.queueMerges === 1 ? '' : 's'}`} />
                <MetricStat label="advisory-only failures" def={DEFS.queueEffAdvisoryNoise}
                  value={`${rc.advisoryNoise}`}
                  delta={`of ${rc.runFailed} failed run${rc.runFailed === 1 ? '' : 's'}`} />
                <MetricStat label="required-gate failures" def={DEFS.queueEffRequiredFailed}
                  value={rc.requiredConfigured ? `${rc.requiredFailed}` : '–'}
                  delta={rc.requiredConfigured ? `of ${rc.total} run${rc.total === 1 ? '' : 's'}`
                    : 'set requiredCheckPrefixes'} />
                <MetricStat label="admin-bypass rate" def={DEFS.queueEffAdminBypass}
                  value={q.adminBypass.rate != null ? fmtPct(q.adminBypass.rate * 100) : '–'}
                  delta={q.adminBypass.merges > 0
                    ? `${q.adminBypass.bypasses} of ${q.adminBypass.merges} known`
                    : 'awaiting merge data'} />
              </div>
              {!rc.requiredConfigured && rc.runFailed > 0 && (
                <p className="metric-note">
                  no <code>requiredCheckPrefixes</code> configured for this repo — every failed run
                  reads as advisory, so the required-gate split can’t be computed. Set it in
                  <code>.pr-dashboard.yml</code> to separate real gate failures from advisory noise.
                </p>
              )}
            </div>
          );
        })}
      </Panel>

      <Panel id="metrics-batch-advisor" title="Batch-size advisor" section="throughput" empty={(payload.batchAdvisor ?? []).length === 0}
        emptyText="not enough observed merge_group trains to model yet">
        <p className="metric-note">
          queueing-theory replay over observed arrival rate, train duration, and eject
          probability — modelled throughput + median time-in-queue per batch size. Static model;
          the answer shifts as those inputs drift.
        </p>
        {(payload.batchAdvisor ?? []).map((a) => (
          <div key={a.repo} className="metric-repo" data-testid={`batch-advisor-${a.repo}`}>
            <h3>{a.repo}</h3>
            <div className="metric-row">
              <MetricStat label="recommended batch" def={DEFS.batchAdvisorRecommend}
                value={String(a.recommendedBatch)}
                delta={a.recommendedBatch === a.currentBatch
                  ? `current (${a.currentBatch}) is optimal`
                  : `current is ${a.currentBatch}`} />
            </div>
            <p className="metric-note">
              from {a.arrivalPerHour}/h arrivals, {formatDur(a.trainDurationSecs)} trains,
              {' '}{fmtPct(a.ejectProbPerGroup * 100)} group-eject rate
              {' '}(≈{fmtPct(a.ejectProbPerPr * 100)} per PR)
            </p>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>batch</th>
                  <th title={defTitle(DEFS.batchAdvisorThroughput)}>throughput /h</th>
                  <th title={defTitle(DEFS.batchAdvisorTimeInQueue)}>time in queue</th>
                </tr>
              </thead>
              <tbody>
                {a.curve.map((c) => {
                  const cls = [c.batch === a.recommendedBatch ? 'batch-recommended' : '',
                    c.batch === a.currentBatch ? 'batch-current' : ''].filter(Boolean).join(' ');
                  return (
                    <tr key={c.batch} className={cls || undefined}
                      data-testid={`batch-row-${a.repo}-${c.batch}`}>
                      <td>{c.batch}{c.batch === a.recommendedBatch ? ' ★' : ''}{c.batch === a.currentBatch ? ' (now)' : ''}</td>
                      <td>{c.throughputPerHour}</td>
                      <td>{c.timeInQueueSecs != null ? formatDur(c.timeInQueueSecs) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </Panel>

      <Panel title="Slowest / most-variable jobs" section="performance" empty={jobRepos.length === 0}>
        {jobRepos.map((r) => (
          <div key={r.repo} className="metric-repo">
            <h3>{r.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>job</th><th>event</th>
                  <th title={defTitle(DEFS.jobP50)}>p50</th>
                  <th title={defTitle(DEFS.jobP90)}>p90</th>
                  <th title={defTitle(DEFS.variability)}>p90/p50</th>
                  <th title={defTitle(DEFS.sampleN)}>n</th>
                  <th>trend (p50 + band)</th>
                </tr>
              </thead>
              <tbody>
                {r.jobs.map((j) => (
                  <tr key={`${j.name}/${j.event}`}>
                    <td className="metric-job-name">{j.name}</td>
                    <td>{j.event}</td>
                    <td>{formatDur(j.p50)}</td>
                    <td>{formatDur(j.p90)}</td>
                    <td className={j.variability > 2 ? 'var-high' : undefined}>
                      {j.variability.toFixed(1)}×
                    </td>
                    <td>{j.n}</td>
                    <td className="metric-trend-cell">
                      <BandSeries compact points={alignBand(axis, j.trend)} kind={kind}
                        format={formatDur} label={`${j.name} p50 trend`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Panel>

      <Panel title="Flakiest jobs" section="reliability" empty={flakeRepos.length === 0}>
        {flakeRepos.map((f) => (
          <div key={f.repo} className="metric-repo">
            <h3>{f.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>job</th><th>event</th>
                  <th title={defTitle(DEFS.flakeRate)}>flake rate</th>
                  <th title={defTitle(DEFS.flakeRate)}>events / runs</th>
                  <th>trend (rate)</th>
                </tr>
              </thead>
              <tbody>
                {f.checks.map((c) => (
                  <tr key={`${c.name}/${c.event}`}>
                    <td className="metric-job-name">{c.name}</td>
                    <td>{c.event}</td>
                    <td className={c.flakeRatePct >= 20 ? 'var-high' : undefined}>
                      {fmtPct(c.flakeRatePct)}
                    </td>
                    <td>{c.flakeEvents} / {c.totalRuns}</td>
                    <td className="metric-trend-cell">
                      <BandSeries compact format={fmtPct}
                        points={alignBand(axis, c.trend.map((t) => ({
                          bucket: t.bucket,
                          p50: t.runs ? (t.flakeEvents / t.runs) * 100 : 0,
                        })))} kind={kind}
                        label={`${c.name} flake rate trend`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="metric-note">
              flake = failed then passed on the same commit (re-run, no new push) —
              min 5 runs per job
            </p>
          </div>
        ))}
      </Panel>

      <Panel id="metrics-demotion-candidates" title="Demotion candidates" section="reliability"
        empty={demotionRepos.length === 0}
        emptyText="no almost-always-green checks with enough history">
        {demotionRepos.map((d) => (
          <div key={d.repo} className="metric-repo">
            <h3>{d.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>check</th><th>runs on</th>
                  <th title="success rate over distinct (sha, attempt) runs in the window">green</th>
                  <th title="runner-minutes spent in the window — the cost basis for ranking">cost</th>
                  <th>suggested</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {d.candidates.map((c) => {
                  const key = `${d.repo}::${c.name}/${c.event}`;
                  const st = demotePr[key];
                  return (
                  <tr key={`${c.name}/${c.event}`} data-testid={`demotion-${c.name}/${c.event}`}>
                    <td className="metric-job-name">{c.name}</td>
                    <td>{c.currentTier}</td>
                    <td title={c.reason}>{fmtPct(c.successRatePct)} ({c.runsInWindow})</td>
                    <td className="metric-num">{c.minutesInWindow.toLocaleString()} min</td>
                    <td><span className="demotion-arrow">→ {c.suggestedTier}</span></td>
                    <td>
                      {st?.url
                        ? <a className="demotion-pr-link" href={st.url} target="_blank" rel="noreferrer">draft PR ↗</a>
                        : st?.error
                          ? <span className="pr-action-msg err" title={st.error}>failed</span>
                          : <button type="button" className="demotion-draft-btn"
                              data-testid={`demotion-draft-${c.name}/${c.event}`}
                              disabled={st?.loading}
                              onClick={() => draftDemotionPr(d.repo, c)}>
                              {st?.loading ? 'opening…' : 'Draft PR'}
                            </button>}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="metric-note">
              ≥99% green over ≥50 distinct runs, ranked by runner-minutes spent. Only
              moves that keep the merge-queue gate are suggested — a merge-queue check
              is never demoted off the gate. Advisory — a green check may still guard
              rare regressions; review before demoting.
            </p>
          </div>
        ))}
      </Panel>

      <Panel id="metrics-promotion-candidates" title="Promotion candidates" section="reliability"
        empty={promotionRepos.length === 0}
        emptyText="no checks with a real (non-flaky) failure rate to shift left">
        {promotionRepos.map((p) => (
          <div key={p.repo} className="metric-repo">
            <h3>{p.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>check</th><th>runs on</th>
                  <th title="real (non-flaky) failures — failing runs minus same-sha-resolved flakes">real fails</th>
                  <th>suggested</th>
                </tr>
              </thead>
              <tbody>
                {p.candidates.map((c) => (
                  <tr key={`${c.name}/${c.event}`} data-testid={`promotion-${c.name}/${c.event}`}>
                    <td className="metric-job-name">{c.name}</td>
                    <td>{c.currentTier}</td>
                    <td title={c.reason} className="var-high">{c.realFailures} ({fmtPct(c.failRatePct)})</td>
                    <td><span className="promotion-arrow">↑ {c.suggestedTier}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="metric-note">
              Checks failing for real (flakes excluded) at a late tier with no earlier coverage
              of the same name — shifting left catches them sooner. A merge_group failure already
              run on PRs is omitted (merge-emergent). Note: coverage under a different name (e.g.
              an affected-slice job) isn't recognized — confirm before acting. Advisory.
            </p>
          </div>
        ))}
      </Panel>

      <Panel title="Spot reclaims" section="reliability" empty={reclaimRepos.length === 0}
        emptyText="no reclaim events in window">
        {reclaimRepos.map((r) => (
          <div key={r.repo} className="metric-repo">
            <h3>{r.repo}</h3>
            <div className="metric-row">
              <MetricStat label="reclaim events" def={DEFS.reclaimEvents}
                value={String(r.total)} />
              {r.spot && (
                <>
                  <MetricStat label="spot reclaim rate" def={DEFS.spotReclaimRate}
                    value={r.spot.ratePct != null ? `${r.spot.ratePct}%` : '–'} />
                  <MetricStat label="spot reclaims / hr" def={DEFS.spotReclaimPerHour}
                    value={String(r.spot.perHour)} />
                  <MetricStat label="spot jobs" def={DEFS.spotJobsRan}
                    value={String(r.spot.jobs)} />
                </>
              )}
            </div>
            <ChartBlock label={`reclaims per ${noun}`}>
              <AreaSeries points={alignCounts(axis, r.perBucket)} kind={kind}
                format={fmtCount} populated={r.perBucket.length}
                label={`${r.repo} spot-reclaim events per ${noun}`} />
            </ChartBlock>
            {r.spot && r.spot.perBucket.length > 0 && (
              <ChartBlock label={`spot reclaim rate (%) per ${noun}`}>
                <AreaSeries
                  points={alignCounts(axis, r.spot.perBucket.map((b) => ({
                    bucket: b.bucket,
                    count: b.jobs > 0 ? Math.round((b.reclaims / b.jobs) * 1000) / 10 : 0,
                  })))}
                  kind={kind} format={(v) => `${v}%`} populated={r.spot.perBucket.length}
                  label={`${r.repo} spot reclaim rate per ${noun}`} />
              </ChartBlock>
            )}
            <table className="metric-table">
              <thead><tr><th>pool</th><th>events</th></tr></thead>
              <tbody>
                {r.byPool.map((bp) => (
                  <tr key={bp.pool}>
                    <td className="metric-job-name">{bp.pool}</td>
                    <td>{bp.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="metric-note">
              reclaim = a CANCELLED check whose commit passed the same check at
              a later attempt — an infra kill (spot reclaim), not a verdict.
              The Gantt marks live ones &lsquo;↻ re-run in progress — do
              nothing&rsquo;
            </p>
          </div>
        ))}
      </Panel>

      <Panel title="Train killers" section="reliability" empty={killerRepos.length === 0}>
        {killerRepos.map((t) => (
          <div key={t.repo} className="metric-repo">
            <h3>{t.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>job</th>
                  <th title={defTitle(DEFS.trainEjects)}>trains ejected</th>
                  <th title={defTitle(DEFS.ejectCost)}>est. cost (train-hours)</th>
                  <th title={defTitle(DEFS.flakeRate)}>flake rate</th>
                </tr>
              </thead>
              <tbody>
                {t.checks.map((c) => {
                  const flaky = c.flakeRatePct != null && c.flakeRatePct >= 20;
                  return (
                    <tr key={c.name} className={flaky ? 'tk-flaky' : undefined}>
                      <td className="metric-job-name">{c.name}</td>
                      <td>{c.ejects}</td>
                      <td>{c.estCostTrainHours != null ? c.estCostTrainHours.toFixed(1) : '–'}</td>
                      <td>{c.flakeRatePct != null
                        ? `${fmtPct(c.flakeRatePct)}${flaky ? ' ⚐ flaky' : ''}` : '–'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="metric-note">
              cost ≈ ejects × median group run
              {t.medianGroupRunSecs != null ? ` (${formatDur(t.medianGroupRunSecs)})` : ''} ×
              batch size ({t.batchSize}) — an approximation of wasted train-hours;
              amber rows are train killers that are ALSO flaky (fix-list top)
            </p>
          </div>
        ))}
      </Panel>

      <Panel title="Critical path" section="performance" empty={cpByRepo.size === 0}>
        {[...cpByRepo.entries()].map(([repo, entries]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            {entries.map((cp) => (
              <div key={cp.event} className="metric-cp">
                <div className="metric-row">
                  <MetricStat label={`${cp.event} end-to-end (p50)`}
                    def={DEFS.cpEndToEnd} value={formatDur(cp.endToEndP50Secs)} />
                </div>
                <ol className="cp-chain" aria-label={`${repo} ${cp.event} critical path`}>
                  {cp.path.map((step) => (
                    <li key={step.name} className="cp-step" title={defTitle(DEFS.cpStep)}>
                      <span className="cp-name">{step.name}</span>
                      <span className="cp-times">
                        {step.waitP50 > 0
                          ? `wait ${formatDur(step.waitP50)} + ${formatDur(step.durationP50)}`
                          : formatDur(step.durationP50)}
                      </span>
                    </li>
                  ))}
                </ol>
                {cp.offPath.length > 0 && (
                  <ul className="cp-offpath">
                    {cp.offPath.map((o) => (
                      <li key={o.name} title={defTitle(DEFS.cpSlack)}>
                        <span className="metric-job-name">{o.name}</span>
                        {' '}could grow {formatDur(o.slackSecs)} before mattering
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <p className="metric-note">
              expected path from last-20 run medians (wait + duration per job) —
              ignores the window selector; off-path slack = how much a job could
              grow before it starts gating the end-to-end time
            </p>
          </div>
        ))}
      </Panel>

      <Panel title="CI needs graph" section="performance" empty={(payload.needsGraph ?? []).length === 0}
        emptyText="no derived needs-graph with observed durations yet">
        <p className="needs-graph-legend">
          nodes are jobs (run p50 + runner wait); edges are <code>needs:</code> dependencies;
          the <span className="cp-swatch">critical path</span> is highlighted. Hover or focus a
          node to isolate its dependencies.
        </p>
        {[...needsByRepo].map(([repo, events]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            {events.map((g) => (
              <div key={g.event} className="metric-cp" data-testid={`needs-graph-${repo}-${g.event}`}>
                <div className="metric-row">
                  <MetricStat label={`${g.event} jobs`} def={DEFS.needsGraphNodes}
                    value={String(g.nodes.length)}
                    delta={`end-to-end p50 ${formatDur(g.endToEndP50Secs)}`} />
                </div>
                <NeedsGraph nodes={g.nodes} formatDur={formatDur} />
              </div>
            ))}
          </div>
        ))}
      </Panel>

      <Panel id="metrics-workflow-lint" title="Workflow lint" section="reliability" empty={lintRepos.length === 0} emptyText="no findings">
        {lintRepos.map((l) => (
          <div key={l.repo} className="metric-repo">
            <h3>{l.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>severity</th><th>job</th><th>finding</th>
                  <th title={defTitle(DEFS.lintP99)}>p99</th>
                  <th title={defTitle(DEFS.lintTimeout)}>timeout</th>
                </tr>
              </thead>
              <tbody>
                {l.findings.map((f) => (
                  <tr key={`${f.rule}/${f.job}`}>
                    <td><span className={`lint-badge lint-${f.severity}`}>{f.severity}</span>{' '}
                      <span className="lint-rule" title="lint rule id">{f.rule}</span></td>
                    <td className="metric-job-name">{f.job}</td>
                    <td>{f.message}</td>
                    <td>{formatDur(f.observed)}</td>
                    <td>{f.configured != null ? formatDur(f.configured)
                      : f.rule === 'timeout' ? '– (default 6h)' : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="metric-note">
              timeout calibration: warn = timeout under observed p99 × 1.2 (will
              timeout-cancel a slow-but-normal run); info = explicit timeout over
              p99 × 10 (hung runs burn the runner before failing)
            </p>
          </div>
        ))}
      </Panel>

      <Panel id="metrics-runner-routing" title="Runner routing" section="reliability" empty={false}>
        <RunnerRouting />
      </Panel>

      <Panel title="Merge velocity + deploy lag" section="throughput" empty={velocityRepos.length === 0}>
        {velocityRepos.map((v) => (
          <div key={v.repo} className="metric-repo">
            <h3>{v.repo}</h3>
            <div className="metric-row">
              <MetricStat label="merged" def={DEFS.velocityMerged}
                value={String(v.merged.value ?? 0)}
                delta={deltaText(v.merged)} />
              <MetricStat label="merge → QA (p50)" def={DEFS.mergeToQa}
                value={v.mergeToQaP50.value != null ? formatDur(v.mergeToQaP50.value) : '–'}
                delta={deltaText(v.mergeToQaP50)} />
              <MetricStat label="avg PR lifespan" def={DEFS.lifespan}
                value={v.lifespanMeanHours.value != null ? fmtHours(v.lifespanMeanHours.value) : '–'}
                delta={deltaText(v.lifespanMeanHours)} />
            </div>
            <ChartBlock label={`merged per ${noun}`}>
              <AreaSeries points={alignCounts(axis, v.mergedPerBucket)} kind={kind}
                format={fmtCount} populated={v.mergedPerBucket.length}
                label={`${v.repo} merged per ${noun}`} />
            </ChartBlock>
            <ChartBlock label={`merge → QA (p50) per ${noun}`}>
              <AreaSeries points={align(axis, v.mergeToQaBuckets, (b) => b.p50)} kind={kind}
                format={formatDur} label={`${v.repo} merge to QA p50 per ${noun}`} />
            </ChartBlock>
            <ChartBlock label={`avg PR lifespan per ${noun}`}>
              <AreaSeries points={align(axis, v.avgLifespanBuckets, (b) => b.meanHours)} kind={kind}
                format={fmtHours} label={`${v.repo} average PR lifespan per ${noun}`} />
            </ChartBlock>
          </div>
        ))}
      </Panel>

      <Panel title="ETA calibration" section="performance" empty={calByRepo.size === 0}>
        {[...calByRepo.entries()].map(([repo, stages]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            {stages.map((c) => (
              <div key={c.stage} className="metric-calibration-stage">
                <div className="metric-row">
                  <MetricStat label={`${c.stage} stage`} def={DEFS.calibrationError}
                    value={calibrationHeadline(c.medianErrorPct, c.n)}
                    delta={`p90 |error| ${Math.round(c.p90AbsErrorPct)}% — ${DEFS.calibrationP90Abs.text}`} />
                </div>
                <ChartBlock label={`${c.stage} median ETA error per ${noun} (+ = ran over)`}>
                  <SignedLine points={align(axis, c.buckets, (b) => b.medianErrorPct)}
                    kind={kind} format={fmtPct}
                    label={`${repo} ${c.stage} median ETA error per ${noun}`} />
                </ChartBlock>
                <ChartBlock label={`${c.stage} predicted vs actual`}>
                  <ScatterPlot points={c.points} format={formatDur}
                    label={`${repo} ${c.stage} predicted vs actual ETA`} />
                </ChartBlock>
              </div>
            ))}
          </div>
        ))}
      </Panel>

      </ActiveSectionContext.Provider>
    </div>
  );
}
