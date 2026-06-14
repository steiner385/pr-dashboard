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
      runnerWaits: [], queue: [], queueEfficiency: [], slowestJobs: [], velocity: [],
      leadTime: [], trends: [],
      calibration: [], flakiness: [], trainKillers: [], criticalPath: [], lint: [],
      regressions: [], runnerPools: [], reclaims: [], concurrency: [], cost: [],
      costJobs: [], costRuns: [], costActuals: [], costAutoRate: null,
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
    const poolsFor = (_repo: string, name: string, _event: string) =>
      name === 'e2e' ? { pool: 'kindash-runner|kindash-ondemand', githubHosted: false } : null;
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
    const poolsFor = (_repo: string, name: string, _event: string) =>
      name === 'mystery' ? null : { pool: 'p1', githubHosted: false };
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

// ---- CI cost attribution (issue #43) ----------------------------------------

describe('computeMetrics: CI cost attribution (issue #43)', () => {
  /** unit-tests/build → spot; e2e → a runs-on ternary (composite pool);
   *  mystery → unmappable (null). */
  const poolsFor = (_repo: string, name: string, _event: string) =>
    name.startsWith('e2e') ? { pool: 'spot|ondemand', githubHosted: false }
      : name === 'mystery' ? null
        : { pool: 'spot', githubHosted: false };

  const costMetrics = (cpm: Record<string, number> | null = null,
    exclude: string[] = [], window: '24h' | '3d' = '24h') =>
    computeMetrics(h, window, 'hour', NOW, exclude, () => 1, new Map(), new Map(),
      [], poolsFor, [], cpm).cost;

  /** One job run: started at `startISO`, ran `secs`, any conclusion counts. */
  const job = (name: string, startISO: string, secs: number,
    attempt: number | null = 1, conclusion = 'SUCCESS'): void => {
    const start = new Date(startISO);
    const end = new Date(start.getTime() + secs * 1000);
    h.recordCheckDuration(REPO, name, 'pull_request', start.toISOString(),
      end.toISOString(), conclusion, 'sha-cost', attempt);
  };

  it('buckets runner-minutes by pool from started_at→duration; composite and unknown pools attribute honestly', () => {
    job('unit-tests', '2026-06-11T10:05:00Z', 300);       // spot, 5 min
    job('build', '2026-06-11T11:05:00Z', 300);            // spot, 5 min
    job('e2e shard 1', '2026-06-11T10:10:00Z', 120);      // spot|ondemand, 2 min
    job('mystery', '2026-06-11T10:15:00Z', 60);           // unknown, 1 min
    const [c] = costMetrics();
    expect(c!.repo).toBe(REPO);
    expect(c!.totalMinutes).toBeCloseTo(13);
    // pools sorted by minutes desc
    expect(c!.pools.map((p) => [p.pool, p.minutes])).toEqual([
      ['spot', 10], ['spot|ondemand', 2], ['unknown', 1]]);
    expect(c!.pools[0]!.buckets).toEqual([
      { bucket: '2026-06-11T10', minutes: 5 },
      { bucket: '2026-06-11T11', minutes: 5 }]);
  });

  it('every conclusion counts — a cancelled job burned its runner-minutes too', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600, 1, 'CANCELLED');
    const [c] = costMetrics();
    expect(c!.totalMinutes).toBeCloseTo(10);
  });

  it('without a costPerMinute map: minutes report, every dollar figure is null', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);
    job('unit-tests', '2026-06-11T10:20:00Z', 600, 2); // retry
    const [c] = costMetrics(null);
    expect(c!.totalMinutes).toBeCloseTo(20);
    expect(c!.totalDollars).toBeNull();
    expect(c!.retryDollars).toBeNull();
    expect(c!.pools.every((p) => p.dollars === null)).toBe(true);
  });

  it('maps minutes to dollars per pool; composite/unknown labels fall back to the default key', () => {
    job('unit-tests', '2026-06-11T10:05:00Z', 600);   // spot: 10 min × 0.01 = $0.10
    job('e2e shard 1', '2026-06-11T10:10:00Z', 300);  // spot|ondemand → default: 5 × 0.02
    job('mystery', '2026-06-11T10:15:00Z', 300);      // unknown → default: 5 × 0.02
    const [c] = costMetrics({ spot: 0.01, default: 0.02 });
    expect(c!.pools.find((p) => p.pool === 'spot')!.dollars).toBeCloseTo(0.1);
    expect(c!.pools.find((p) => p.pool === 'spot|ondemand')!.dollars).toBeCloseTo(0.1);
    expect(c!.pools.find((p) => p.pool === 'unknown')!.dollars).toBeCloseTo(0.1);
    expect(c!.totalDollars).toBeCloseTo(0.3);
  });

  it('a pool with no rate and no default carries null dollars and stays out of the $ total', () => {
    job('unit-tests', '2026-06-11T10:05:00Z', 600);   // spot priced
    job('mystery', '2026-06-11T10:15:00Z', 300);      // unknown, unpriced
    const [c] = costMetrics({ spot: 0.01 });
    expect(c!.pools.find((p) => p.pool === 'unknown')!.dollars).toBeNull();
    expect(c!.totalDollars).toBeCloseTo(0.1); // priced pools only — documented undercount
  });

  it('retry burden: minutes (and $) on run_attempt > 1 samples only', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600, 1);
    job('unit-tests', '2026-06-11T10:20:00Z', 300, 2);  // re-run
    job('build', '2026-06-11T10:30:00Z', 300, 3);       // re-run of a re-run
    job('mystery', '2026-06-11T10:40:00Z', 300, null);  // attempt unknown — not a retry
    const [c] = costMetrics({ default: 0.01 });
    expect(c!.retryMinutes).toBeCloseTo(10);
    expect(c!.retryDollars).toBeCloseTo(0.1);
    expect(c!.totalMinutes).toBeCloseTo(25);
  });

  it('minutes per merged PR divides by window merges; null at zero merges', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);
    expect(costMetrics()[0]!.minutesPerMergedPr).toBeNull();
    h.upsertMergedPr({ repo: REPO, number: 1, title: 'a', url: 'u',
      mergedAt: '2026-06-11T10:30:00Z', mergeCommitSha: 'm1' });
    h.upsertMergedPr({ repo: REPO, number: 2, title: 'b', url: 'u',
      mergedAt: '2026-06-11T11:00:00Z', mergeCommitSha: 'm2' });
    const [c] = costMetrics();
    expect(c!.mergesInWindow).toBe(2);
    expect(c!.minutesPerMergedPr).toBeCloseTo(5);
  });

  it('respects exclude and the window (started_at must be in-window); empty repos omitted', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);
    job('unit-tests', '2026-06-09T10:00:00Z', 600);     // outside 24h window
    expect(costMetrics(null, [REPO])).toEqual([]);
    const [c] = costMetrics();
    expect(c!.totalMinutes).toBeCloseTo(10);            // old row not counted
    expect(costMetrics(null, [], '3d')[0]!.totalMinutes).toBeCloseTo(20);
    // no rows at all → section empty
    expect(computeMetrics(new HistoryStore(':memory:'), '24h', 'hour', NOW).cost).toEqual([]);
  });

  it('excludes live foreign names — their spans are CI-lifecycle wall-clock, not runner time', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 300);
    job('ci-gate', '2026-06-11T10:00:00Z', 9000); // foreign rollup mirror (issue #61)
    const m = computeMetrics(h, '24h', 'hour', NOW, [], () => 1, new Map(),
      new Map([[REPO, new Set(['ci-gate'])]]), [], poolsFor, [], null);
    expect(m.cost[0]!.totalMinutes).toBeCloseTo(5);
  });
});

