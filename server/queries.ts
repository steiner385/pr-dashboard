/** Safely escape a string for inline interpolation into a GraphQL query literal. */
function q(s: string): string {
  return JSON.stringify(s);
}

/**
 * Escape a value for interpolation inside an already-quoted search string —
 * e.g. the owner in `"user:${owner} is:pr ..."`. The outer double-quotes are
 * owned by the GraphQL string literal, so we only need to escape backslashes
 * and inner double-quotes, not the whole value.
 */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Tiny startup query: who owns the token (owners auto-derivation fallback). */
export function buildViewerQuery(): string {
  return 'query { viewer { login } }';
}

const PR_CORE_FRAGMENT = `
fragment PrCore on PullRequest {
  number title url isDraft createdAt mergedAt
  repository { nameWithOwner }
  mergeCommit { oid }
  mergedBy { login }
}`;

export function buildSweepQuery(owners: string[], mergedSince: string): string {
  const opens = owners.map((o, i) =>
    `open${i}: search(query: "user:${esc(o)} is:pr is:open archived:false", type: ISSUE, first: 50) { issueCount pageInfo { hasNextPage endCursor } nodes { ...PrCore } }`);
  const merged = owners.map((o, i) =>
    `merged${i}: search(query: "user:${esc(o)} is:pr is:merged merged:>=${mergedSince} archived:false", type: ISSUE, first: 50) { issueCount pageInfo { hasNextPage endCursor } nodes { ...PrCore } }`);
  return `query {
  rateLimit { remaining resetAt }
  ${opens.join('\n  ')}
  ${merged.join('\n  ')}
}
${PR_CORE_FRAGMENT}`;
}

/** Follow-up page of a merged search (startup deep sweep only — the 7-day window
 *  can exceed one page of 50; routine incremental sweeps never should). */
export function buildMergedPageQuery(owner: string, mergedSince: string, cursor: string): string {
  return `query {
  rateLimit { remaining resetAt }
  merged: search(query: "user:${esc(owner)} is:pr is:merged merged:>=${mergedSince} archived:false", type: ISSUE, first: 50, after: ${q(cursor)}) {
    issueCount pageInfo { hasNextPage endCursor } nodes { ...PrCore }
  }
}
${PR_CORE_FRAGMENT}`;
}

/** Follow-up page of an open-PR search (EVERY sweep — open PRs are the core
 *  dataset, so unlike the merged 7-day window this set must always be complete;
 *  >50 open PRs per owner happens routinely). */
export function buildOpenPageQuery(owner: string, cursor: string): string {
  return `query {
  rateLimit { remaining resetAt }
  open: search(query: "user:${esc(owner)} is:pr is:open archived:false", type: ISSUE, first: 50, after: ${q(cursor)}) {
    issueCount pageInfo { hasNextPage endCursor } nodes { ...PrCore }
  }
}
${PR_CORE_FRAGMENT}`;
}

/**
 * Read one in-repo file as a blob (e.g. `HEAD:.pr-dashboard.yml`) — `HEAD:`
 * expressions resolve against the default branch, so callers need not know the
 * branch name up front; `defaultBranchRef` is fetched alongside so unknown-branch
 * repos still report which branch was read.
 */
export function buildBlobQuery(owner: string, name: string, expression: string): string {
  return `query {
  rateLimit { remaining resetAt }
  repository(owner: ${q(owner)}, name: ${q(name)}) {
    defaultBranchRef { name }
    object(expression: ${q(expression)}) { ... on Blob { text } }
  }
}`;
}

/** One-shot listing of a directory's files WITH their text — `expression` is a
 *  `<ref>:<dir>` tree path (e.g. `HEAD:.github/workflows`). Used by rollup
 *  workflow auto-discovery: a single GraphQL call returns every workflow file's
 *  body, so we can find which one defines the rollup job after a file rename. */
