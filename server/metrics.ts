import type { HistoryStore } from './history';
import { percentile } from './math';

/**
 * Metrics tab payload (round 12). This interface is the BINDING CONTRACT with
 * the frontend mirror in `frontend/src/types.ts` — change both together.
 *
 * All `p50`/`p90` values are seconds; `meanHours` is hours. `date` is a UTC
 * day (`YYYY-MM-DD`); `at` is a full ISO timestamp.
 */
export interface MetricsPayload {
  windowDays: number;
  runnerWaits: { repo: string; event: string; days: { date: string; p50: number; p90: number; n: number }[] }[];
  queue: { repo: string; mergesPerDay: { date: string; count: number }[]; queueWaitDays: { date: string; p50: number; n: number }[]; groupRunDays: { date: string; p50: number; n: number }[] }[];
  slowestJobs: { repo: string; jobs: { name: string; event: string; p50: number; p90: number; variability: number; n: number; trend: { date: string; p50: number }[] }[] }[]; // top 10 by p50, variability = p90/p50
  velocity: { repo: string; mergedPerDay: { date: string; count: number }[]; mergeToQaDays: { date: string; p50: number; n: number }[]; avgLifespanDays: { date: string; meanHours: number; n: number }[] }[];
  trends: { repo: string; samples: { at: string; open: number; ci: number; queue: number; failed: number }[] }[]; // raw state_samples within window (≤15min cadence)
}

export const METRICS_WINDOWS = [7, 14, 30] as const;
export type MetricsWindow = (typeof METRICS_WINDOWS)[number];

/** Top-N cap for the slowest-jobs leaderboard (per repo). */
const SLOWEST_JOBS_CAP = 10;

/**
 * Snap an arbitrary `windowDays` query value to the allowed set {7, 14, 30}:
 * missing/unparseable → the 14-day default; any other number → nearest window.
 */
export function clampWindowDays(raw: unknown): MetricsWindow {
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 14;
  let best: MetricsWindow = 14;
  let bestDist = Infinity;
  for (const w of METRICS_WINDOWS) {
    const dist = Math.abs(w - n);
    if (dist < bestDist) { bestDist = dist; best = w; }
  }
  return best;
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

/** Day-bucketed { date, p50, n } summaries from (date, value) pairs, dates ascending. */
function dayPercentiles(rows: { date: string; value: number }[]): { date: string; p50: number; n: number }[] {
  return [...groupBy(rows, (r) => r.date)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({ date, p50: p(vals.map((v) => v.value), 0.5), n: vals.length }));
}

/** Day-bucketed counts from ISO timestamps, dates ascending. */
function dayCounts(timestamps: string[]): { date: string; count: number }[] {
  return [...groupBy(timestamps, (t) => t.slice(0, 10))]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, ts]) => ({ date, count: ts.length }));
}

/**
 * Compute the full metrics payload for one window — a single pass over the
 * local SQLite history per section, computed on request (no caching).
 */
export function computeMetrics(history: HistoryStore, windowDays: number,
  now: Date = new Date()): MetricsPayload {
  const since = new Date(now.getTime() - windowDays * 86400_000).toISOString();

  // 1. Runner-wait health: per (repo, event) day buckets with p50/p90.
  const runnerWaits = [...groupBy(history.runnerWaitsSince(since),
    (r) => `${r.repo}${SEP}${r.event}`)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const [repo, event] = key.split(SEP) as [string, string];
      const days = [...groupBy(rows, (r) => r.date)]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, vals]) => {
          const waits = vals.map((v) => v.waitSecs);
          return { date, p50: p(waits, 0.5), p90: p(waits, 0.9), n: waits.length };
        });
      return { repo, event, days };
    });

  // Shared merged-PR rows: queue.mergesPerDay + the whole velocity section.
  const merged = history.mergedSince(since);
  const mergedByRepo = groupBy(merged, (r) => r.repo);
  const queueWaitsByRepo = groupBy(history.queueWaitsSince(since), (r) => r.repo);
  const groupRunsByRepo = groupBy(history.groupRunsSince(since), (r) => r.repo);

  // 2. Queue throughput: merges/day + time-in-queue p50 + group-run p50.
  const queueRepos = [...new Set([
    ...mergedByRepo.keys(), ...queueWaitsByRepo.keys(), ...groupRunsByRepo.keys(),
  ])].sort();
  const queue = queueRepos.map((repo) => ({
    repo,
    mergesPerDay: dayCounts((mergedByRepo.get(repo) ?? []).map((r) => r.mergedAt)),
    queueWaitDays: dayPercentiles((queueWaitsByRepo.get(repo) ?? [])
      .map((r) => ({ date: r.date, value: r.waitSecs }))),
    groupRunDays: dayPercentiles((groupRunsByRepo.get(repo) ?? [])
      .map((r) => ({ date: r.date, value: r.durationSecs }))),
  }));

  // 3. Slowest / most-variable jobs: top 10 per repo by window p50.
  const slowestJobs = [...groupBy(history.checkDurationsSince(since), (r) => r.repo)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, rows]) => {
      const jobs = [...groupBy(rows, (r) => `${r.name}${SEP}${r.event}`)]
        .map(([key, samples]) => {
          const [name, event] = key.split(SEP) as [string, string];
          const durations = samples.map((s) => s.durationSecs);
          const p50 = p(durations, 0.5);
          const p90 = p(durations, 0.9);
          return {
            name, event, p50, p90,
            variability: p90 / p50, // durations are >0 by recordCheckDuration's guard
            n: durations.length,
            trend: dayPercentiles(samples.map((s) => ({ date: s.date, value: s.durationSecs })))
              .map((d) => ({ date: d.date, p50: d.p50 })),
          };
        })
        .sort((a, b) => b.p50 - a.p50 || a.name.localeCompare(b.name))
        .slice(0, SLOWEST_JOBS_CAP);
      return { repo, jobs };
    });

  // 4. Merge velocity + deploy lag (+ lifespan), all from merged_prs.
  const velocity = [...mergedByRepo.keys()].sort().map((repo) => {
    const rows = mergedByRepo.get(repo)!;
    const toQa = rows.filter((r) => r.qaLiveAt != null)
      .map((r) => ({ date: r.mergedAt.slice(0, 10),
        value: (Date.parse(r.qaLiveAt!) - Date.parse(r.mergedAt)) / 1000 }));
    // lifespan = mergedAt − createdAt; pre-migration rows lack created_at → excluded
    const lifespans = rows.filter((r) => r.createdAt != null)
      .map((r) => ({ date: r.mergedAt.slice(0, 10),
        hours: (Date.parse(r.mergedAt) - Date.parse(r.createdAt!)) / 3600_000 }));
    const avgLifespanDays = [...groupBy(lifespans, (l) => l.date)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, ls]) => ({ date,
        meanHours: ls.reduce((sum, l) => sum + l.hours, 0) / ls.length, n: ls.length }));
    return {
      repo,
      mergedPerDay: dayCounts(rows.map((r) => r.mergedAt)),
      mergeToQaDays: dayPercentiles(toQa),
      avgLifespanDays,
    };
  });

  // 5. Trends: raw state samples within the window (≤15min cadence).
  const trends = [...groupBy(history.stateSamplesSince(since), (r) => r.repo)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, rows]) => ({
      repo,
      samples: rows.map(({ at, open, ci, queue, failed }) => ({ at, open, ci, queue, failed })),
    }));

  return { windowDays, runnerWaits, queue, slowestJobs, velocity, trends };
}
