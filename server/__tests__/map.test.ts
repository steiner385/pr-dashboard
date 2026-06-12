import { describe, it, expect } from 'vitest';
import { mapPrNode, mapRollupContexts, mapQueueEntries } from '../map';

const CHECK = {
  __typename: 'CheckRun', name: 'static-checks / Unit Tests (3/8)', status: 'COMPLETED',
  conclusion: 'SUCCESS', startedAt: '2026-06-10T10:00:00Z', completedAt: '2026-06-10T10:08:00Z',
  detailsUrl: 'https://github.com/x', isRequired: false,
  checkSuite: { workflowRun: { event: 'merge_group', runNumber: 7994, runAttempt: 2, workflow: { name: 'CI' } } },
};
const STATUS_CTX = { __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS' };

describe('mapRollupContexts', () => {
  it('filters StatusContext nodes, canonicalizes names, defaults event', () => {
    const out = mapRollupContexts([CHECK, STATUS_CTX, { ...CHECK, checkSuite: null }]);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('static-checks / Unit Tests (shard/8)');
    expect(out[0].rawName).toBe('static-checks / Unit Tests (3/8)');
    expect(out[0].event).toBe('merge_group');
    expect(out[0].workflowName).toBe('CI');
    expect(out[0].runNumber).toBe(7994);
    expect(out[0].runAttempt).toBe(2);
    expect(out[1].event).toBe('unknown');
    expect(out[1].workflowName).toBeNull();
    expect(out[1].runNumber).toBeNull();
    expect(out[1].runAttempt).toBeNull();
  });

  it('keeps same-named checks from different workflows as separate runs', () => {
    const out = mapRollupContexts([
      { ...CHECK, name: 'ci', checkSuite: { workflowRun: { event: 'pull_request', runNumber: 7990, workflow: { name: 'CI' } } } },
      { ...CHECK, name: 'ci-gate', checkSuite: { workflowRun: { event: 'pull_request', runNumber: 511, workflow: { name: 'Auto-merge PRs' } } } },
      { ...CHECK, name: 'ci', checkSuite: { workflowRun: { event: 'pull_request', runNumber: 510, workflow: { name: 'Auto-merge PRs' } } } },
    ]);
    expect(out).toHaveLength(3);
    const cis = out.filter((c) => c.name === 'ci');
    expect(cis.map((c) => c.workflowName).sort()).toEqual(['Auto-merge PRs', 'CI']);
  });
  it('dedupes by (canonical name, event), aggregating the family timing', () => {
    const out = mapRollupContexts([
      CHECK,
      { ...CHECK, name: 'static-checks / Unit Tests (5/8)', startedAt: '2026-06-10T11:00:00Z' },
    ]);
    expect(out).toHaveLength(1);
    // family aggregate: earliest start across shards, shardCount recorded
    expect(out[0].startedAt).toBe(CHECK.startedAt);
    expect(out[0].shardCount).toBe(2);
  });
});

describe('mapPrNode', () => {
  it('maps a detail node to PrSnapshot', () => {
    const pr = mapPrNode('acme/widgets', {
      number: 8979, title: 'docs: guardrails', url: 'https://github.com/x/8979',
      isDraft: false, mergeStateStatus: 'BLOCKED', mergedAt: null, headRefOid: 'head1',
      autoMergeRequest: { mergeMethod: 'SQUASH' },
      mergeCommit: null,
      mergeQueueEntry: { position: 11, state: 'QUEUED', enqueuedAt: '2026-06-10T16:00:00Z', headCommit: null },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { nodes: [CHECK] } } } }] },
    });
    expect(pr).not.toBeNull();
    expect(pr!.repo).toBe('acme/widgets');
    expect(pr!.autoMergeArmed).toBe(true);
    expect(pr!.queue).toEqual({ position: 11, state: 'QUEUED', enqueuedAt: '2026-06-10T16:00:00Z', groupHeadOid: null });
    expect(pr!.checks).toHaveLength(1);
  });
  it('handles null rollup and missing optionals', () => {
    const pr = mapPrNode('a/b', {
      number: 1, title: 't', url: 'u', isDraft: true, mergeStateStatus: null, mergedAt: null,
      headRefOid: 'h', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    expect(pr!.checks).toEqual([]);
    expect(pr!.queue).toBeNull();
  });

  it('returns null when node is null (inaccessible PR in batched response)', () => {
    expect(mapPrNode('a/b', null)).toBeNull();
  });

  it('returns null when node is undefined', () => {
    expect(mapPrNode('a/b', undefined)).toBeNull();
  });

  it('returns empty checks array and does not throw when commits.nodes is empty', () => {
    const pr = mapPrNode('a/b', {
      number: 2, title: 't', url: 'u', isDraft: false, mergeStateStatus: null, mergedAt: null,
      headRefOid: 'h', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
      commits: { nodes: [] },
    });
    expect(pr).not.toBeNull();
    expect(pr!.checks).toEqual([]);
  });
});