export function buildTreeFilesQuery(owner: string, name: string, expression: string): string {
  return `query {
  rateLimit { remaining resetAt }
  repository(owner: ${q(owner)}, name: ${q(name)}) {
    object(expression: ${q(expression)}) {
      ... on Tree { entries { name path object { ... on Blob { text } } } }
    }
  }
}`;
}

function prDetailSelection(n: number): string {
  // files(first: 50): only the paths matter — the workflow-change flag
  // (issue #49) needs any path under .github/workflows/. Cost-aware cap at 50;
  // truncation is acceptable (a >50-file PR that buries its workflow change
  // past the cap just misses the advisory badge).
  return `number title url isDraft mergeStateStatus createdAt mergedAt headRefOid
    autoMergeRequest { mergeMethod }
    mergeCommit { oid }
    files(first: 50) { nodes { path } }
    mergeQueueEntry { position state enqueuedAt headCommit { oid } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) {
      pageInfo { hasNextPage }
      nodes { __typename ... on CheckRun {
        name status conclusion startedAt completedAt detailsUrl
        isRequired(pullRequestNumber: ${n})
        checkSuite { workflowRun { databaseId event runNumber runAttempt workflow { name } } }
      } }
    } } } } }`;
}

export function buildDetailQuery(prs: { owner: string; name: string; number: number }[]): string {
  const byRepo = new Map<string, number[]>();
  for (const p of prs) {
    const key = `${p.owner}/${p.name}`;
    byRepo.set(key, [...(byRepo.get(key) ?? []), p.number]);
  }
  const parts = [...byRepo.entries()].map(([key, numbers], i) => {
    const [owner, name] = key.split('/');
    const fields = numbers.map((n) => `pr${n}: pullRequest(number: ${n}) { ${prDetailSelection(n)} }`).join('\n    ');
    return `r${i}: repository(owner: ${q(owner)}, name: ${q(name)}) { nameWithOwner ${fields} }`;
  });
  return `query {
  rateLimit { remaining resetAt }
  ${parts.join('\n  ')}
}`;
}

export function buildQueueQuery(owner: string, name: string, branch: string): string {
  return `query {
  rateLimit { remaining resetAt }
  repository(owner: ${q(owner)}, name: ${q(name)}) {
    mergeQueue(branch: ${q(branch)}) {
      entries(first: 30) { nodes {
        position state enqueuedAt
        headCommit { oid }
        pullRequest { number }
      } }
    }
  }
}`;
}

export function buildOidRollupQuery(owner: string, name: string, oids: string[]): string {
  // workflowRun.createdAt feeds the dispatch-stall classifier (issue #39):
  // a run created >5min ago with no started check is wedged. GraphQL's
  // WorkflowRun has NO runStartedAt field (schema-verified 2026-06-12) — the
  // REST run_started_at==created_at signature is derived from check statuses.
  const fields = oids.map((oid, i) => `o${i}: object(oid: ${q(oid)}) { ... on Commit {
    oid
    statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun {
      name status conclusion startedAt completedAt detailsUrl
      checkSuite { workflowRun { databaseId event runNumber runAttempt createdAt workflow { name } } }
    } } } }
  } }`).join('\n  ');
  return `query {
  rateLimit { remaining resetAt }
  repository(owner: ${q(owner)}, name: ${q(name)}) { ${fields} }
}`;
}

export function buildBackfillQuery(owner: string, name: string, cursor: string | null): string {
  const after = cursor ? `, after: ${q(cursor)}` : '';
  return `query {
  rateLimit { remaining resetAt }
  repository(owner: ${q(owner)}, name: ${q(name)}) {
    defaultBranchRef { name target { ... on Commit {
      history(first: 10${after}) {
        pageInfo { hasNextPage endCursor }
        nodes { oid statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun {
          name status conclusion startedAt completedAt
          checkSuite { workflowRun { databaseId event runNumber runAttempt workflow { name } } }
        } } } } }
      }
    } } }
  }
}`;
}
