import { describe, it, expect } from 'vitest';
import {
  selectRunIdsToFetch, observedKey, jobsApiPath, resolveJobsResponse,
  pushRunsApiPath, selectPushRunIds, MAX_JOBS_FETCHES_PER_CYCLE,
  MAX_PUSH_RUNS_PER_CYCLE,
} from '../pool-learning';
import type { CheckRun } from '../types';

const mk = (over: Partial<CheckRun>): CheckRun => ({
  name: 'x', rawName: 'x', status: 'COMPLETED', conclusion: 'SUCCESS',
  startedAt: null, completedAt: null, event: 'pull_request', workflowName: 'CI',
  runNumber: null, runDatabaseId: null, runAttempt: null, isRequired: true, url: null, ...over });

const REPO = 'acme/widgets';

describe('selectRunIdsToFetch', () => {
  it('picks distinct runDatabaseIds of unobserved checks, first-seen order', () => {
    const checks = [
      mk({ name: 'a', runDatabaseId: 100 }),
      mk({ name: 'b', runDatabaseId: 100 }), // same run → one fetch
      mk({ name: 'c', runDatabaseId: 200 }),
    ];
    expect(selectRunIdsToFetch(checks, new Set(), new Set(), REPO)).toEqual([100, 200]);
  });

  it('skips checks already observed', () => {
    const observed = new Set([observedKey(REPO, 'a', 'pull_request')]);
    const checks = [
      mk({ name: 'a', runDatabaseId: 100 }), // observed → skip
      mk({ name: 'c', runDatabaseId: 200 }),
    ];
    expect(selectRunIdsToFetch(checks, observed, new Set(), REPO)).toEqual([200]);
  });

  it('an unobserved check still triggers its run even if a sibling in the same run is observed', () => {
    const observed = new Set([observedKey(REPO, 'a', 'pull_request')]);
    const checks = [
      mk({ name: 'a', runDatabaseId: 100 }), // observed
      mk({ name: 'b', runDatabaseId: 100 }), // unobserved, same run → fetch 100
    ];
    expect(selectRunIdsToFetch(checks, observed, new Set(), REPO)).toEqual([100]);
  });

  it('skips run ids already fetched recently (cross-cycle cache)', () => {
    const checks = [mk({ name: 'a', runDatabaseId: 100 }), mk({ name: 'c', runDatabaseId: 200 })];
    expect(selectRunIdsToFetch(checks, new Set(), new Set([100]), REPO)).toEqual([200]);
  });

  it('ignores checks without a runDatabaseId', () => {
    const checks = [mk({ name: 'a', runDatabaseId: null }), mk({ name: 'c', runDatabaseId: 200 })];
    expect(selectRunIdsToFetch(checks, new Set(), new Set(), REPO)).toEqual([200]);
  });

  it('respects the per-cycle cap', () => {
    const checks = Array.from({ length: 20 }, (_, i) =>
      mk({ name: `j${i}`, runDatabaseId: 1000 + i }));
    const out = selectRunIdsToFetch(checks, new Set(), new Set(), REPO);
    expect(out).toHaveLength(MAX_JOBS_FETCHES_PER_CYCLE);
    expect(out[0]).toBe(1000);
  });

  it('an explicit cap overrides the default', () => {
    const checks = Array.from({ length: 5 }, (_, i) => mk({ name: `j${i}`, runDatabaseId: i }));
    expect(selectRunIdsToFetch(checks, new Set(), new Set(), REPO, 2)).toEqual([0, 1]);
  });

  it('distinct events for the same name are distinct observed keys', () => {
    const observed = new Set([observedKey(REPO, 'a', 'pull_request')]);
    const checks = [mk({ name: 'a', event: 'merge_group', runDatabaseId: 100 })];
    // pull_request/a observed, but merge_group/a is not → fetch
    expect(selectRunIdsToFetch(checks, observed, new Set(), REPO)).toEqual([100]);
  });
});

describe('jobsApiPath', () => {
  it('builds the per-run jobs path with per_page=100', () => {
    expect(jobsApiPath('acme', 'widgets', 12345))
      .toBe('/repos/acme/widgets/actions/runs/12345/jobs?per_page=100');
  });
});

describe('pushRunsApiPath', () => {
  it('builds the push-event completed-runs path with the workflow basename, branch, and per_page', () => {
    expect(pushRunsApiPath('acme', 'widgets', 'ci.yml', 'main', 5))
      .toBe('/repos/acme/widgets/actions/workflows/ci.yml/runs'
        + '?event=push&branch=main&status=completed&per_page=5');
  });

  it('honors a non-default branch and per_page', () => {
    expect(pushRunsApiPath('octo', 'demo', 'deploy.yml', 'release', 1))
      .toBe('/repos/octo/demo/actions/workflows/deploy.yml/runs'
        + '?event=push&branch=release&status=completed&per_page=1');
  });
});

describe('selectPushRunIds', () => {
  it('returns workflow_run ids newest-first (API order), capped', () => {
    const resp = { workflow_runs: [{ id: 30 }, { id: 20 }, { id: 10 }, { id: 5 }] };
    expect(selectPushRunIds(resp, new Set(), 2)).toEqual([30, 20]);
  });

  it('defaults the cap to MAX_PUSH_RUNS_PER_CYCLE', () => {
    const resp = { workflow_runs: Array.from({ length: 10 }, (_, i) => ({ id: 100 - i })) };
    expect(selectPushRunIds(resp, new Set())).toHaveLength(MAX_PUSH_RUNS_PER_CYCLE);
  });

  it('skips run ids already fetched recently', () => {
    const resp = { workflow_runs: [{ id: 30 }, { id: 20 }, { id: 10 }] };
    expect(selectPushRunIds(resp, new Set([30]), 5)).toEqual([20, 10]);
  });

  it('tolerates a missing/empty list and runs without an id', () => {
    expect(selectPushRunIds({}, new Set())).toEqual([]);
    expect(selectPushRunIds({ workflow_runs: null }, new Set())).toEqual([]);
    expect(selectPushRunIds({ workflow_runs: [] }, new Set())).toEqual([]);
    expect(selectPushRunIds({ workflow_runs: [{ id: null }, { id: 7 }] }, new Set())).toEqual([7]);
  });
});

describe('resolveJobsResponse', () => {
  it('resolves every job to {name, pool}', () => {
    const out = resolveJobsResponse({ jobs: [
      { name: 'db-migrations / DB Migrations', labels: ['kindash-arc'], runner_group_name: 'arc' },
      { name: 'lint', labels: ['ubuntu-latest'], runner_group_name: 'GitHub Actions' },
    ] });
    expect(out).toEqual([
      { name: 'db-migrations / DB Migrations', pool: { pool: 'kindash-arc', githubHosted: false } },
      { name: 'lint', pool: { pool: 'ubuntu-latest', githubHosted: true } },
    ]);
  });

  it('tolerates a missing/empty jobs array', () => {
    expect(resolveJobsResponse({})).toEqual([]);
    expect(resolveJobsResponse({ jobs: null })).toEqual([]);
  });

  it('tolerates jobs with missing labels/group', () => {
    expect(resolveJobsResponse({ jobs: [{ name: 'j' }] }))
      .toEqual([{ name: 'j', pool: { pool: 'unknown', githubHosted: false } }]);
  });
});
