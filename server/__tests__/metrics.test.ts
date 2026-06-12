import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryStore } from '../history';
import { computeMetrics, resolveMetricsQuery, sweepBucketPeaks, METRICS_WINDOWS, WINDOW_DAYS } from '../metrics';

const REPO = 'acme/widgets';
const NOW = new Date('2026-06-11T12:00:00Z');

let h: HistoryStore;
beforeEach(() => {
  h = new HistoryStore(':memory:');
});

describe('resolveMetricsQuery', () => {
  it('defaults to window=3d bucket=hour', () => {
    expect(resolveMetricsQuery({})).toEqual({ window: '3d', bucket: 'hour' });
  });

  it('accepts every allowed window key', () => {
    for (const w of METRICS_WINDOWS) {
      expect(resolveMetricsQuery({ window: w }).window).toBe(w);
    }
  });

  it('honors bucket=day for any window', () => {
    for (const w of METRICS_WINDOWS) {
      expect(resolveMetricsQuery({ window: w, bucket: 'day' }).bucket).toBe('day');
    }
  });

  it('clamping matrix: hour allowed only for windows ≤ 7d', () => {
    expect(resolveMetricsQuery({ window: '24h', bucket: 'hour' }).bucket).toBe('hour');
    expect(resolveMetricsQuery({ window: '3d', bucket: 'hour' }).bucket).toBe('hour');
    expect(resolveMetricsQuery({ window: '7d', bucket: 'hour' }).bucket).toBe('hour');
    expect(resolveMetricsQuery({ window: '14d', bucket: 'hour' }).bucket).toBe('day');
    expect(resolveMetricsQuery({ window: '30d', bucket: 'hour' }).bucket).toBe('day');
  });

  it('default bucket (hour) is also clamped for long windows', () => {
    expect(resolveMetricsQuery({ window: '14d' }).bucket).toBe('day');
    expect(resolveMetricsQuery({ window: '30d' }).bucket).toBe('day');
  });

  it('unknown bucket values fall back to the hour default (then clamp)', () => {
    expect(resolveMetricsQuery({ window: '3d', bucket: 'minute' }).bucket).toBe('hour');
    expect(resolveMetricsQuery({ window: '30d', bucket: 'minute' }).bucket).toBe('day');
  });

  it('back-compat: windowDays=7/14/30 map to 7d/14d/30d', () => {
    expect(resolveMetricsQuery({ windowDays: '7' }).window).toBe('7d');
    expect(resolveMetricsQuery({ windowDays: '14' }).window).toBe('14d');
    expect(resolveMetricsQuery({ windowDays: '30' }).window).toBe('30d');
    expect(resolveMetricsQuery({ windowDays: 7 }).window).toBe('7d');
  });

  it('back-compat: other windowDays values snap to the nearest legacy window', () => {
    expect(resolveMetricsQuery({ windowDays: '1' }).window).toBe('7d');
    expect(resolveMetricsQuery({ windowDays: '999' }).window).toBe('30d');
    expect(resolveMetricsQuery({ windowDays: '21' }).window).toBe('14d');
    expect(resolveMetricsQuery({ windowDays: '-5' }).window).toBe('7d');
  });

  it('window param wins over windowDays; garbage falls through to the default', () => {
    expect(resolveMetricsQuery({ window: '24h', windowDays: '30' }).window).toBe('24h');
    expect(resolveMetricsQuery({ window: '5d', windowDays: '30' }).window).toBe('30d');
    expect(resolveMetricsQuery({ window: 'abc' }).window).toBe('3d');
    expect(resolveMetricsQuery({ windowDays: 'abc' }).window).toBe('3d');
  });

  it('WINDOW_DAYS covers every window key', () => {
    expect(Object.keys(WINDOW_DAYS).sort()).toEqual([...METRICS_WINDOWS].sort());
    expect(WINDOW_DAYS['24h']).toBe(1);
    expect(WINDOW_DAYS['3d']).toBe(3);
  });
});