// ---- Cost explorer: per-job / per-run cost + poolMeta (instance type, rates) --

describe('computeMetrics: cost explorer (per-job, per-run, poolMeta)', () => {
  /** unit-tests/build → spot; e2e → composite ternary; mystery → unmappable. */
  const poolsFor = (_repo: string, name: string, _event: string) =>
    name.startsWith('e2e') ? { pool: 'spot|ondemand', githubHosted: false }
      : name === 'mystery' ? null
        : { pool: 'spot', githubHosted: false };

  const explorer = (opts: {
    cpm?: Record<string, number> | null;
    poolMeta?: Parameters<typeof computeMetrics>[12];
    prNumberForSha?: (repo: string, sha: string) => number | null;
  } = {}) =>
    computeMetrics(h, '24h', 'hour', NOW, [], () => 1, new Map(), new Map(),
      [], poolsFor, [], opts.cpm ?? null, opts.poolMeta ?? null,
      opts.prNumberForSha ?? (() => null));

  /** One job row with full run identity (sha + run number). */
  const runJob = (name: string, startISO: string, secs: number,
    sha: string | null, runNumber: number | null, event = 'pull_request',
    attempt: number | null = 1): void => {
    const start = new Date(startISO);
    const end = new Date(start.getTime() + secs * 1000);
    h.recordCheckDuration(REPO, name, event, start.toISOString(),
      end.toISOString(), 'SUCCESS', sha, attempt, runNumber);
  };

  it('costJobs: groups by (name, event), sums minutes, counts samples, sorts by minutes desc', () => {
    runJob('unit-tests', '2026-06-11T10:00:00Z', 300, 'sha1', 1);
    runJob('unit-tests', '2026-06-11T10:30:00Z', 300, 'sha2', 2);
    runJob('unit-tests', '2026-06-11T10:40:00Z', 60, 'sha2', 3, 'merge_group');
    runJob('build', '2026-06-11T11:00:00Z', 1200, 'sha1', 1);
    const [cj] = explorer().costJobs;
    expect(cj!.repo).toBe(REPO);
    expect(cj!.jobs).toEqual([
      { name: 'build', event: 'pull_request', minutes: 20, dollars: null,
        pool: 'spot', samples: 1 },
      { name: 'unit-tests', event: 'pull_request', minutes: 10, dollars: null,
        pool: 'spot', samples: 2 },
      { name: 'unit-tests', event: 'merge_group', minutes: 1, dollars: null,
        pool: 'spot', samples: 1 },
    ]);
  });

  it('costJobs: rate precedence poolMeta > costPerMinute > default; unpriced pool → null dollars', () => {
    runJob('unit-tests', '2026-06-11T10:00:00Z', 600, 'sha1', 1);  // spot, 10 min
    runJob('e2e', '2026-06-11T10:10:00Z', 600, 'sha1', 1);          // spot|ondemand → default
    runJob('mystery', '2026-06-11T10:20:00Z', 600, 'sha1', 1);      // unknown
    const [cj] = explorer({
      cpm: { spot: 0.01 },                                          // superseded for spot
      poolMeta: { spot: { dollarsPerMinute: 0.005 } },              // wins
    }).costJobs;
    const by = new Map(cj!.jobs.map((j) => [j.name, j]));
    expect(by.get('unit-tests')!.dollars).toBeCloseTo(0.05);        // poolMeta rate
    expect(by.get('e2e')!.dollars).toBeNull();                      // no default anywhere
    expect(by.get('mystery')!.dollars).toBeNull();
  });

  it('costJobs: caps at 15 jobs per repo', () => {
    for (let i = 0; i < 20; i++) {
      runJob(`job-${String(i).padStart(2, '0')}`, '2026-06-11T10:00:00Z', 60 + i, 'sha1', 1);
    }
    expect(explorer().costJobs[0]!.jobs).toHaveLength(15);
    // top by minutes: job-19 (the longest) leads
    expect(explorer().costJobs[0]!.jobs[0]!.name).toBe('job-19');
  });

  it('costRuns: groups by (event, sha, run number); jobCount = distinct names; retries add minutes', () => {
    runJob('unit-tests', '2026-06-11T10:00:00Z', 300, 'shaAAA1234', 41);
    runJob('build', '2026-06-11T10:00:00Z', 600, 'shaAAA1234', 41);
    runJob('unit-tests', '2026-06-11T10:20:00Z', 300, 'shaAAA1234', 41, 'pull_request', 2); // retry, same run
    runJob('unit-tests', '2026-06-11T11:00:00Z', 60, 'shaBBB1234', 42);                     // another run
    runJob('unit-tests', '2026-06-11T11:30:00Z', 60, 'shaAAA1234', 43, 'merge_group');      // same sha, group run
    const [cr] = explorer().costRuns;
    expect(cr!.repo).toBe(REPO);
    expect(cr!.runs).toEqual([
      { event: 'pull_request', runNumber: 41, headShaShort: 'shaAAA1', minutes: 20,
        dollars: null, jobCount: 2, prNumber: null },
      // minutes tie → newer run number first
      { event: 'merge_group', runNumber: 43, headShaShort: 'shaAAA1', minutes: 1,
        dollars: null, jobCount: 1, prNumber: null },
      { event: 'pull_request', runNumber: 42, headShaShort: 'shaBBB1', minutes: 1,
        dollars: null, jobCount: 1, prNumber: null },
    ]);
  });

  it('costRuns: rows without run_number or head_sha cannot be attributed and are excluded (ramp)', () => {
    runJob('unit-tests', '2026-06-11T10:00:00Z', 300, 'sha1', null); // pre-migration shape
    runJob('build', '2026-06-11T10:00:00Z', 300, null, 7);           // placeholder sha
    runJob('e2e', '2026-06-11T10:00:00Z', 300, 'sha1', 7);           // attributable
    const [cr] = explorer().costRuns;
    expect(cr!.runs).toHaveLength(1);
    expect(cr!.runs[0]!).toMatchObject({ runNumber: 7, jobCount: 1 });
    // the job leaderboard still sees all three (works on day one)
    expect(explorer().costJobs[0]!.jobs).toHaveLength(3);
  });

  it('costRuns: prices member jobs via their pools and joins the PR number by head sha', () => {
    runJob('unit-tests', '2026-06-11T10:00:00Z', 600, 'headsha99', 50); // spot 10m
    runJob('mystery', '2026-06-11T10:00:00Z', 600, 'headsha99', 50);    // unknown 10m, unpriced
    const [cr] = explorer({
      cpm: { spot: 0.01 },
      prNumberForSha: (repo, sha) => (repo === REPO && sha === 'headsha99' ? 8962 : null),
    }).costRuns;
    expect(cr!.runs[0]!).toMatchObject({
      runNumber: 50, prNumber: 8962, minutes: 20, dollars: 0.1, jobCount: 2 });
  });

  it('costRuns: caps at 20 runs per repo, largest minutes first', () => {
    for (let i = 0; i < 25; i++) {
      runJob('unit-tests', '2026-06-11T10:00:00Z', 60 * (i + 1), `sha${i}xxxx`, 100 + i);
    }
    const runs = explorer().costRuns[0]!.runs;
    expect(runs).toHaveLength(20);
    expect(runs[0]!.runNumber).toBe(124); // the 25-minute run leads
  });

  it('cost pools carry instanceType from poolMeta (null when unset)', () => {
    runJob('unit-tests', '2026-06-11T10:00:00Z', 300, 'sha1', 1);
    runJob('mystery', '2026-06-11T10:00:00Z', 300, 'sha1', 1);
    const [c] = explorer({ poolMeta: { spot: { instanceType: 'm7a.2xlarge spot' } } }).cost;
    expect(c!.pools.find((p) => p.pool === 'spot')!.instanceType).toBe('m7a.2xlarge spot');
    expect(c!.pools.find((p) => p.pool === 'unknown')!.instanceType).toBeNull();
  });

  it('poolMeta rates alone (no costPerMinute) flip $ on — totals are no longer null', () => {
    runJob('unit-tests', '2026-06-11T10:00:00Z', 600, 'sha1', 1);
    const [c] = explorer({ poolMeta: { default: { dollarsPerMinute: 0.02 } } }).cost;
    expect(c!.totalDollars).toBeCloseTo(0.2);
    expect(c!.pools[0]!.dollars).toBeCloseTo(0.2);
  });

  it('costJobs/costRuns are exclude-filtered and empty on empty history', () => {
    runJob('unit-tests', '2026-06-11T10:00:00Z', 300, 'sha1', 1);
    const m = computeMetrics(h, '24h', 'hour', NOW, [REPO], () => 1, new Map(), new Map(),
      [], poolsFor, [], null);
    expect(m.costJobs).toEqual([]);
    expect(m.costRuns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cost actuals + attribution coverage (cost explorer phase 2)
// ---------------------------------------------------------------------------

describe('computeMetrics: cost actuals + attribution coverage (phase 2)', () => {
  /** unit-tests/build → spot; e2e → composite ternary; mystery → unmappable;
   *  hosted → a GITHUB-HOSTED pool (ubuntu-latest) — billed by GitHub, so it
   *  must NOT count toward the EC2 fleet coverage. */
  const poolsFor = (_repo: string, name: string, _event: string) =>
    name.startsWith('e2e') ? { pool: 'spot|ondemand', githubHosted: false }
      : name === 'mystery' ? null
        : name === 'hosted' ? { pool: 'ubuntu-latest', githubHosted: true }
          : { pool: 'spot', githubHosted: false };

  const actuals = (opts: {
    cpm?: Record<string, number> | null;
    exclude?: string[];
  } = {}) =>
    computeMetrics(h, '24h', 'hour', NOW, opts.exclude ?? [], () => 1, new Map(), new Map(),
      [], poolsFor, [], opts.cpm ?? null, null, () => null).costActuals;

  const job = (name: string, startISO: string, secs: number, repo = REPO): void => {
    const start = new Date(startISO);
    const end = new Date(start.getTime() + secs * 1000);
    h.recordCheckDuration(repo, name, 'pull_request', start.toISOString(),
      end.toISOString(), 'SUCCESS', 'sha1', 1, 1);
  };

  it('joins per-day actuals with per-day attributed dollars; per-day coverage = attributed ÷ actual', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);   // spot, 10 min
    job('build', '2026-06-11T11:00:00Z', 1200);       // spot, 20 min
    h.upsertCostActual('fleet', '2026-06-11', 0.60, 'aws-ce');
    const [fleet] = actuals({ cpm: { spot: 0.01 } }); // 30 min × $0.01 = $0.30
    expect(fleet).toEqual({
      scope: 'fleet',
      // the per-day row still carries its own coverage
      days: [{ date: '2026-06-11', actualDollars: 0.60,
        attributedDollars: expect.closeTo(0.30, 6), coveragePct: expect.closeTo(50, 6),
        cumulativeCoveragePct: null }],  // 06-11 is today → not a comparable day
      totalActualDollars: 0.60,
      totalAttributedDollars: expect.closeTo(0.30, 6),
      // ...but the only billed day is NOW's day (today, still settling), so it is
      // NOT a comparable day → cumulative coverage and coverageSince are null,
      // consistent with recentCoveragePct. (Avoids the mismatched-day-set ratio
      // that made attributed look like it exceeded actual.)
      coveragePct: null, coverageSince: null,
      recentCoveragePct: null, recentCoverageDate: null,
    });
  });

  it('excludes pre-tracking days from cumulative coverage but keeps them in the bill', () => {
    // The exact screenshot bug: days billed BEFORE job-tracking began have real
    // actual spend and zero attributed. Summing them into the ratio (or, in the
    // mirror case, summing today's still-settling attributed) is what made
    // attributed appear to exceed actual. Coverage must use comparable days only.
    job('unit-tests', '2026-06-10T13:00:00Z', 600);            // 10 min × $0.01 = $0.10 (tracked)
    h.upsertCostActual('fleet', '2026-06-05', 1.00, 'aws-ce'); // pre-tracking: bill, no jobs
    h.upsertCostActual('fleet', '2026-06-10', 0.20, 'aws-ce'); // tracked + settled
    h.upsertCostActual('fleet', '2026-06-11', 5.00, 'aws-ce'); // today, still settling
    const [fleet] = computeMetrics(h, '30d', 'day', NOW, [], () => 1, new Map(), new Map(),
      [], poolsFor, [], { spot: 0.01 }, null, () => null).costActuals;
    // total bill keeps every day (6.20); attribution only the tracked day (0.10)
    expect(fleet!.totalActualDollars).toBeCloseTo(6.20, 6);
    expect(fleet!.totalAttributedDollars).toBeCloseTo(0.10, 6);
    // coverage is the comparable day 06-10 ALONE: 0.10/0.20 = 50% — NOT the naive
    // 0.10/6.20 = 1.6% that pre-tracking + today would produce.
    expect(fleet!.coveragePct).toBeCloseTo(50, 6);
    expect(fleet!.coverageSince).toBe('2026-06-10');
  });

  it('per-day coverage can exceed 100% on a burst day, but cumulative-to-date smooths it', () => {
    // A fixed-capacity fleet bills ~flat per day; pricing minutes×rate overshoots
    // on a heavy day and undershoots on a light one. The per-day ratio is noisy
    // (>100% allowed); cumulativeCoveragePct converges and is what the table shows.
    job('burst', '2026-06-09T10:00:00Z', 6000);                // 100 min × $0.01 = $1.00
    job('light', '2026-06-10T10:00:00Z', 600);                 //  10 min × $0.01 = $0.10
    h.upsertCostActual('fleet', '2026-06-09', 0.50, 'aws-ce'); // burst day: attributed $1.00 > actual → 200%
    h.upsertCostActual('fleet', '2026-06-10', 1.00, 'aws-ce'); // light day: $0.10 / $1.00 → 10%
    const [fleet] = computeMetrics(h, '30d', 'day', NOW, [], () => 1, new Map(), new Map(),
      [], poolsFor, [], { spot: 0.01 }, null, () => null).costActuals;
    const [d09, d10] = fleet!.days;
    expect(d09!.coveragePct).toBeCloseTo(200, 6);              // raw per-day overshoots
    expect(d09!.cumulativeCoveragePct).toBeCloseTo(200, 6);    // running = just day 1 so far
    expect(d10!.coveragePct).toBeCloseTo(10, 6);               // raw per-day undershoots
    expect(d10!.cumulativeCoveragePct).toBeCloseTo(73.333, 3); // 1.10 / 1.50 — smoothed
    expect(fleet!.coveragePct).toBeCloseTo(73.333, 3);         // headline = final cumulative
  });

  it('recentCoveragePct = coverage of the latest fully-billed day, skipping today', () => {
    // two billed days; NOW is 2026-06-11 noon so 06-11 is "today" (excluded),
    // 06-10 is the latest complete day → its coverage is the headline
    job('unit-tests', '2026-06-10T13:00:00Z', 600);   // 10 min × $0.01 = $0.10 (inside 24h window)
    job('build', '2026-06-11T10:00:00Z', 600);        // today — counted in day but not headline
    h.upsertCostActual('fleet', '2026-06-10', 0.20, 'aws-ce'); // coverage 0.10/0.20 = 50%
    h.upsertCostActual('fleet', '2026-06-11', 5.00, 'aws-ce'); // today, partial
    const [fleet] = actuals({ cpm: { spot: 0.01 } });
    expect(fleet!.recentCoverageDate).toBe('2026-06-10');
    expect(fleet!.recentCoveragePct).toBeCloseTo(50, 6);
  });

  it('minutes-only mode (no rates): attributed and coverage stay null, actual still reports', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);
    h.upsertCostActual('fleet', '2026-06-11', 123, null);
    const [fleet] = actuals();
    expect(fleet!.days).toEqual([
      { date: '2026-06-11', actualDollars: 123, attributedDollars: null,
        coveragePct: null, cumulativeCoveragePct: null }]);
    expect(fleet!.totalAttributedDollars).toBeNull();
    expect(fleet!.coveragePct).toBeNull();
  });

  it('a billed day with zero priced job rows reads attributed 0 / coverage 0, not null', () => {
    h.upsertCostActual('fleet', '2026-06-11', 50, null);
    const [fleet] = actuals({ cpm: { spot: 0.01 } });
    expect(fleet!.days).toEqual([
      { date: '2026-06-11', actualDollars: 50, attributedDollars: 0,
        coveragePct: 0, cumulativeCoveragePct: null }]);
  });

  it('a $0 actual cannot be a coverage denominator — per-day and headline go null', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);
    h.upsertCostActual('fleet', '2026-06-11', 0, null);
    const [fleet] = actuals({ cpm: { spot: 0.01 } });
    expect(fleet!.days[0]!.coveragePct).toBeNull();
    expect(fleet!.coveragePct).toBeNull();
  });

  it('pool scopes attribute only their own pool; unpriced pools never attribute; fleet sorts first', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);   // spot
    job('e2e', '2026-06-11T10:10:00Z', 600);          // spot|ondemand composite
    job('mystery', '2026-06-11T10:20:00Z', 600);      // unknown — no rate, never attributes
    h.upsertCostActual('spot', '2026-06-11', 1, null);
    h.upsertCostActual('fleet', '2026-06-11', 1, null);
    const out = actuals({ cpm: { 'spot': 0.01, 'spot|ondemand': 0.02 } });
    expect(out.map((a) => a.scope)).toEqual(['fleet', 'spot']);
    // fleet = spot $0.10 + composite $0.20 (mystery unpriced → excluded)
    expect(out[0]!.days[0]!.attributedDollars).toBeCloseTo(0.30, 6);
    // pool scope 'spot' = only the spot job's $0.10
    expect(out[1]!.days[0]!.attributedDollars).toBeCloseTo(0.10, 6);
  });

  it('github-hosted jobs are EXCLUDED from the fleet coverage but still get their own pool scope', () => {
    // The >100% leak this fixes: ubuntu-latest minutes are on GitHub's bill, not
    // the EC2 fleet actuals. They must not inflate the 'fleet' attributed total.
    job('unit-tests', '2026-06-11T10:00:00Z', 600);   // spot (fleet), 10 min
    job('hosted', '2026-06-11T10:10:00Z', 6000);      // ubuntu-latest, github-hosted, 100 min
    h.upsertCostActual('fleet', '2026-06-11', 1, null);
    h.upsertCostActual('ubuntu-latest', '2026-06-11', 1, null); // a separate GitHub bill scope
    const out = actuals({ cpm: { 'spot': 0.01, 'ubuntu-latest': 0.008 } });
    const fleet = out.find((a) => a.scope === 'fleet')!;
    // fleet = ONLY the spot job's $0.10 — the hosted job's $0.80 is excluded
    expect(fleet.days[0]!.attributedDollars).toBeCloseTo(0.10, 6);
    expect(fleet.days[0]!.coveragePct).toBeCloseTo(10, 6); // 0.10 / 1.00, NOT 90%
    // the hosted job still gets a 'ubuntu-latest' pool scope (cost is real)
    const hosted = out.find((a) => a.scope === 'ubuntu-latest');
    expect(hosted?.days[0]?.attributedDollars).toBeCloseTo(0.80, 6);
  });

  it('window floor applies to actual rows; headline sums in-window days only', () => {
    h.upsertCostActual('fleet', '2026-06-01', 999, null); // outside the 24h window
    h.upsertCostActual('fleet', '2026-06-11', 10, null);
    const [fleet] = actuals({ cpm: { spot: 0.01 } });
    expect(fleet!.days.map((d) => d.date)).toEqual(['2026-06-11']);
    expect(fleet!.totalActualDollars).toBe(10);
  });

  it('excluded repos do not attribute (the actual side is fleet-level and unaffected)', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);                  // REPO — excluded below
    job('unit-tests', '2026-06-11T10:00:00Z', 600, 'acme/other');    // stays
    h.upsertCostActual('fleet', '2026-06-11', 1, null);
    const [fleet] = actuals({ cpm: { spot: 0.01 }, exclude: [REPO] });
    expect(fleet!.days[0]!.attributedDollars).toBeCloseTo(0.10, 6);
  });

  it('empty without imported rows (jobs alone produce no actuals section)', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);
    expect(actuals({ cpm: { spot: 0.01 } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cost empirical auto-rate (issue #100) — opt-in, fleet ÷ tracked minutes
// ---------------------------------------------------------------------------

describe('computeMetrics: cost empirical auto-rate (issue #100)', () => {
  /** unit-tests/build → spot (fleet); hosted → github-hosted (NOT on the fleet). */
  const poolsFor = (_repo: string, name: string, _event: string) =>
    name === 'hosted' ? { pool: 'ubuntu-latest', githubHosted: true }
      : { pool: 'spot', githubHosted: false };

  const job = (name: string, startISO: string, secs: number, repo = REPO): void => {
    const start = new Date(startISO);
    const end = new Date(start.getTime() + secs * 1000);
    h.recordCheckDuration(repo, name, 'pull_request', start.toISOString(),
      end.toISOString(), 'SUCCESS', 'sha1', 1, 1);
  };

  /** computeMetrics with the auto-rate flag wired in as the trailing param. */
  const run = (opts: { auto?: boolean; cpm?: Record<string, number> | null } = {}) =>
    computeMetrics(h, '24h', 'hour', NOW, [], () => 1, new Map(), new Map(),
      [], poolsFor, [], opts.cpm ?? null, null, () => null, opts.auto ?? false);

  it('derives the blended rate = fleet actuals ÷ tracked (non-github-hosted) minutes', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);   // spot, 10 min (tracked)
    job('build', '2026-06-11T11:00:00Z', 1200);       // spot, 20 min (tracked)
    job('hosted', '2026-06-11T11:30:00Z', 6000);      // github-hosted, 100 min (EXCLUDED)
    h.upsertCostActual('fleet', '2026-06-11', 0.60, 'aws-ce');
    const m = run({ auto: true, cpm: { spot: 0.001 } }); // static rate would be way off
    // 30 tracked minutes, $0.60 fleet → $0.02/min
    expect(m.costAutoRate).toEqual({
      dollarsPerMinute: expect.closeTo(0.02, 9),
      fleetDollars: expect.closeTo(0.60, 9),
      trackedMinutes: expect.closeTo(30, 9),
      windowDays: 1,
    });
  });

  it('prices per-pool/per-job dollars at the blended rate for non-github-hosted pools', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);   // spot, 10 min
    job('build', '2026-06-11T11:00:00Z', 1200);       // spot, 20 min
    h.upsertCostActual('fleet', '2026-06-11', 0.60, 'aws-ce'); // blended $0.02/min
    const m = run({ auto: true, cpm: { spot: 0.001 } });
    const pool = m.cost[0]!.pools.find((p) => p.pool === 'spot')!;
    expect(pool.dollars).toBeCloseTo(0.60, 6);       // 30 min × $0.02, NOT static 0.001
    const byJob = new Map(m.costJobs[0]!.jobs.map((j) => [j.name, j]));
    expect(byJob.get('unit-tests')!.dollars).toBeCloseTo(0.20, 6); // 10 × 0.02
    expect(byJob.get('build')!.dollars).toBeCloseTo(0.40, 6);      // 20 × 0.02
  });

  it('total attributed ≈ fleet actuals (coverage ≈ 100%) under auto-rate', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);   // spot, 10 min
    job('build', '2026-06-11T11:00:00Z', 1200);       // spot, 20 min
    h.upsertCostActual('fleet', '2026-06-11', 0.60, 'aws-ce');
    const fleet = run({ auto: true, cpm: { spot: 0.001 } }).costActuals
      .find((a) => a.scope === 'fleet')!;
    expect(fleet.days[0]!.coveragePct).toBeCloseTo(100, 4);
    expect(fleet.totalAttributedDollars).toBeCloseTo(0.60, 6);
  });

  it('github-hosted pools keep their STATIC rate even under auto-rate (separate bill)', () => {
    job('hosted', '2026-06-11T10:00:00Z', 600);       // github-hosted, 10 min
    job('unit-tests', '2026-06-11T11:00:00Z', 600);   // spot, 10 min
    h.upsertCostActual('fleet', '2026-06-11', 0.20, 'aws-ce'); // blended over 10 tracked = $0.02/min
    const m = run({ auto: true, cpm: { 'spot': 0.001, 'ubuntu-latest': 0.008 } });
    const byJob = new Map(m.costJobs[0]!.jobs.map((j) => [j.name, j]));
    expect(byJob.get('hosted')!.dollars).toBeCloseTo(0.08, 6);   // 10 × static 0.008
    expect(byJob.get('unit-tests')!.dollars).toBeCloseTo(0.20, 6); // 10 × blended 0.02
    // tracked minutes excluded the hosted job
    expect(m.costAutoRate!.trackedMinutes).toBeCloseTo(10, 9);
  });

  it('flag OFF (default): dollars use the static poolRate, costAutoRate is null', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);   // spot, 10 min
    h.upsertCostActual('fleet', '2026-06-11', 0.60, 'aws-ce');
    const m = run({ auto: false, cpm: { spot: 0.001 } });
    expect(m.costAutoRate).toBeNull();
    expect(m.cost[0]!.pools[0]!.dollars).toBeCloseTo(0.01, 6); // 10 × static 0.001
  });

  it('flag ON but no fleet actuals yet: falls back to the static rate, costAutoRate null', () => {
    job('unit-tests', '2026-06-11T10:00:00Z', 600);   // spot, 10 min, no fleet bill imported
    const m = run({ auto: true, cpm: { spot: 0.001 } });
    expect(m.costAutoRate).toBeNull();
    expect(m.cost[0]!.pools[0]!.dollars).toBeCloseTo(0.01, 6); // static fallback
  });
});

