import { describe, it, expect } from 'vitest';
import { canonicalizeCheckName, dedupeChecks, familyDisplayName } from '../normalize';
import type { CheckRun } from '../types';

const run = (over: Partial<CheckRun>): CheckRun => ({
  name: 'x', rawName: 'x', status: 'COMPLETED', conclusion: 'SUCCESS',
  startedAt: '2026-06-10T10:00:00Z', completedAt: '2026-06-10T10:05:00Z',
  event: 'pull_request', workflowName: null, runNumber: null, runAttempt: null, runDatabaseId: null, isRequired: true, url: null, ...over,
});

describe('canonicalizeCheckName', () => {
  it('normalizes un-interpolated matrix placeholders', () => {
    expect(canonicalizeCheckName('static-checks / Unit Tests (${{ matrix.shard }}/8)'))
      .toBe('static-checks / Unit Tests (shard/8)');
  });
  it('normalizes expanded shard names to the same family', () => {
    expect(canonicalizeCheckName('static-checks / Unit Tests (3/8)'))
      .toBe('static-checks / Unit Tests (shard/8)');
    expect(canonicalizeCheckName('Integration Tests (1/3)')).toBe('Integration Tests (shard/3)');
  });
  it('leaves plain names alone', () => {
    expect(canonicalizeCheckName('fast-checks / ESLint')).toBe('fast-checks / ESLint');
  });
});

