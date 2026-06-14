import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryStore, addColumnIfMissing } from '../history';

let h: HistoryStore;
beforeEach(() => {
  h = new HistoryStore(':memory:');
});

const REPO = 'acme/widgets';

describe('check durations', () => {
  it('records and computes p50/p90 from last 20 successes', () => {
    for (let i = 0; i < 25; i++) {
      h.recordCheckDuration(REPO, 'TypeScript', 'pull_request',
        `2026-06-0${(i % 9) + 1}T10:00:00Z`, `2026-06-0${(i % 9) + 1}T10:0${(i % 5) + 1}:00Z`, 'SUCCESS');
    }
    const e = h.expected(REPO, 'TypeScript', 'pull_request');
    expect(e).not.toBeNull();
    expect(e!.n).toBeLessThanOrEqual(20);
    expect(e!.p50).toBeGreaterThan(0);
    expect(e!.p90).toBeGreaterThanOrEqual(e!.p50);
    expect(e!.p10).toBeGreaterThan(0);
    expect(e!.p10).toBeLessThanOrEqual(e!.p50);
  });

  it('computes p10 by nearest rank over the same last-20 SUCCESS window', () => {
    // 20 samples: 1..20 minutes (distinct completed_at so none dedupe)
    for (let i = 1; i <= 20; i++) {
      const mm = String(i).padStart(2, '0');
      h.recordCheckDuration(REPO, 'Build', 'pull_request',
        `2026-06-10T10:${mm}:00Z`, `2026-06-10T10:${mm}:${String(i).padStart(2, '0')}Z`, 'SUCCESS');
    }
    // durations are 1..20 seconds; nearest rank: p10 → ceil(0.1·20)=2nd smallest = 2s
    const e = h.expected(REPO, 'Build', 'pull_request')!;
    expect(e.n).toBe(20);
    expect(e.p10).toBe(2);
    expect(e.p50).toBe(10);
    expect(e.p90).toBe(18);
  });

  it('a single sample yields p10 = p50 = p90', () => {
    h.recordCheckDuration(REPO, 'Solo', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T10:05:00Z', 'SUCCESS');
    const e = h.expected(REPO, 'Solo', 'pull_request')!;
    expect(e.p10).toBe(300);
    expect(e.p50).toBe(300);
    expect(e.p90).toBe(300);
  });

  it('rejects negative/zero durations (SKIPPED placeholder timestamps)', () => {
    const ok = h.recordCheckDuration(REPO, 'Unit Tests (shard/8)', 'pull_request',
      '2026-06-10T17:54:54Z', '2026-06-10T16:55:51Z', 'SKIPPED');
    expect(ok).toBe(false);
    expect(h.expected(REPO, 'Unit Tests (shard/8)', 'pull_request')).toBeNull();
  });

  it('separates duration populations by event', () => {
    h.recordCheckDuration(REPO, 'TypeScript', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:10:00Z', 'SUCCESS');
    h.recordCheckDuration(REPO, 'TypeScript', 'merge_group', '2026-06-10T10:00:00Z', '2026-06-10T10:02:00Z', 'SUCCESS');
    expect(h.expected(REPO, 'TypeScript', 'pull_request')!.p50).toBe(600);
    expect(h.expected(REPO, 'TypeScript', 'merge_group')!.p50).toBe(120);
  });

  it('ignores duplicate ingestion (same completed_at)', () => {
    h.recordCheckDuration(REPO, 'ESLint', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:01:00Z', 'SUCCESS');
    h.recordCheckDuration(REPO, 'ESLint', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:01:00Z', 'SUCCESS');
    expect(h.expected(REPO, 'ESLint', 'pull_request')!.n).toBe(1);
  });

  it('expected() ignores non-SUCCESS conclusions', () => {
    h.recordCheckDuration(REPO, 'CI', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:10:00Z', 'FAILURE');
    h.recordCheckDuration(REPO, 'CI', 'pull_request', '2026-06-10T11:00:00Z', '2026-06-10T11:05:00Z', 'CANCELLED');
    expect(h.expected(REPO, 'CI', 'pull_request')).toBeNull();
    h.recordCheckDuration(REPO, 'CI', 'pull_request', '2026-06-10T12:00:00Z', '2026-06-10T12:10:00Z', 'SUCCESS');
    expect(h.expected(REPO, 'CI', 'pull_request')!.n).toBe(1);
  });

  it('expectedSet returns names with a SUCCESS in the window', () => {
    h.recordCheckDuration(REPO, 'ESLint', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:01:00Z', 'SUCCESS');
    h.recordCheckDuration(REPO, 'Old', 'pull_request', '2026-01-01T10:00:00Z', '2026-01-01T10:01:00Z', 'SUCCESS');
    h.recordCheckDuration(REPO, 'Flaky', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:01:00Z', 'FAILURE');
    const set = h.expectedSet(REPO, 'pull_request', new Date('2026-06-11T00:00:00Z'));
    expect(set).toContain('ESLint');
    expect(set).not.toContain('Old');
    expect(set).not.toContain('Flaky');
  });
});

describe('merged PRs', () => {
  it('upserts, lists undeployed, marks env live', () => {
    h.upsertMergedPr({ repo: REPO, number: 8951, title: 'feat: allowance UI', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'abc123' });
    expect(h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))).toHaveLength(1);
    h.markEnvLive(REPO, 8951, 'qa', '2026-06-10T12:08:00Z');
    h.markEnvLive(REPO, 8951, 'prod', '2026-06-10T15:00:00Z');
    const rec = h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))[0];
    expect(rec.qaLiveAt).toBe('2026-06-10T12:08:00Z');
    expect(rec.prodLiveAt).toBe('2026-06-10T15:00:00Z');
  });

  it('re-upsert with null sha does not null-out a known merge_commit_sha', () => {
    h.upsertMergedPr({ repo: REPO, number: 8951, title: 'feat: allowance UI', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'abc123' });
    // sweep search payload can lag detail: mergeCommit comes back null on a later upsert
    h.upsertMergedPr({ repo: REPO, number: 8951, title: 'feat: allowance UI', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: null });
    const rec = h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))[0];
    expect(rec.mergeCommitSha).toBe('abc123');
  });

  it('re-upsert with a sha fills a previously-null merge_commit_sha', () => {
    h.upsertMergedPr({ repo: REPO, number: 8952, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: null });
    h.upsertMergedPr({ repo: REPO, number: 8952, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'def456' });
    expect(h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))[0].mergeCommitSha).toBe('def456');
  });

  it('markEnvLive rejects a bogus environment name (defense in depth)', () => {
    h.upsertMergedPr({ repo: REPO, number: 8953, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'x' });
    expect(() => h.markEnvLive(REPO, 8953, 'staging' as never, '2026-06-10T13:00:00Z'))
      .toThrow(/qa.*prod|prod.*qa/);
  });

  it('excludes PRs merged outside the retention window', () => {
    h.upsertMergedPr({ repo: REPO, number: 1, title: 'old', url: 'u',
      mergedAt: '2026-05-01T00:00:00Z', mergeCommitSha: 'x' });
    expect(h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))).toHaveLength(0);
  });

  it('mergedTimestampsSince: per-repo merge timestamps at/after since, ascending', () => {
    h.upsertMergedPr({ repo: REPO, number: 2, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: null });
    h.upsertMergedPr({ repo: REPO, number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-10T11:00:00Z', mergeCommitSha: null });
    h.upsertMergedPr({ repo: REPO, number: 3, title: 'too old', url: 'u',
      mergedAt: '2026-06-09T00:00:00Z', mergeCommitSha: null });
    h.upsertMergedPr({ repo: 'other/repo', number: 4, title: 'other repo', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: null });
    expect(h.mergedTimestampsSince(REPO, '2026-06-10T00:00:00Z'))
      .toEqual(['2026-06-10T11:00:00Z', '2026-06-10T12:00:00Z']);
    expect(h.mergedTimestampsSince('empty/repo', '2026-06-10T00:00:00Z')).toEqual([]);
  });
});

describe('lead-time timestamps on merged_prs (issue #44)', () => {
  it('persists first_green_at + enqueued_at through upsert and reads them back', () => {
    h.upsertMergedPr({ repo: REPO, number: 100, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'sha', createdAt: '2026-06-10T09:00:00Z',
      firstGreenAt: '2026-06-10T10:00:00Z', enqueuedAt: '2026-06-10T11:30:00Z' });
    const rec = h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))[0];
    expect(rec.firstGreenAt).toBe('2026-06-10T10:00:00Z');
    expect(rec.enqueuedAt).toBe('2026-06-10T11:30:00Z');
  });

  it('omitted fields read back null (old callers / unobserved transitions)', () => {
    h.upsertMergedPr({ repo: REPO, number: 101, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: null });
    const rec = h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))[0];
    expect(rec.firstGreenAt).toBeNull();
    expect(rec.enqueuedAt).toBeNull();
  });

  it('re-upsert with nulls keeps previously persisted values (COALESCE, like merge_commit_sha)', () => {
    h.upsertMergedPr({ repo: REPO, number: 102, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: null,
      firstGreenAt: '2026-06-10T10:00:00Z', enqueuedAt: '2026-06-10T11:30:00Z' });
    // overlapping merged sweep re-ingests the PR after the in-memory maps were consumed
    h.upsertMergedPr({ repo: REPO, number: 102, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: null });
    const rec = h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))[0];
    expect(rec.firstGreenAt).toBe('2026-06-10T10:00:00Z');
    expect(rec.enqueuedAt).toBe('2026-06-10T11:30:00Z');
  });

  it('leadTimeRowsSince: rows merged in-window OR prod-live in-window', () => {
    // merged + prod-live in window
    h.upsertMergedPr({ repo: REPO, number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'a', createdAt: '2026-06-10T09:00:00Z',
      firstGreenAt: '2026-06-10T10:00:00Z', enqueuedAt: '2026-06-10T11:00:00Z' });
    h.markEnvLive(REPO, 1, 'qa', '2026-06-10T12:10:00Z');
    h.markEnvLive(REPO, 1, 'prod', '2026-06-10T18:00:00Z');
    // merged BEFORE the window but prod-live inside it (manual prod deploy)
    h.upsertMergedPr({ repo: REPO, number: 2, title: 't', url: 'u',
      mergedAt: '2026-06-01T12:00:00Z', mergeCommitSha: 'b' });
    h.markEnvLive(REPO, 2, 'prod', '2026-06-10T18:00:00Z');
    // merged before the window, never prod-live — excluded
    h.upsertMergedPr({ repo: REPO, number: 3, title: 't', url: 'u',
      mergedAt: '2026-06-01T11:00:00Z', mergeCommitSha: 'c' });
    const rows = h.leadTimeRowsSince('2026-06-10T00:00:00Z');
    expect(rows.map((r) => r.mergedAt).sort()).toEqual(
      ['2026-06-01T12:00:00Z', '2026-06-10T12:00:00Z']);
    const full = rows.find((r) => r.mergedAt === '2026-06-10T12:00:00Z')!;
    expect(full).toEqual({ repo: REPO, createdAt: '2026-06-10T09:00:00Z',
      firstGreenAt: '2026-06-10T10:00:00Z', enqueuedAt: '2026-06-10T11:00:00Z',
      mergedAt: '2026-06-10T12:00:00Z', qaLiveAt: '2026-06-10T12:10:00Z',
      prodLiveAt: '2026-06-10T18:00:00Z' });
  });
});