describe('queue efficiency (issue #23)', () => {
  // One merge_group check row; distinct (sha, run#) form runs.
  const mgCheck = (name: string, conclusion: string, sha: string, runNo: number, min: number) =>
    h.recordCheckDuration(REPO, name, 'merge_group',
      `2026-06-10T10:${String(min).padStart(2, '0')}:00Z`,
      `2026-06-10T10:${String(min + 1).padStart(2, '0')}:00Z`, conclusion, sha, 1, runNo);
  const merge = (n: number) => h.upsertMergedPr({
    repo: REPO, number: n, title: `pr ${n}`, url: `u/${n}`,
    mergedAt: '2026-06-10T11:00:00Z', mergeCommitSha: `m${n}`,
  });
  const run = (prefixes: string[]) => computeMetrics(h, '7d', 'day', NOW, [], () => 1,
    new Map(), new Map(), [], () => null, [], null, null, () => null, false,
    () => prefixes).queueEfficiency;

  it('counts merge_group RUNS per merged PR and splits run-level vs required-gate failures', () => {
    // run A: ci ✓ + advisory ✓ → clean
    mgCheck('ci', 'SUCCESS', 'sha1', 1, 0); mgCheck('lint-advisory', 'SUCCESS', 'sha1', 1, 2);
    // run B: ci ✓ but advisory ✗ → run reads failed, required gate PASSED (noise)
    mgCheck('ci', 'SUCCESS', 'sha2', 2, 4); mgCheck('lint-advisory', 'FAILURE', 'sha2', 2, 6);
    // run C: ci ✗ → required gate failed
    mgCheck('ci', 'FAILURE', 'sha3', 3, 8);
    merge(1); merge(2);   // 2 queue merges

    const [qe] = run(['ci']);
    expect(qe!.mergeGroupRuns).toBe(3);
    expect(qe!.queueMerges).toBe(2);
    expect(qe!.runsPerMerge).toBeCloseTo(1.5, 6);   // 3 runs / 2 merges
    expect(qe!.runConclusion).toEqual({
      total: 3, runFailed: 2, requiredFailed: 1, advisoryNoise: 1, requiredConfigured: true,
    });
  });

  it('without requiredCheckPrefixes the split is unknowable (everything reads advisory)', () => {
    mgCheck('ci', 'FAILURE', 'sha1', 1, 0);   // a real gate failure…
    const [qe] = run([]);                      // …but no prefixes configured
    expect(qe!.runConclusion.requiredConfigured).toBe(false);
    expect(qe!.runConclusion.runFailed).toBe(1);
    expect(qe!.runConclusion.requiredFailed).toBe(0);     // can't tell it was required
    expect(qe!.runConclusion.advisoryNoise).toBe(1);
  });

  it('runsPerMerge is null when there are runs but no merges in the window', () => {
    mgCheck('ci', 'SUCCESS', 'sha1', 1, 0);
    const [qe] = run(['ci']);
    expect(qe!.queueMerges).toBe(0);
    expect(qe!.runsPerMerge).toBeNull();
  });

  it('admin-bypass rate = non-[bot] merges ÷ merges with a known merger', () => {
    const mergeBy = (n: number, by: string | null) => h.upsertMergedPr({ repo: REPO, number: n,
      title: `pr ${n}`, url: `u/${n}`, mergedAt: '2026-06-10T11:00:00Z',
      mergeCommitSha: `m${n}`, mergedBy: by });
    mergeBy(1, 'queue-bot[bot]'); mergeBy(2, 'queue-bot[bot]'); mergeBy(3, 'queue-bot[bot]');
    mergeBy(4, 'alice');     // human admin merge — bypassed the queue
    mergeBy(5, null);        // unknown merger — excluded from the ratio
    const [qe] = run(['ci']);
    expect(qe!.queueMerges).toBe(5);          // every merge counts toward runs/merge
    expect(qe!.adminBypass.merges).toBe(4);   // …but only known-merger rows feed the bypass rate
    expect(qe!.adminBypass.bypasses).toBe(1); // alice
    expect(qe!.adminBypass.rate).toBeCloseTo(0.25, 6);
  });
});