describe('dedupeChecks', () => {
  it('separates same-named jobs from different workflows (workflowName in the key)', () => {
    const out = dedupeChecks([
      run({ name: 'ci', workflowName: 'CI', startedAt: '2026-06-10T09:00:00Z' }),
      run({ name: 'ci', workflowName: 'Auto-merge PRs', startedAt: '2026-06-10T09:01:00Z' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.workflowName).sort()).toEqual(['Auto-merge PRs', 'CI']);
  });

  it('null workflowName groups together (old data keeps the pre-workflow key)', () => {
    const out = dedupeChecks([
      run({ name: 'ci', workflowName: null, startedAt: '2026-06-10T09:00:00Z' }),
      run({ name: 'ci', workflowName: null, startedAt: '2026-06-10T09:30:00Z', conclusion: 'FAILURE' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.conclusion).toBe('FAILURE');
  });

  it('keeps latest startedAt per (name, event), separates events', () => {
    const out = dedupeChecks([
      run({ name: 'TypeScript', event: 'push', startedAt: '2026-06-10T09:00:00Z' }),
      run({ name: 'TypeScript', event: 'merge_group', startedAt: '2026-06-10T09:01:00Z' }),
      run({ name: 'TypeScript', event: 'merge_group', startedAt: '2026-06-10T09:30:00Z', conclusion: 'FAILURE' }),
    ]);
    expect(out).toHaveLength(2);
    const mg = out.find((c) => c.event === 'merge_group')!;
    expect(mg.conclusion).toBe('FAILURE');
  });

  it('aggregation is order-independent; real timestamps survive null members', () => {
    const real = run({ name: 'Build', event: 'pull_request', startedAt: '2026-06-10T10:00:00Z', conclusion: 'SUCCESS' });
    const nullStart = run({ name: 'Build', event: 'pull_request', startedAt: null, conclusion: 'FAILURE' });

    for (const order of [[nullStart, real], [real, nullStart]]) {
      const out = dedupeChecks(order);
      expect(out).toHaveLength(1);
      expect(out[0].startedAt).toBe('2026-06-10T10:00:00Z');
      // family aggregation: any failing member fails the family (a failure is
      // never hidden by a sibling's success)
      expect(out[0].conclusion).toBe('FAILURE');
      expect(out[0].shardCount).toBe(2);
    }
  });
});

describe('matrix-shard family aggregation', () => {
  const shard = (i: number, over: Partial<CheckRun> = {}): CheckRun => run({
    name: 'static-checks / Unit Tests (shard/8)',
    rawName: `static-checks / Unit Tests (${i}/8)`,
    workflowName: 'CI',
    startedAt: `2026-06-12T10:0${i}:00Z`,
    completedAt: `2026-06-12T10:1${i}:00Z`,
    ...over,
  });

  it('collapses a completed family: shardCount, min start, max finish, worst conclusion', () => {
    const out = dedupeChecks([shard(1), shard(2), shard(3, { conclusion: 'FAILURE' })]);
    expect(out).toHaveLength(1);
    const fam = out[0];
    expect(fam.shardCount).toBe(3);
    expect(fam.startedAt).toBe('2026-06-12T10:01:00Z');
    expect(fam.completedAt).toBe('2026-06-12T10:13:00Z');
    expect(fam.status).toBe('COMPLETED');
    expect(fam.conclusion).toBe('FAILURE');
  });

  it('partial family reads IN_PROGRESS with no completedAt/conclusion', () => {
    const out = dedupeChecks([
      shard(1),
      shard(2, { status: 'IN_PROGRESS', conclusion: null, completedAt: null }),
    ]);
    expect(out[0].status).toBe('IN_PROGRESS');
    expect(out[0].completedAt).toBeNull();
    expect(out[0].conclusion).toBeNull();
    expect(out[0].startedAt).toBe('2026-06-12T10:01:00Z');
  });

  it('SKIPPED members are excluded from timing but counted in shardCount', () => {
    const out = dedupeChecks([
      shard(1), shard(2),
      shard(3, { conclusion: 'SKIPPED', startedAt: '2026-06-12T17:54:54Z', completedAt: '2026-06-12T16:55:51Z' }),
    ]);
    expect(out[0].shardCount).toBe(3);
    expect(out[0].startedAt).toBe('2026-06-12T10:01:00Z');
    expect(out[0].completedAt).toBe('2026-06-12T10:12:00Z');
    expect(out[0].conclusion).toBe('SUCCESS');
  });

  it('single checks carry shardCount 1 and keep their fields verbatim', () => {
    const out = dedupeChecks([run({ name: 'fast-checks / ESLint' })]);
    expect(out[0].shardCount).toBe(1);
    expect(out[0].conclusion).toBe('SUCCESS');
  });
});

describe('cross-run re-run families (issue #61)', () => {
  // Live repro: sha 5bd0942 had THREE 'Changed scope' runs (queue-recover
  // delete-and-recreate during the 2026-06-12 dispatch stall), each ~20s.
  // min-start→max-finish across them fabricated a 51,027s duration.
  const rerun = (runNumber: number, startedAt: string, completedAt: string,
    over: Partial<CheckRun> = {}): CheckRun => run({
    name: 'Changed scope', rawName: 'Changed scope', workflowName: 'CI',
    runNumber, runAttempt: 1, startedAt, completedAt, ...over,
  });

  it('collapses to the LATEST workflow run only — never spans re-run gaps', () => {
    const out = dedupeChecks([
      rerun(101, '2026-06-12T02:28:27Z', '2026-06-12T02:28:45Z'),
      rerun(108, '2026-06-12T10:48:25Z', '2026-06-12T10:48:41Z'),
      rerun(115, '2026-06-12T16:38:35Z', '2026-06-12T16:38:54Z'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].startedAt).toBe('2026-06-12T16:38:35Z');
    expect(out[0].completedAt).toBe('2026-06-12T16:38:54Z');
    expect(out[0].shardCount).toBe(1);
  });

  it('a stale FAILURE from an older run never outranks the latest run’s SUCCESS', () => {
    const out = dedupeChecks([
      rerun(101, '2026-06-12T02:28:27Z', '2026-06-12T02:28:45Z', { conclusion: 'FAILURE' }),
      rerun(115, '2026-06-12T16:38:35Z', '2026-06-12T16:38:54Z', { conclusion: 'SUCCESS' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].conclusion).toBe('SUCCESS');
  });

  it('matrix shards sharing one runNumber still aggregate min start → max finish', () => {
    const shard = (i: number): CheckRun => run({
      name: 'Unit Tests (shard/8)', rawName: `Unit Tests (${i}/8)`,
      workflowName: 'CI', runNumber: 200,
      startedAt: `2026-06-12T10:0${i}:00Z`, completedAt: `2026-06-12T10:1${i}:00Z`,
    });
    const out = dedupeChecks([shard(1), shard(2), shard(3)]);
    expect(out).toHaveLength(1);
    expect(out[0].shardCount).toBe(3);
    expect(out[0].startedAt).toBe('2026-06-12T10:01:00Z');
    expect(out[0].completedAt).toBe('2026-06-12T10:13:00Z');
  });

  it('mixed generations: only the latest run’s shards aggregate; older leftovers drop', () => {
    const shard = (i: number, runNumber: number, h: string): CheckRun => run({
      name: 'Unit Tests (shard/8)', rawName: `Unit Tests (${i}/8)`,
      workflowName: 'CI', runNumber,
      startedAt: `2026-06-12T${h}:0${i}:00Z`, completedAt: `2026-06-12T${h}:1${i}:00Z`,
    });
    const out = dedupeChecks([
      shard(1, 200, '02'), shard(2, 200, '02'), // old run
      shard(1, 205, '16'), shard(2, 205, '16'), // latest run
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].shardCount).toBe(2);
    expect(out[0].startedAt).toBe('2026-06-12T16:01:00Z');
    expect(out[0].completedAt).toBe('2026-06-12T16:12:00Z');
  });

  it('members without run identity keep legacy behavior when no numbered member exists', () => {
    const out = dedupeChecks([
      run({ name: 'Legacy', runNumber: null, startedAt: '2026-06-12T10:00:00Z', completedAt: '2026-06-12T10:01:00Z' }),
      run({ name: 'Legacy', runNumber: null, startedAt: '2026-06-12T11:00:00Z', completedAt: '2026-06-12T11:01:00Z', conclusion: 'FAILURE' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].shardCount).toBe(2);
    expect(out[0].conclusion).toBe('FAILURE'); // worst across the (legacy) family
  });

  it('unattributable null-runNumber members drop when a numbered member exists', () => {
    const out = dedupeChecks([
      run({ name: 'X', runNumber: null, startedAt: '2026-06-12T02:00:00Z', completedAt: '2026-06-12T02:01:00Z' }),
      run({ name: 'X', runNumber: 300, startedAt: '2026-06-12T16:00:00Z', completedAt: '2026-06-12T16:01:00Z' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].shardCount).toBe(1);
    expect(out[0].startedAt).toBe('2026-06-12T16:00:00Z');
  });
});

describe('superseded workflow runs (stale failed rollup — #9681)', () => {
  it('drops ALL checks from an older run when a newer run of the same workflow exists — even a check the newer run has not produced yet', () => {
    // An older CI run fast-failed its `ci` rollup (concurrency cancel); the live
    // newer run is still in progress and hasn't produced `ci` yet. The stale
    // failed `ci` must NOT survive (GitHub's own rollup is PENDING).
    const out = dedupeChecks([
      run({ name: 'ci', workflowName: 'CI', conclusion: 'FAILURE', status: 'COMPLETED', runNumber: 9106 }),
      run({ name: 'Prepare', workflowName: 'CI', conclusion: 'CANCELLED', status: 'COMPLETED', runNumber: 9106 }),
      run({ name: 'Prepare', workflowName: 'CI', conclusion: null, status: 'IN_PROGRESS', completedAt: null, runNumber: 9107 }),
    ]);
    expect(out.find((c) => c.name === 'ci')).toBeUndefined();   // stale failed ci is gone
    const prep = out.find((c) => c.name === 'Prepare')!;
    expect(prep.status).toBe('IN_PROGRESS');                    // live run's Prepare wins
    expect(prep.runNumber).toBe(9107);
  });

  it('supersedes per (workflow, event) — different workflows on the same commit stay independent', () => {
    const out = dedupeChecks([
      run({ name: 'ci', workflowName: 'CI', conclusion: 'SUCCESS', runNumber: 50 }),
      run({ name: 'ci-gate', workflowName: 'Auto-merge PRs', conclusion: 'CANCELLED', status: 'COMPLETED', runNumber: 313 }),
    ]);
    expect(out.map((c) => c.name).sort()).toEqual(['ci', 'ci-gate']);
  });

  it('does not supersede legacy checks lacking workflow identity (null workflowName)', () => {
    const out = dedupeChecks([
      run({ name: 'a', workflowName: null, runNumber: 1 }),
      run({ name: 'b', workflowName: null, runNumber: 9 }),
    ]);
    expect(out.map((c) => c.name).sort()).toEqual(['a', 'b']);  // both kept; no cross-name supersession
  });
});

describe('familyDisplayName', () => {
  it('families label with the matrix denominator, not the surviving shard', () => {
    const fam = dedupeChecks([
      run({ name: 'static-checks / Unit Tests (shard/8)', rawName: 'static-checks / Unit Tests (1/8)', startedAt: '2026-06-12T10:01:00Z' }),
      run({ name: 'static-checks / Unit Tests (shard/8)', rawName: 'static-checks / Unit Tests (2/8)', startedAt: '2026-06-12T10:02:00Z' }),
    ])[0];
    expect(familyDisplayName(fam)).toBe('static-checks / Unit Tests (8 shards)');
  });

  it('non-matrix families fall back to a count suffix; singles keep rawName', () => {
    expect(familyDisplayName(run({ name: 'build', rawName: 'build', shardCount: 2 }))).toBe('build (2×)');
    expect(familyDisplayName(run({ rawName: 'static-checks / Unit Tests (2/8)' }))).toBe('static-checks / Unit Tests (2/8)');
  });
});