describe('samples (raw last-20 SUCCESS durations)', () => {
  it('returns SUCCESS duration values, scoped by event, ignoring failures', () => {
    h.recordCheckDuration(REPO, 'CI', 'pull_request', '2026-06-10T10:00:00Z', '2026-06-10T10:02:00Z', 'SUCCESS'); // 120
    h.recordCheckDuration(REPO, 'CI', 'pull_request', '2026-06-10T11:00:00Z', '2026-06-10T11:10:00Z', 'SUCCESS'); // 600
    h.recordCheckDuration(REPO, 'CI', 'pull_request', '2026-06-10T12:00:00Z', '2026-06-10T12:30:00Z', 'FAILURE');
    h.recordCheckDuration(REPO, 'CI', 'merge_group', '2026-06-10T10:00:00Z', '2026-06-10T10:05:00Z', 'SUCCESS');
    expect([...h.samples(REPO, 'CI', 'pull_request')].sort((a, b) => a - b)).toEqual([120, 600]);
    expect(h.samples(REPO, 'CI', 'merge_group')).toEqual([300]);
    expect(h.samples(REPO, 'Other', 'pull_request')).toEqual([]);
  });

  it('caps at the last 20 samples', () => {
    for (let i = 0; i < 25; i++) {
      h.recordCheckDuration(REPO, 'CI', 'pull_request',
        `2026-06-10T10:${String(i).padStart(2, '0')}:00Z`,
        `2026-06-10T11:${String(i).padStart(2, '0')}:00Z`, 'SUCCESS');
    }
    expect(h.samples(REPO, 'CI', 'pull_request')).toHaveLength(20);
  });
});

describe('group runs (observed merge-group durations)', () => {
  it('records and returns median of last 20', () => {
    [600, 900, 1200].forEach((d, i) =>
      h.recordGroupRun(REPO, d, `2026-06-10T1${i}:00:00Z`));
    expect(h.medianGroupRun(REPO)).toBe(900);
    expect(h.medianGroupRun('other/repo')).toBeNull();
  });

  it('rejects non-positive durations', () => {
    expect(h.recordGroupRun(REPO, 0, '2026-06-10T10:00:00Z')).toBe(false);
    expect(h.recordGroupRun(REPO, -5, '2026-06-10T11:00:00Z')).toBe(false);
    expect(h.recordGroupRun(REPO, NaN, '2026-06-10T12:00:00Z')).toBe(false);
    expect(h.medianGroupRun(REPO)).toBeNull();
  });

  it('ignores duplicate ingestion (same completed_at)', () => {
    expect(h.recordGroupRun(REPO, 600, '2026-06-10T10:00:00Z')).toBe(true);
    h.recordGroupRun(REPO, 600, '2026-06-10T10:00:00Z');
    h.recordGroupRun(REPO, 1200, '2026-06-10T11:00:00Z');
    // duplicate dropped → 2 samples → lower median 600
    expect(h.medianGroupRun(REPO)).toBe(600);
  });

  it('uses only the last 20 runs', () => {
    for (let i = 0; i < 25; i++) {
      // oldest 5 runs are tiny; the last 20 are all 1000s
      h.recordGroupRun(REPO, i < 5 ? 1 : 1000,
        `2026-06-10T10:${String(i).padStart(2, '0')}:00Z`);
    }
    expect(h.medianGroupRun(REPO)).toBe(1000);
  });
});

describe('queue waits', () => {
  it('records and returns median of last 20', () => {
    [120, 300, 600].forEach((w, i) =>
      h.recordQueueWait(REPO, w, `2026-06-10T1${i}:00:00Z`));
    expect(h.medianQueueWait(REPO)).toBe(300);
    expect(h.medianQueueWait('other/repo')).toBeNull();
  });

  it('rejects non-positive waits', () => {
    expect(h.recordQueueWait(REPO, 0, '2026-06-10T10:00:00Z')).toBe(false);
    expect(h.recordQueueWait(REPO, -60, '2026-06-10T11:00:00Z')).toBe(false);
    expect(h.medianQueueWait(REPO)).toBeNull();
  });
});

describe('deploy gaps + meta', () => {
  it('stores gaps and returns median', () => {
    [300, 600, 900].forEach((g) => h.recordDeployGap(REPO, 'qa', g));
    expect(h.medianDeployGap(REPO, 'qa')).toBe(600);
    expect(h.medianDeployGap(REPO, 'prod')).toBeNull();
  });
  it('meta get/set', () => {
    expect(h.getMeta('lastSweep')).toBeNull();
    h.setMeta('lastSweep', '2026-06-10T12:00:00Z');
    expect(h.getMeta('lastSweep')).toBe('2026-06-10T12:00:00Z');
  });

  it('meta delete removes the key (idempotent)', () => {
    h.setMeta('repoConfig:acme/widgets', '{"batchSize":12}');
    h.deleteMeta('repoConfig:acme/widgets');
    expect(h.getMeta('repoConfig:acme/widgets')).toBeNull();
    h.deleteMeta('repoConfig:acme/widgets'); // already gone — no throw
  });

  it('listMeta returns only prefix-matched rows, sorted by key', () => {
    h.setMeta('repoConfig:acme/widgets', 'a');
    h.setMeta('repoConfig:octo/tools', 'b');
    h.setMeta('ciGraph:acme/widgets', 'c');
    h.setMeta('lastSweep', 'd');
    expect(h.listMeta('repoConfig:')).toEqual([
      { key: 'repoConfig:acme/widgets', value: 'a' },
      { key: 'repoConfig:octo/tools', value: 'b' },
    ]);
    expect(h.listMeta('ciGraph:')).toEqual([{ key: 'ciGraph:acme/widgets', value: 'c' }]);
  });

  it('listMeta escapes LIKE wildcards in the prefix', () => {
    h.setMeta('p_x:one', 'a');   // `_` must not act as a single-char wildcard
    h.setMeta('pax:two', 'b');
    expect(h.listMeta('p_x:')).toEqual([{ key: 'p_x:one', value: 'a' }]);
  });
});

describe('eta accuracy (Task F)', () => {
  it('null when no samples exist for the (repo, stage)', () => {
    expect(h.etaAccuracy(REPO, 'ci')).toBeNull();
  });

  it('records samples and returns median absolute error over the last 20', () => {
    // |600-700|=100, |300-250|=50, |120-400|=280 → median 100
    h.recordEtaAccuracy(REPO, 'ci', 600, 700, '2026-06-10T10:00:00Z');
    h.recordEtaAccuracy(REPO, 'ci', 300, 250, '2026-06-10T10:05:00Z');
    h.recordEtaAccuracy(REPO, 'ci', 120, 400, '2026-06-10T10:10:00Z');
    expect(h.etaAccuracy(REPO, 'ci')).toEqual({ medianAbsErrSecs: 100, n: 3 });
    // stages are independent
    expect(h.etaAccuracy(REPO, 'queue')).toBeNull();
  });

  it('caps the window at the last 20 samples', () => {
    for (let i = 0; i < 25; i++) {
      // first 5 rows have err 1000; the last 20 all have err 60 — old rows must fall out
      h.recordEtaAccuracy(REPO, 'queue', 600, i < 5 ? 1600 : 660, `2026-06-10T10:${10 + i}:00Z`);
    }
    expect(h.etaAccuracy(REPO, 'queue')).toEqual({ medianAbsErrSecs: 60, n: 20 });
  });

  it('rejects non-positive or non-finite actuals and negative predictions', () => {
    expect(h.recordEtaAccuracy(REPO, 'ci', 600, 0, '2026-06-10T10:00:00Z')).toBe(false);
    expect(h.recordEtaAccuracy(REPO, 'ci', 600, -5, '2026-06-10T10:00:00Z')).toBe(false);
    expect(h.recordEtaAccuracy(REPO, 'ci', 600, NaN, '2026-06-10T10:00:00Z')).toBe(false);
    expect(h.recordEtaAccuracy(REPO, 'ci', -1, 100, '2026-06-10T10:00:00Z')).toBe(false);
    expect(h.recordEtaAccuracy(REPO, 'ci', NaN, 100, '2026-06-10T10:00:00Z')).toBe(false);
    expect(h.etaAccuracy(REPO, 'ci')).toBeNull();
  });
});

describe('eta accuracy flap guard (issue #54)', () => {
  const AT = '2026-06-12T10:00:00Z';

  it('rejects a stage-flap artifact: hours-long first ETA scored against a seconds-long actual', () => {
    // The live failure mode: predicted=8534s, actual=8.3s ×8 (classification
    // bounced through ci within one poll cycle)
    expect(h.recordEtaAccuracy(REPO, 'ci', 8534, 8.3, AT)).toBe(false);
    expect(h.etaAccuracy(REPO, 'ci')).toBeNull();
  });

  it('records a legitimately short stage when the prediction was also short', () => {
    // predicted 90s → threshold max(60, 4.5) = 60 → actual 75s is a real sample
    expect(h.recordEtaAccuracy(REPO, 'ci', 90, 75, AT)).toBe(true);
    expect(h.etaAccuracy(REPO, 'ci')).toEqual({ medianAbsErrSecs: 15, n: 1 });
  });

  it('still records rows with predicted=0 (no usable first ETA) when actual clears the floor', () => {
    expect(h.recordEtaAccuracy(REPO, 'ci', 0, 120, AT)).toBe(true);
  });

  it('60s floor boundary: actual ≥ 60 records, just below does not (small predictions)', () => {
    expect(h.recordEtaAccuracy(REPO, 'ci', 100, 59.9, AT)).toBe(false);
    expect(h.recordEtaAccuracy(REPO, 'ci', 100, 60, AT)).toBe(true);
    expect(h.etaAccuracy(REPO, 'ci')).toEqual({ medianAbsErrSecs: 40, n: 1 });
  });

  it('5%-of-predicted boundary dominates the floor for large predictions', () => {
    // predicted 8534s → threshold max(60, ~426.7) = ~426.7s
    expect(h.recordEtaAccuracy(REPO, 'queue', 8534, 400, AT)).toBe(false); // ≥60 but <5%
    expect(h.recordEtaAccuracy(REPO, 'queue', 8534, 426, AT)).toBe(false); // just under 5%
    expect(h.recordEtaAccuracy(REPO, 'queue', 8534, 427, AT)).toBe(true);  // just over 5%
    expect(h.etaAccuracy(REPO, 'queue')).toEqual({ medianAbsErrSecs: 8534 - 427, n: 1 });
    // exact-threshold inclusivity on a float-exact pair: 2000 × 0.05 = 100
    expect(h.recordEtaAccuracy(REPO, 'queue', 2000, 100, AT)).toBe(true);
  });
});