describe('computeMetrics: runner waits', () => {
  it('hour bucketing: per (repo, event) ISO-hour buckets with p50/p90/n', () => {
    // 3 waits in the 10:00 hour, 1 in the 11:00 hour, 1 outside the 24h window
    h.recordRunnerWait(REPO, 'build', 'pull_request', 10, '2026-06-11T10:05:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 20, '2026-06-11T10:25:00Z');
    h.recordRunnerWait(REPO, 'lint', 'pull_request', 30, '2026-06-11T10:45:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 60, '2026-06-11T11:05:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 999, '2026-06-09T10:00:00Z'); // outside 24h

    const m = computeMetrics(h, '24h', 'hour', NOW);
    expect(m.window).toBe('24h');
    expect(m.bucket).toBe('hour');
    const pr = m.runnerWaits.find((r) => r.repo === REPO && r.event === 'pull_request')!;
    expect(pr.buckets).toEqual([
      { bucket: '2026-06-11T10', p50: 20, p90: 30, n: 3 },
      { bucket: '2026-06-11T11', p50: 60, p90: 60, n: 1 },
    ]);
  });

  it('day bucketing still aggregates whole UTC days; window-scoped', () => {
    h.recordRunnerWait(REPO, 'build', 'pull_request', 10, '2026-06-10T10:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 20, '2026-06-10T11:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 30, '2026-06-10T12:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 60, '2026-06-09T10:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 999, '2026-06-01T10:00:00Z'); // outside 7d
    h.recordRunnerWait(REPO, 'ci', 'merge_group', 100, '2026-06-10T10:00:00Z');

    const m = computeMetrics(h, '7d', 'day', NOW);
    const mg = m.runnerWaits.find((r) => r.repo === REPO && r.event === 'merge_group')!;
    expect(mg.buckets).toEqual([{ bucket: '2026-06-10', p50: 100, p90: 100, n: 1 }]);
    const pr = m.runnerWaits.find((r) => r.repo === REPO && r.event === 'pull_request')!;
    expect(pr.buckets).toEqual([
      { bucket: '2026-06-09', p50: 60, p90: 60, n: 1 },
      { bucket: '2026-06-10', p50: 20, p90: 30, n: 3 },
    ]);
  });

  it('headline p50 with prev-window comparison; prev null without prior samples', () => {
    // current 24h window: 10, 20 → p50 10; previous 24h window: 100 → prev p50 100
    h.recordRunnerWait(REPO, 'build', 'pull_request', 10, '2026-06-11T10:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 20, '2026-06-11T11:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 100, '2026-06-10T09:00:00Z'); // prev window
    h.recordRunnerWait(REPO, 'ci', 'merge_group', 40, '2026-06-11T10:00:00Z'); // no prev samples

    const m = computeMetrics(h, '24h', 'hour', NOW);
    const pr = m.runnerWaits.find((r) => r.event === 'pull_request')!;
    expect(pr.p50).toEqual({ value: 10, prev: 100 });
    const mg = m.runnerWaits.find((r) => r.event === 'merge_group')!;
    expect(mg.p50).toEqual({ value: 40, prev: null });
  });

  it('a (repo, event) with samples only in the previous window is omitted', () => {
    h.recordRunnerWait(REPO, 'build', 'pull_request', 100, '2026-06-10T09:00:00Z'); // prev only
    const m = computeMetrics(h, '24h', 'hour', NOW);
    expect(m.runnerWaits).toEqual([]);
  });
});

describe('computeMetrics: queue throughput', () => {
  it('merge counts, queue-wait p50, group-run p50 per bucket + headlines with prev', () => {
    h.upsertMergedPr({ repo: REPO, number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-11T10:10:00Z', mergeCommitSha: 'a' });
    h.upsertMergedPr({ repo: REPO, number: 2, title: 't', url: 'u',
      mergedAt: '2026-06-11T10:40:00Z', mergeCommitSha: 'b' });
    h.upsertMergedPr({ repo: REPO, number: 3, title: 't', url: 'u',
      mergedAt: '2026-06-11T09:00:00Z', mergeCommitSha: 'c' });
    // previous 24h window (before 2026-06-10T12:00Z): one merge
    h.upsertMergedPr({ repo: REPO, number: 4, title: 't', url: 'u',
      mergedAt: '2026-06-10T09:00:00Z', mergeCommitSha: 'd' });
    h.recordQueueWait(REPO, 120, '2026-06-11T10:00:00Z');
    h.recordQueueWait(REPO, 240, '2026-06-11T10:30:00Z');
    h.recordQueueWait(REPO, 600, '2026-06-10T09:00:00Z'); // prev window
    h.recordGroupRun(REPO, 600, '2026-06-11T10:30:00Z');

    const q = computeMetrics(h, '24h', 'hour', NOW).queue.find((r) => r.repo === REPO)!;
    expect(q.mergesPerBucket).toEqual([
      { bucket: '2026-06-11T09', count: 1 },
      { bucket: '2026-06-11T10', count: 2 },
    ]);
    expect(q.queueWaitBuckets).toEqual([{ bucket: '2026-06-11T10', p50: 120, n: 2 }]);
    expect(q.groupRunBuckets).toEqual([{ bucket: '2026-06-11T10', p50: 600, n: 1 }]);
    expect(q.merges).toEqual({ value: 3, prev: 1 });
    expect(q.queueWaitP50).toEqual({ value: 120, prev: 600 });
    expect(q.groupRunP50).toEqual({ value: 600, prev: null });
  });

  it('repos with data only in the previous window are omitted', () => {
    h.upsertMergedPr({ repo: REPO, number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-10T09:00:00Z', mergeCommitSha: 'a' }); // prev window only
    expect(computeMetrics(h, '24h', 'hour', NOW).queue).toEqual([]);
  });
});

describe('computeMetrics: slowest jobs', () => {
  it('orders by p50 desc, variability = p90/p50, per-bucket trend carries p50 AND p90', () => {
    // 'slow': 100 on 06-09; 200 + 300 on 06-10 → window p50 200, p90 300
    h.recordCheckDuration(REPO, 'slow', 'pull_request', '2026-06-09T10:00:00Z', '2026-06-09T10:01:40Z', 'SUCCESS'); // 100
    h.recordCheckDuration(REPO, 'slow', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:03:20Z', 'SUCCESS'); // 200
    h.recordCheckDuration(REPO, 'slow', 'pull_request', '2026-06-10T11:00:00Z', '2026-06-10T11:05:00Z', 'SUCCESS'); // 300
    h.recordCheckDuration(REPO, 'fast', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:00:20Z', 'SUCCESS');
    // failures never count
    h.recordCheckDuration(REPO, 'slow', 'pull_request', '2026-06-10T13:00:00Z', '2026-06-10T14:00:00Z', 'FAILURE');

    const jobs = computeMetrics(h, '7d', 'day', NOW).slowestJobs.find((r) => r.repo === REPO)!.jobs;
    expect(jobs.map((j) => j.name)).toEqual(['slow', 'fast']);
    const slow = jobs[0]!;
    expect(slow.p50).toBe(200);
    expect(slow.p90).toBe(300);
    expect(slow.variability).toBeCloseTo(1.5);
    expect(slow.n).toBe(3);
    expect(slow.trend).toEqual([
      { bucket: '2026-06-09', p50: 100, p90: 100, n: 1 },
      { bucket: '2026-06-10', p50: 200, p90: 300, n: 2 },
    ]);
  });

  it('hour bucketing applies to the trend', () => {
    h.recordCheckDuration(REPO, 'ci', 'pull_request', '2026-06-11T10:00:00Z', '2026-06-11T10:01:00Z', 'SUCCESS'); // 60
    h.recordCheckDuration(REPO, 'ci', 'pull_request', '2026-06-11T11:00:00Z', '2026-06-11T11:02:00Z', 'SUCCESS'); // 120
    const jobs = computeMetrics(h, '24h', 'hour', NOW).slowestJobs.find((r) => r.repo === REPO)!.jobs;
    expect(jobs[0]!.trend.map((t) => t.bucket)).toEqual(['2026-06-11T10', '2026-06-11T11']);
  });

  it('caps each repo at the top 10 jobs by p50', () => {
    for (let i = 1; i <= 12; i++) {
      const secs = i * 10;
      h.recordCheckDuration('octo/bridge', `job-${String(i).padStart(2, '0')}`, 'pull_request',
        '2026-06-10T10:00:00Z', new Date(Date.parse('2026-06-10T10:00:00Z') + secs * 1000).toISOString(), 'SUCCESS');
    }
    const jobs = computeMetrics(h, '7d', 'day', NOW).slowestJobs.find((r) => r.repo === 'octo/bridge')!.jobs;
    expect(jobs).toHaveLength(10);
    expect(jobs[0]!.name).toBe('job-12');
    expect(jobs.map((j) => j.name)).not.toContain('job-01');
    expect(jobs.map((j) => j.name)).not.toContain('job-02');
  });

  it('same job name under different events stays separate', () => {
    h.recordCheckDuration(REPO, 'ci', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:01:00Z', 'SUCCESS');
    h.recordCheckDuration(REPO, 'ci', 'merge_group', '2026-06-10T10:00:00Z', '2026-06-10T10:10:00Z', 'SUCCESS');
    const jobs = computeMetrics(h, '7d', 'day', NOW).slowestJobs.find((r) => r.repo === REPO)!.jobs;
    expect(jobs.map((j) => `${j.name}/${j.event}`).sort()).toEqual(['ci/merge_group', 'ci/pull_request']);
  });
});

describe('computeMetrics: velocity', () => {
  it('per-bucket merged counts, merge→QA p50, lifespan meanHours + headlines with prev', () => {
    // current window (3d): lifespan 24h, merge→QA 600s
    h.upsertMergedPr({ repo: REPO, number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-10T10:00:00Z', mergeCommitSha: 'a', createdAt: '2026-06-09T10:00:00Z' });
    h.markEnvLive(REPO, 1, 'qa', '2026-06-10T10:10:00Z');
    // created_at unknown (pre-migration row) — excluded from lifespan
    h.upsertMergedPr({ repo: REPO, number: 2, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'b' });
    // lifespan 1h, merged the previous day (still inside 3d window)
    h.upsertMergedPr({ repo: REPO, number: 3, title: 't', url: 'u',
      mergedAt: '2026-06-09T09:00:00Z', mergeCommitSha: 'c', createdAt: '2026-06-09T08:00:00Z' });
    // previous 3d window (06-05..06-08): one merge, lifespan 2h
    h.upsertMergedPr({ repo: REPO, number: 4, title: 't', url: 'u',
      mergedAt: '2026-06-06T09:00:00Z', mergeCommitSha: 'd', createdAt: '2026-06-06T07:00:00Z' });
    // outside both windows entirely
    h.upsertMergedPr({ repo: REPO, number: 5, title: 't', url: 'u',
      mergedAt: '2026-05-01T09:00:00Z', mergeCommitSha: 'e', createdAt: '2026-05-01T08:00:00Z' });

    const v = computeMetrics(h, '3d', 'day', NOW).velocity.find((r) => r.repo === REPO)!;
    expect(v.mergedPerBucket).toEqual([
      { bucket: '2026-06-09', count: 1 },
      { bucket: '2026-06-10', count: 2 },
    ]);
    expect(v.mergeToQaBuckets).toEqual([{ bucket: '2026-06-10', p50: 600, n: 1 }]);
    expect(v.avgLifespanBuckets).toEqual([
      { bucket: '2026-06-09', meanHours: 1, n: 1 },
      { bucket: '2026-06-10', meanHours: 24, n: 1 }, // null-created_at row excluded
    ]);
    expect(v.merged).toEqual({ value: 3, prev: 1 });
    expect(v.mergeToQaP50).toEqual({ value: 600, prev: null });
    expect(v.lifespanMeanHours.value).toBeCloseTo(12.5); // mean(24h, 1h)
    expect(v.lifespanMeanHours.prev).toBeCloseTo(2);
  });
});

describe('computeMetrics: trends (state samples)', () => {
  it('aggregates per bucket using the LAST sample in each bucket (closing value)', () => {
    expect(h.recordStateSample(REPO, '2026-06-11T10:00:00Z',
      { open: 5, ci: 2, queue: 1, failed: 0 })).toBe(true);
    expect(h.recordStateSample(REPO, '2026-06-11T10:20:00Z',
      { open: 6, ci: 3, queue: 0, failed: 1 })).toBe(true);
    expect(h.recordStateSample(REPO, '2026-06-11T11:05:00Z',
      { open: 7, ci: 1, queue: 0, failed: 0 })).toBe(true);
    h.recordStateSample('octo/bridge', '2026-06-11T10:00:00Z', { open: 1, ci: 0, queue: 0, failed: 0 });

    const t = computeMetrics(h, '24h', 'hour', NOW).trends.find((r) => r.repo === REPO)!;
    expect(t.points).toEqual([
      { bucket: '2026-06-11T10', open: 6, ci: 3, queue: 0, failed: 1 }, // last of the 10:00 hour
      { bucket: '2026-06-11T11', open: 7, ci: 1, queue: 0, failed: 0 },
    ]);
    expect(computeMetrics(h, '24h', 'hour', NOW).trends.find((r) => r.repo === 'octo/bridge')!.points)
      .toHaveLength(1);
  });

  it('day bucketing takes the last sample of each day', () => {
    h.recordStateSample(REPO, '2026-06-10T09:00:00Z', { open: 3, ci: 1, queue: 0, failed: 0 });
    h.recordStateSample(REPO, '2026-06-10T22:00:00Z', { open: 9, ci: 0, queue: 2, failed: 1 });
    const t = computeMetrics(h, '7d', 'day', NOW).trends.find((r) => r.repo === REPO)!;
    expect(t.points).toEqual([
      { bucket: '2026-06-10', open: 9, ci: 0, queue: 2, failed: 1 },
    ]);
  });

  it('samples outside the window are excluded', () => {
    h.recordStateSample(REPO, '2026-06-01T10:00:00Z', { open: 9, ci: 9, queue: 9, failed: 9 });
    h.recordStateSample(REPO, '2026-06-10T10:00:00Z', { open: 1, ci: 0, queue: 0, failed: 0 });
    const t = computeMetrics(h, '7d', 'day', NOW).trends.find((r) => r.repo === REPO)!;
    expect(t.points).toHaveLength(1);
    expect(t.points[0]!.open).toBe(1);
  });
});

describe('computeMetrics: empty history', () => {
  it('returns the full payload shape with empty sections', () => {
    expect(computeMetrics(h, '3d', 'hour', NOW)).toEqual({
      window: '3d', bucket: 'hour',
      runnerWaits: [], queue: [], slowestJobs: [], velocity: [], leadTime: [], trends: [],
      calibration: [], flakiness: [], trainKillers: [], criticalPath: [], lint: [],
      regressions: [], runnerPools: [], reclaims: [], concurrency: [],
    });
  });
});

describe('computeMetrics: ETA calibration (issue #35)', () => {
  it('per (repo, stage): n, signed medianErrorPct (+ = optimistic), p90AbsErrorPct, scatter points', () => {
    // signed errors: +20%, −10%, +50% → median +20; abs [10,20,50] → p90 50
    h.recordEtaAccuracy(REPO, 'ci', 100, 120, '2026-06-11T10:00:00Z');
    h.recordEtaAccuracy(REPO, 'ci', 100, 90, '2026-06-11T10:10:00Z');
    h.recordEtaAccuracy(REPO, 'ci', 100, 150, '2026-06-11T10:20:00Z');
    const m = computeMetrics(h, '24h', 'hour', NOW);
    expect(m.calibration).toEqual([{
      repo: REPO, stage: 'ci', n: 3,
      medianErrorPct: 20, p90AbsErrorPct: 50,
      buckets: [{ bucket: '2026-06-11T10', medianErrorPct: 20, n: 3 }],
      points: [
        { predicted: 100, actual: 120 },
        { predicted: 100, actual: 90 },
        { predicted: 100, actual: 150 },
      ],
    }]);
  });

  it('buckets signed error per hour/day like every other section', () => {
    h.recordEtaAccuracy(REPO, 'queue', 100, 110, '2026-06-11T09:00:00Z'); // +10%
    h.recordEtaAccuracy(REPO, 'queue', 100, 130, '2026-06-11T10:00:00Z'); // +30%
    h.recordEtaAccuracy(REPO, 'queue', 100, 80, '2026-06-11T10:30:00Z');  // −20%
    const hour = computeMetrics(h, '24h', 'hour', NOW).calibration[0]!;
    expect(hour.buckets).toEqual([
      { bucket: '2026-06-11T09', medianErrorPct: 10, n: 1 },
      { bucket: '2026-06-11T10', medianErrorPct: -20, n: 2 }, // lower median of [−20, 30]
    ]);
    const day = computeMetrics(h, '24h', 'day', NOW).calibration[0]!;
    expect(day.buckets).toEqual([{ bucket: '2026-06-11', medianErrorPct: 10, n: 3 }]);
  });

  it('groups sort repo → stage; rows outside the window are dropped', () => {
    h.recordEtaAccuracy('octo/bridge', 'ci', 100, 110, '2026-06-11T10:00:00Z');
    h.recordEtaAccuracy(REPO, 'queue', 100, 110, '2026-06-11T10:00:00Z');
    h.recordEtaAccuracy(REPO, 'ci', 100, 110, '2026-06-11T10:00:00Z');
    h.recordEtaAccuracy(REPO, 'ci', 100, 900, '2026-06-09T10:00:00Z'); // outside 24h
    const cal = computeMetrics(h, '24h', 'hour', NOW).calibration;
    expect(cal.map((c) => [c.repo, c.stage])).toEqual([
      [REPO, 'ci'], [REPO, 'queue'], ['octo/bridge', 'ci'],
    ]);
    expect(cal[0]!.n).toBe(1); // the 2-day-old row is gone
  });

  it('caps scatter points at the 200 most recent rows (n keeps the full count)', () => {
    for (let i = 0; i < 230; i++) {
      const at = new Date(Date.parse('2026-06-11T00:00:00Z') + i * 60_000).toISOString();
      h.recordEtaAccuracy(REPO, 'ci', 100, 100 + i, at);
    }
    const c = computeMetrics(h, '24h', 'hour', NOW).calibration[0]!;
    expect(c.n).toBe(230);
    expect(c.points).toHaveLength(200);
    expect(c.points[0]).toEqual({ predicted: 100, actual: 130 });   // rows 0..29 dropped
    expect(c.points[199]).toEqual({ predicted: 100, actual: 329 }); // newest kept
  });

  it('skips predicted=0 rows (no error % exists for them)', () => {
    h.recordEtaAccuracy(REPO, 'ci', 0, 120, '2026-06-11T10:00:00Z');
    expect(computeMetrics(h, '24h', 'hour', NOW).calibration).toEqual([]);
  });
});

describe('computeMetrics: exclude filter (repo toggles)', () => {
  it('drops excluded repos from every panel', () => {
    h.recordRunnerWait('acme/kept', 'build', 'pull_request', 10, '2026-06-11T10:05:00Z');
    h.recordRunnerWait('acme/dropped', 'build', 'pull_request', 10, '2026-06-11T10:05:00Z');
    h.recordCheckDuration('acme/dropped', 'Build', 'pull_request',
      '2026-06-11T10:00:00Z', '2026-06-11T10:05:00Z', 'SUCCESS');
    h.upsertMergedPr({ repo: 'acme/dropped', number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-11T10:00:00Z', mergeCommitSha: null, createdAt: null });
    h.recordStateSample('acme/dropped', '2026-06-11T10:00:00Z', { open: 1, ci: 0, queue: 0, failed: 0 });
    h.recordEtaAccuracy('acme/kept', 'ci', 100, 120, '2026-06-11T10:00:00Z');
    h.recordEtaAccuracy('acme/dropped', 'ci', 100, 120, '2026-06-11T10:00:00Z');

    const m = computeMetrics(h, '24h', 'hour', NOW, ['acme/dropped']);
    const repos = [
      ...m.runnerWaits.map((r) => r.repo),
      ...m.queue.map((r) => r.repo),
      ...m.slowestJobs.map((r) => r.repo),
      ...m.velocity.map((r) => r.repo),
      ...m.trends.map((r) => r.repo),
      ...m.calibration.map((r) => r.repo),
      ...m.leadTime.map((r) => r.repo),
    ];
    expect(repos).toContain('acme/kept');
    expect(repos).not.toContain('acme/dropped');
  });
});

describe('computeMetrics: lead-time decomposition (issue #44)', () => {
  /** Full-pipeline row: created 09:00 → green 10:00 → enqueued 11:00 →
   *  merged 11:20 → qa 11:30 → prod 18:00 (same day, inside the 24h window).
   *  Pass null in `over` to drop a timestamp. */
  type Over = Partial<Record<'createdAt' | 'firstGreenAt' | 'enqueuedAt'
    | 'qaLiveAt' | 'prodLiveAt', string | null>>;
  const fullRow = (number: number, over: Over = {}) => {
    h.upsertMergedPr({ repo: REPO, number, title: 't', url: 'u',
      mergedAt: '2026-06-11T11:20:00Z', mergeCommitSha: 'sha',
      createdAt: over.createdAt !== undefined ? over.createdAt : '2026-06-11T09:00:00Z',
      firstGreenAt: over.firstGreenAt !== undefined ? over.firstGreenAt : '2026-06-11T10:00:00Z',
      enqueuedAt: over.enqueuedAt !== undefined ? over.enqueuedAt : '2026-06-11T11:00:00Z' });
    const qa = over.qaLiveAt !== undefined ? over.qaLiveAt : '2026-06-11T11:30:00Z';
    if (qa != null) h.markEnvLive(REPO, number, 'qa', qa);
    const prod = over.prodLiveAt !== undefined ? over.prodLiveAt : '2026-06-11T18:00:00Z';
    if (prod != null) h.markEnvLive(REPO, number, 'prod', prod);
  };

  const seg = (m: ReturnType<typeof computeMetrics>, id: string) =>
    m.leadTime.find((r) => r.repo === REPO)!.segments.find((s) => s.id === id)!;

  it('computes all five segment medians + total over full-pipeline rows', () => {
    fullRow(1);
    const m = computeMetrics(h, '24h', 'hour', NOW);
    expect(seg(m, 'toFirstGreen')).toEqual({ id: 'toFirstGreen', medianSecs: 3600, n: 1 });
    expect(seg(m, 'greenToEnqueued')).toEqual({ id: 'greenToEnqueued', medianSecs: 3600, n: 1 });
    expect(seg(m, 'queue')).toEqual({ id: 'queue', medianSecs: 1200, n: 1 });
    expect(seg(m, 'qaDeploy')).toEqual({ id: 'qaDeploy', medianSecs: 600, n: 1 });
    expect(seg(m, 'awaitingProd')).toEqual({ id: 'awaitingProd', medianSecs: 6.5 * 3600, n: 1 });
    const repo = m.leadTime.find((r) => r.repo === REPO)!;
    expect(repo.totalP50Secs).toBe(9 * 3600); // created 09:00 → prod 18:00
    expect(repo.totalN).toBe(1);
    expect(repo.prodDeploys).toBe(1);
    expect(repo.deploysPerDay).toBe(1); // 1 prod-live event / 1-day window
    // segment order is the fixed pipeline order
    expect(repo.segments.map((s) => s.id)).toEqual(
      ['toFirstGreen', 'greenToEnqueued', 'queue', 'qaDeploy', 'awaitingProd']);
  });

  it('missing pairs: a row contributes only to segments whose BOTH ends exist', () => {
    // historical row: merged→qa→prod known, first_green/enqueued null
    h.upsertMergedPr({ repo: REPO, number: 2, title: 't', url: 'u',
      mergedAt: '2026-06-11T11:20:00Z', mergeCommitSha: 'sha',
      createdAt: '2026-06-11T09:00:00Z' });
    h.markEnvLive(REPO, 2, 'qa', '2026-06-11T11:30:00Z');
    h.markEnvLive(REPO, 2, 'prod', '2026-06-11T18:00:00Z');
    const m = computeMetrics(h, '24h', 'hour', NOW);
    expect(seg(m, 'toFirstGreen')).toEqual({ id: 'toFirstGreen', medianSecs: null, n: 0 });
    expect(seg(m, 'greenToEnqueued')).toEqual({ id: 'greenToEnqueued', medianSecs: null, n: 0 });
    expect(seg(m, 'queue')).toEqual({ id: 'queue', medianSecs: null, n: 0 });
    expect(seg(m, 'qaDeploy')).toEqual({ id: 'qaDeploy', medianSecs: 600, n: 1 });
    expect(seg(m, 'awaitingProd').n).toBe(1);
    expect(m.leadTime.find((r) => r.repo === REPO)!.totalP50Secs).toBe(9 * 3600);
  });

  it('per-segment medians over multiple rows report per-segment n', () => {
    fullRow(1);
    fullRow(3, { firstGreenAt: null }); // no green → toFirstGreen/greenToEnqueued skip this row
    const m = computeMetrics(h, '24h', 'hour', NOW);
    expect(seg(m, 'toFirstGreen').n).toBe(1);
    expect(seg(m, 'queue').n).toBe(2);
    expect(seg(m, 'queue').medianSecs).toBe(1200);
  });

  it('rows merged before the window are excluded from segments but their in-window prod-live still counts toward deploysPerDay', () => {
    h.upsertMergedPr({ repo: REPO, number: 4, title: 't', url: 'u',
      mergedAt: '2026-06-01T12:00:00Z', mergeCommitSha: 'sha',
      createdAt: '2026-06-01T09:00:00Z' });
    h.markEnvLive(REPO, 4, 'qa', '2026-06-01T12:10:00Z');
    h.markEnvLive(REPO, 4, 'prod', '2026-06-11T10:00:00Z'); // prod-live inside the 24h window
    const m = computeMetrics(h, '24h', 'hour', NOW);
    const repo = m.leadTime.find((r) => r.repo === REPO)!;
    expect(repo.segments.every((s) => s.n === 0)).toBe(true); // merged outside window
    expect(repo.prodDeploys).toBe(1);
    expect(repo.deploysPerDay).toBe(1);
    expect(repo.totalN).toBe(0);
  });

  it('rows not yet prod-live do not count toward deploysPerDay', () => {
    fullRow(1);                                       // prod-live → counts
    fullRow(5, { qaLiveAt: '2026-06-11T11:30:00Z', prodLiveAt: null }); // awaiting prod
    const m = computeMetrics(h, '24h', 'hour', NOW);
    const repo = m.leadTime.find((r) => r.repo === REPO)!;
    expect(repo.prodDeploys).toBe(1);
    expect(seg(m, 'qaDeploy').n).toBe(2);             // both rows have merged→qa
    expect(seg(m, 'awaitingProd').n).toBe(1);         // only the shipped one
    expect(repo.totalN).toBe(1);
  });

  it('negative pairs (clock artifacts) are skipped, not fabricated', () => {
    fullRow(1, { firstGreenAt: '2026-06-11T08:00:00Z' }); // green before created → skip
    const m = computeMetrics(h, '24h', 'hour', NOW);
    expect(seg(m, 'toFirstGreen')).toEqual({ id: 'toFirstGreen', medianSecs: null, n: 0 });
    expect(seg(m, 'greenToEnqueued').n).toBe(1); // green → enqueued is still a valid pair
  });

  it('repos with no in-window rows are omitted entirely', () => {
    h.upsertMergedPr({ repo: 'acme/stale', number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-01T12:00:00Z', mergeCommitSha: null });
    expect(computeMetrics(h, '24h', 'hour', NOW).leadTime).toEqual([]);
  });
});

describe('computeMetrics: flakiness (issue #37)', () => {
  /** One sha+attempt-aware check_durations row, 60s duration. */
  const row = (conclusion: string, sha: string, attempt: number, completedAt: string,
    name = 'e2e', event = 'merge_group', repo = REPO) =>
    h.recordCheckDuration(repo, name, event,
      new Date(Date.parse(completedAt) - 60_000).toISOString(), completedAt,
      conclusion, sha, attempt);

  /** Seed `n` clean runs + `flakes` fail→pass pairs for one check. */
  const seed = (name: string, flakes: number, cleanRuns: number, repo = REPO) => {
    for (let i = 0; i < flakes; i++) {
      row('FAILURE', `f${i}`, 1, `2026-06-11T0${i}:00:00Z`, name, 'merge_group', repo);
      row('SUCCESS', `f${i}`, 2, `2026-06-11T0${i}:20:00Z`, name, 'merge_group', repo);
    }
    for (let i = 0; i < cleanRuns; i++) {
      row('SUCCESS', `c${i}`, 1, `2026-06-11T1${i}:00:00Z`, name, 'merge_group', repo);
    }
  };

  it('reports per-check flake events, runs, rate, and per-bucket trend', () => {
    seed('e2e', 2, 6); // 2 flakes / 10 runs = 20%
    const f = computeMetrics(h, '24h', 'hour', NOW).flakiness;
    expect(f).toHaveLength(1);
    expect(f[0]!.repo).toBe(REPO);
    const c = f[0]!.checks[0]!;
    expect(c).toMatchObject({ name: 'e2e', event: 'merge_group',
      flakeEvents: 2, totalRuns: 10, flakeRatePct: 20 });
    // trend buckets: every bucket with runs; flake counts joined in
    expect(c.trend).toContainEqual({ bucket: '2026-06-11T00', flakeEvents: 1, runs: 2 });
    expect(c.trend).toContainEqual({ bucket: '2026-06-11T10', flakeEvents: 0, runs: 1 });
  });

  it('min-runs threshold: checks with under 5 runs are excluded', () => {
    seed('thin', 1, 2); // 4 runs total — below the floor
    seed('thick', 1, 3); // 5 runs — at the floor
    const checks = computeMetrics(h, '24h', 'hour', NOW).flakiness[0]!.checks;
    expect(checks.map((c) => c.name)).toEqual(['thick']);
  });

  it('never-flaky checks are excluded; ordering is by flake rate desc', () => {
    seed('steady', 0, 8);
    seed('worst', 3, 3); // 50%
    seed('mild', 1, 8);  // 10%
    const checks = computeMetrics(h, '24h', 'hour', NOW).flakiness[0]!.checks;
    expect(checks.map((c) => c.name)).toEqual(['worst', 'mild']);
  });

  it('window-scoped and exclude-filtered like every section', () => {
    seed('e2e', 1, 5);
    seed('other', 1, 5, 'acme/dropped');
    // outside the 24h window entirely
    row('FAILURE', 'old', 1, '2026-06-01T10:00:00Z', 'ancient');
    row('SUCCESS', 'old', 2, '2026-06-01T10:20:00Z', 'ancient');
    const f = computeMetrics(h, '24h', 'hour', NOW, ['acme/dropped']).flakiness;
    expect(f.map((r) => r.repo)).toEqual([REPO]);
    expect(f[0]!.checks.map((c) => c.name)).toEqual(['e2e']);
  });
});

describe('computeMetrics: train killers (issue #38)', () => {
  it('ranks checks by ejects; cost = ejects × median group run × batchSize in hours', () => {
    h.recordGroupFailure(REPO, 'e2e', 'oid1', '2026-06-11T08:00:00Z');
    h.recordGroupFailure(REPO, 'e2e', 'oid2', '2026-06-11T09:00:00Z');
    h.recordGroupFailure(REPO, 'unit', 'oid3', '2026-06-11T10:00:00Z');
    h.recordGroupRun(REPO, 1800, '2026-06-11T07:00:00Z'); // median group run 30m
    const tk = computeMetrics(h, '24h', 'hour', NOW, [], () => 6).trainKillers;
    expect(tk).toHaveLength(1);
    expect(tk[0]!).toMatchObject({ repo: REPO, batchSize: 6, medianGroupRunSecs: 1800 });
    expect(tk[0]!.checks).toEqual([
      // 2 ejects × 1800s × 6 = 21600s = 6h
      { name: 'e2e', ejects: 2, estCostTrainHours: 6, flakeRatePct: null },
      { name: 'unit', ejects: 1, estCostTrainHours: 3, flakeRatePct: null },
    ]);
  });

  it('estCostTrainHours is null without an observed group-run median; batchSize defaults to 1', () => {
    h.recordGroupFailure(REPO, 'e2e', 'oid1', '2026-06-11T08:00:00Z');
    const tk = computeMetrics(h, '24h', 'hour', NOW).trainKillers[0]!;
    expect(tk.batchSize).toBe(1);
    expect(tk.medianGroupRunSecs).toBeNull();
    expect(tk.checks[0]!.estCostTrainHours).toBeNull();
  });

  it('cross-references the flake rate for the same check name (killer AND flaky)', () => {
    // 'e2e' flakes 25% (1 flake / 4 runs is under min-runs → seed 5 runs: 1/5 = 20%)
    for (let i = 0; i < 4; i++) {
      h.recordCheckDuration(REPO, 'e2e', 'merge_group',
        `2026-06-11T0${i}:00:00Z`, `2026-06-11T0${i}:01:00Z`, 'SUCCESS', `sha${i}`, 1);
    }
    h.recordCheckDuration(REPO, 'e2e', 'merge_group',
      '2026-06-11T05:00:00Z', '2026-06-11T05:01:00Z', 'FAILURE', 'shaF', 1);
    h.recordCheckDuration(REPO, 'e2e', 'merge_group',
      '2026-06-11T05:20:00Z', '2026-06-11T05:21:00Z', 'SUCCESS', 'shaF', 2);
    h.recordGroupFailure(REPO, 'e2e', 'oid1', '2026-06-11T08:00:00Z');
    h.recordGroupFailure(REPO, 'never-flaky', 'oid2', '2026-06-11T09:00:00Z');
    const checks = computeMetrics(h, '24h', 'hour', NOW).trainKillers[0]!.checks;
    const e2e = checks.find((c) => c.name === 'e2e')!;
    expect(e2e.flakeRatePct).toBeCloseTo((1 / 6) * 100); // 1 flake / 6 distinct runs
    expect(checks.find((c) => c.name === 'never-flaky')!.flakeRatePct).toBeNull();
  });

  it('window-scoped and exclude-filtered', () => {
    h.recordGroupFailure(REPO, 'e2e', 'old', '2026-06-01T08:00:00Z'); // outside 24h
    h.recordGroupFailure('acme/dropped', 'e2e', 'oid1', '2026-06-11T08:00:00Z');
    h.recordGroupFailure(REPO, 'unit', 'oid2', '2026-06-11T09:00:00Z');
    const tk = computeMetrics(h, '24h', 'hour', NOW, ['acme/dropped']).trainKillers;
    expect(tk.map((r) => r.repo)).toEqual([REPO]);
    expect(tk[0]!.checks.map((c) => c.name)).toEqual(['unit']);
  });
});

// ---- critical path (#42) + workflow lint (#48 rule 1) ----------------------

import type { CiGraphNode } from '../required-checks';

const gnode = (needs: string[], opts: Partial<CiGraphNode> = {}): CiGraphNode =>
  ({ needs, activity: { mode: 'all' }, runsOn: null, timeoutMinutes: null, ...opts });

/** Seed `count` SUCCESS duration samples of `secs` for (name, event), spread
 *  over distinct timestamps near NOW (well inside the 14-day expectedSet window). */
function seedDurations(name: string, event: string, secs: number, count = 5,
  dayOffset = 0): void {
  for (let i = 0; i < count; i++) {
    const end = new Date(NOW.getTime() - dayOffset * 86400_000 - i * 3600_000);
    const start = new Date(end.getTime() - secs * 1000);
    h.recordCheckDuration(REPO, name, event, start.toISOString(), end.toISOString(), 'SUCCESS');
  }
}

function seedWaits(name: string, event: string, secs: number, count = 3): void {
  for (let i = 0; i < count; i++) {
    h.recordRunnerWait(REPO, name, event, secs,
      new Date(NOW.getTime() - i * 3600_000).toISOString());
  }
}

/** Diamond: ci ← {unit-tests, bats-tests} ← build; bats is merge_group-only. */
function diamondGraph(): Map<string, Map<string, CiGraphNode>> {
  return new Map([[REPO, new Map([
    ['build', gnode([], { timeoutMinutes: 1 })],
    ['unit-tests', gnode(['build'], { timeoutMinutes: 600 })],
    ['bats-tests', gnode(['build'], { activity: { mode: 'only', events: ['merge_group'] } })],
    ['ci', gnode(['build', 'unit-tests', 'bats-tests'])],
  ])]]);
}

function seedDiamond(): void {
  seedDurations('build', 'pull_request', 100);
  seedDurations('unit-tests', 'pull_request', 600);
  seedDurations('ci', 'pull_request', 10);
  seedWaits('build', 'pull_request', 20);
  seedWaits('unit-tests', 'pull_request', 30);
  seedWaits('ci', 'pull_request', 5);
  // merge_group: bats dominates; no waits recorded at all (wait reads as 0)
  seedDurations('build', 'merge_group', 100);
  seedDurations('unit-tests', 'merge_group', 200);
  seedDurations('bats-tests', 'merge_group', 900);
  seedDurations('ci', 'merge_group', 10);
}

describe('computeMetrics: critical path (issue #42)', () => {
  it('emits per repo×event static expected paths from last-N medians', () => {
    seedDiamond();
    const m = computeMetrics(h, '3d', 'hour', NOW, [], () => 1, diamondGraph());

    const pr = m.criticalPath.find((c) => c.event === 'pull_request')!;
    expect(pr.repo).toBe(REPO);
    // bats-tests is merge_group-only → excluded from the pull_request DAG entirely
    expect(pr.path.map((s) => s.name)).toEqual(['build', 'unit-tests', 'ci']);
    expect(pr.endToEndP50Secs).toBe(120 + 630 + 15); // (wait+dur) summed down the path
    expect(pr.path[1]).toEqual({ name: 'unit-tests', durationP50: 600, waitP50: 30 });
    expect(pr.offPath).toEqual([]);

    const mg = m.criticalPath.find((c) => c.event === 'merge_group')!;
    expect(mg.path.map((s) => s.name)).toEqual(['build', 'bats-tests', 'ci']);
    expect(mg.endToEndP50Secs).toBe(100 + 900 + 10); // no waits recorded → 0
    // unit-tests sits off-path with slack = 900 − 200
    expect(mg.offPath).toEqual([{ name: 'unit-tests', slackSecs: 700 }]);
  });

  it('matches check names to graph nodes by longest prefix (reusable-workflow inner checks)', () => {
    seedDurations('static-checks / TypeScript', 'pull_request', 300);
    seedDurations('static-checks / ESLint', 'pull_request', 500);
    seedDurations('ci', 'pull_request', 10);
    const graphs = new Map([[REPO, new Map([
      ['static-checks /', gnode([])],
      ['ci', gnode(['static-checks /'])],
    ])]]);
    const m = computeMetrics(h, '3d', 'hour', NOW, [], () => 1, graphs);
    const pr = m.criticalPath.find((c) => c.event === 'pull_request')!;
    // node duration = the slowest inner check (they run in parallel inside the call)
    expect(pr.path.map((s) => s.name)).toEqual(['static-checks /', 'ci']);
    expect(pr.path[0]!.durationP50).toBe(500);
    expect(pr.endToEndP50Secs).toBe(510);
  });

  it('ignores the metrics window selector (last-N medians, 14-day name discovery)', () => {
    // samples 3 days old, window 24h — the section must still populate
    seedDurations('build', 'pull_request', 100, 5, 3);
    seedDurations('ci', 'pull_request', 10, 5, 3);
    const graphs = new Map([[REPO, new Map([
      ['build', gnode([])], ['ci', gnode(['build'])],
    ])]]);
    const m = computeMetrics(h, '24h', 'hour', NOW, [], () => 1, graphs);
    expect(m.criticalPath.find((c) => c.event === 'pull_request')!.endToEndP50Secs).toBe(110);
  });

  it('omits repo×event entries with no observed durations and respects exclude', () => {
    const graphs = diamondGraph();
    // no history at all → no entries
    expect(computeMetrics(h, '3d', 'hour', NOW, [], () => 1, graphs).criticalPath).toEqual([]);
    seedDiamond();
    // excluded repo → no entries either
    expect(computeMetrics(h, '3d', 'hour', NOW, [REPO], () => 1, graphs).criticalPath).toEqual([]);
    // no graphs → empty section
    expect(computeMetrics(h, '3d', 'hour', NOW).criticalPath).toEqual([]);
  });

  it('caps offPath at the 10 lowest-slack jobs', () => {
    const nodes = new Map<string, CiGraphNode>([['long', gnode([])]]);
    seedDurations('long', 'pull_request', 10_000);
    const needs: string[] = ['long'];
    for (let i = 0; i < 12; i++) {
      const name = `par-${String(i).padStart(2, '0')}`;
      nodes.set(name, gnode([]));
      needs.push(name);
      seedDurations(name, 'pull_request', 100 + i);
    }
    nodes.set('ci', gnode(needs));
    seedDurations('ci', 'pull_request', 10);
    const m = computeMetrics(h, '3d', 'hour', NOW, [], () => 1, new Map([[REPO, nodes]]));
    const pr = m.criticalPath.find((c) => c.event === 'pull_request')!;
    expect(pr.offPath).toHaveLength(10);
    // lowest slack first = the SLOWEST parallel jobs (closest to mattering)
    expect(pr.offPath[0]!.name).toBe('par-11');
  });
});

describe('computeMetrics: workflow lint (issue #48 rule 1 — timeout calibration)', () => {
  it('flags timeout-vs-p99 misconfigurations per repo (warn under 1.2×, info over 10×)', () => {
    seedDiamond();
    const m = computeMetrics(h, '3d', 'hour', NOW, [], () => 1, diamondGraph());
    expect(m.lint).toHaveLength(1);
    const { repo, findings } = m.lint[0]!;
    expect(repo).toBe(REPO);
    // build: timeout 1m=60s < p99 100s × 1.2 → warn
    // unit-tests: timeout 600m=36000s > p99 600s × 10 → info
    // ci/bats: no explicit timeout, p99 far under the 360m default → nothing
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      rule: 'timeout', severity: 'warn', job: 'build', observed: 100, configured: 60 });
    expect(findings[1]).toMatchObject({
      rule: 'timeout', severity: 'info', job: 'unit-tests', observed: 600, configured: 36_000 });
  });

  it('requires ≥5 recent runs before linting a job (thin p99s are noise)', () => {
    const graphs = new Map([[REPO, new Map([
      ['build', gnode([], { timeoutMinutes: 1 })],
      ['ci', gnode(['build'])],
    ])]]);
    seedDurations('build', 'pull_request', 600, 4); // would warn, but only 4 runs
    seedDurations('ci', 'pull_request', 10, 5);
    expect(computeMetrics(h, '3d', 'hour', NOW, [], () => 1, graphs).lint).toEqual([]);
  });

  it('omits repos with no findings and respects exclude', () => {
    seedDiamond();
    expect(computeMetrics(h, '3d', 'hour', NOW, [REPO], () => 1, diamondGraph()).lint).toEqual([]);
    expect(computeMetrics(h, '3d', 'hour', NOW).lint).toEqual([]);
  });
});

describe('computeMetrics: live foreign-name exclusion (issue #61 follow-up)', () => {
  // `ci-gate` (Auto-merge PRs) startsWith-matches the `ci` node but mirrors the
  // whole CI lifecycle — hours-long SUCCESS spans BY DESIGN. History rows carry
  // no workflow identity, so the static×runtime joins take a live foreign-name
  // set (same pattern as the classify-layer expectedSet exclusion).
  const graphs = () => new Map([[REPO, new Map([
    ['build', gnode([])],
    ['ci', gnode(['build'], { timeoutMinutes: 15 })],
  ])]]);
  const seed = () => {
    seedDurations('build', 'pull_request', 100);
    seedDurations('ci', 'pull_request', 10);
    seedDurations('ci-gate', 'pull_request', 10_000);
  };

  it('excludes foreign names from the lint and critical-path joins', () => {
    seed();
    const foreign = new Map([[REPO, new Set(['ci-gate'])]]);
    const m = computeMetrics(h, '3d', 'hour', NOW, [], () => 1, graphs(), foreign);
    // ci p99 = 10s (its OWN samples, not ci-gate's) → the truthful too-loose INFO
    expect(m.lint[0]!.findings).toMatchObject([
      { rule: 'timeout', severity: 'info', job: 'ci', observed: 10 }]);
    const pr = m.criticalPath.find((c) => c.event === 'pull_request')!;
    expect(pr.path.find((s) => s.name === 'ci')!.durationP50).toBe(10);
  });

  it('regression guard: without the exclusion the foreign name poisons both joins', () => {
    seed();
    const m = computeMetrics(h, '3d', 'hour', NOW, [], () => 1, graphs());
    expect(m.lint[0]!.findings).toMatchObject([
      { rule: 'timeout', severity: 'warn', job: 'ci', observed: 10_000 }]);
    const pr = m.criticalPath.find((c) => c.event === 'pull_request')!;
    expect(pr.path.find((s) => s.name === 'ci')!.durationP50).toBe(10_000);
  });
});

describe('computeMetrics: duration regressions (issue #41)', () => {
  const REG = { check: 'build-test', event: 'merge_group', priorP50Secs: 240,
    recentP50Secs: 600, ratio: 2.5, sinceApprox: '2026-06-10T14:00:00Z' };

  it('passes the poller cache through per repo', () => {
    const m = computeMetrics(h, '3d', 'hour', NOW, [], () => 1, new Map(), new Map(),
      [{ repo: REPO, checks: [REG] }]);
    expect(m.regressions).toEqual([{ repo: REPO, checks: [REG] }]);
  });

  it('defaults to empty and applies the exclude list', () => {
    expect(computeMetrics(h, '3d', 'hour', NOW).regressions).toEqual([]);
    const m = computeMetrics(h, '3d', 'hour', NOW, [REPO], () => 1, new Map(), new Map(),
      [{ repo: REPO, checks: [REG] }, { repo: 'octo/gizmos', checks: [REG] }]);
    expect(m.regressions.map((r) => r.repo)).toEqual(['octo/gizmos']);
  });

  it('omits repos with no active regressions', () => {
    const m = computeMetrics(h, '3d', 'hour', NOW, [], () => 1, new Map(), new Map(),
      [{ repo: REPO, checks: [] }]);
    expect(m.regressions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fleet telemetry: runner pools (#45), spot reclaims (#46), concurrency (#47)
// ---------------------------------------------------------------------------

describe('computeMetrics: runner pools (issue #45)', () => {
  it('buckets pool-labeled waits per repo×pool with p50/p90 + headline delta', () => {
    // current window (24h): pool p1 waits 30/60; previous window: 10
    h.recordRunnerWait(REPO, 'a', 'pull_request', 30, '2026-06-11T10:00:00Z', 'p1');
    h.recordRunnerWait(REPO, 'b', 'merge_group', 60, '2026-06-11T10:30:00Z', 'p1');
    h.recordRunnerWait(REPO, 'c', 'pull_request', 10, '2026-06-10T06:00:00Z', 'p1'); // prev window
    h.recordRunnerWait(REPO, 'd', 'pull_request', 400, '2026-06-11T11:00:00Z', 'p2');
    h.recordRunnerWait(REPO, 'legacy', 'pull_request', 999, '2026-06-11T11:00:00Z'); // no pool
    const m = computeMetrics(h, '24h', 'hour', NOW);
    expect(m.runnerPools.map((r) => [r.repo, r.pool])).toEqual([
      [REPO, 'p1'], [REPO, 'p2']]);
    const p1 = m.runnerPools[0]!;
    expect(p1.p50.value).toBe(30);  // nearest-rank p50 of [30, 60]
    expect(p1.p50.prev).toBe(10);
    expect(p1.buckets.map((b) => b.bucket)).toEqual(['2026-06-11T10']);
    expect(p1.buckets[0]!.n).toBe(2);
    // the event-keyed section keeps the unlabeled sample — both views coexist
    expect(m.runnerWaits.some((rw) => rw.event === 'pull_request')).toBe(true);
  });

  it('joins the live pool-health snapshot (current p90 vs baseline + starving)', () => {
    h.recordRunnerWait(REPO, 'a', 'pull_request', 30, '2026-06-11T10:00:00Z', 'p1');
    const m = computeMetrics(h, '24h', 'hour', NOW, [], () => 1, new Map(), new Map(), [],
      () => null,
      [{ repo: REPO, pools: [{ pool: 'p1', lastHourP90Secs: 1500,
        baselineP90Secs: 60, n: 8, starving: true }] }]);
    expect(m.runnerPools[0]).toMatchObject({
      pool: 'p1', lastHourP90Secs: 1500, baselineP90Secs: 60, starving: true });
  });

  it('pools without a health snapshot carry nulls + starving:false', () => {
    h.recordRunnerWait(REPO, 'a', 'pull_request', 30, '2026-06-11T10:00:00Z', 'p1');
    const m = computeMetrics(h, '24h', 'hour', NOW);
    expect(m.runnerPools[0]).toMatchObject({
      lastHourP90Secs: null, baselineP90Secs: null, starving: false });
  });

  it('exclude filter applies', () => {
    h.recordRunnerWait(REPO, 'a', 'pull_request', 30, '2026-06-11T10:00:00Z', 'p1');
    expect(computeMetrics(h, '24h', 'hour', NOW, [REPO]).runnerPools).toEqual([]);
  });
});

describe('computeMetrics: spot reclaims (issue #46)', () => {
  const seedReclaim = (name: string, cancelledAt: string, sha = 'shaR') => {
    h.recordCheckDuration(REPO, name, 'merge_group',
      new Date(Date.parse(cancelledAt) - 60_000).toISOString(), cancelledAt,
      'CANCELLED', sha, 1);
    const okAt = new Date(Date.parse(cancelledAt) + 20 * 60_000).toISOString();
    h.recordCheckDuration(REPO, name, 'merge_group',
      new Date(Date.parse(okAt) - 60_000).toISOString(), okAt, 'SUCCESS', sha, 2);
  };

  it('counts events per bucket and splits by pool via poolsFor', () => {
    seedReclaim('e2e', '2026-06-11T09:10:00Z');
    seedReclaim('e2e', '2026-06-11T10:10:00Z', 'shaR2');
    seedReclaim('mystery-job', '2026-06-11T10:20:00Z', 'shaR3');
    const poolsFor = (_repo: string, name: string): string[] | null =>
      name === 'e2e' ? ['kindash-runner', 'kindash-ondemand'] : null;
    const m = computeMetrics(h, '24h', 'hour', NOW, [], () => 1, new Map(), new Map(), [],
      poolsFor);
    expect(m.reclaims).toHaveLength(1);
    const r = m.reclaims[0]!;
    expect(r.repo).toBe(REPO);
    expect(r.total).toBe(3);
    expect(r.perBucket).toEqual([
      { bucket: '2026-06-11T09', count: 1 }, { bucket: '2026-06-11T10', count: 2 }]);
    // ternary candidates joined; unmappable jobs land in 'unknown'
    expect(r.byPool).toEqual([
      { pool: 'kindash-runner|kindash-ondemand', count: 2 }, { pool: 'unknown', count: 1 }]);
  });

  it('a FAILURE→SUCCESS pair (a flake) produces no reclaim entry', () => {
    h.recordCheckDuration(REPO, 'flaky', 'merge_group',
      '2026-06-11T09:00:00Z', '2026-06-11T09:10:00Z', 'FAILURE', 'shaF', 1);
    h.recordCheckDuration(REPO, 'flaky', 'merge_group',
      '2026-06-11T09:20:00Z', '2026-06-11T09:30:00Z', 'SUCCESS', 'shaF', 2);
    expect(computeMetrics(h, '24h', 'hour', NOW).reclaims).toEqual([]);
  });

  it('exclude filter applies', () => {
    seedReclaim('e2e', '2026-06-11T09:10:00Z');
    expect(computeMetrics(h, '24h', 'hour', NOW, [REPO]).reclaims).toEqual([]);
  });
});

describe('sweepBucketPeaks (issue #47 — the sweep-line math)', () => {
  const T = (hhmm: string): number => Date.parse(`2026-06-11T${hhmm}:00Z`);
  const WIN = [T('00:00'), T('12:00')] as const;

  it('overlapping intervals raise the peak; disjoint ones do not', () => {
    const out = sweepBucketPeaks([
      { startMs: T('09:00'), endMs: T('09:30') },
      { startMs: T('09:10'), endMs: T('09:40') },  // overlaps the first → 2
      { startMs: T('09:50'), endMs: T('09:55') },  // disjoint → still 2 max
    ], WIN[0], WIN[1], 'hour');
    expect(out).toEqual([{ bucket: '2026-06-11T09', peak: 2 }]);
  });

  it('back-to-back intervals (end == start) are NOT concurrent', () => {
    const out = sweepBucketPeaks([
      { startMs: T('09:00'), endMs: T('09:30') },
      { startMs: T('09:30'), endMs: T('10:00') },
    ], WIN[0], WIN[1], 'hour');
    expect(out).toEqual([{ bucket: '2026-06-11T09', peak: 1 }]);
  });

  it('a long interval carries its level into buckets with no events', () => {
    const out = sweepBucketPeaks([
      { startMs: T('08:30'), endMs: T('11:30') }, // spans 09 and 10 without events
    ], WIN[0], WIN[1], 'hour');
    expect(out).toEqual([
      { bucket: '2026-06-11T08', peak: 1 }, { bucket: '2026-06-11T09', peak: 1 },
      { bucket: '2026-06-11T10', peak: 1 }, { bucket: '2026-06-11T11', peak: 1 }]);
  });

  it('per-bucket PEAK, not closing value: a burst inside the hour wins', () => {
    const out = sweepBucketPeaks([
      { startMs: T('09:00'), endMs: T('09:10') },
      { startMs: T('09:05'), endMs: T('09:10') },
      { startMs: T('09:05'), endMs: T('09:10') },  // 3 concurrent 09:05–09:10
      { startMs: T('09:50'), endMs: T('09:59') },  // hour closes at 1
    ], WIN[0], WIN[1], 'hour');
    expect(out).toEqual([{ bucket: '2026-06-11T09', peak: 3 }]);
  });

  it('intervals are clipped to the window (no buckets before since / after now)', () => {
    const out = sweepBucketPeaks([
      { startMs: T('00:00') - 3 * 3600_000, endMs: T('01:30') }, // started pre-window
    ], WIN[0], WIN[1], 'hour');
    expect(out).toEqual([
      { bucket: '2026-06-11T00', peak: 1 }, { bucket: '2026-06-11T01', peak: 1 }]);
  });

  it('day buckets aggregate the same way', () => {
    const out = sweepBucketPeaks([
      { startMs: Date.parse('2026-06-10T23:00:00Z'), endMs: Date.parse('2026-06-11T01:00:00Z') },
      { startMs: Date.parse('2026-06-10T23:30:00Z'), endMs: Date.parse('2026-06-10T23:45:00Z') },
    ], Date.parse('2026-06-09T12:00:00Z'), Date.parse('2026-06-11T12:00:00Z'), 'day');
    expect(out).toEqual([
      { bucket: '2026-06-10', peak: 2 }, { bucket: '2026-06-11', peak: 1 }]);
  });

  it('degenerate/inverted intervals are dropped', () => {
    expect(sweepBucketPeaks([
      { startMs: T('09:00'), endMs: T('09:00') },
      { startMs: T('10:00'), endMs: T('09:00') },
      { startMs: NaN, endMs: T('09:00') },
    ], WIN[0], WIN[1], 'hour')).toEqual([]);
  });
});

describe('computeMetrics: concurrency demand (issue #47)', () => {
  it('sweeps stored intervals per repo×pool (unknown pool grouped separately)', () => {
    // two overlapping pool-p1 jobs + one unmappable job
    h.recordCheckDuration(REPO, 'unit', 'pull_request',
      '2026-06-11T09:00:00Z', '2026-06-11T09:30:00Z', 'SUCCESS', 'sha1', 1);
    h.recordCheckDuration(REPO, 'e2e', 'pull_request',
      '2026-06-11T09:10:00Z', '2026-06-11T09:40:00Z', 'CANCELLED', 'sha1', 1); // counts too
    h.recordCheckDuration(REPO, 'mystery', 'pull_request',
      '2026-06-11T09:00:00Z', '2026-06-11T09:05:00Z', 'SUCCESS', 'sha1', 1);
    const poolsFor = (_repo: string, name: string): string[] | null =>
      name === 'mystery' ? null : ['p1'];
    const m = computeMetrics(h, '24h', 'hour', NOW, [], () => 1, new Map(), new Map(), [],
      poolsFor);
    expect(m.concurrency.map((c) => [c.pool, c.peak])).toEqual([
      ['p1', 2], ['unknown', 1]]);
    const p1 = m.concurrency.find((c) => c.pool === 'p1')!;
    expect(p1.buckets).toEqual([{ bucket: '2026-06-11T09', peak: 2 }]);
  });

  it('exclude filter applies', () => {
    h.recordCheckDuration(REPO, 'unit', 'pull_request',
      '2026-06-11T09:00:00Z', '2026-06-11T09:30:00Z', 'SUCCESS');
    expect(computeMetrics(h, '24h', 'hour', NOW, [REPO]).concurrency).toEqual([]);
  });
});
