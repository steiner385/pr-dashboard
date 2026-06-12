import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryStore } from '../history';

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