describe('eta accuracy windowed read (issue #35 calibration panel)', () => {
  it('returns rows at/after since with full fields, ordered repo → stage → observed_at', () => {
    h.recordEtaAccuracy('octo/bridge', 'ci', 100, 150, '2026-06-10T10:30:00Z');
    h.recordEtaAccuracy(REPO, 'queue', 600, 660, '2026-06-10T10:20:00Z');
    h.recordEtaAccuracy(REPO, 'ci', 300, 360, '2026-06-10T10:10:00Z');
    h.recordEtaAccuracy(REPO, 'ci', 200, 180, '2026-06-10T10:00:00Z');
    h.recordEtaAccuracy(REPO, 'ci', 400, 420, '2026-06-09T10:00:00Z'); // outside the window
    expect(h.etaAccuracySince('2026-06-10T00:00:00Z')).toEqual([
      { repo: REPO, stage: 'ci', predictedSecs: 200, actualSecs: 180, at: '2026-06-10T10:00:00Z' },
      { repo: REPO, stage: 'ci', predictedSecs: 300, actualSecs: 360, at: '2026-06-10T10:10:00Z' },
      { repo: REPO, stage: 'queue', predictedSecs: 600, actualSecs: 660, at: '2026-06-10T10:20:00Z' },
      { repo: 'octo/bridge', stage: 'ci', predictedSecs: 100, actualSecs: 150, at: '2026-06-10T10:30:00Z' },
    ]);
    expect(h.etaAccuracySince('2026-06-11T00:00:00Z')).toEqual([]);
  });

  it('the since-read hits the observed_at index (no full-table scan)', () => {
    const plan = (h as unknown as { db: import('better-sqlite3').Database }).db
      .prepare("EXPLAIN QUERY PLAN SELECT repo FROM eta_accuracy WHERE observed_at >= '2026'")
      .all() as { detail: string }[];
    expect(plan.map((r) => r.detail).join('; ')).toMatch(/USING INDEX idx_eta_accuracy_observed/);
  });
});

