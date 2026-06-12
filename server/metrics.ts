import { FLAKE_MIN_RUNS, type HistoryStore } from './history';
import type { DurationRegressionView, PoolHealthView } from './poller';
import { percentile } from './math';
import { activeForEvent, type CiGraphNode } from './required-checks';
import { matchingPrefix } from './estimator/classify';
import { computeCriticalPath, type CriticalPathNodeInput } from './estimator/critical-path';
import { lintTimeouts, type LintFinding, type TimeoutLintInput } from './estimator/workflow-lint';

/**
 * Metrics tab payload (metrics-readability revision). This interface is the
 * BINDING CONTRACT with the frontend mirror in `frontend/src/types.ts` —
 * change both together.
 *
 * Granularity: every bucketed series is keyed by `bucket` — an ISO UTC hour
 * (`YYYY-MM-DDTHH`) when `bucket === 'hour'`, an ISO UTC day (`YYYY-MM-DD`)
 * when `bucket === 'day'`. Hour buckets are only offered for windows ≤ 7d
 * (≤ 168 points); longer windows are clamped to day buckets.
 *
 * All `p50`/`p90` values are seconds; `meanHours` is hours. Headline stats
 * carry `{ value, prev }` where `prev` is the same aggregate over the
 * previous equal-length window (null when not computable).
 */

export const METRICS_WINDOWS = ['24h', '3d', '7d', '14d', '30d'] as const;
export type MetricsWindow = (typeof METRICS_WINDOWS)[number];
export type MetricsBucket = 'hour' | 'day';

/** Window key → length in days. */
export const WINDOW_DAYS: Record<MetricsWindow, number> = {
  '24h': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30,
};

/** Hour buckets are only allowed for windows ≤ this many days. */
const HOUR_BUCKET_MAX_DAYS = 7;

/** Current-window aggregate + the previous equal window's value for deltas.
 *  null = not computable (no samples in that window). */
export interface HeadlineStat { value: number | null; prev: number | null }

