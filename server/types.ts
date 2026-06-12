export type CheckStatus = 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'WAITING' | 'PENDING' | 'REQUESTED';

export interface CheckRun {
  name: string;        // canonical (matrix-normalized) name
  rawName: string;
  /** Matrix-shard members collapsed into this row by dedupeChecks
   *  (1 / undefined = not a family). */
  shardCount?: number;
  status: CheckStatus;
  conclusion: string | null; // SUCCESS | FAILURE | SKIPPED | CANCELLED | TIMED_OUT | ...
  startedAt: string | null;
  completedAt: string | null;
  event: string;       // pull_request | merge_group | push | unknown
  /** Workflow display name from the check's workflowRun (e.g. `CI`,
   *  `Auto-merge PRs`); null when the API omits it (old data, no workflow). */
  workflowName: string | null;
  runNumber: number | null;
  isRequired: boolean;
  url: string | null;
}

export interface PrSnapshot {
  repo: string;        // owner/name
  number: number;
  title: string;
  url: string;
  headSha: string;
  isDraft: boolean;
  mergeStateStatus: string | null; // BLOCKED|BEHIND|DIRTY|UNSTABLE|CLEAN|UNKNOWN
  /** PR creation time (lifespan metric); null on placeholder snapshots/old data. */
  createdAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  autoMergeArmed: boolean;
  queue: { position: number; state: string; enqueuedAt: string | null; groupHeadOid: string | null } | null;
  checks: CheckRun[];
}

export interface QueueEntry {
  position: number;
  state: string;       // QUEUED | AWAITING_CHECKS | MERGEABLE | ...
  enqueuedAt: string | null;
  headCommitOid: string | null;
  prNumber: number;
}

export type StageId = 'ci' | 'parked' | 'ready' | 'queue' | 'qa-deploy' | 'awaiting-prod' | 'merged';

export interface StageResult {
  stage: StageId;
  substate: string | null; // ci-failed|conflicting|draft|armed|idle|propagating|unknown|retrying|group-failed|unmergeable|queue-blocked
  percent: number | null;
  etaSeconds: number | null;
  etaRangeSeconds: [number, number] | null;
  overdue: boolean;
}