describe('calibrationFactor (issue #35 conformal-lite ranges)', () => {
  const at = (i: number) => `2026-06-10T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;

  it('null under 10 usable rows', () => {
    expect(h.calibrationFactor(REPO, 'ci')).toBeNull();
    for (let i = 0; i < 9; i++) h.recordEtaAccuracy(REPO, 'ci', 100, 120, at(i));
    expect(h.calibrationFactor(REPO, 'ci')).toBeNull(); // n=9
    h.recordEtaAccuracy(REPO, 'ci', 100, 120, at(9));
    expect(h.calibrationFactor(REPO, 'ci')).toBeCloseTo(1.2, 10); // n=10
  });

  it('returns the 90th percentile of actual/predicted ratios over the last 30 rows', () => {
    // ratios 1.01..1.30 — p90 over 30 sorted values = the 27th value = 1.27
    for (let i = 0; i < 30; i++) h.recordEtaAccuracy(REPO, 'ci', 100, 101 + i, at(i));
    expect(h.calibrationFactor(REPO, 'ci')).toBeCloseTo(1.27, 10);
  });

  it('older rows beyond the last 30 fall out of the window', () => {
    // 10 ancient rows with huge ratios, then 30 recent mild ones — p90 must come from the recent 30
    for (let i = 0; i < 10; i++) h.recordEtaAccuracy(REPO, 'queue', 100, 1000, at(i));
    for (let i = 0; i < 30; i++) h.recordEtaAccuracy(REPO, 'queue', 100, 110, at(10 + i));
    expect(h.calibrationFactor(REPO, 'queue')).toBeCloseTo(1.1, 10);
  });

  it('is scoped per (repo, stage)', () => {
    for (let i = 0; i < 10; i++) h.recordEtaAccuracy(REPO, 'ci', 100, 150, at(i));
    expect(h.calibrationFactor(REPO, 'queue')).toBeNull();
    expect(h.calibrationFactor('other/repo', 'ci')).toBeNull();
    expect(h.calibrationFactor(REPO, 'ci')).toBeCloseTo(1.5, 10);
  });

  it('rows with predicted=0 are excluded (no division by zero) and do not count toward n', () => {
    for (let i = 0; i < 9; i++) h.recordEtaAccuracy(REPO, 'ci', 100, 120, at(i));
    h.recordEtaAccuracy(REPO, 'ci', 0, 120, at(9)); // recordable (predicted ≥ 0) but unusable
    expect(h.calibrationFactor(REPO, 'ci')).toBeNull(); // 9 usable, not 10
    h.recordEtaAccuracy(REPO, 'ci', 100, 120, at(10));
    expect(h.calibrationFactor(REPO, 'ci')).toBeCloseTo(1.2, 10);
  });
});

describe('runner waits (W2)', () => {
  const at = (i: number) => `2026-06-10T10:${String(i).padStart(2, '0')}:00Z`;

  it('records and returns the median of the last 20 per (repo, name, event)', () => {
    [60, 120, 600].forEach((w, i) => h.recordRunnerWait(REPO, 'build', 'pull_request', w, at(i)));
    expect(h.expectedRunnerWait(REPO, 'build', 'pull_request')).toBe(120);
    expect(h.expectedRunnerWait(REPO, 'build', 'merge_group')).toBeNull();
    expect(h.expectedRunnerWait(REPO, 'other', 'pull_request')).toBeNull();
    expect(h.expectedRunnerWait('other/repo', 'build', 'pull_request')).toBeNull();
  });

  it('caps the name-level window at the last 20 samples', () => {
    // 10 old samples of 1000s, then 20 newer samples of 100s — median must be 100
    for (let i = 0; i < 10; i++) h.recordRunnerWait(REPO, 'build', 'pull_request', 1000, at(i));
    for (let i = 0; i < 20; i++) h.recordRunnerWait(REPO, 'build', 'pull_request', 100, at(20 + i));
    expect(h.expectedRunnerWait(REPO, 'build', 'pull_request')).toBe(100);
  });

  it('ignores duplicate ingestion (same started_at)', () => {
    expect(h.recordRunnerWait(REPO, 'build', 'pull_request', 60, at(0))).toBe(true);
    expect(h.recordRunnerWait(REPO, 'build', 'pull_request', 999, at(0))).toBe(true); // ignored row
    expect(h.expectedRunnerWait(REPO, 'build', 'pull_request')).toBe(60);
  });

  it('accepts zero waits (same-second warm pickups), rejects negative and non-finite', () => {
    expect(h.recordRunnerWait(REPO, 'build', 'pull_request', 0, at(0))).toBe(true);
    expect(h.recordRunnerWait(REPO, 'build', 'pull_request', -5, at(1))).toBe(false);
    expect(h.recordRunnerWait(REPO, 'build', 'pull_request', NaN, at(2))).toBe(false);
    expect(h.expectedRunnerWait(REPO, 'build', 'pull_request')).toBe(0);
  });

  it('expectedRunnerWaitForEvent pools the last 50 across names as a fallback (n ≥ 3)', () => {
    h.recordRunnerWait(REPO, 'build', 'pull_request', 60, at(0));
    h.recordRunnerWait(REPO, 'static-checks / TypeScript', 'pull_request', 120, at(1));
    h.recordRunnerWait(REPO, 'ci', 'pull_request', 600, at(2));
    h.recordRunnerWait(REPO, 'ci', 'merge_group', 9, at(3)); // other event — excluded
    expect(h.expectedRunnerWaitForEvent(REPO, 'pull_request')).toBe(120);
    expect(h.expectedRunnerWaitForEvent(REPO, 'push')).toBeNull();
    expect(h.expectedRunnerWaitForEvent('other/repo', 'pull_request')).toBeNull();
  });

  it('expectedRunnerWaitForEvent returns null below 3 samples (too thin to generalize)', () => {
    h.recordRunnerWait(REPO, 'build', 'pull_request', 60, at(0));
    expect(h.expectedRunnerWaitForEvent(REPO, 'pull_request')).toBeNull(); // n=1
    h.recordRunnerWait(REPO, 'ci', 'pull_request', 120, at(1));
    expect(h.expectedRunnerWaitForEvent(REPO, 'pull_request')).toBeNull(); // n=2
    h.recordRunnerWait(REPO, 'mobile', 'pull_request', 90, at(2));
    expect(h.expectedRunnerWaitForEvent(REPO, 'pull_request')).toBe(90);   // n=3
  });
});

describe('observed_pools (ground-truth job→pool mapping)', () => {
  it('records and reads back a pool observation', () => {
    h.recordObservedPool(REPO, 'DB Migrations', 'pull_request',
      { pool: 'kindash-arc', githubHosted: false });
    expect(h.observedPool(REPO, 'DB Migrations', 'pull_request'))
      .toEqual({ pool: 'kindash-arc', githubHosted: false });
  });

  it('returns null for an unobserved (repo, name, event)', () => {
    expect(h.observedPool(REPO, 'unseen', 'pull_request')).toBeNull();
  });

  describe('observedPoolWithFallback (sibling non-merge_group borrow)', () => {
    it('push borrows the pull_request pool when push has no exact observation', () => {
      h.recordObservedPool(REPO, 'fast-checks / ESLint', 'pull_request',
        { pool: 'kindash-arc-spot', githubHosted: false });
      // push was never fetched by the learning loop → exact miss → borrow PR's
      expect(h.observedPool(REPO, 'fast-checks / ESLint', 'push')).toBeNull();
      expect(h.observedPoolWithFallback(REPO, 'fast-checks / ESLint', 'push'))
        .toEqual({ pool: 'kindash-arc-spot', githubHosted: false });
    });

    it('exact observation always wins over the sibling borrow', () => {
      h.recordObservedPool(REPO, 'j', 'pull_request', { pool: 'arc', githubHosted: false });
      h.recordObservedPool(REPO, 'j', 'push', { pool: 'special', githubHosted: false });
      expect(h.observedPoolWithFallback(REPO, 'j', 'push')?.pool).toBe('special');
    });

    it('borrows the github-hosted flag too (push of an ubuntu-latest job)', () => {
      h.recordObservedPool(REPO, 'Changed scope', 'pull_request',
        { pool: 'ubuntu-latest', githubHosted: true });
      expect(h.observedPoolWithFallback(REPO, 'Changed scope', 'push'))
        .toEqual({ pool: 'ubuntu-latest', githubHosted: true });
    });

    it('merge_group does NOT borrow (runs-on ternary can differ)', () => {
      h.recordObservedPool(REPO, 'k', 'pull_request', { pool: 'arc-spot', githubHosted: false });
      expect(h.observedPoolWithFallback(REPO, 'k', 'merge_group')).toBeNull();
    });

    it('returns null when no observation exists for the job at all', () => {
      expect(h.observedPoolWithFallback(REPO, 'never-seen', 'push')).toBeNull();
    });
  });

  it('keys on (repo, check_name, event) — same name, different event are distinct', () => {
    h.recordObservedPool(REPO, 'build', 'pull_request',
      { pool: 'kindash-arc', githubHosted: false });
    h.recordObservedPool(REPO, 'build', 'merge_group',
      { pool: 'kindash-ondemand', githubHosted: false });
    expect(h.observedPool(REPO, 'build', 'pull_request')?.pool).toBe('kindash-arc');
    expect(h.observedPool(REPO, 'build', 'merge_group')?.pool).toBe('kindash-ondemand');
  });

  it('upserts: a re-observation replaces pool/githubHosted and refreshes last_seen', () => {
    h.recordObservedPool(REPO, 'build', 'pull_request',
      { pool: 'kindash-arc', githubHosted: false }, '2026-01-01T00:00:00.000Z');
    h.recordObservedPool(REPO, 'build', 'pull_request',
      { pool: 'ubuntu-latest', githubHosted: true }, '2026-02-01T00:00:00.000Z');
    expect(h.observedPool(REPO, 'build', 'pull_request'))
      .toEqual({ pool: 'ubuntu-latest', githubHosted: true });
    const all = h.observedPoolsByRepo();
    const row = all.find((r) => r.repo === REPO && r.checkName === 'build' && r.event === 'pull_request');
    expect(row?.lastSeen).toBe('2026-02-01T00:00:00.000Z');
  });

  it('stores github_hosted as a boolean round-trip', () => {
    h.recordObservedPool(REPO, 'lint', 'pull_request',
      { pool: 'ubuntu-latest', githubHosted: true });
    expect(h.observedPool(REPO, 'lint', 'pull_request')?.githubHosted).toBe(true);
  });

  it('observedPoolsByRepo lists every observation', () => {
    h.recordObservedPool(REPO, 'a', 'pull_request', { pool: 'p1', githubHosted: false });
    h.recordObservedPool(REPO, 'b', 'merge_group', { pool: 'p2', githubHosted: true });
    h.recordObservedPool('other/repo', 'c', 'push', { pool: 'p3', githubHosted: false });
    const rows = h.observedPoolsByRepo();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.pool).sort()).toEqual(['p1', 'p2', 'p3']);
  });
});

// ---------------------------------------------------------------------------
// Round 12 (metrics tab): merged_prs.created_at migration + state samples
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('merged_prs created_at migration', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function preMigrationDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'prdash-hist-'));
    dirs.push(dir);
    const path = join(dir, 'history.db');
    // exact old merged_prs shape (no created_at column)
    const raw = new Database(path);
    raw.exec(`CREATE TABLE merged_prs (
      repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      merged_at TEXT NOT NULL, merge_commit_sha TEXT,
      qa_live_at TEXT, prod_live_at TEXT,
      PRIMARY KEY (repo, number)
    );`);
    raw.prepare('INSERT INTO merged_prs (repo, number, title, url, merged_at, merge_commit_sha) VALUES (?,?,?,?,?,?)')
      .run(REPO, 1, 'old row', 'u', '2026-06-10T10:00:00Z', 'abc');
    raw.close();
    return path;
  }

  it('opens a pre-existing DB, keeps old rows readable (createdAt null), accepts the new column', () => {
    const path = preMigrationDb();
    const store = new HistoryStore(path);
    const old = store.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))
      .find((r) => r.number === 1)!;
    expect(old.title).toBe('old row');
    expect(old.createdAt).toBeNull();
    expect(old.firstGreenAt).toBeNull(); // issue #44 columns migrate the same way
    expect(old.enqueuedAt).toBeNull();
    store.upsertMergedPr({ repo: REPO, number: 2, title: 'new row', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'def', createdAt: '2026-06-09T12:00:00Z',
      firstGreenAt: '2026-06-09T13:00:00Z', enqueuedAt: '2026-06-10T11:00:00Z' });
    const fresh = store.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))
      .find((r) => r.number === 2)!;
    expect(fresh.createdAt).toBe('2026-06-09T12:00:00Z');
    expect(fresh.firstGreenAt).toBe('2026-06-09T13:00:00Z');
    expect(fresh.enqueuedAt).toBe('2026-06-10T11:00:00Z');
    store.close();
  });

  it('re-opening an already-migrated DB does not throw (ALTER is idempotent via try/catch)', () => {
    const path = preMigrationDb();
    new HistoryStore(path).close();
    const again = new HistoryStore(path);
    expect(again.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))).toHaveLength(1);
    again.close();
  });
});

describe('addColumnIfMissing (migration helper)', () => {
  it('adds the column once and is a no-op when it already exists (duplicate swallowed)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (a TEXT)');
    addColumnIfMissing(db, 't', 'b TEXT');
    expect(() => addColumnIfMissing(db, 't', 'b TEXT')).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(t)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['a', 'b']);
    db.close();
  });

  it('rethrows non-duplicate-column SQLite errors instead of swallowing them', () => {
    const db = new Database(':memory:');
    // no such table → must surface, NOT be mistaken for "column already exists"
    expect(() => addColumnIfMissing(db, 'missing_table', 'b TEXT')).toThrow(/no such table/i);
    db.close();
  });
});

describe('metrics windowed queries use index support (no full-table scans)', () => {
  it('the since-queries on the two large tables hit completed_at/started_at indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prdash-idx-'));
    const path = join(dir, 'history.db');
    new HistoryStore(path).close();
    const raw = new Database(path, { readonly: true });
    try {
      const plan = (sql: string): string =>
        (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
          .map((r) => r.detail).join('; ');
      expect(plan("SELECT repo FROM check_durations WHERE conclusion='SUCCESS' AND completed_at >= '2026'"))
        .toMatch(/USING INDEX idx_durations_completed/);
      expect(plan("SELECT repo FROM runner_waits WHERE started_at >= '2026'"))
        .toMatch(/USING INDEX idx_runner_waits_started/);
    } finally {
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('check_durations head_sha + run_attempt (issue #34)', () => {
  it('migrates a pre-existing DB: columns added, old rows intact with NULLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prdash-mig-'));
    const path = join(dir, 'history.db');
    const raw = new Database(path);
    // pre-#34 schema (no head_sha / run_attempt)
    raw.exec(`CREATE TABLE check_durations (
      repo TEXT NOT NULL, check_name TEXT NOT NULL, event TEXT NOT NULL,
      duration_secs REAL NOT NULL, completed_at TEXT NOT NULL, conclusion TEXT NOT NULL,
      UNIQUE(repo, check_name, event, completed_at));`);
    raw.prepare('INSERT INTO check_durations VALUES (?,?,?,?,?,?)')
      .run(REPO, 'Build', 'pull_request', 120, '2026-06-10T10:02:00Z', 'SUCCESS');
    raw.close();

    const store = new HistoryStore(path);
    try {
      // legacy row still readable through the normal query paths
      expect(store.expected(REPO, 'Build', 'pull_request')!.n).toBe(1);
      // new ingestion records sha + attempt alongside the legacy row
      expect(store.recordCheckDuration(REPO, 'Build', 'pull_request',
        '2026-06-11T10:00:00Z', '2026-06-11T10:02:00Z', 'SUCCESS', 'abc123', 2)).toBe(true);
    } finally {
      store.close();
    }
    const check = new Database(path, { readonly: true });
    try {
      const rows = check.prepare(
        'SELECT head_sha, run_attempt FROM check_durations ORDER BY completed_at').all() as
        { head_sha: string | null; run_attempt: number | null }[];
      expect(rows).toEqual([
        { head_sha: null, run_attempt: null },       // legacy row
        { head_sha: 'abc123', run_attempt: 2 },      // new ingestion
      ]);
    } finally {
      check.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omitted or empty head_sha and omitted run_attempt store NULL on a fresh DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prdash-sha-'));
    const path = join(dir, 'history.db');
    const store = new HistoryStore(path);
    store.recordCheckDuration(REPO, 'Build', 'pull_request',
      '2026-06-11T10:00:00Z', '2026-06-11T10:02:00Z', 'SUCCESS');                 // omitted
    store.recordCheckDuration(REPO, 'Build', 'pull_request',
      '2026-06-11T11:00:00Z', '2026-06-11T11:02:00Z', 'SUCCESS', '', null);       // placeholder ''
    store.close();
    const check = new Database(path, { readonly: true });
    try {
      const rows = check.prepare('SELECT head_sha, run_attempt FROM check_durations').all() as
        { head_sha: string | null; run_attempt: number | null }[];
      expect(rows).toEqual([
        { head_sha: null, run_attempt: null },
        { head_sha: null, run_attempt: null },
      ]);
    } finally {
      check.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('UNIQUE dedupe is unchanged: a re-ingest of the same (repo,name,event,completed_at) is ignored', () => {
    expect(h.recordCheckDuration(REPO, 'Build', 'pull_request',
      '2026-06-11T10:00:00Z', '2026-06-11T10:02:00Z', 'SUCCESS', 'sha-a', 1)).toBe(true);
    // same key, different sha/attempt → INSERT OR IGNORE keeps the first row
    expect(h.recordCheckDuration(REPO, 'Build', 'pull_request',
      '2026-06-11T10:00:00Z', '2026-06-11T10:02:00Z', 'SUCCESS', 'sha-b', 2)).toBe(true);
    expect(h.expected(REPO, 'Build', 'pull_request')!.n).toBe(1);
  });
});

describe('merged_prs createdAt upsert semantics', () => {
  it('round-trips createdAt and treats an absent createdAt as null', () => {
    h.upsertMergedPr({ repo: REPO, number: 10, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'x', createdAt: '2026-06-08T09:00:00Z' });
    h.upsertMergedPr({ repo: REPO, number: 11, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'y' });
    const recs = h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'));
    expect(recs.find((r) => r.number === 10)!.createdAt).toBe('2026-06-08T09:00:00Z');
    expect(recs.find((r) => r.number === 11)!.createdAt).toBeNull();
  });

  it('re-upsert without createdAt does not null-out a known created_at', () => {
    h.upsertMergedPr({ repo: REPO, number: 12, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'x', createdAt: '2026-06-08T09:00:00Z' });
    h.upsertMergedPr({ repo: REPO, number: 12, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'x' });
    expect(h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))[0]!.createdAt)
      .toBe('2026-06-08T09:00:00Z');
  });

  it('re-upsert with createdAt fills a previously-null created_at', () => {
    h.upsertMergedPr({ repo: REPO, number: 13, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'x' });
    h.upsertMergedPr({ repo: REPO, number: 13, title: 't', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'x', createdAt: '2026-06-08T09:00:00Z' });
    expect(h.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))[0]!.createdAt)
      .toBe('2026-06-08T09:00:00Z');
  });
});

describe('state samples (metrics trends)', () => {
  const COUNTS = { open: 5, ci: 2, queue: 1, failed: 0 };

  it('records and reads back window-scoped samples, oldest first', () => {
    h.recordStateSample(REPO, '2026-06-10T10:00:00Z', COUNTS);
    h.recordStateSample(REPO, '2026-06-10T10:20:00Z', { open: 6, ci: 3, queue: 0, failed: 1 });
    const rows = h.stateSamplesSince('2026-06-10T00:00:00Z');
    expect(rows).toEqual([
      { repo: REPO, at: '2026-06-10T10:00:00Z', open: 5, ci: 2, queue: 1, failed: 0 },
      { repo: REPO, at: '2026-06-10T10:20:00Z', open: 6, ci: 3, queue: 0, failed: 1 },
    ]);
    expect(h.stateSamplesSince('2026-06-11T00:00:00Z')).toEqual([]);
  });

  it('throttles to at most one row per 15 minutes per repo', () => {
    expect(h.recordStateSample(REPO, '2026-06-10T10:00:00Z', COUNTS)).toBe(true);
    expect(h.recordStateSample(REPO, '2026-06-10T10:05:00Z', COUNTS)).toBe(false);
    expect(h.recordStateSample(REPO, '2026-06-10T10:14:59Z', COUNTS)).toBe(false);
    expect(h.recordStateSample(REPO, '2026-06-10T10:15:00Z', COUNTS)).toBe(true);
    expect(h.stateSamplesSince('2026-06-01T00:00:00Z')).toHaveLength(2);
  });

  it('throttle windows are independent per repo', () => {
    expect(h.recordStateSample(REPO, '2026-06-10T10:00:00Z', COUNTS)).toBe(true);
    expect(h.recordStateSample('octo/bridge', '2026-06-10T10:01:00Z', COUNTS)).toBe(true);
    expect(h.recordStateSample(REPO, '2026-06-10T10:02:00Z', COUNTS)).toBe(false);
  });

  it('prunes samples older than 90 days when a new sample lands', () => {
    h.recordStateSample(REPO, '2026-01-01T10:00:00Z', COUNTS);
    h.recordStateSample(REPO, '2026-06-10T10:00:00Z', COUNTS);
    const rows = h.stateSamplesSince('2025-01-01T00:00:00Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.at).toBe('2026-06-10T10:00:00Z');
  });
});

describe('distinctRepos (repo toggles)', () => {
  it('is empty on a fresh store', () => {
    expect(h.distinctRepos()).toEqual([]);
  });

  it('unions repos across check_durations, merged_prs, and state_samples — sorted, deduped', () => {
    h.recordCheckDuration('acme/a', 'Build', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T10:05:00Z', 'SUCCESS');
    h.upsertMergedPr({ repo: 'acme/b', number: 1, title: 't', url: 'u',
      mergedAt: '2026-06-10T10:00:00Z', mergeCommitSha: null });
    h.recordStateSample('octo/c', '2026-06-10T10:00:00Z', { open: 1, ci: 0, queue: 0, failed: 0 });
    // 'acme/a' also appears in state_samples — must dedupe
    h.recordStateSample('acme/a', '2026-06-10T10:00:00Z', { open: 1, ci: 0, queue: 0, failed: 0 });
    expect(h.distinctRepos()).toEqual(['acme/a', 'acme/b', 'octo/c']);
  });
});

// ---------------------------------------------------------------------------
// Flake radar (issue #37) — flakeStats over check_durations (sha+attempt-aware)
// ---------------------------------------------------------------------------

describe('flakeStats (issue #37)', () => {
  const REPO2 = 'acme/widgets';
  const SINCE = '2026-06-01T00:00:00Z';
  /** Insert one check_durations row with full sha/attempt identity. */
  const row = (conclusion: string, sha: string, attempt: number | null, completedAt: string,
    name = 'e2e', event = 'merge_group', repo = REPO2) =>
    h.recordCheckDuration(repo, name, event,
      new Date(Date.parse(completedAt) - 60_000).toISOString(), completedAt,
      conclusion, sha, attempt);

  it('attempt-based: FAILURE then SUCCESS at a higher attempt on the SAME sha = one flake event', () => {
    row('FAILURE', 'sha1', 1, '2026-06-10T10:00:00Z');
    row('SUCCESS', 'sha1', 2, '2026-06-10T10:20:00Z');
    const [s] = h.flakeStats(REPO2, SINCE);
    expect(s).toMatchObject({ name: 'e2e', event: 'merge_group',
      flakeEvents: 1, totalRuns: 2, flakeRatePct: 50 });
    expect(s!.flakeAts).toEqual(['2026-06-10T10:00:00Z']);
  });

  it('TIMED_OUT and STARTUP_FAILURE are failing-class; CANCELLED is not', () => {
    row('TIMED_OUT', 'sha1', 1, '2026-06-10T10:00:00Z');
    row('SUCCESS', 'sha1', 2, '2026-06-10T10:20:00Z');
    row('STARTUP_FAILURE', 'sha2', 1, '2026-06-10T11:00:00Z');
    row('SUCCESS', 'sha2', 2, '2026-06-10T11:20:00Z');
    row('CANCELLED', 'sha3', 1, '2026-06-10T12:00:00Z'); // spot kill — not a flake
    row('SUCCESS', 'sha3', 2, '2026-06-10T12:20:00Z');
    const [s] = h.flakeStats(REPO2, SINCE);
    expect(s).toMatchObject({ flakeEvents: 2, totalRuns: 6 });
  });

  it('same-sha later SUCCESS without attempts (timestamp order) is a flake', () => {
    row('FAILURE', 'sha1', null, '2026-06-10T10:00:00Z');
    row('SUCCESS', 'sha1', null, '2026-06-10T10:30:00Z');
    const [s] = h.flakeStats(REPO2, SINCE);
    expect(s).toMatchObject({ flakeEvents: 1, totalRuns: 2, flakeRatePct: 50 });
  });

  it('failure followed only by SUCCESS on a NEW sha is NOT a flake (real failure, then fixed)', () => {
    row('FAILURE', 'shaA', 1, '2026-06-10T10:00:00Z');
    row('SUCCESS', 'shaB', 1, '2026-06-10T11:00:00Z');
    const [s] = h.flakeStats(REPO2, SINCE);
    expect(s).toMatchObject({ flakeEvents: 0, totalRuns: 2, flakeRatePct: 0 });
  });

  it('SUCCESS at a LOWER attempt than the failure does not resolve it (regression, not flake)', () => {
    row('SUCCESS', 'sha1', 1, '2026-06-10T10:00:00Z');
    row('FAILURE', 'sha1', 2, '2026-06-10T10:30:00Z');
    const [s] = h.flakeStats(REPO2, SINCE);
    expect(s!.flakeEvents).toBe(0);
  });

  it('rows without head_sha (pre-#34 history) are excluded entirely', () => {
    h.recordCheckDuration(REPO2, 'e2e', 'merge_group',
      '2026-06-10T09:59:00Z', '2026-06-10T10:00:00Z', 'FAILURE'); // no sha
    expect(h.flakeStats(REPO2, SINCE)).toEqual([]);
  });

  it('window: rows before `since` are ignored', () => {
    row('FAILURE', 'sha1', 1, '2026-05-01T10:00:00Z');
    row('SUCCESS', 'sha1', 2, '2026-05-01T10:20:00Z');
    expect(h.flakeStats(REPO2, '2026-06-01T00:00:00Z')).toEqual([]);
  });

  it('totalRuns counts distinct (sha, attempt) — duplicate attempt rows collapse, names with spaces survive', () => {
    const name = 'fast-checks / ESLint';
    row('FAILURE', 'sha1', 1, '2026-06-10T10:00:00Z', name);
    row('FAILURE', 'sha1', 1, '2026-06-10T10:00:01Z', name); // same run re-observed
    row('SUCCESS', 'sha1', 2, '2026-06-10T10:20:00Z', name);
    const [s] = h.flakeStats(REPO2, SINCE);
    expect(s!.name).toBe(name);
    expect(s!.totalRuns).toBe(2);
  });

  it('stats are per (check, event); flakeStatsByRepo splits per repo', () => {
    row('FAILURE', 'sha1', 1, '2026-06-10T10:00:00Z', 'e2e', 'merge_group');
    row('SUCCESS', 'sha1', 2, '2026-06-10T10:20:00Z', 'e2e', 'merge_group');
    row('SUCCESS', 'sha1', 1, '2026-06-10T10:20:00Z', 'e2e', 'pull_request');
    row('SUCCESS', 'shaX', 1, '2026-06-10T10:20:00Z', 'e2e', 'merge_group', 'octo/bridge');
    const stats = h.flakeStats(REPO2, SINCE);
    expect(stats.map((s) => `${s.name}/${s.event}`).sort())
      .toEqual(['e2e/merge_group', 'e2e/pull_request']);
    const byRepo = h.flakeStatsByRepo(SINCE);
    expect([...byRepo.keys()].sort()).toEqual(['acme/widgets', 'octo/bridge']);
  });
});

// ---------------------------------------------------------------------------
// Train-killer ledger (issue #38) — group_failures
// ---------------------------------------------------------------------------

describe('group failures (issue #38)', () => {
  const REPO2 = 'acme/widgets';

  it('records once per (repo, group sha, check) — re-ingestion dedupes', () => {
    expect(h.recordGroupFailure(REPO2, 'e2e', 'oid1', '2026-06-10T10:00:00Z')).toBe(true);
    expect(h.recordGroupFailure(REPO2, 'e2e', 'oid1', '2026-06-10T10:05:00Z')).toBe(false);
    expect(h.recordGroupFailure(REPO2, 'unit', 'oid1', '2026-06-10T10:00:00Z')).toBe(true);
    expect(h.recordGroupFailure(REPO2, 'e2e', 'oid2', '2026-06-10T11:00:00Z')).toBe(true);
    expect(h.groupFailuresSince('2026-06-01T00:00:00Z')).toHaveLength(3);
  });

  it('rejects empty identity fields', () => {
    expect(h.recordGroupFailure(REPO2, '', 'oid1', '2026-06-10T10:00:00Z')).toBe(false);
    expect(h.recordGroupFailure(REPO2, 'e2e', '', '2026-06-10T10:00:00Z')).toBe(false);
    expect(h.recordGroupFailure(REPO2, 'e2e', 'oid1', '')).toBe(false);
  });

  it('groupFailuresSince windows on observed_at and maps fields', () => {
    h.recordGroupFailure(REPO2, 'e2e', 'old', '2026-05-01T10:00:00Z');
    h.recordGroupFailure(REPO2, 'e2e', 'new', '2026-06-10T10:00:00Z');
    const rows = h.groupFailuresSince('2026-06-01T00:00:00Z');
    expect(rows).toEqual([{ repo: REPO2, checkName: 'e2e', groupSha: 'new',
      at: '2026-06-10T10:00:00Z' }]);
  });
});

// ---------------------------------------------------------------------------
// Issues #39/#40: queue ops counts + train-duration samples
// ---------------------------------------------------------------------------

describe('queue ops rollups (issues #39/#40)', () => {
  it('groupRunSamples returns the last-20 durations, newest first', () => {
    for (let i = 0; i < 25; i++) {
      h.recordGroupRun(REPO, 100 + i, `2026-06-${String(1 + Math.floor(i / 4)).padStart(2, '0')}T1${i % 4}:00:00Z`);
    }
    const samples = h.groupRunSamples(REPO);
    expect(samples).toHaveLength(20);
    expect(samples[0]).toBe(124); // newest completed_at first
    expect(h.groupRunSamples('other/repo')).toEqual([]);
  });

  it('countGroupRuns is windowed and repo-scoped', () => {
    h.recordGroupRun(REPO, 600, '2026-06-10T10:00:00Z');
    h.recordGroupRun(REPO, 700, '2026-06-11T10:00:00Z');
    h.recordGroupRun(REPO, 800, '2026-06-12T10:00:00Z');
    h.recordGroupRun('other/repo', 900, '2026-06-12T10:00:00Z');
    expect(h.countGroupRuns(REPO, '2026-06-11T00:00:00Z')).toBe(2);
    expect(h.countGroupRuns(REPO, '2026-06-13T00:00:00Z')).toBe(0);
    expect(h.countGroupRuns('other/repo', '2026-06-11T00:00:00Z')).toBe(1);
  });

  it('countGroupEjects counts DISTINCT ejected group shas (multi-check eject = 1)', () => {
    h.recordGroupFailure(REPO, 'e2e', 'oidA', '2026-06-12T10:00:00Z');
    h.recordGroupFailure(REPO, 'unit', 'oidA', '2026-06-12T10:01:00Z'); // same group
    h.recordGroupFailure(REPO, 'e2e', 'oidB', '2026-06-12T11:00:00Z');
    h.recordGroupFailure(REPO, 'e2e', 'oidOld', '2026-06-01T10:00:00Z'); // outside window
    expect(h.countGroupEjects(REPO, '2026-06-11T00:00:00Z')).toBe(2);
    expect(h.countGroupEjects('other/repo', '2026-06-11T00:00:00Z')).toBe(0);
  });
});

describe('durationP99 (issue #48 timeout lint — last-50 SUCCESS p99)', () => {
  it('returns the p99 (≈max) over recent SUCCESS samples with the sample count', () => {
    // durations 60..600 in steps of 60 (completed 10:01..10:10)
    for (let i = 1; i <= 10; i++) {
      h.recordCheckDuration(REPO, 'CI', 'pull_request', '2026-06-10T10:00:00Z',
        `2026-06-10T10:${String(i).padStart(2, '0')}:00Z`, 'SUCCESS'); // i*60 secs
    }
    const r = h.durationP99(REPO, 'CI', 'pull_request');
    expect(r).toEqual({ p99Secs: 600, n: 10 });
  });

  it('windows to the most recent 50 samples (old outliers age out)', () => {
    // one huge ancient sample, then 50 recent small ones — the p99 must not see the outlier
    h.recordCheckDuration(REPO, 'CI', 'pull_request',
      '2026-06-01T00:00:00Z', '2026-06-01T10:00:00Z', 'SUCCESS'); // 36000s, oldest
    for (let i = 0; i < 50; i++) {
      const m = String(Math.floor(i / 10)).padStart(2, '0');
      const s = String((i % 10) * 6).padStart(2, '0');
      h.recordCheckDuration(REPO, 'CI', 'pull_request',
        `2026-06-10T10:${m}:${s}Z`, `2026-06-10T11:${m}:${s}Z`, 'SUCCESS'); // 3600s each
    }
    const r = h.durationP99(REPO, 'CI', 'pull_request');
    expect(r).toEqual({ p99Secs: 3600, n: 50 });
  });

  it('ignores non-SUCCESS conclusions and other events; null when no samples', () => {
    h.recordCheckDuration(REPO, 'CI', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T12:00:00Z', 'FAILURE');
    h.recordCheckDuration(REPO, 'CI', 'merge_group',
      '2026-06-10T10:00:00Z', '2026-06-10T10:01:00Z', 'SUCCESS');
    expect(h.durationP99(REPO, 'CI', 'pull_request')).toBeNull();
    expect(h.durationP99(REPO, 'CI', 'merge_group')).toEqual({ p99Secs: 60, n: 1 });
  });
});

describe('duration regression reads (issue #41)', () => {
  /** Insert `n` SUCCESS samples of `secs` for (name, event), one minute apart,
   *  newest ending at base + n minutes. */
  const seed = (name: string, event: string, n: number, secs: number,
    baseIso = '2026-06-10T10:00:00Z', repo = REPO) => {
    const base = Date.parse(baseIso);
    for (let i = 0; i < n; i++) {
      const start = new Date(base + i * 60_000).toISOString();
      const end = new Date(base + i * 60_000 + secs * 1000).toISOString();
      h.recordCheckDuration(repo, name, event, start, end, 'SUCCESS');
    }
  };

  it('regressionCandidates lists (repo, check, event) with ≥ minSamples SUCCESS rows + newestAt', () => {
    seed('build-test', 'merge_group', 30, 120);
    seed('lint', 'pull_request', 29, 60); // one short of the bar
    const cands = h.regressionCandidates(30);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.repo).toBe(REPO);
    expect(cands[0]!.name).toBe('build-test');
    expect(cands[0]!.event).toBe('merge_group');
    // newest sample: base + 29min start + 120s duration
    expect(Date.parse(cands[0]!.newestAt)).toBe(Date.parse('2026-06-10T10:31:00Z'));
  });

  it('regressionCandidates ignores non-SUCCESS rows in the count', () => {
    seed('flaky', 'pull_request', 29, 60);
    h.recordCheckDuration(REPO, 'flaky', 'pull_request',
      '2026-06-11T10:00:00Z', '2026-06-11T10:01:00Z', 'FAILURE');
    expect(h.regressionCandidates(30)).toHaveLength(0);
  });

  it('regressionCandidates spans repos (one scan query for the whole DB)', () => {
    seed('build', 'pull_request', 30, 60);
    seed('build', 'pull_request', 30, 60, '2026-06-10T10:00:00Z', 'octo/gizmos');
    expect(h.regressionCandidates(30).map((c) => c.repo).sort())
      .toEqual(['acme/widgets', 'octo/gizmos']);
  });

  it('recentDurationSamples returns newest-first SUCCESS samples with timestamps, capped', () => {
    seed('build-test', 'merge_group', 35, 120);
    h.recordCheckDuration(REPO, 'build-test', 'merge_group',
      '2026-06-11T10:00:00Z', '2026-06-11T10:30:00Z', 'FAILURE'); // newest row, wrong conclusion
    const s = h.recentDurationSamples(REPO, 'build-test', 'merge_group', 30);
    expect(s).toHaveLength(30);
    expect(s.every((x) => x.durationSecs === 120)).toBe(true);
    // newest first — and the FAILURE row is absent
    expect(Date.parse(s[0]!.completedAt)).toBeGreaterThan(Date.parse(s[1]!.completedAt));
    expect(Date.parse(s[0]!.completedAt)).toBe(Date.parse('2026-06-10T10:36:00Z'));
  });
});

// ---------------------------------------------------------------------------
// Fleet telemetry (issues #45/#46/#47): pool column, intervals, reclaim ledger
// ---------------------------------------------------------------------------

describe('runner_waits pool column (issue #45)', () => {
  it('records and reads pool-labeled waits; unlabeled rows are excluded', () => {
    h.recordRunnerWait(REPO, 'unit-tests', 'pull_request', 30, '2026-06-10T10:00:00Z', 'kindash-runner');
    h.recordRunnerWait(REPO, 'legacy-job', 'pull_request', 99, '2026-06-10T10:01:00Z'); // no pool
    const rows = h.runnerPoolWaitsSince('2026-06-10T00:00:00Z');
    expect(rows).toEqual([{ repo: REPO, pool: 'kindash-runner',
      at: '2026-06-10T10:00:00Z', waitSecs: 30 }]);
  });

  it('multi-candidate pools store the joined candidates string verbatim', () => {
    // a `${{ … && 'a' || 'b' }}` runs-on: the caller pre-joins — one composite pool
    h.recordRunnerWait(REPO, 'shards', 'merge_group', 12, '2026-06-10T10:00:00Z',
      'kindash-runner|kindash-ondemand');
    expect(h.runnerPoolWaitsSince('2026-06-10T00:00:00Z')[0]!.pool)
      .toBe('kindash-runner|kindash-ondemand');
  });

  it('the since filter applies and ordering is repo → pool → started_at', () => {
    h.recordRunnerWait(REPO, 'a', 'pull_request', 1, '2026-06-01T10:00:00Z', 'p1'); // out of window
    h.recordRunnerWait(REPO, 'b', 'pull_request', 2, '2026-06-10T11:00:00Z', 'p2');
    h.recordRunnerWait(REPO, 'c', 'pull_request', 3, '2026-06-10T10:00:00Z', 'p1');
    h.recordRunnerWait('octo/gizmos', 'd', 'pull_request', 4, '2026-06-10T09:00:00Z', 'p1');
    expect(h.runnerPoolWaitsSince('2026-06-09T00:00:00Z').map((r) => [r.repo, r.pool, r.waitSecs]))
      .toEqual([[REPO, 'p1', 3], [REPO, 'p2', 2], ['octo/gizmos', 'p1', 4]]);
  });
});

describe('check_durations started_at + intervals (issue #47)', () => {
  it('checkIntervalsSince returns the exact stored interval, every conclusion', () => {
    h.recordCheckDuration(REPO, 'unit-tests', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T10:05:00Z', 'SUCCESS');
    h.recordCheckDuration(REPO, 'e2e', 'merge_group',
      '2026-06-10T10:01:00Z', '2026-06-10T10:02:30Z', 'CANCELLED'); // occupied a runner too
    const rows = h.checkIntervalsSince('2026-06-10T00:00:00Z');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === 'unit-tests')).toMatchObject({
      repo: REPO, event: 'pull_request',
      startedAt: '2026-06-10T10:00:00Z', completedAt: '2026-06-10T10:05:00Z' });
    expect(rows.find((r) => r.name === 'e2e')).toMatchObject({
      startedAt: '2026-06-10T10:01:00Z', completedAt: '2026-06-10T10:02:30Z' });
  });

  it('the since filter applies to completed_at', () => {
    h.recordCheckDuration(REPO, 'old', 'pull_request',
      '2026-06-01T10:00:00Z', '2026-06-01T10:05:00Z', 'SUCCESS');
    expect(h.checkIntervalsSince('2026-06-09T00:00:00Z')).toEqual([]);
  });
});

describe('reclaim ledger (issue #46)', () => {
  const SHA = 'sha-reclaim';
  const rec = (name: string, conclusion: string, attempt: number | null,
    completedAt: string, sha: string | null = SHA) =>
    h.recordCheckDuration(REPO, name, 'merge_group',
      new Date(Date.parse(completedAt) - 60_000).toISOString(), completedAt,
      conclusion, sha, attempt);
  const SINCE = '2026-06-10T00:00:00Z';

  it('CANCELLED at attempt N + SUCCESS on the same sha at N+1 = one reclaim event', () => {
    rec('e2e', 'CANCELLED', 1, '2026-06-10T10:00:00Z');
    rec('e2e', 'SUCCESS', 2, '2026-06-10T10:20:00Z');
    expect(h.reclaimEventsByRepo(SINCE).get(REPO)).toEqual([
      { name: 'e2e', event: 'merge_group', at: '2026-06-10T10:00:00Z' }]);
  });

  it('a SUCCESS at any HIGHER attempt resolves (intermediate attempt also killed)', () => {
    rec('e2e', 'CANCELLED', 1, '2026-06-10T10:00:00Z');
    rec('e2e', 'CANCELLED', 2, '2026-06-10T10:10:00Z');
    rec('e2e', 'SUCCESS', 3, '2026-06-10T10:20:00Z');
    expect(h.reclaimEventsByRepo(SINCE).get(REPO)).toHaveLength(2); // both kills count
  });

  it('FAILURE-class is NOT a reclaim — that is the flake/real-failure domain', () => {
    rec('e2e', 'FAILURE', 1, '2026-06-10T10:00:00Z');
    rec('e2e', 'SUCCESS', 2, '2026-06-10T10:20:00Z');
    expect(h.reclaimEventsByRepo(SINCE).size).toBe(0);
  });

  it('a SUCCESS at the SAME attempt does not resolve a cancellation', () => {
    rec('e2e', 'CANCELLED', 2, '2026-06-10T10:00:00Z');
    rec('e2e', 'SUCCESS', 2, '2026-06-10T10:20:00Z');
    expect(h.reclaimEventsByRepo(SINCE).size).toBe(0);
  });

  it('a SUCCESS on a DIFFERENT sha never resolves (new push ≠ re-run)', () => {
    rec('e2e', 'CANCELLED', 1, '2026-06-10T10:00:00Z');
    rec('e2e', 'SUCCESS', 2, '2026-06-10T10:20:00Z', 'other-sha');
    expect(h.reclaimEventsByRepo(SINCE).size).toBe(0);
  });

  it('rows without head_sha or run_attempt cannot participate', () => {
    rec('no-sha', 'CANCELLED', 1, '2026-06-10T10:00:00Z', null);
    rec('no-sha', 'SUCCESS', 2, '2026-06-10T10:20:00Z', null);
    rec('no-attempt', 'CANCELLED', null, '2026-06-10T11:00:00Z');
    rec('no-attempt', 'SUCCESS', 2, '2026-06-10T11:20:00Z');
    rec('success-no-attempt', 'CANCELLED', 1, '2026-06-10T12:00:00Z');
    rec('success-no-attempt', 'SUCCESS', null, '2026-06-10T12:20:00Z');
    expect(h.reclaimEventsByRepo(SINCE).size).toBe(0);
  });

  it('events are keyed per (check, event, sha) and per repo', () => {
    rec('e2e', 'CANCELLED', 1, '2026-06-10T10:00:00Z');
    rec('e2e', 'SUCCESS', 2, '2026-06-10T10:20:00Z');
    rec('unit', 'CANCELLED', 1, '2026-06-10T10:01:00Z');
    rec('unit', 'SUCCESS', 2, '2026-06-10T10:21:00Z');
    h.recordCheckDuration('octo/gizmos', 'e2e', 'merge_group',
      '2026-06-10T10:00:00Z', '2026-06-10T10:02:00Z', 'CANCELLED', SHA, 1);
    h.recordCheckDuration('octo/gizmos', 'e2e', 'merge_group',
      '2026-06-10T10:20:00Z', '2026-06-10T10:22:00Z', 'SUCCESS', SHA, 2);
    const m = h.reclaimEventsByRepo(SINCE);
    expect(m.get(REPO)!.map((e) => e.name).sort()).toEqual(['e2e', 'unit']);
    expect(m.get('octo/gizmos')).toHaveLength(1);
  });

  it('the window filter applies to completed_at', () => {
    rec('e2e', 'CANCELLED', 1, '2026-06-01T10:00:00Z');
    rec('e2e', 'SUCCESS', 2, '2026-06-01T10:20:00Z');
    expect(h.reclaimEventsByRepo(SINCE).size).toBe(0);
  });
});

describe('fleet-telemetry migrations (issues #45/#47): pre-existing DBs', () => {
  const dirs2: string[] = [];
  afterEach(() => { for (const d of dirs2.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function preFleetDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'prdash-fleet-'));
    dirs2.push(dir);
    const path = join(dir, 'history.db');
    // exact pre-#45/#47 shapes: runner_waits without pool, check_durations
    // without started_at (head_sha/run_attempt already migrated by #34)
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE runner_waits (
        repo TEXT NOT NULL, check_name TEXT NOT NULL, event TEXT NOT NULL,
        wait_secs REAL NOT NULL, started_at TEXT NOT NULL,
        UNIQUE(repo, check_name, event, started_at)
      );
      CREATE TABLE check_durations (
        repo TEXT NOT NULL, check_name TEXT NOT NULL, event TEXT NOT NULL,
        duration_secs REAL NOT NULL, completed_at TEXT NOT NULL, conclusion TEXT NOT NULL,
        head_sha TEXT, run_attempt INTEGER,
        UNIQUE(repo, check_name, event, completed_at)
      );
    `);
    raw.prepare('INSERT INTO runner_waits VALUES (?,?,?,?,?)')
      .run(REPO, 'old-job', 'pull_request', 42, '2026-06-10T10:00:00Z');
    raw.prepare('INSERT INTO check_durations VALUES (?,?,?,?,?,?,?,?)')
      .run(REPO, 'old-check', 'pull_request', 300, '2026-06-10T10:05:00Z', 'SUCCESS', 'sha1', 1);
    raw.close();
    return path;
  }

  it('opens a pre-migration DB; old waits stay readable but pool-less (excluded from pool reads)', () => {
    const store = new HistoryStore(preFleetDb());
    expect(store.expectedRunnerWait(REPO, 'old-job', 'pull_request')).toBe(42); // legacy read intact
    expect(store.runnerPoolWaitsSince('2026-06-01T00:00:00Z')).toEqual([]);    // NULL pool excluded
    store.recordRunnerWait(REPO, 'new-job', 'pull_request', 7, '2026-06-10T11:00:00Z', 'p1');
    expect(store.runnerPoolWaitsSince('2026-06-01T00:00:00Z')).toHaveLength(1);
  });

  it('legacy duration rows derive started = completed − duration; new rows store it exactly', () => {
    const store = new HistoryStore(preFleetDb());
    store.recordCheckDuration(REPO, 'new-check', 'pull_request',
      '2026-06-10T11:00:00Z', '2026-06-10T11:02:00Z', 'SUCCESS');
    const rows = store.checkIntervalsSince('2026-06-01T00:00:00Z');
    // legacy: 10:05 completed − 300s = 10:00 derived start
    expect(rows.find((r) => r.name === 'old-check')!.startedAt)
      .toBe('2026-06-10T10:00:00.000Z');
    expect(rows.find((r) => r.name === 'new-check')!.startedAt)
      .toBe('2026-06-10T11:00:00Z');
  });
});

