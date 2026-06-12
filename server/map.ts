import type { CheckRun, PrSnapshot, QueueEntry } from './types';
import { canonicalizeCheckName, dedupeChecks } from './normalize';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function mapRollupContexts(nodes: any[], isRequiredDefault = false): CheckRun[] {
  const runs: CheckRun[] = [];
  for (const n of nodes ?? []) {
    if (!n || n.__typename !== 'CheckRun') continue; // StatusContext has no timing data
    runs.push({
      name: canonicalizeCheckName(n.name),
      rawName: n.name,
      status: n.status,
      conclusion: n.conclusion ?? null,
      startedAt: n.startedAt ?? null,
      completedAt: n.completedAt ?? null,
      event: n.checkSuite?.workflowRun?.event ?? 'unknown',
      workflowName: n.checkSuite?.workflowRun?.workflow?.name ?? null,
      runNumber: n.checkSuite?.workflowRun?.runNumber ?? null,
      isRequired: n.isRequired ?? isRequiredDefault,
      url: n.detailsUrl ?? null,
    });
  }
  return dedupeChecks(runs);
}

/**
 * Map a single PR detail node from a batched GraphQL response to a PrSnapshot.
 *
 * Returns null when `node` is null or undefined — batched responses include null
 * aliases for PRs the token cannot access (private repo, removed PR, etc.).
 */
export function mapPrNode(repo: string, node: any): PrSnapshot | null {
  if (node == null) return null;
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const mq = node.mergeQueueEntry;
  return {
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    headSha: node.headRefOid,
    isDraft: !!node.isDraft,
    mergeStateStatus: node.mergeStateStatus ?? null,
    createdAt: node.createdAt ?? null,
    mergedAt: node.mergedAt ?? null,
    mergeCommitSha: node.mergeCommit?.oid ?? null,
    autoMergeArmed: !!node.autoMergeRequest,
    queue: mq ? {
      position: mq.position, state: mq.state,
      enqueuedAt: mq.enqueuedAt ?? null, groupHeadOid: mq.headCommit?.oid ?? null,
    } : null,
    checks: mapRollupContexts(rollup?.contexts?.nodes ?? []),
  };
}

export function mapQueueEntries(mergeQueue: any): QueueEntry[] {
  return (mergeQueue?.entries?.nodes ?? [])
    .filter((e: any) => e?.pullRequest)
    .map((e: any) => ({
      position: e.position,
      state: e.state,
      enqueuedAt: e.enqueuedAt ?? null,
      headCommitOid: e.headCommit?.oid ?? null,
      prNumber: e.pullRequest.number,
    }));
}