export interface MetricsPayload {
  window: MetricsWindow;
  bucket: MetricsBucket;
  runnerWaits: { repo: string; event: string; p50: HeadlineStat;
    buckets: { bucket: string; p50: number; p90: number; n: number }[] }[];
  queue: { repo: string;
    merges: HeadlineStat; queueWaitP50: HeadlineStat; groupRunP50: HeadlineStat;
    mergesPerBucket: { bucket: string; count: number }[];
    queueWaitBuckets: { bucket: string; p50: number; n: number }[];
    groupRunBuckets: { bucket: string; p50: number; n: number }[] }[];
  slowestJobs: { repo: string; jobs: { name: string; event: string; p50: number; p90: number;
    variability: number; n: number;
    trend: { bucket: string; p50: number; p90: number; n: number }[] }[] }[]; // top 10 by p50, variability = p90/p50
  velocity: { repo: string;
    merged: HeadlineStat; mergeToQaP50: HeadlineStat; lifespanMeanHours: HeadlineStat;
    mergedPerBucket: { bucket: string; count: number }[];
    mergeToQaBuckets: { bucket: string; p50: number; n: number }[];
    avgLifespanBuckets: { bucket: string; meanHours: number; n: number }[] }[];
  trends: { repo: string;
    points: { bucket: string; open: number; ci: number; queue: number; failed: number }[] }[]; // last state sample per bucket (closing value)
  /** ETA calibration (issue #35): signed error % per (repo, stage), where
   *  errorPct = (actual − predicted) / predicted × 100 — POSITIVE means ETAs
   *  run optimistic (the stage took longer than first predicted). `points`
   *  carries the (predicted, actual) scatter, capped at the 200 most recent. */
  calibration: { repo: string; stage: string; n: number;
    medianErrorPct: number; p90AbsErrorPct: number;
    buckets: { bucket: string; medianErrorPct: number; n: number }[];
    points: { predicted: number; actual: number }[] }[];
  /** Flake radar (issue #37): per repo, the top checks by flake rate — a flake
   *  is a failing-class sample resolved by SUCCESS on the SAME head sha (re-run,
   *  no new push). Only checks with ≥ FLAKE_MIN_RUNS (5) distinct (sha, attempt)
   *  samples qualify; capped at 10 per repo. Trend buckets carry flake events
   *  and total runs per bucket. */
  flakiness: { repo: string; checks: { name: string; event: string;
    flakeEvents: number; totalRuns: number; flakeRatePct: number;
    trend: { bucket: string; flakeEvents: number; runs: number }[] }[] }[];
  /** Train-killer leaderboard (issue #38): per repo, checks ranked by how many
   *  merge-group builds they ejected in the window. `estCostTrainHours` is an
   *  APPROXIMATION: ejects × median group-run duration × current batchSize, in
   *  hours — each eject roughly wastes one group build's wall-clock for each of
   *  the up-to-batchSize PRs riding the train (null without an observed median).
   *  `flakeRatePct` cross-references the flake radar for the same check name
   *  (max rate across events, ≥ FLAKE_MIN_RUNS); null when unknown. */
  trainKillers: { repo: string; batchSize: number; medianGroupRunSecs: number | null;
    checks: { name: string; ejects: number; estCostTrainHours: number | null;
      flakeRatePct: number | null }[] }[];
  /** Critical path (issue #42): per repo×event (pull_request / merge_group),
   *  the STATIC expected longest chain through the derived needs DAG where
   *  node weight = median pickup wait + median duration. `offPath` lists the
   *  10 lowest-slack off-path jobs (slack = seconds the job could grow before
   *  joining the path). DELIBERATELY window-independent: built from last-N
   *  per-check medians (last 20) + 14-day name discovery, NOT the selected
   *  metrics window — the UI labels this. Per-run path attribution is v2. */
  criticalPath: { repo: string; event: string; endToEndP50Secs: number;
    path: { name: string; durationP50: number; waitP50: number }[];
    offPath: { name: string; slackSecs: number }[] }[];
  /** Lead-time decomposition + DORA-lite headlines (issue #44): per repo, the
   *  median seconds spent in each delivery segment over PRs MERGED in the
   *  window. Segments are computed pairwise — a row contributes to a segment
   *  only when it has BOTH endpoint timestamps (`n` is per segment; medianSecs
   *  is null at n=0, never fabricated). Segment order is fixed
   *  (LEAD_TIME_SEGMENTS): created→first_green → enqueued → merged → qa_live →
   *  prod_live. first_green_at/enqueued_at only exist on rows merged after the
   *  poller started recording them (2026-06) — the UI labels thin segments
   *  'collecting'. `totalP50Secs` = created→prod_live p50 over rows with both
   *  (the DORA lead-time-for-changes headline). `prodDeploys` counts rows that
   *  went prod-live IN the window (even when merged before it);
   *  `deploysPerDay` = prodDeploys / window days (deployment frequency). */
  leadTime: { repo: string;
    segments: { id: LeadTimeSegmentId; medianSecs: number | null; n: number }[];
    totalP50Secs: number | null; totalN: number;
    prodDeploys: number; deploysPerDay: number }[];
  /** Duration regressions (issue #41): the CURRENTLY-ACTIVE rolling-median
   *  step-ups from the poller's hourly scan — a live alert strip, NOT a
   *  window-scoped aggregate (the window selector never applies; the UI labels
   *  this). Each entry: prior/recent p50 over the last 20-vs-10 SUCCESS
   *  samples, their ratio, and the approximate onset (first sample of the
   *  recent window). Repos with no active regressions are omitted. */
  regressions: { repo: string; checks: DurationRegressionView[] }[];
  /** Workflow lint (issue #48, rule 1 — timeout calibration): per repo,
   *  findings from joining each derived job's `timeout-minutes` with its
   *  observed p99 duration (last 50 runs, ≥ LINT_MIN_RUNS samples; max across
   *  events). `observed`/`configured` are seconds; configured null = unset
   *  (GitHub's 360m default). Window-independent, like criticalPath. Repos
   *  with zero findings are omitted (the UI's empty state reads 'no findings'). */
  lint: { repo: string; findings: LintFinding[] }[];
  /** Per-pool runner telemetry (issue #45): like runnerWaits but keyed by the
   *  job's runs-on POOL instead of the trigger event (the event-keyed section
   *  stays — they answer different questions). Pool keys come from ingestion:
   *  a runs-on ternary's candidates are stored JOINED ('a|b' is ONE composite
   *  pool — the chosen branch is unknowable from the rollup); only rows
   *  ingested after #45 carry a pool. The three health fields are the live
   *  starvation snapshot from the server's hourly scan (null until the first
   *  scan evaluates the pool) — window-independent, like regressions. */
  runnerPools: { repo: string; pool: string; p50: HeadlineStat;
    buckets: { bucket: string; p50: number; p90: number; n: number }[];
    lastHourP90Secs: number | null; baselineP90Secs: number | null;
    starving: boolean }[];
  /** Spot-reclaim ledger (issue #46): infra-kill events per repo — a CANCELLED
   *  check at attempt N whose sha later carries a SUCCESS of the same check at
   *  a higher attempt (deliberately disjoint from flakes, which are
   *  FAILING-class). `byPool` joins each event's check onto its runs-on pool
   *  via the derived graph ('unknown' when unmappable). Repos with zero
   *  events in the window are omitted. */
  reclaims: { repo: string; total: number;
    perBucket: { bucket: string; count: number }[];
    byPool: { pool: string; count: number }[] }[];
  /** Concurrency demand curve (issue #47): per repo×pool, the PEAK number of
   *  simultaneously-running jobs within each bucket — a sweep-line over the
   *  stored job intervals (started_at..completed_at; pre-#47 rows derive
   *  started = completed − duration). No fleet-cap overlay in v1: the cap is
   *  not knowable by the dashboard — follow-up is a per-pool config knob to
   *  draw the cap line. `peak` is the window-wide maximum. */
  concurrency: { repo: string; pool: string; peak: number;
    buckets: { bucket: string; peak: number }[] }[];
}

