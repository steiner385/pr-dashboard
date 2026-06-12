import { describe, it, expect } from 'vitest';
import { buildSweepQuery, buildMergedPageQuery, buildOpenPageQuery, buildDetailQuery, buildQueueQuery, buildOidRollupQuery, buildBackfillQuery, buildViewerQuery, buildBlobQuery } from '../queries';

describe('buildViewerQuery', () => {
  it('asks only for the token owner login', () => {
    expect(buildViewerQuery()).toBe('query { viewer { login } }');
  });
});

describe('buildBlobQuery', () => {
  it('reads one blob by expression, with defaultBranchRef and rateLimit alongside', () => {
    const q = buildBlobQuery('acme', 'widgets', 'HEAD:.pr-dashboard.yml');
    expect(q).toContain('rateLimit { remaining resetAt }');
    expect(q).toContain('repository(owner: "acme", name: "widgets")');
    expect(q).toContain('defaultBranchRef { name }'); // unknown-branch repos still report theirs
    expect(q).toContain('object(expression: "HEAD:.pr-dashboard.yml") { ... on Blob { text } }');
  });
});

describe('buildSweepQuery', () => {
  it('aliases open + incremental merged searches per owner and includes rateLimit', () => {
    const q = buildSweepQuery(['acme', 'octo'], '2026-06-10T12:00:00Z');
    expect(q).toContain('rateLimit { remaining resetAt }');
    expect(q).toContain('open0: search(query: "user:acme is:pr is:open archived:false"');
    expect(q).toContain('open1: search(query: "user:octo is:pr is:open archived:false"');
    expect(q).toContain('merged0: search(query: "user:acme is:pr is:merged merged:>=2026-06-10T12:00:00Z archived:false"');
    expect(q).toContain('fragment PrCore on PullRequest');
  });

  it('merged aliases carry pageInfo for the startup deep sweep', () => {
    const q = buildSweepQuery(['acme'], '2026-06-03T12:00:00Z');
    expect(q).toContain('merged0: search');
    expect(q.split('merged0: search')[1]).toContain('pageInfo { hasNextPage endCursor }');
  });

  it('open aliases carry pageInfo so every sweep can follow open-PR pagination', () => {
    const q = buildSweepQuery(['acme'], '2026-06-03T12:00:00Z');
    expect(q).toContain('open0: search');
    const openSection = q.split('open0: search')[1]!.split('merged0: search')[0];
    expect(openSection).toContain('pageInfo { hasNextPage endCursor }');
  });

  it('escapes backslashes and double-quotes inside the owner value (inner-string escaping)', () => {
    // A crafted owner containing " or \ must not break the surrounding GraphQL string.
    const q = buildSweepQuery(['evil"org\\x'], '2026-06-10T12:00:00Z');
    // The owner must appear with its special chars escaped inside the outer double-quoted string.
    expect(q).toContain('user:evil\\"org\\\\x');
    // The outer GraphQL string delimiters must still be intact (no unmatched quotes).
    const openCount = (q.match(/(?<!\\)"/g) ?? []).length;
    expect(openCount % 2).toBe(0);
  });
});

describe('buildMergedPageQuery', () => {
  it('targets the same merged window with an after-cursor and pageInfo', () => {
    const q = buildMergedPageQuery('acme', '2026-06-03T12:00:00Z', 'CUR123');
    expect(q).toContain('merged: search(query: "user:acme is:pr is:merged merged:>=2026-06-03T12:00:00Z archived:false", type: ISSUE, first: 50, after: "CUR123")');
    expect(q).toContain('pageInfo { hasNextPage endCursor }');
    expect(q).toContain('fragment PrCore on PullRequest');
  });

  it('escapes double-quotes inside the owner value', () => {
    const q = buildMergedPageQuery('evil"owner', '2026-06-03T12:00:00Z', 'CUR');
    expect(q).toContain('user:evil\\"owner');
    const openCount = (q.match(/(?<!\\)"/g) ?? []).length;
    expect(openCount % 2).toBe(0);
  });
});

describe('buildOpenPageQuery', () => {
  it('targets the open-PR search with an after-cursor, pageInfo, and PrCore', () => {
    const q = buildOpenPageQuery('acme', 'CUR123');
    expect(q).toContain('open: search(query: "user:acme is:pr is:open archived:false", type: ISSUE, first: 50, after: "CUR123")');
    expect(q).toContain('pageInfo { hasNextPage endCursor }');
    expect(q).toContain('issueCount');
    expect(q).toContain('rateLimit { remaining resetAt }');
    expect(q).toContain('fragment PrCore on PullRequest');
  });

  it('escapes double-quotes inside the owner value', () => {
    const q = buildOpenPageQuery('evil"owner', 'CUR');
    expect(q).toContain('user:evil\\"owner');
    const openCount = (q.match(/(?<!\\)"/g) ?? []).length;
    expect(openCount % 2).toBe(0);
  });
});

describe('buildDetailQuery', () => {
  it('batches PRs as aliases with literal numbers (isRequired needs them)', () => {
    const q = buildDetailQuery([
      { owner: 'acme', name: 'widgets', number: 8962 },
      { owner: 'acme', name: 'widgets', number: 8979 },
      { owner: 'octo', name: 'bridge', number: 41 },
    ]);
    expect(q).toContain('r0: repository(owner: "acme", name: "widgets")');
    expect(q).toContain('pr8962: pullRequest(number: 8962)');
    expect(q).toContain('isRequired(pullRequestNumber: 8962)');
    expect(q).toContain('pr8979: pullRequest(number: 8979)');
    expect(q).toContain('r1: repository(owner: "octo", name: "bridge")');
    expect(q).toContain('mergeQueueEntry { position state enqueuedAt headCommit { oid } }');
    expect(q).toContain('checkSuite { workflowRun { event runNumber runAttempt workflow { name } } }');
  });
});

describe('queue + rollup + backfill builders', () => {
  it('buildQueueQuery targets the branch merge queue', () => {
    const q = buildQueueQuery('acme', 'widgets', 'main');
    expect(q).toContain('mergeQueue(branch: "main")');
    expect(q).toContain('pullRequest { number }');
  });
  it('buildOidRollupQuery aliases commit objects by oid', () => {
    const q = buildOidRollupQuery('acme', 'widgets', ['abc', 'def']);
    expect(q).toContain('o0: object(oid: "abc")');
    expect(q).toContain('o1: object(oid: "def")');
    expect(q).toContain('... on Commit');
    // createdAt feeds the dispatch-stall classifier (issue #39)
    expect(q).toContain('checkSuite { workflowRun { event runNumber runAttempt createdAt workflow { name } } }');
  });
  it('buildBackfillQuery pages default-branch history rollups', () => {
    const q = buildBackfillQuery('acme', 'widgets', null);
    expect(q).toContain('defaultBranchRef');
    expect(q).toContain('history(first: 10');
    expect(q).toContain('checkSuite { workflowRun { event runNumber runAttempt workflow { name } } }');
    expect(buildBackfillQuery('acme', 'widgets', 'CUR')).toContain('after: "CUR"');
  });
});

// ---------------------------------------------------------------------------
// Round 12 (metrics tab): createdAt flows through every PR-bearing query
// ---------------------------------------------------------------------------

describe('createdAt selection (PR lifespan metric)', () => {
  it('PrCore fragment carries createdAt (sweep + open/merged page queries share it)', () => {
    for (const q of [
      buildSweepQuery(['acme'], '2026-06-10T12:00:00Z'),
      buildMergedPageQuery('acme', '2026-06-10T12:00:00Z', 'CUR'),
      buildOpenPageQuery('acme', 'CUR'),
    ]) {
      const fragment = q.split('fragment PrCore on PullRequest')[1]!;
      expect(fragment).toContain('createdAt');
    }
  });

  it('detail query selects createdAt too (detail fetch also upserts merged PRs)', () => {
    const q = buildDetailQuery([{ owner: 'acme', name: 'widgets', number: 8962 }]);
    expect(q).toContain('createdAt');
  });
});

// ---------------------------------------------------------------------------
// Workflow-change impact (issue #49): the detail query carries the file list
// ---------------------------------------------------------------------------

describe('PR file list selection (issue #49)', () => {
  it('detail query selects files(first: 50) paths — the touchesWorkflows source', () => {
    const q = buildDetailQuery([{ owner: 'acme', name: 'widgets', number: 8962 }]);
    expect(q).toContain('files(first: 50) { nodes { path } }');
  });
});