describe('costRowsSince (issue #43 cost attribution)', () => {
  it('returns every conclusion with name, startedAt, duration and run_attempt', () => {
    h.recordCheckDuration(REPO, 'unit-tests', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T10:05:00Z', 'SUCCESS', 'sha1', 1);
    h.recordCheckDuration(REPO, 'e2e', 'merge_group',
      '2026-06-10T10:01:00Z', '2026-06-10T10:02:30Z', 'CANCELLED', 'sha1', 2);
    const rows = h.costRowsSince('2026-06-10T00:00:00Z');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === 'unit-tests')).toEqual({
      repo: REPO, name: 'unit-tests', event: 'pull_request', headSha: 'sha1',
      runNumber: null, startedAt: '2026-06-10T10:00:00Z',
      durationSecs: 300, runAttempt: 1 });
    expect(rows.find((r) => r.name === 'e2e')).toEqual({
      repo: REPO, name: 'e2e', event: 'merge_group', headSha: 'sha1',
      runNumber: null, startedAt: '2026-06-10T10:01:00Z',
      durationSecs: 90, runAttempt: 2 });
  });

  it('rows without run_attempt carry null; pre-#47 rows derive startedAt', () => {
    h.recordCheckDuration(REPO, 'legacy', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T10:10:00Z', 'SUCCESS');
    // simulate a pre-#47 row: null started_at on disk
    (h as unknown as { db: { exec(sql: string): void } }).db
      .exec("UPDATE check_durations SET started_at = NULL WHERE check_name = 'legacy'");
    const rows = h.costRowsSince('2026-06-10T00:00:00Z');
    expect(rows).toEqual([{ repo: REPO, name: 'legacy', event: 'pull_request',
      headSha: null, runNumber: null,
      startedAt: '2026-06-10T10:00:00.000Z', durationSecs: 600, runAttempt: null }]);
  });

  it('the since filter applies to completed_at', () => {
    h.recordCheckDuration(REPO, 'old', 'pull_request',
      '2026-06-01T10:00:00Z', '2026-06-01T10:05:00Z', 'SUCCESS');
    expect(h.costRowsSince('2026-06-09T00:00:00Z')).toEqual([]);
  });
});