/** Lead-time segment ids, in pipeline order (issue #44). */
export const LEAD_TIME_SEGMENTS = [
  { id: 'toFirstGreen', from: 'createdAt', to: 'firstGreenAt' },
  { id: 'greenToEnqueued', from: 'firstGreenAt', to: 'enqueuedAt' },
  { id: 'queue', from: 'enqueuedAt', to: 'mergedAt' },
  { id: 'qaDeploy', from: 'mergedAt', to: 'qaLiveAt' },
  { id: 'awaitingProd', from: 'qaLiveAt', to: 'prodLiveAt' },
] as const;
export type LeadTimeSegmentId = (typeof LEAD_TIME_SEGMENTS)[number]['id'];

/**
 * Resolve `GET /api/metrics` query params to a (window, bucket) pair.
 *  - `window` accepts the METRICS_WINDOWS keys; invalid/missing falls through
 *    to legacy `windowDays` (snapped to the nearest of 7/14/30), then to '3d'.
 *  - `bucket` accepts 'hour' | 'day' (default 'hour'), clamped to 'day' for
 *    windows longer than 7 days.
 */
export function resolveMetricsQuery(query: Record<string, unknown>):
  { window: MetricsWindow; bucket: MetricsBucket } {
  const window = resolveWindow(query.window, query.windowDays);
  const requested: MetricsBucket = query.bucket === 'day' ? 'day' : 'hour';
  const bucket: MetricsBucket =
    WINDOW_DAYS[window] > HOUR_BUCKET_MAX_DAYS ? 'day' : requested;
  return { window, bucket };
}

function resolveWindow(windowRaw: unknown, windowDaysRaw: unknown): MetricsWindow {
  if (typeof windowRaw === 'string' &&
      (METRICS_WINDOWS as readonly string[]).includes(windowRaw)) {
    return windowRaw as MetricsWindow;
  }
  // Back-compat: pre-granularity clients sent windowDays=7|14|30.
  const n = typeof windowDaysRaw === 'number' ? windowDaysRaw
    : typeof windowDaysRaw === 'string' && windowDaysRaw.trim() !== '' ? Number(windowDaysRaw) : NaN;
  if (Number.isFinite(n)) {
    let best: 7 | 14 | 30 = 14;
    let bestDist = Infinity;
    for (const w of [7, 14, 30] as const) {
      const dist = Math.abs(w - n);
      if (dist < bestDist) { bestDist = dist; best = w; }
    }
    return best === 7 ? '7d' : best === 14 ? '14d' : '30d';
  }
  return '3d';
}

const p = (values: number[], q: number): number =>
  percentile([...values].sort((a, b) => a - b), q);

/** Compound-key separator — check names contain spaces and ' / ', so a NUL it is. */
const SEP = '\u0000';

/** Group rows into an insertion-ordered Map by a derived key. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    out.set(k, [...(out.get(k) ?? []), row]);
  }
  return out;
}

/** Bucketed { bucket, p50, p90, n } summaries from (at, value) pairs, ascending. */
function bucketPercentiles(rows: { at: string; value: number }[], key: (ts: string) => string):
  { bucket: string; p50: number; p90: number; n: number }[] {
  return [...groupBy(rows, (r) => key(r.at))]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, vals]) => {
      const xs = vals.map((v) => v.value);
      return { bucket, p50: p(xs, 0.5), p90: p(xs, 0.9), n: xs.length };
    });
}

/** Bucketed counts from ISO timestamps, ascending. */
function bucketCounts(timestamps: string[], key: (ts: string) => string):
  { bucket: string; count: number }[] {
  return [...groupBy(timestamps, key)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, ts]) => ({ bucket, count: ts.length }));
}

/** Split a 2×-window read into current-window and previous-window rows. */
function splitWindow<T>(rows: T[], at: (r: T) => string, since: string): { cur: T[]; prev: T[] } {
  const cur: T[] = [];
  const prev: T[] = [];
  for (const r of rows) (at(r) >= since ? cur : prev).push(r);
  return { cur, prev };
}

