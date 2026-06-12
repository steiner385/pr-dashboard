import { useEffect, useState, type ReactNode } from 'react';
import type { HeadlineStat, LeadTimeSegmentId, MetricsBucket, MetricsPayload, MetricsWindow } from './types';
import {
  AreaSeries, BandSeries, MultiLine, ScatterPlot, SignedLine,
  type BandPoint, type ChartPoint, type LineSeries,
} from './charts';
import { formatDur, formatSince } from './format';

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

/**
 * Calibration headline: signed median error → plain English. POSITIVE error
 * means stages took longer than first promised (ETAs run optimistic).
 */
function calibrationHeadline(medianErrorPct: number, n: number): string {
  const pct = Math.round(Math.abs(medianErrorPct));
  if (pct === 0) return `p50 ETAs on target (n=${n})`;
  return `p50 ETAs run ${pct}% ${medianErrorPct > 0 ? 'optimistic' : 'pessimistic'} (n=${n})`;
}

function Panel({ title, empty, emptyText = 'no data yet', children }: {
  title: string; empty: boolean; emptyText?: string; children: ReactNode;
}) {
  return (
    <section className="metric-panel">
      <h2>{title}</h2>
      {empty ? <p className="metric-empty">{emptyText}</p> : children}
    </section>
  );
}