describe('runnerWaitStats (issue #48 wait-dominated lint)', () => {
  it('returns the last-20 p50 WITH the sample count behind it', () => {
    // 11 samples 100..110 → lower median 105
    for (let i = 0; i < 11; i++) {
      h.recordRunnerWait(REPO, 'job', 'pull_request', 100 + i,
        `2026-06-10T10:${String(i).padStart(2, '0')}:00Z`);
    }
    expect(h.runnerWaitStats(REPO, 'job', 'pull_request')).toEqual({ p50Secs: 105, n: 11 });
  });

  it('null with no samples; scoped per (repo, name, event)', () => {
    h.recordRunnerWait(REPO, 'job', 'pull_request', 50, '2026-06-10T10:00:00Z');
    expect(h.runnerWaitStats(REPO, 'job', 'merge_group')).toBeNull();
    expect(h.runnerWaitStats(REPO, 'other', 'pull_request')).toBeNull();
    expect(h.runnerWaitStats(REPO, 'job', 'pull_request')).toEqual({ p50Secs: 50, n: 1 });
  });

  it('caps at the newest 20 samples (same window as expectedRunnerWait)', () => {
    for (let i = 0; i < 25; i++) {
      h.recordRunnerWait(REPO, 'job', 'pull_request', i,
        `2026-06-10T10:${String(i).padStart(2, '0')}:00Z`);
    }
    expect(h.runnerWaitStats(REPO, 'job', 'pull_request')!.n).toBe(20);
  });
});

