import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryStore } from '../history';
import { computeMetrics, clampWindowDays } from '../metrics';

const REPO = 'acme/widgets';
const NOW = new Date('2026-06-11T12:00:00Z');

let h: HistoryStore;
beforeEach(() => {
  h = new HistoryStore(':memory:');
});

describe('clampWindowDays', () => {
  it('accepts the three allowed windows', () => {
    expect(clampWindowDays('7')).toBe(7);
    expect(clampWindowDays('14')).toBe(14);
    expect(clampWindowDays('30')).toBe(30);
    expect(clampWindowDays(7)).toBe(7);
  });

  it('defaults to 14 for missing or unparseable values', () => {
    expect(clampWindowDays(undefined)).toBe(14);
    expect(clampWindowDays('abc')).toBe(14);
    expect(clampWindowDays('')).toBe(14);
    expect(clampWindowDays(null)).toBe(14);
  });

  it('clamps other numbers to the nearest allowed window', () => {
    expect(clampWindowDays('1')).toBe(7);
    expect(clampWindowDays('999')).toBe(30);
    expect(clampWindowDays('21')).toBe(14);
    expect(clampWindowDays('-5')).toBe(7);
  });
});

describe('computeMetrics: runner waits', () => {
  it('buckets per (repo, event) by UTC day with p50/p90/n; window-scoped', () => {
    // pull_request 'build': 3 waits on 06-10, 1 on 06-09, 1 outside the window
    h.recordRunnerWait(REPO, 'build', 'pull_request', 10, '2026-06-10T10:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 20, '2026-06-10T11:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 30, '2026-06-10T12:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 60, '2026-06-09T10:00:00Z');
    h.recordRunnerWait(REPO, 'build', 'pull_request', 999, '2026-06-01T10:00:00Z'); // outside 7d
    // separate event tier
    h.recordRunnerWait(REPO, 'ci', 'merge_group', 100, '2026-06-10T10:00:00Z');

    const m = computeMetrics(h, 7, NOW);
    expect(m.windowDays).toBe(7);
    const mg = m.runnerWaits.find((r) => r.repo === REPO && r.event === 'merge_group')!;
    expect(mg.days).toEqual([{ date: '2026-06-10', p50: 100, p90: 100, n: 1 }]);
    const pr = m.runnerWaits.find((r) => r.repo === REPO && r.event === 'pull_request')!;
    expect(pr.days).toEqual([
      { date: '2026-06-09', p50: 60, p90: 60, n: 1 },
      { date: '2026-06-10', p50: 20, p90: 30, n: 3 },
    ]);
  });
});

describe('computeMetrics: queue throughput', () => {
  it('merges/day counts, queue-wait p50/day, group-run p50/day', () => {
    h.upsertMergedPr({ repo: REPO, number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-10T10:00:00Z', mergeCommitSha: 'a' });
    h.upsertMergedPr({ repo: REPO, number: 2, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'b' });
    h.upsertMergedPr({ repo: REPO, number: 3, title: 't', url: 'u',
      mergedAt: '2026-06-09T09:00:00Z', mergeCommitSha: 'c' });
    h.recordQueueWait(REPO, 120, '2026-06-10T10:00:00Z');
    h.recordQueueWait(REPO, 240, '2026-06-10T11:00:00Z');
    h.recordGroupRun(REPO, 600, '2026-06-10T10:30:00Z');

    const q = computeMetrics(h, 7, NOW).queue.find((r) => r.repo === REPO)!;
    expect(q.mergesPerDay).toEqual([
      { date: '2026-06-09', count: 1 },
      { date: '2026-06-10', count: 2 },
    ]);
    expect(q.queueWaitDays).toEqual([{ date: '2026-06-10', p50: 120, n: 2 }]);
    expect(q.groupRunDays).toEqual([{ date: '2026-06-10', p50: 600, n: 1 }]);
  });
});

describe('computeMetrics: slowest jobs', () => {
  it('orders by p50 desc, computes variability = p90/p50, builds per-day trend, excludes failures', () => {
    // 'slow': 100 on 06-09; 200 + 300 on 06-10 → window p50 200, p90 300
    h.recordCheckDuration(REPO, 'slow', 'pull_request', '2026-06-09T10:00:00Z', '2026-06-09T10:01:40Z', 'SUCCESS'); // 100
    h.recordCheckDuration(REPO, 'slow', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:03:20Z', 'SUCCESS'); // 200
    h.recordCheckDuration(REPO, 'slow', 'pull_request', '2026-06-10T11:00:00Z', '2026-06-10T11:05:00Z', 'SUCCESS'); // 300
    // 'fast': 20s
    h.recordCheckDuration(REPO, 'fast', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:00:20Z', 'SUCCESS');
    // 'spiky': 10, 10, 100 → p50 10, p90 100, variability 10
    h.recordCheckDuration(REPO, 'spiky', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:00:10Z', 'SUCCESS');
    h.recordCheckDuration(REPO, 'spiky', 'pull_request', '2026-06-10T11:00:00Z', '2026-06-10T11:00:10Z', 'SUCCESS');
    h.recordCheckDuration(REPO, 'spiky', 'pull_request', '2026-06-10T12:00:00Z', '2026-06-10T12:01:40Z', 'SUCCESS');
    // failures never count
    h.recordCheckDuration(REPO, 'slow', 'pull_request', '2026-06-10T13:00:00Z', '2026-06-10T14:00:00Z', 'FAILURE');

    const jobs = computeMetrics(h, 7, NOW).slowestJobs.find((r) => r.repo === REPO)!.jobs;
    expect(jobs.map((j) => j.name)).toEqual(['slow', 'fast', 'spiky']);
    const slow = jobs[0]!;
    expect(slow.event).toBe('pull_request');
    expect(slow.p50).toBe(200);
    expect(slow.p90).toBe(300);
    expect(slow.variability).toBeCloseTo(1.5);
    expect(slow.n).toBe(3);
    expect(slow.trend).toEqual([
      { date: '2026-06-09', p50: 100 },
      { date: '2026-06-10', p50: 200 },
    ]);
    expect(jobs[2]!.variability).toBeCloseTo(10);
  });

  it('caps each repo at the top 10 jobs by p50', () => {
    for (let i = 1; i <= 12; i++) {
      const secs = i * 10;
      h.recordCheckDuration('octo/bridge', `job-${String(i).padStart(2, '0')}`, 'pull_request',
        '2026-06-10T10:00:00Z', new Date(Date.parse('2026-06-10T10:00:00Z') + secs * 1000).toISOString(), 'SUCCESS');
    }
    const jobs = computeMetrics(h, 7, NOW).slowestJobs.find((r) => r.repo === 'octo/bridge')!.jobs;
    expect(jobs).toHaveLength(10);
    expect(jobs[0]!.name).toBe('job-12');                 // slowest first
    expect(jobs.map((j) => j.name)).not.toContain('job-01'); // two cheapest fall off
    expect(jobs.map((j) => j.name)).not.toContain('job-02');
  });

  it('same job name under different events stays separate', () => {
    h.recordCheckDuration(REPO, 'ci', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:01:00Z', 'SUCCESS');
    h.recordCheckDuration(REPO, 'ci', 'merge_group', '2026-06-10T10:00:00Z', '2026-06-10T10:10:00Z', 'SUCCESS');
    const jobs = computeMetrics(h, 7, NOW).slowestJobs.find((r) => r.repo === REPO)!.jobs;
    expect(jobs.map((j) => `${j.name}/${j.event}`).sort()).toEqual(['ci/merge_group', 'ci/pull_request']);
  });
});

describe('computeMetrics: velocity', () => {
  it('merged/day, merge→QA p50/day, avg lifespan meanHours/day excluding null created_at', () => {
    // lifespan 24h, merge→QA 600s
    h.upsertMergedPr({ repo: REPO, number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-10T10:00:00Z', mergeCommitSha: 'a', createdAt: '2026-06-09T10:00:00Z' });
    h.markEnvLive(REPO, 1, 'qa', '2026-06-10T10:10:00Z');
    // created_at unknown (pre-migration row) — excluded from lifespan
    h.upsertMergedPr({ repo: REPO, number: 2, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'b' });
    // lifespan 1h, merged the previous day
    h.upsertMergedPr({ repo: REPO, number: 3, title: 't', url: 'u',
      mergedAt: '2026-06-09T09:00:00Z', mergeCommitSha: 'c', createdAt: '2026-06-09T08:00:00Z' });
    // outside the window entirely
    h.upsertMergedPr({ repo: REPO, number: 4, title: 't', url: 'u',
      mergedAt: '2026-05-01T09:00:00Z', mergeCommitSha: 'd', createdAt: '2026-05-01T08:00:00Z' });

    const v = computeMetrics(h, 7, NOW).velocity.find((r) => r.repo === REPO)!;
    expect(v.mergedPerDay).toEqual([
      { date: '2026-06-09', count: 1 },
      { date: '2026-06-10', count: 2 },
    ]);
    expect(v.mergeToQaDays).toEqual([{ date: '2026-06-10', p50: 600, n: 1 }]);
    expect(v.avgLifespanDays).toEqual([
      { date: '2026-06-09', meanHours: 1, n: 1 },
      { date: '2026-06-10', meanHours: 24, n: 1 }, // n=1: the null-created_at row is excluded
    ]);
  });
});

describe('computeMetrics: trends (state samples)', () => {
  it('returns raw window-scoped samples per repo, oldest first', () => {
    expect(h.recordStateSample(REPO, '2026-06-10T10:00:00Z',
      { open: 5, ci: 2, queue: 1, failed: 0 })).toBe(true);
    expect(h.recordStateSample(REPO, '2026-06-10T10:20:00Z',
      { open: 6, ci: 3, queue: 0, failed: 1 })).toBe(true);
    h.recordStateSample('octo/bridge', '2026-06-10T10:00:00Z', { open: 1, ci: 0, queue: 0, failed: 0 });

    const t = computeMetrics(h, 7, NOW).trends.find((r) => r.repo === REPO)!;
    expect(t.samples).toEqual([
      { at: '2026-06-10T10:00:00Z', open: 5, ci: 2, queue: 1, failed: 0 },
      { at: '2026-06-10T10:20:00Z', open: 6, ci: 3, queue: 0, failed: 1 },
    ]);
    expect(computeMetrics(h, 7, NOW).trends.find((r) => r.repo === 'octo/bridge')!.samples).toHaveLength(1);
  });

  it('samples outside the window are excluded', () => {
    h.recordStateSample(REPO, '2026-06-01T10:00:00Z', { open: 9, ci: 9, queue: 9, failed: 9 });
    h.recordStateSample(REPO, '2026-06-10T10:00:00Z', { open: 1, ci: 0, queue: 0, failed: 0 });
    const t = computeMetrics(h, 7, NOW).trends.find((r) => r.repo === REPO)!;
    expect(t.samples).toHaveLength(1);
    expect(t.samples[0]!.open).toBe(1);
  });
});

describe('computeMetrics: empty history', () => {
  it('returns the full payload shape with empty sections', () => {
    expect(computeMetrics(h, 14, NOW)).toEqual({
      windowDays: 14, runnerWaits: [], queue: [], slowestJobs: [], velocity: [], trends: [],
    });
  });
});