function MetricStat({ label, value, delta }: {
  label: string; value: string; delta?: string | null;
}) {
  return (
    <div className="metric-stat">
      <b>{value}</b>
      <span>{label}</span>
      {delta != null && <em className="metric-delta">{delta}</em>}
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

/** Lead-time segment display metadata (issue #44), pipeline order — mirrors
 *  the server's LEAD_TIME_SEGMENTS ids. */
const LEAD_TIME_SEGMENTS: { id: LeadTimeSegmentId; label: string; color: string }[] = [
  { id: 'toFirstGreen', label: 'to first green', color: 'var(--accent)' },
  { id: 'greenToEnqueued', label: 'green → enqueued', color: 'var(--amber)' },
  { id: 'queue', label: 'queue', color: 'var(--purple)' },
  { id: 'qaDeploy', label: 'QA deploy', color: 'var(--done)' },
  { id: 'awaitingProd', label: 'awaiting prod', color: 'var(--fail)' },
];

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
        <MetricStat label="deploy frequency (prod)"
          value={`${(Math.round(lt.deploysPerDay * 10) / 10).toString()}/day`}
          delta={`${lt.prodDeploys} prod deploy${lt.prodDeploys === 1 ? '' : 's'} in window`} />
        <MetricStat label="lead time created → prod (p50)"
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
            <span key={s.id} className="legend-item">
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

export function MetricsView({ now }: {
  /** Injectable clock (tests) — the window axis is derived from it. */
  now?: () => Date;
} = {}) {
  const [window, setWindow] = useState<MetricsWindow>('3d');
  const [bucketPref, setBucketPref] = useState<MetricsBucket>('hour');
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

  const controls = (
    <div className="metrics-controls">
      <div className="metrics-group" role="group" aria-label="Window">
        {WINDOWS.map((w) => (
          <button key={w} type="button" className="metrics-window-btn"
            aria-pressed={window === w} onClick={() => setWindow(w)}>
            {w}
          </button>
        ))}
      </div>
      <span className="metrics-sep" aria-hidden="true" />
      <div className="metrics-group" role="group" aria-label="Bucket size">
        <button type="button" className="metrics-window-btn" disabled={hourDisabled}
          title={hourDisabled ? 'hourly buckets are available for windows up to 7d' : undefined}
          aria-pressed={bucket === 'hour'} onClick={() => setBucketPref('hour')}>
          hourly
        </button>
        <button type="button" className="metrics-window-btn"
          aria-pressed={bucket === 'day'} onClick={() => setBucketPref('day')}>
          daily
        </button>
      </div>
      <button type="button" className="metrics-refresh" aria-label="Refresh metrics"
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
  const killerRepos = payload.trainKillers.filter((t) => t.checks.length);
  const cpByRepo = new Map<string, typeof payload.criticalPath>();
  for (const cp of payload.criticalPath) {
    if (!cp.path.length) continue;
    cpByRepo.set(cp.repo, [...(cpByRepo.get(cp.repo) ?? []), cp]);
  }
  const lintRepos = payload.lint.filter((l) => l.findings.length);
  // ?? []: tolerate a pre-upgrade server payload while the SPA is newer
  const leadTimeRepos = payload.leadTime ?? [];
  const regressionRepos = (payload.regressions ?? []).filter((r) => r.checks.length);

  return (
    <div className="metrics">
      {controls}

      <Panel title="Duration regressions" empty={regressionRepos.length === 0}
        emptyText="none active">
        {regressionRepos.map((r) => (
          <div key={r.repo} className="metric-repo">
            <h3>{r.repo}</h3>
            <ul className="regression-strip">
              {r.checks.map((c) => (
                <li key={`${c.check}/${c.event}`} className="regression-chip">
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

      <Panel title="Lead time" empty={leadTimeRepos.length === 0}>
        {leadTimeRepos.map((lt) => <LeadTimeRepo key={lt.repo} lt={lt} />)}
      </Panel>

      <Panel title="Trends" empty={trendRepos.length === 0}>
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
                  <MetricStat key={s.key} label={s.key} value={String(latest[s.key])} />
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

      <Panel title="Runner-wait health" empty={runnerByRepo.size === 0}>
        {[...runnerByRepo.entries()].map(([repo, tiers]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            <div className="metric-row">
              {tiers.map((tier) => (
                <MetricStat key={tier.event} label={`${tier.event} p50 wait`}
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

      <Panel title="Queue throughput" empty={queueRepos.length === 0}>
        {queueRepos.map((q) => (
          <div key={q.repo} className="metric-repo">
            <h3>{q.repo}</h3>
            <div className="metric-row">
              <MetricStat label="merges" value={String(q.merges.value ?? 0)}
                delta={deltaText(q.merges)} />
              <MetricStat label="time in queue (p50)"
                value={q.queueWaitP50.value != null ? formatDur(q.queueWaitP50.value) : '–'}
                delta={deltaText(q.queueWaitP50)} />
              <MetricStat label="group run (p50)"
                value={q.groupRunP50.value != null ? formatDur(q.groupRunP50.value) : '–'}
                delta={deltaText(q.groupRunP50)} />
            </div>
            <ChartBlock label={`merges per ${noun}`}>
              <AreaSeries points={alignCounts(axis, q.mergesPerBucket)} kind={kind}
                format={fmtCount} populated={q.mergesPerBucket.length}
                label={`${q.repo} merges per ${noun}`} />
            </ChartBlock>
            <ChartBlock label={`time in queue (p50) per ${noun}`}>
              <AreaSeries points={align(axis, q.queueWaitBuckets, (b) => b.p50)} kind={kind}
                format={formatDur} label={`${q.repo} time in queue p50 per ${noun}`} />
            </ChartBlock>
            <ChartBlock label={`merge-group run (p50) per ${noun}`}>
              <AreaSeries points={align(axis, q.groupRunBuckets, (b) => b.p50)} kind={kind}
                format={formatDur} label={`${q.repo} merge-group run p50 per ${noun}`} />
            </ChartBlock>
          </div>
        ))}
      </Panel>

      <Panel title="Slowest / most-variable jobs" empty={jobRepos.length === 0}>
        {jobRepos.map((r) => (
          <div key={r.repo} className="metric-repo">
            <h3>{r.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>job</th><th>event</th><th>p50</th><th>p90</th>
                  <th>p90/p50</th><th>n</th><th>trend (p50 + band)</th>
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

      <Panel title="Flakiest jobs" empty={flakeRepos.length === 0}>
        {flakeRepos.map((f) => (
          <div key={f.repo} className="metric-repo">
            <h3>{f.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>job</th><th>event</th><th>flake rate</th><th>events / runs</th>
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

      <Panel title="Train killers" empty={killerRepos.length === 0}>
        {killerRepos.map((t) => (
          <div key={t.repo} className="metric-repo">
            <h3>{t.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>job</th><th>trains ejected</th><th>est. cost (train-hours)</th>
                  <th>flake rate</th>
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

      <Panel title="Critical path" empty={cpByRepo.size === 0}>
        {[...cpByRepo.entries()].map(([repo, entries]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            {entries.map((cp) => (
              <div key={cp.event} className="metric-cp">
                <div className="metric-row">
                  <MetricStat label={`${cp.event} end-to-end (p50)`}
                    value={formatDur(cp.endToEndP50Secs)} />
                </div>
                <ol className="cp-chain" aria-label={`${repo} ${cp.event} critical path`}>
                  {cp.path.map((step) => (
                    <li key={step.name} className="cp-step">
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
                      <li key={o.name}>
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

      <Panel title="Workflow lint" empty={lintRepos.length === 0} emptyText="no findings">
        {lintRepos.map((l) => (
          <div key={l.repo} className="metric-repo">
            <h3>{l.repo}</h3>
            <table className="metric-table">
              <thead>
                <tr>
                  <th>severity</th><th>job</th><th>finding</th><th>p99</th><th>timeout</th>
                </tr>
              </thead>
              <tbody>
                {l.findings.map((f) => (
                  <tr key={`${f.rule}/${f.job}`}>
                    <td><span className={`lint-badge lint-${f.severity}`}>{f.severity}</span></td>
                    <td className="metric-job-name">{f.job}</td>
                    <td>{f.message}</td>
                    <td>{formatDur(f.observed)}</td>
                    <td>{f.configured != null ? formatDur(f.configured) : '– (default 6h)'}</td>
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

      <Panel title="Merge velocity + deploy lag" empty={velocityRepos.length === 0}>
        {velocityRepos.map((v) => (
          <div key={v.repo} className="metric-repo">
            <h3>{v.repo}</h3>
            <div className="metric-row">
              <MetricStat label="merged" value={String(v.merged.value ?? 0)}
                delta={deltaText(v.merged)} />
              <MetricStat label="merge → QA (p50)"
                value={v.mergeToQaP50.value != null ? formatDur(v.mergeToQaP50.value) : '–'}
                delta={deltaText(v.mergeToQaP50)} />
              <MetricStat label="avg PR lifespan"
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

      <Panel title="ETA calibration" empty={calByRepo.size === 0}>
        {[...calByRepo.entries()].map(([repo, stages]) => (
          <div key={repo} className="metric-repo">
            <h3>{repo}</h3>
            {stages.map((c) => (
              <div key={c.stage} className="metric-calibration-stage">
                <div className="metric-row">
                  <MetricStat label={`${c.stage} stage`}
                    value={calibrationHeadline(c.medianErrorPct, c.n)}
                    delta={`p90 |error| ${Math.round(c.p90AbsErrorPct)}%`} />
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
    </div>
  );
}