// ------------------------------------------------------------------------------
// Cost explorer: run_number column (per-run cost grouping key)
// ------------------------------------------------------------------------------

describe('run_number plumbing (cost explorer)', () => {
  it('recordCheckDuration persists run_number; costRowsSince returns it', () => {
    h.recordCheckDuration(REPO, 'unit-tests', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T10:05:00Z', 'SUCCESS', 'sha1', 1, 4711);
    const [row] = h.costRowsSince('2026-06-10T00:00:00Z');
    expect(row).toMatchObject({ name: 'unit-tests', headSha: 'sha1', runNumber: 4711 });
  });

  it('runNumber defaults to NULL (old callers / unknown runs)', () => {
    h.recordCheckDuration(REPO, 'unit-tests', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T10:05:00Z', 'SUCCESS', 'sha1', 1);
    expect(h.costRowsSince('2026-06-10T00:00:00Z')[0]!.runNumber).toBeNull();
  });

  it('migration: a pre-existing DB without run_number gains the column on re-open (old rows NULL)', () => {
    const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'prdash-hist-'));
    try {
      const path = join(dir, 'history.db');
      const h1 = new HistoryStore(path);
      // simulate a pre-migration row: drop the column, then insert without it
      (h1 as unknown as { db: import('better-sqlite3').Database }).db.exec(`
        ALTER TABLE check_durations DROP COLUMN run_number;
        INSERT INTO check_durations (repo, check_name, event, duration_secs, completed_at, conclusion)
        VALUES ('${REPO}', 'legacy', 'pull_request', 300, '2026-06-10T10:05:00Z', 'SUCCESS');
      `);
      h1.close();
      const h2 = new HistoryStore(path); // re-open runs the ALTER migration
      const rows = h2.costRowsSince('2026-06-10T00:00:00Z');
      expect(rows[0]).toMatchObject({ name: 'legacy', runNumber: null });
      // and new rows persist a value alongside the migrated old ones
      h2.recordCheckDuration(REPO, 'fresh', 'pull_request',
        '2026-06-10T11:00:00Z', '2026-06-10T11:05:00Z', 'SUCCESS', 'sha9', 1, 99);
      expect(h2.costRowsSince('2026-06-10T00:00:00Z')
        .find((r) => r.name === 'fresh')!.runNumber).toBe(99);
      h2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cost actuals import (cost explorer phase 2)
// ---------------------------------------------------------------------------

describe('cost actuals (cost explorer phase 2)', () => {
  it('upserts and reads rows by date floor, ordered scope → date', () => {
    h.upsertCostActual('fleet', '2026-06-10', 123.45, 'aws-ce');
    h.upsertCostActual('fleet', '2026-06-09', 110, null);
    h.upsertCostActual('kindash-arc', '2026-06-10', 80, 'aws-ce');
    expect(h.costActualsSince('2026-06-09')).toEqual([
      { scope: 'fleet', date: '2026-06-09', dollars: 110, source: null },
      { scope: 'fleet', date: '2026-06-10', dollars: 123.45, source: 'aws-ce' },
      { scope: 'kindash-arc', date: '2026-06-10', dollars: 80, source: 'aws-ce' },
    ]);
    // window floor: older dates drop out
    expect(h.costActualsSince('2026-06-10').map((r) => r.date)).toEqual(['2026-06-10', '2026-06-10']);
  });

  it('re-importing the same (scope, date) REPLACES dollars and source (idempotent cron)', () => {
    h.upsertCostActual('fleet', '2026-06-10', 100, 'manual');
    h.upsertCostActual('fleet', '2026-06-10', 123.45, 'aws-ce');
    expect(h.costActualsSince('2026-06-01')).toEqual([
      { scope: 'fleet', date: '2026-06-10', dollars: 123.45, source: 'aws-ce' },
    ]);
  });

  it('migration: a pre-existing DB gains the cost_actuals table on re-open', () => {
    const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'prdash-hist-'));
    try {
      const path = join(dir, 'history.db');
      const h1 = new HistoryStore(path);
      // simulate a pre-upgrade DB: the table didn't exist before this feature
      (h1 as unknown as { db: import('better-sqlite3').Database }).db
        .exec('DROP TABLE cost_actuals');
      h1.close();
      const h2 = new HistoryStore(path); // re-open re-creates it
      h2.upsertCostActual('fleet', '2026-06-10', 42, null);
      expect(h2.costActualsSince('2026-06-01'))
        .toEqual([{ scope: 'fleet', date: '2026-06-10', dollars: 42, source: null }]);
      h2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyCheckAliases — carry learned history across a check rename', () => {
  const pool = { pool: 'kindash-arc', githubHosted: false };

  it('moves append-table rows (durations, runner-waits) onto the new name', () => {
    h.recordCheckDuration(REPO, 'static-checks', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T10:05:00Z', 'SUCCESS');
    h.recordRunnerWait(REPO, 'static-checks', 'pull_request', 30, '2026-06-10T10:00:00Z', 'kindash-arc');
    expect(h.expected(REPO, 'static-checks', 'pull_request')).not.toBeNull();

    const n = h.applyCheckAliases(REPO, { 'static-checks': 'checks' });
    expect(n).toBe(1);

    // history now lives under the new name…
    expect(h.expected(REPO, 'checks', 'pull_request')).not.toBeNull();
    expect(h.expectedRunnerWait(REPO, 'checks', 'pull_request')).not.toBeNull();
    // …and nothing remains under the old name
    expect(h.expected(REPO, 'static-checks', 'pull_request')).toBeNull();
  });

  it('moves an upsert-table pool when the new name has none', () => {
    h.recordObservedPool(REPO, 'integration-tests', 'merge_group', pool);
    h.applyCheckAliases(REPO, { 'integration-tests': 'integ' });
    expect(h.observedPool(REPO, 'integ', 'merge_group')).toEqual(pool);
    expect(h.observedPool(REPO, 'integration-tests', 'merge_group')).toBeNull();
  });

  it('keeps the fresher new-name pool on collision and drops the stale old row', () => {
    h.recordObservedPool(REPO, 'old', 'merge_group', { pool: 'stale', githubHosted: false });
    h.recordObservedPool(REPO, 'new', 'merge_group', { pool: 'fresh', githubHosted: false });
    h.applyCheckAliases(REPO, { old: 'new' });
    // UPDATE OR IGNORE can't overwrite the existing 'new' row; the stale 'old' is deleted
    expect(h.observedPool(REPO, 'new', 'merge_group')).toEqual({ pool: 'fresh', githubHosted: false });
    expect(h.observedPool(REPO, 'old', 'merge_group')).toBeNull();
  });

  it('is idempotent — a second apply of the same pair is a no-op', () => {
    h.recordCheckDuration(REPO, 'a', 'pull_request',
      '2026-06-10T10:00:00Z', '2026-06-10T10:05:00Z', 'SUCCESS');
    expect(h.applyCheckAliases(REPO, { a: 'b' })).toBe(1);
    // a later duration recorded under the (now-dead) old name must NOT be re-moved
    h.recordCheckDuration(REPO, 'a', 'pull_request',
      '2026-06-11T10:00:00Z', '2026-06-11T10:05:00Z', 'SUCCESS');
    expect(h.applyCheckAliases(REPO, { a: 'b' })).toBe(0);
    expect(h.expected(REPO, 'a', 'pull_request')).not.toBeNull(); // stayed put
  });

  it('scopes the rename to the given repo only', () => {
    h.recordObservedPool(REPO, 'x', 'merge_group', pool);
    h.recordObservedPool('other/repo', 'x', 'merge_group', pool);
    h.applyCheckAliases(REPO, { x: 'y' });
    expect(h.observedPool(REPO, 'y', 'merge_group')).toEqual(pool);
    expect(h.observedPool('other/repo', 'x', 'merge_group')).toEqual(pool); // untouched
  });

  it('returns 0 and does nothing when aliases is undefined', () => {
    expect(h.applyCheckAliases(REPO, undefined)).toBe(0);
  });
});

describe('pruneConflatedGroupStatsOnce', () => {
  it('clears group_runs + group_failures once, then is a no-op', () => {
    h.recordGroupRun(REPO, 120, '2026-06-10T10:00:00Z');
    h.recordGroupFailure(REPO, 'ci', 'sha1', '2026-06-10T10:00:00Z');
    expect(h.pruneConflatedGroupStatsOnce()).toBe(true);              // ran
    expect(h.medianGroupRun(REPO)).toBeNull();
    expect(h.groupFailuresSince('2026-06-01T00:00:00Z').filter((f) => f.repo === REPO)).toHaveLength(0);
    // a fresh row after the prune survives, and a second call does nothing
    h.recordGroupRun(REPO, 200, '2026-06-11T10:00:00Z');
    expect(h.pruneConflatedGroupStatsOnce()).toBe(false);            // already done
    expect(h.medianGroupRun(REPO)).toBe(200);
  });
});