describe('mapQueueEntries', () => {
  it('maps mergeQueue entries', () => {
    const out = mapQueueEntries({
      entries: { nodes: [
        { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: 'T', headCommit: { oid: 'g1' }, pullRequest: { number: 100 } },
        { position: 2, state: 'QUEUED', enqueuedAt: 'T', headCommit: null, pullRequest: { number: 200 } },
      ] },
    });
    expect(out).toEqual([
      { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: 'T', headCommitOid: 'g1', prNumber: 100 },
      { position: 2, state: 'QUEUED', enqueuedAt: 'T', headCommitOid: null, prNumber: 200 },
    ]);
  });
});

describe('mapPrNode createdAt (Round 12 metrics)', () => {
  const BASE = {
    number: 1, title: 't', url: 'u', isDraft: false, mergeStateStatus: 'CLEAN',
    mergedAt: null, headRefOid: 'h', autoMergeRequest: null, mergeCommit: null,
    mergeQueueEntry: null, commits: { nodes: [] },
  };

  it('maps createdAt when present', () => {
    expect(mapPrNode('acme/widgets', { ...BASE, createdAt: '2026-06-09T10:00:00Z' })!.createdAt)
      .toBe('2026-06-09T10:00:00Z');
  });

  it('defaults createdAt to null when the node omits it', () => {
    expect(mapPrNode('acme/widgets', BASE)!.createdAt).toBeNull();
  });
});

describe('mapRollupContexts runCreatedAt (issue #39 — dispatch-stall telemetry)', () => {
  it('maps workflowRun.createdAt when present, null otherwise', () => {
    const node = (workflowRun: Record<string, unknown> | null) => ({
      __typename: 'CheckRun', name: 'ci', status: 'QUEUED', conclusion: null,
      startedAt: null, completedAt: null, detailsUrl: 'u',
      checkSuite: workflowRun ? { workflowRun } : null,
    });
    const [withCreated] = mapRollupContexts([
      node({ event: 'merge_group', createdAt: '2026-06-10T11:50:00Z' })]);
    expect(withCreated!.runCreatedAt).toBe('2026-06-10T11:50:00Z');
    const [without] = mapRollupContexts([node({ event: 'merge_group' })]);
    expect(without!.runCreatedAt).toBeNull();
    const [noRun] = mapRollupContexts([node(null)]);
    expect(noRun!.runCreatedAt).toBeNull();
  });

  it('a matrix family keeps the EARLIEST runCreatedAt (the run, not a late shard)', () => {
    const shard = (i: number, createdAt: string) => ({
      __typename: 'CheckRun', name: `Unit Tests (${i}/2)`, status: 'QUEUED', conclusion: null,
      startedAt: null, completedAt: null, detailsUrl: 'u',
      checkSuite: { workflowRun: { event: 'merge_group', createdAt } },
    });
    const out = mapRollupContexts([
      shard(1, '2026-06-10T11:50:00Z'), shard(2, '2026-06-10T11:58:00Z')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.runCreatedAt).toBe('2026-06-10T11:50:00Z');
  });
});

describe('mapPrNode touchesWorkflows (issue #49)', () => {
  const BASE = {
    number: 1, title: 't', url: 'u', isDraft: false, mergeStateStatus: 'CLEAN',
    mergedAt: null, headRefOid: 'h', autoMergeRequest: null, mergeCommit: null,
    mergeQueueEntry: null, commits: { nodes: [] },
  };

  it('true when any changed path is under .github/workflows/', () => {
    expect(mapPrNode('a/b', { ...BASE, files: { nodes: [
      { path: 'src/index.ts' }, { path: '.github/workflows/ci.yml' },
    ] } })!.touchesWorkflows).toBe(true);
  });

  it('false for non-workflow paths (including nested look-alikes)', () => {
    expect(mapPrNode('a/b', { ...BASE, files: { nodes: [
      { path: 'src/index.ts' }, { path: 'docs/.github/workflows/x.yml' },
      { path: '.github/dependabot.yml' },
    ] } })!.touchesWorkflows).toBe(false);
  });

  it('false when the node omits files entirely (old payloads)', () => {
    expect(mapPrNode('a/b', BASE)!.touchesWorkflows).toBe(false);
  });
});