/** Headline p50 over current vs previous window values (null when empty). */
function p50Stat(cur: number[], prev: number[]): HeadlineStat {
  return {
    value: cur.length ? p(cur, 0.5) : null,
    prev: prev.length ? p(prev, 0.5) : null,
  };
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Top-N cap for the slowest-jobs leaderboard (per repo). */
const SLOWEST_JOBS_CAP = 10;

/** Top-N cap for the flakiest-jobs leaderboard (per repo). */
const FLAKINESS_CAP = 10;

/** Scatter-point cap for the calibration panel (most recent rows win). */
const CALIBRATION_POINTS_CAP = 200;

/** Events the critical-path section is computed for (issue #42). */
const CRITICAL_PATH_EVENTS = ['pull_request', 'merge_group'] as const;

/** Off-path jobs reported per repo×event (lowest slack first). */
const OFF_PATH_CAP = 10;

/** Minimum last-50 samples behind a p99 before the timeout lint trusts it —
 *  a thin tail reads as noise, not calibration evidence (issue #48). */
export const LINT_MIN_RUNS = 5;

/**
 * Sweep-line bucket peaks (issue #47): given job occupancy intervals, the
 * PEAK number of simultaneously-running jobs within each bucket of the
 * [sinceMs, nowMs) window. Intervals are clipped to the window; an interval
 * spanning a bucket with no start/end events inside it still raises that
 * bucket's level (the carried level is applied to every bucket the constant
 * span overlaps). Boundary rule: an interval ending exactly when another
 * starts does NOT count as concurrent (ends sort before starts).
 * Buckets with peak 0 are omitted (sparse, like every other series).
 */
export function sweepBucketPeaks(intervals: { startMs: number; endMs: number }[],
  sinceMs: number, nowMs: number, bucket: MetricsBucket): { bucket: string; peak: number }[] {
  const stepMs = bucket === 'hour' ? 3600_000 : 86400_000;
  const keyOf = (ms: number): string =>
    new Date(ms).toISOString().slice(0, bucket === 'hour' ? 13 : 10);
  const events: { t: number; delta: number }[] = [];
  for (const iv of intervals) {
    const start = Math.max(iv.startMs, sinceMs);
    const end = Math.min(iv.endMs, nowMs);
    if (!(end > start)) continue; // empty/inverted after clipping (or NaN)
    events.push({ t: start, delta: +1 }, { t: end, delta: -1 });
  }
  // ends before starts at the same instant — back-to-back ≠ concurrent
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  const peaks = new Map<string, number>();
  let cur = 0;
  let prevT = sinceMs;
  const mark = (from: number, to: number, level: number): void => {
    if (level <= 0 || !(to > from)) return;
    // every bucket the constant-level span [from, to) overlaps
    for (let b = Math.floor(from / stepMs) * stepMs; b < to; b += stepMs) {
      const k = keyOf(b);
      if ((peaks.get(k) ?? 0) < level) peaks.set(k, level);
    }
  };
  for (const e of events) {
    mark(prevT, e.t, cur);
    cur += e.delta;
    prevT = e.t;
  }
  mark(prevT, nowMs, cur); // cur is 0 here (every interval was closed), but keep the shape honest
  return [...peaks].sort(([a], [b]) => a.localeCompare(b))
    .map(([b, peak]) => ({ bucket: b, peak }));
}

/**
 * Compute the full metrics payload for one (window, bucket) pair — a single
 * pass over the local SQLite history per section, computed on request (no
 * caching). Sections with headline deltas read 2× the window and split at the
 * boundary; repos/groups with rows only in the previous window are omitted.
 */
export function computeMetrics(history: HistoryStore, window: MetricsWindow,
  bucket: MetricsBucket, now: Date = new Date(), exclude: string[] = [],
  batchSizeFor: (repo: string) => number = () => 1,
  ciGraphs: Map<string, Map<string, CiGraphNode>> = new Map(),
  foreignNames: Map<string, Set<string>> = new Map(),
  activeRegressions: { repo: string; checks: DurationRegressionView[] }[] = [],
  poolsFor: (repo: string, name: string) => string[] | null = () => null,
  poolHealth: { repo: string; pools: PoolHealthView[] }[] = []): MetricsPayload {
  const dropped = new Set(exclude);
  const keep = <T extends { repo: string }>(rows: T[]): T[] =>
    dropped.size ? rows.filter((r) => !dropped.has(r.repo)) : rows;
  const windowMs = WINDOW_DAYS[window] * 86400_000;
  const since = new Date(now.getTime() - windowMs).toISOString();
  const prevSince = new Date(now.getTime() - 2 * windowMs).toISOString();
  const key = (ts: string): string => ts.slice(0, bucket === 'hour' ? 13 : 10);

  // 1. Runner-wait health: per (repo, event) buckets with p50/p90 + headline p50.
  const rw = splitWindow(keep(history.runnerWaitsSince(prevSince)), (r) => r.at, since);
  const rwPrevByKey = groupBy(rw.prev, (r) => `${r.repo}${SEP}${r.event}`);
  const runnerWaits = [...groupBy(rw.cur, (r) => `${r.repo}${SEP}${r.event}`)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, rows]) => {
      const [repo, event] = k.split(SEP) as [string, string];
      const prevRows = rwPrevByKey.get(k) ?? [];
      return {
        repo, event,
        p50: p50Stat(rows.map((r) => r.waitSecs), prevRows.map((r) => r.waitSecs)),
        buckets: bucketPercentiles(rows.map((r) => ({ at: r.at, value: r.waitSecs })), key),
      };
    });

  // Shared merged-PR rows: queue merges + the whole velocity section.
  const merged = splitWindow(keep(history.mergedSince(prevSince)), (r) => r.mergedAt, since);
  const mergedByRepo = groupBy(merged.cur, (r) => r.repo);
  const mergedPrevByRepo = groupBy(merged.prev, (r) => r.repo);
  const qw = splitWindow(keep(history.queueWaitsSince(prevSince)), (r) => r.at, since);
  const queueWaitsByRepo = groupBy(qw.cur, (r) => r.repo);
  const queueWaitsPrevByRepo = groupBy(qw.prev, (r) => r.repo);
  const gr = splitWindow(keep(history.groupRunsSince(prevSince)), (r) => r.at, since);
  const groupRunsByRepo = groupBy(gr.cur, (r) => r.repo);
  const groupRunsPrevByRepo = groupBy(gr.prev, (r) => r.repo);

  // 2. Queue throughput: merges + time-in-queue p50 + group-run p50 per bucket.
  // Repos qualify on CURRENT-window rows only (prev-only repos are omitted).
  const queueRepos = [...new Set([
    ...mergedByRepo.keys(), ...queueWaitsByRepo.keys(), ...groupRunsByRepo.keys(),
  ])].sort();
  const queue = queueRepos.map((repo) => {
    const merges = mergedByRepo.get(repo) ?? [];
    const waits = queueWaitsByRepo.get(repo) ?? [];
    const runs = groupRunsByRepo.get(repo) ?? [];
    return {
      repo,
      merges: {
        value: merges.length,
        prev: (mergedPrevByRepo.get(repo) ?? []).length,
      },
      queueWaitP50: p50Stat(waits.map((r) => r.waitSecs),
        (queueWaitsPrevByRepo.get(repo) ?? []).map((r) => r.waitSecs)),
      groupRunP50: p50Stat(runs.map((r) => r.durationSecs),
        (groupRunsPrevByRepo.get(repo) ?? []).map((r) => r.durationSecs)),
      mergesPerBucket: bucketCounts(merges.map((r) => r.mergedAt), key),
      queueWaitBuckets: bucketPercentiles(waits.map((r) => ({ at: r.at, value: r.waitSecs })), key)
        .map(({ bucket: b, p50, n }) => ({ bucket: b, p50, n })),
      groupRunBuckets: bucketPercentiles(runs.map((r) => ({ at: r.at, value: r.durationSecs })), key)
        .map(({ bucket: b, p50, n }) => ({ bucket: b, p50, n })),
    };
  });

  // 3. Slowest / most-variable jobs: top 10 per repo by window p50 (no headline
  // deltas → current window read only). Trend buckets carry p50 AND p90 so the
  // leaderboard sparkline can render the p50→p90 band.
  const slowestJobs = [...groupBy(keep(history.checkDurationsSince(since)), (r) => r.repo)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, rows]) => {
      const jobs = [...groupBy(rows, (r) => `${r.name}${SEP}${r.event}`)]
        .map(([k, samples]) => {
          const [name, event] = k.split(SEP) as [string, string];
          const durations = samples.map((s) => s.durationSecs);
          const p50 = p(durations, 0.5);
          const p90 = p(durations, 0.9);
          return {
            name, event, p50, p90,
            variability: p90 / p50, // durations are >0 by recordCheckDuration's guard
            n: durations.length,
            trend: bucketPercentiles(samples.map((s) => ({ at: s.at, value: s.durationSecs })), key),
          };
        })
        .sort((a, b) => b.p50 - a.p50 || a.name.localeCompare(b.name))
        .slice(0, SLOWEST_JOBS_CAP);
      return { repo, jobs };
    });

  // 4. Merge velocity + deploy lag (+ lifespan), all from merged_prs.
  const velocity = [...mergedByRepo.keys()].sort().map((repo) => {
    const rows = mergedByRepo.get(repo)!;
    const prevRows = mergedPrevByRepo.get(repo) ?? [];
    const toQaSecs = (r: { mergedAt: string; qaLiveAt: string | null }): number =>
      (Date.parse(r.qaLiveAt!) - Date.parse(r.mergedAt)) / 1000;
    const lifespanHours = (r: { mergedAt: string; createdAt: string | null }): number =>
      (Date.parse(r.mergedAt) - Date.parse(r.createdAt!)) / 3600_000;
    const toQa = rows.filter((r) => r.qaLiveAt != null)
      .map((r) => ({ at: r.mergedAt, value: toQaSecs(r) }));
    // lifespan = mergedAt − createdAt; pre-migration rows lack created_at → excluded
    const lifespans = rows.filter((r) => r.createdAt != null)
      .map((r) => ({ at: r.mergedAt, hours: lifespanHours(r) }));
    const prevToQa = prevRows.filter((r) => r.qaLiveAt != null).map(toQaSecs);
    const prevLifespans = prevRows.filter((r) => r.createdAt != null).map(lifespanHours);
    const avgLifespanBuckets = [...groupBy(lifespans, (l) => key(l.at))]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([b, ls]) => ({ bucket: b, meanHours: mean(ls.map((l) => l.hours)), n: ls.length }));
    return {
      repo,
      merged: { value: rows.length, prev: prevRows.length },
      mergeToQaP50: p50Stat(toQa.map((t) => t.value), prevToQa),
      lifespanMeanHours: {
        value: lifespans.length ? mean(lifespans.map((l) => l.hours)) : null,
        prev: prevLifespans.length ? mean(prevLifespans) : null,
      },
      mergedPerBucket: bucketCounts(rows.map((r) => r.mergedAt), key),
      mergeToQaBuckets: bucketPercentiles(toQa, key)
        .map(({ bucket: b, p50, n }) => ({ bucket: b, p50, n })),
      avgLifespanBuckets,
    };
  });

  // 4b. Lead-time decomposition + DORA-lite headlines (issue #44). Current
  // window only (no headline deltas). Segment medians run over rows MERGED in
  // the window; deployment frequency counts prod-live EVENTS in the window
  // (a manual prod deploy often ships merges older than the window — the read
  // includes those rows so the count is honest).
  const pairSecs = (from: string | null, to: string | null): number | null => {
    if (from == null || to == null) return null;
    const secs = (Date.parse(to) - Date.parse(from)) / 1000;
    // negative pairs are clock artifacts (e.g. backfilled created_at after a
    // re-open) — skip rather than poison the median; NaN = unparseable
    return Number.isFinite(secs) && secs >= 0 ? secs : null;
  };
  const ltRows = keep(history.leadTimeRowsSince(since));
  const leadTime = [...groupBy(ltRows, (r) => r.repo)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, rows]) => {
      const mergedRows = rows.filter((r) => r.mergedAt >= since);
      const segments = LEAD_TIME_SEGMENTS.map(({ id, from, to }) => {
        const vals = mergedRows.map((r) => pairSecs(r[from], r[to]))
          .filter((v): v is number => v != null);
        return { id, medianSecs: vals.length ? p(vals, 0.5) : null, n: vals.length };
      });
      const totals = mergedRows.map((r) => pairSecs(r.createdAt, r.prodLiveAt))
        .filter((v): v is number => v != null);
      const prodDeploys = rows.filter((r) => r.prodLiveAt != null && r.prodLiveAt >= since).length;
      return {
        repo, segments,
        totalP50Secs: totals.length ? p(totals, 0.5) : null, totalN: totals.length,
        prodDeploys, deploysPerDay: prodDeploys / WINDOW_DAYS[window],
      };
    })
    .filter((r) => r.prodDeploys > 0 || r.segments.some((s) => s.n > 0));

  // 5. Trends: state samples aggregated per bucket — the LAST sample in each
  // bucket is the bucket's closing value (rows arrive time-ordered per repo).
  const trends = [...groupBy(keep(history.stateSamplesSince(since)), (r) => r.repo)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, rows]) => ({
      repo,
      points: [...groupBy(rows, (r) => key(r.at))]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([b, samples]) => {
          const last = samples[samples.length - 1]!;
          return { bucket: b, open: last.open, ci: last.ci, queue: last.queue, failed: last.failed };
        }),
    }));

  // 6. ETA calibration (issue #35): signed error % per (repo, stage). Rows with
  // predicted=0 are recordable upstream but carry no error % — skipped here.
  // Current-window read only (no headline deltas, like slowestJobs).
  const errPct = (r: { predictedSecs: number; actualSecs: number }): number =>
    ((r.actualSecs - r.predictedSecs) / r.predictedSecs) * 100;
  const calRows = keep(history.etaAccuracySince(since)).filter((r) => r.predictedSecs > 0);
  const calibration = [...groupBy(calRows, (r) => `${r.repo}${SEP}${r.stage}`)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, rows]) => {
      const [repo, stage] = k.split(SEP) as [string, string];
      const errors = rows.map(errPct);
      return {
        repo, stage, n: rows.length,
        medianErrorPct: p(errors, 0.5),
        p90AbsErrorPct: p(errors.map(Math.abs), 0.9),
        buckets: [...groupBy(rows, (r) => key(r.at))]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([bucket, rs]) => ({ bucket, medianErrorPct: p(rs.map(errPct), 0.5), n: rs.length })),
        // rows arrive ordered oldest-first per (repo, stage) — keep the newest
        points: rows.slice(-CALIBRATION_POINTS_CAP)
          .map((r) => ({ predicted: r.predictedSecs, actual: r.actualSecs })),
      };
    });

  // 7. Flake radar (issue #37): per repo, top checks by flake rate. Current
  // window only (no headline deltas — like slowestJobs). Min-runs threshold
  // keeps one-off retries from reading as 100% flaky.
  const flakeByRepo = history.flakeStatsByRepo(since);
  const flakiness = [...flakeByRepo]
    .filter(([repo]) => !dropped.has(repo))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, stats]) => ({
      repo,
      checks: stats
        .filter((s) => s.totalRuns >= FLAKE_MIN_RUNS && s.flakeEvents > 0)
        .sort((a, b) => b.flakeRatePct - a.flakeRatePct || a.name.localeCompare(b.name))
        .slice(0, FLAKINESS_CAP)
        .map((s) => {
          // axis = run buckets (every bucket with samples); flake counts joined in
          const flakeByBucket = new Map(bucketCounts(s.flakeAts, key).map((b) => [b.bucket, b.count]));
          const trend = bucketCounts(s.runAts, key).map((b) => ({
            bucket: b.bucket,
            flakeEvents: flakeByBucket.get(b.bucket) ?? 0,
            runs: b.count,
          }));
          return { name: s.name, event: s.event, flakeEvents: s.flakeEvents,
            totalRuns: s.totalRuns, flakeRatePct: s.flakeRatePct, trend };
        }),
    }))
    .filter((r) => r.checks.length > 0);

  // 8. Train killers (issue #38): ejects per check from group_failures, with the
  // documented cost approximation (ejects × median group run × batchSize) and a
  // flake-rate cross-reference (max across events for the same check name).
  const flakeRateByRepoName = new Map<string, number>(); // `${repo}\0${name}` → max rate
  for (const [repo, stats] of flakeByRepo) {
    for (const s of stats) {
      if (s.totalRuns < FLAKE_MIN_RUNS) continue;
      const k = `${repo}${SEP}${s.name}`;
      flakeRateByRepoName.set(k, Math.max(flakeRateByRepoName.get(k) ?? 0, s.flakeRatePct));
    }
  }
  const trainKillers = [...groupBy(keep(history.groupFailuresSince(since)), (r) => r.repo)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, rows]) => {
      const batchSize = batchSizeFor(repo);
      const medianGroupRunSecs = history.medianGroupRun(repo);
      const checks = [...groupBy(rows, (r) => r.checkName)]
        .map(([name, ejections]) => ({
          name,
          ejects: ejections.length, // one row per (group sha, check) — UNIQUE-deduped at write
          estCostTrainHours: medianGroupRunSecs != null
            ? (ejections.length * medianGroupRunSecs * batchSize) / 3600 : null,
          flakeRatePct: flakeRateByRepoName.get(`${repo}${SEP}${name}`) ?? null,
        }))
        .sort((a, b) => b.ejects - a.ejects || a.name.localeCompare(b.name));
      return { repo, batchSize, medianGroupRunSecs, checks };
    });

  // 9. Critical path (issue #42) + 10. workflow lint (issue #48 rule 1): both
  // join the derived needs DAG with observed history. Window-independent BY
  // DESIGN (documented on the payload fields): node medians come from the
  // last-20 samples per (check, event), p99s from the last-50, and check-name
  // discovery from the 14-day expectedSet — the window selector never applies.
  const criticalPath: MetricsPayload['criticalPath'] = [];
  const lint: MetricsPayload['lint'] = [];
  for (const [repo, graph] of [...ciGraphs].sort(([a], [b]) => a.localeCompare(b))) {
    if (dropped.has(repo)) continue;
    const allKeys = [...graph.keys()];
    const foreign = foreignNames.get(repo);
    // node → lint input; the worst (max) p99 across events wins per node
    const lintInputs = new Map<string, TimeoutLintInput>();
    for (const event of CRITICAL_PATH_EVENTS) {
      const names = history.expectedSet(repo, event, now);
      // nodes provably inactive for this event leave the DAG entirely (their
      // needs-edges are dropped by computeCriticalPath's unknown-name rule)
      const active = [...graph].filter(([, node]) => activeForEvent(node.activity, event));
      const activeKeys = active.map(([k]) => k);
      const eventWait = history.expectedRunnerWaitForEvent(repo, event);
      const namesByNode = new Map<string, string[]>();
      for (const name of names) {
        // A name whose LIVE check provably belongs to a foreign workflow
        // (`ci-gate` from `Auto-merge PRs`) must not prefix-join a node of
        // the rollup workflow's DAG (issue #61 follow-up): its durations are
        // wall-clock CI-lifecycle spans, not job runtime — they would poison
        // both the lint p99 and the node's critical-path weight.
        if (foreign?.has(name)) continue;
        const nodeKey = matchingPrefix(name, activeKeys);
        if (nodeKey != null) namesByNode.set(nodeKey, [...(namesByNode.get(nodeKey) ?? []), name]);
        // lint joins against EVERY node (event activity doesn't gate a timeout)
        const lintKey = matchingPrefix(name, allKeys);
        if (lintKey != null) {
          const p99 = history.durationP99(repo, name, event);
          if (p99 != null && p99.n >= LINT_MIN_RUNS) {
            const prior = lintInputs.get(lintKey);
            if (!prior || p99.p99Secs > prior.p99Secs) {
              lintInputs.set(lintKey, { job: lintKey,
                timeoutMinutes: graph.get(lintKey)!.timeoutMinutes, p99Secs: p99.p99Secs });
            }
          }
        }
      }
      // node weight = the slowest matched check (a reusable-workflow node's
      // inner checks run in parallel — the longest one carries the node)
      let sawDuration = false;
      const inputs: CriticalPathNodeInput[] = active.map(([key, node]) => {
        let durationP50: number | null = null;
        let waitP50: number | null = null;
        for (const name of namesByNode.get(key) ?? []) {
          const p50 = history.expected(repo, name, event)?.p50;
          if (p50 == null) continue;
          const wait = history.expectedRunnerWait(repo, name, event) ?? eventWait;
          if (durationP50 == null || p50 + (wait ?? 0) > durationP50 + (waitP50 ?? 0)) {
            durationP50 = p50;
            waitP50 = wait;
          }
        }
        if (durationP50 != null) sawDuration = true;
        return { name: key, needs: node.needs, durationP50, waitP50 };
      });
      // a graph with zero observed durations renders nothing useful — omit
      if (!sawDuration) continue;
      const result = computeCriticalPath(inputs);
      if (result == null) continue; // empty/cyclic (corrupt persisted graph)
      criticalPath.push({ repo, event, endToEndP50Secs: result.endToEndP50Secs,
        path: result.path, offPath: result.offPath.slice(0, OFF_PATH_CAP) });
    }
    const findings = lintTimeouts([...lintInputs.values()]);
    if (findings.length > 0) lint.push({ repo, findings });
  }

  // 11. Duration regressions (issue #41): a passthrough of the poller's live
  // active-regression cache — exclude-filtered like everything else, empty
  // repos omitted. Window-independent BY DESIGN (it's "what is regressed NOW").
  const regressions = activeRegressions
    .filter((r) => !dropped.has(r.repo) && r.checks.length > 0);

  // 12. Per-pool runner telemetry (issue #45): runnerWaits' shape, pool-keyed.
  // Only ingestion-labeled rows participate (the pool column is NULL on
  // pre-#45 history). The live health snapshot from the poller's hourly scan
  // joins on (repo, pool); pools the scan hasn't evaluated yet carry nulls.
  const healthByKey = new Map<string, PoolHealthView>();
  for (const ph of poolHealth) {
    for (const p2 of ph.pools) healthByKey.set(`${ph.repo}${SEP}${p2.pool}`, p2);
  }
  const pw = splitWindow(keep(history.runnerPoolWaitsSince(prevSince)), (r) => r.at, since);
  const pwPrevByKey = groupBy(pw.prev, (r) => `${r.repo}${SEP}${r.pool}`);
  const runnerPools = [...groupBy(pw.cur, (r) => `${r.repo}${SEP}${r.pool}`)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, rows]) => {
      const [repo, pool] = k.split(SEP) as [string, string];
      const prevRows = pwPrevByKey.get(k) ?? [];
      const health = healthByKey.get(k);
      return {
        repo, pool,
        p50: p50Stat(rows.map((r) => r.waitSecs), prevRows.map((r) => r.waitSecs)),
        buckets: bucketPercentiles(rows.map((r) => ({ at: r.at, value: r.waitSecs })), key),
        lastHourP90Secs: health?.lastHourP90Secs ?? null,
        baselineP90Secs: health?.baselineP90Secs ?? null,
        starving: health?.starving ?? false,
      };
    });

  // 13. Spot-reclaim ledger (issue #46): events from the sha+attempt data,
  // bucketed for the trend chart and joined onto pools via the derived graph.
  const poolKeyOf = (repo: string, name: string): string => {
    const pools = poolsFor(repo, name);
    return pools?.length ? pools.join('|') : 'unknown';
  };
  const reclaims = [...history.reclaimEventsByRepo(since)]
    .filter(([repo]) => !dropped.has(repo))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, events]) => ({
      repo,
      total: events.length,
      perBucket: bucketCounts(events.map((e) => e.at), key),
      byPool: [...groupBy(events, (e) => poolKeyOf(repo, e.name))]
        .map(([pool, evs]) => ({ pool, count: evs.length }))
        .sort((a, b) => b.count - a.count || a.pool.localeCompare(b.pool)),
    }))
    .filter((r) => r.total > 0);

  // 14. Concurrency demand curve (issue #47): sweep-line peaks over the job
  // intervals completing in-window, per repo×pool. Cancelled/failed jobs
  // count — they occupied a runner for their whole span.
  const nowMs = now.getTime();
  const sinceMs = nowMs - windowMs;
  const concurrency = [...groupBy(keep(history.checkIntervalsSince(since)),
    (r) => `${r.repo}${SEP}${poolKeyOf(r.repo, r.name)}`)]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([k, rows]) => {
      const [repo, pool] = k.split(SEP) as [string, string];
      const buckets = sweepBucketPeaks(rows.map((r) => ({
        startMs: Date.parse(r.startedAt), endMs: Date.parse(r.completedAt) })),
      sinceMs, nowMs, bucket);
      if (!buckets.length) return [];
      return [{ repo, pool, peak: Math.max(...buckets.map((b) => b.peak)), buckets }];
    });

  return { window, bucket, runnerWaits, queue, slowestJobs, velocity, leadTime, trends,
    calibration, flakiness, trainKillers, criticalPath, lint, regressions,
    runnerPools, reclaims, concurrency };
}
