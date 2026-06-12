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
    store.upsertMergedPr({ repo: REPO, number: 2, title: 'new row', url: 'u',
      mergedAt: '2026-06-10T12:00:00Z', mergeCommitSha: 'def', createdAt: '2026-06-09T12:00:00Z' });
    const fresh = store.listTrackedMerged(7, new Date('2026-06-11T00:00:00Z'))
      .find((r) => r.number === 2)!;
    expect(fresh.createdAt).toBe('2026-06-09T12:00:00Z');
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
