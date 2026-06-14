import { EventEmitter } from 'node:events';
import type { GithubClient } from './github';
import { RateLimitError } from './github';
import type { ClientRouter } from './client-router';
import { FAILING_CONCLUSIONS, FLAKE_MIN_RUNS, type HistoryStore, type MergedPrRecord } from './history';
import type { DeployWatcher } from './deploy-watcher';
import { ApiAncestry, type AncestryAnswer } from './ancestry';
import { effectiveRepoSettings, effectiveDeployMap, poolRate, hasAnyRate,
  type AppConfig, type DeployConfig, type RepoSettings, type PoolMetaEntry } from './config';
import { parseRepoConfig, REPO_CONFIG_PATH, type RepoFileConfig } from './repo-config';
import type { WebhookRoute } from './webhooks';
import type { Notifier, NotificationsConfig } from './notifier';
import { deriveCiGraph, discoverRollupWorkflow, fileDefinesJob, activeForEvent, ciGraphToJson, ciGraphFromJson, type CiGraph, type CiGraphNode } from './required-checks';
import type { PrSnapshot, StageResult, QueueEntry, CheckRun } from './types';
import { buildSweepQuery, buildMergedPageQuery, buildOpenPageQuery, buildDetailQuery, buildQueueQuery, buildOidRollupQuery, buildBlobQuery, buildTreeFilesQuery } from './queries';
import { mapPrNode, mapQueueEntries, mapRollupContexts } from './map';
import { familyDisplayName, canonicalizeCheckName } from './normalize';
import { selectRunIdsToFetch, observedKey, jobsApiPath, resolveJobsResponse,
  pushRunsApiPath, selectPushRunIds, type JobsApiResponse,
  type WorkflowRunsResponse } from './pool-learning';
import type { ObservedPool } from './history';
import { computeProgress } from './estimator/progress';
import { applyEtaCalibration, CALIBRATED_STAGES } from './estimator/calibrate';
import { classify, requiredChecks, matchesRequiredPrefix, matchingPrefix, workflowScopeAllows, type DeployInfo } from './estimator/classify';
import { queueStage, simulateMergeEta, ejectProbability, type GroupProgress, type QueueStageResult, type MergeEtaSimulation } from './estimator/queue';
import { classifyQueueHealth, type GroupBuildTelemetry, type QueueHealthState } from './estimator/queue-health';
import { classifyWait, extractRunnerWaits, type NeedActivePredicate } from './estimator/waits';
import { measureDurationStep, flagsRegression, holdsRegression, regressionDetail,
  REGRESSION_MIN_SAMPLES } from './estimator/regression';
import { evaluateStarvation, nextStarving, starvationDetail } from './estimator/starvation';
import { countMergeTrains } from './trains';
import { computeRepoLaneHealth, type RepoLaneHealth } from './estimator/lane-health';
import { computeRepoDeploy, type RepoDeployStatus } from './estimator/deploy-status';
import { diffCiGraphs, type WorkflowImpact } from './workflow-impact';
import { splitOidChecks } from './oid-checks';
import { computeCostSummary, type CostSummary } from './metrics';
import { parseScheduledWorkflows, scheduledRunsApiPath, type ScheduledRunsApiResponse } from './scheduled';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CheckView {
  name: string; status: string; conclusion: string | null; isRequired: boolean;
  workflowName: string | null;
  elapsedSeconds: number | null; expectedSeconds: number | null; url: string | null;
  /** Lower/upper expected-duration bounds (p10/p90 over the same last-20 SUCCESS
   *  window as expectedSeconds); null whenever expectedSeconds is null. */
  expectedLowSeconds: number | null; expectedHighSeconds: number | null;
  waitKind: 'runner' | 'blocked' | 'unknown' | null; blockedOn: string | null;
  waitingSeconds: number | null; expectedRunnerWaitSeconds: number | null;
  /** Flake radar (issue #37): the check's 7-day flake rate when it has enough
   *  history (≥ FLAKE_MIN_RUNS distinct (sha, attempt) samples); null otherwise. */
  flakeRatePct: number | null;
  /** True when the check is CURRENTLY failing-class AND its flake rate is
   *  ≥ LIKELY_FLAKE_MIN_RATE_PCT — "likely flake, consider re-run". */
  likelyFlake: boolean;
  /** Duration regression (issue #41): true while the check's (name, event)
   *  series has an ACTIVE rolling-median step-up (the Gantt's ↑ badge). */
  regressed: boolean;
  /** The step's numbers when `regressed` (badge tooltip); null otherwise. */
  regression: DurationRegressionInfo | null;
  /** Spot-reclaim ledger (issue #46): true for a CANCELLED check whose sha has
   *  a NEWER attempt of the same check running/queued in the same rollup — the
   *  Gantt's '↻ re-run in progress — likely spot reclaim, do nothing' marker
   *  (codifies the never-manually-retrigger rule). */
  rerunInProgress: boolean;
}

/** The measured step behind an active duration regression (issue #41). */
export interface DurationRegressionInfo {
  priorP50Secs: number;
  recentP50Secs: number;
  ratio: number;
  /** completed_at of the recent window's oldest sample — the approximate onset. */
  sinceApprox: string;
}

/** One active regression as cached on the poller / served in metrics `regressions[]`. */
export interface DurationRegressionView extends DurationRegressionInfo {
  check: string;
  event: string;
}

/** The merged_prs waterfall spine (issue #50): the six pipeline waypoints of a
 *  merged PR, threaded verbatim from the merged record. Every field except
 *  mergedAt is nullable — a missing waypoint means "never observed" (pre-#44
 *  rows, merges between polls, PRs that skipped the queue) and the UI omits
 *  the segment rather than fabricating one. */
export interface PrTimeline {
  createdAt: string | null;
  firstGreenAt: string | null;
  enqueuedAt: string | null;
  mergedAt: string;
  qaLiveAt: string | null;
  prodLiveAt: string | null;
}

export interface PrView {
  repo: string; number: number; title: string; url: string;
  stage: StageResult;
  queueAheadCount: number | null;
  checks: CheckView[];
  /** Per-PR "where did the time go" waterfall (issue #50) — merged PRs within
   *  the retention window only; null for open PRs. */
  timeline: PrTimeline | null;
  /** Workflow-change flag (issue #49): the PR's file list touches
   *  `.github/workflows/**` — the row gets the '⚙ CI change' badge. */
  touchesWorkflows: boolean;
  /** Derived-graph diff vs the current main graph (issue #49) for flagged PRs:
   *  human summary lines for the expanded panel. Null when the PR doesn't
   *  touch workflows, the repo has no derived graph, the head blob hasn't
   *  been fetched/derived yet, or the graphs are identical. */
  workflowImpact: WorkflowImpact | null;
  /** Queued PRs only: the merge-group build's checks (the run driving the queue
   *  stage ETA), so the UI can label it separately from head-commit PR checks.
   *  Null when not queued or the group rollup hasn't been fetched yet. */
  groupChecks: CheckView[] | null;
  /** Multi-train merge ETA simulation (issue #40) for WAITING queue entries —
   *  null for building/covered/unmergeable entries, non-queued PRs, and repos
   *  without observed train durations (UI falls back to the single number). */
  mergeEtaSim: MergeEtaSimulation | null;
  /** CI cost of the CURRENT head's check run (cost explorer): elapsed runner
   *  minutes summed over the head's checks (running checks count started→now;
   *  foreign-workflow spans excluded). Null when no check has started, and
   *  for merged PRs (their head checks are no longer tracked). */
  costMinutes: number | null;
  /** The priced subset of costMinutes in dollars (poolRate per check:
   *  poolMeta > costPerMinute > 'default'). Null in minutes-only mode (no
   *  rates configured) or when costMinutes is null. */
  costDollars: number | null;
  /** True when costDollars is a KNOWN UNDERCOUNT: rates are configured but at
   *  least one counted check ran on an unpriced pool (its minutes are in
   *  costMinutes, its dollars aren't). Always false in minutes-only mode and
   *  when costMinutes is null — the flag qualifies a $ figure, never replaces
   *  one. The UI renders '(partial)'. */
  costDollarsPartial: boolean;
}

/** Absolute plausibility cap (secs) for a SUCCESS duration sample when the
 *  job's timeout is unknown (issue #61). Nothing in the watched fleets runs
 *  anywhere near this; stall-spanning contamination starts well above it. */
export const SUCCESS_DURATION_CAP_SECS = 4 * 3600;
/** Margin over a known `timeout-minutes`: a SUCCESS physically cannot outlive
 *  its own timeout; ×1.5 absorbs graph-derivation slop (min-merged node
 *  timeouts, enforcement lag). */
export const SUCCESS_TIMEOUT_CAP_FACTOR = 1.5;

/** Max plausible runtime (secs) for a SUCCESS sample of a job whose derived
 *  `timeout-minutes` is `timeoutMinutes` (null = unknown → absolute cap). */
export function maxPlausibleSuccessSecs(timeoutMinutes: number | null): number {
  return timeoutMinutes != null
    ? timeoutMinutes * 60 * SUCCESS_TIMEOUT_CAP_FACTOR
    : SUCCESS_DURATION_CAP_SECS;
}

/**
 * Shared check-set ingestion (detail fetch, group-rollup fetch, backfill):
 * records completed-check durations AND runner-pickup wait samples derived from
 * the needs graph (wait = startedAt − max(needed completedAt), no extra API calls).
 *
 * `poolFor` (issue #45): the job's runner-pool label candidates (poolsFor
 * semantics). Each wait sample stores the candidates JOINED with '|' — a
 * runs-on ternary's actually-chosen branch is unknowable from the rollup, so
 * the composite string IS the pool key ('kindash-runner|kindash-ondemand' is
 * one pool dimension, not two). Null/empty → pool NULL (unknown).
 */
export function ingestCheckSet(history: HistoryStore, repo: string, checks: CheckRun[],
  needsFor: (canonicalName: string) => string[] | null,
  activeFor: NeedActivePredicate = () => true,
  graphKeys: readonly string[] | null = null,
  rollupWorkflowName: string | null = null,
  headSha: string | null = null,
  timeoutMinutesFor: (canonicalName: string) => number | null = () => null,
  poolFor: (canonicalName: string) => string[] | null = () => null): void {
  for (const c of checks) {
    if (c.status === 'COMPLETED') {
      // Plausibility guard (issue #61): a SUCCESS span exceeding the job's own
      // timeout (×1.5) — or 4h when no timeout is derivable — is wait/re-run
      // contamination, not runtime. Drop the sample rather than poison the
      // p99 tail (timeout lint) and expected medians. Non-SUCCESS rows always
      // record: flake radar consumes their identity, never their duration.
      // The derived graph describes the ROLLUP workflow's jobs, so the timeout
      // lookup is workflow-scoped: a foreign check (`ci-gate` from `Auto-merge
      // PRs` startsWith-matching the `ci` node) must not inherit `ci`'s
      // timeout — its hours-long SUCCESS spans are by design (it mirrors the
      // whole CI lifecycle across spot retries). Foreign checks fall back to
      // the absolute cap.
      if ((c.conclusion ?? '') === 'SUCCESS' && c.startedAt && c.completedAt) {
        const secs = (Date.parse(c.completedAt) - Date.parse(c.startedAt)) / 1000;
        const timeout = workflowScopeAllows(c.workflowName, rollupWorkflowName)
          ? timeoutMinutesFor(c.name) : null;
        if (secs > maxPlausibleSuccessSecs(timeout)) continue;
      }
      // headSha: the commit this check set was fetched for (PR head / group head /
      // default-branch commit); runAttempt + runNumber ride on each check
      // (issue #34; run number = the cost explorer's per-run grouping key)
      history.recordCheckDuration(repo, c.name, c.event, c.startedAt, c.completedAt,
        c.conclusion ?? 'UNKNOWN', headSha, c.runAttempt, c.runNumber);
    }
  }
  for (const s of extractRunnerWaits(checks, needsFor, activeFor, graphKeys, rollupWorkflowName)) {
    const pools = poolFor(s.name);
    history.recordRunnerWait(repo, s.name, s.event, s.waitSecs, s.startedAt,
      pools?.length ? pools.join('|') : null);
  }
}

/**
 * PR-level CI cost (cost explorer): runner occupancy of ONE check set — the
 * current head's checks — as elapsed minutes (completed: started→completed;
 * running: started→now) plus the priced subset in dollars. Foreign-workflow
 * checks are excluded exactly like the metrics cost section (issue #61): their
 * spans are CI-lifecycle wall-clock, not runner occupancy. Per check the rate
 * resolves through its runs-on pool (poolFor candidates joined '|', unknown →
 * 'unknown') with the poolRate precedence (poolMeta > costPerMinute > the
 * 'default' pair); unpriced checks contribute minutes but no dollars — the
 * same documented undercount as the metrics $ totals, surfaced here as
 * `costDollarsPartial: true` so the UI can label the $ figure '(partial)'.
 * Returns nulls when no check has started; dollars is null (and partial
 * false) in minutes-only mode (no rates at all).
 */
export function computePrCost(checks: CheckRun[], rollupWorkflowName: string | null,
  poolFor: (canonicalName: string) => string[] | null,
  costPerMinute: Record<string, number> | null,
  poolMeta: Record<string, PoolMetaEntry> | null,
  now: Date): { costMinutes: number | null; costDollars: number | null;
    costDollarsPartial: boolean } {
  let sawSample = false;
  let sawUnpriced = false;
  let minutes = 0;
  let dollars = 0;
  for (const c of checks) {
    if (!c.startedAt) continue;
    if (!workflowScopeAllows(c.workflowName, rollupWorkflowName)) continue;
    const endMs = c.completedAt ? Date.parse(c.completedAt) : now.getTime();
    const secs = (endMs - Date.parse(c.startedAt)) / 1000;
    if (!(secs > 0)) continue; // negative spans (SKIPPED placeholders) and NaN
    sawSample = true;
    const mins = secs / 60;
    minutes += mins;
    const pools = poolFor(c.name);
    const rate = poolRate(pools?.length ? pools.join('|') : 'unknown', costPerMinute, poolMeta);
    if (rate != null) dollars += mins * rate;
    else sawUnpriced = true;
  }
  if (!sawSample) return { costMinutes: null, costDollars: null, costDollarsPartial: false };
  const hasRates = hasAnyRate(costPerMinute, poolMeta);
  return { costMinutes: minutes,
    costDollars: hasRates ? dollars : null,
    costDollarsPartial: hasRates && sawUnpriced };
}

/** Flake-rate map key — check names contain spaces and ' / ', so a NUL it is. */
const flakeKey = (name: string, event: string): string => `${name}\u0000${event}`;

/** A currently-failing-class flake rate at/above this reads as "likely flake". */
export const LIKELY_FLAKE_MIN_RATE_PCT = 20;

/** Live likelyFlake annotations look back this far (the 7-day flake window). */
const FLAKE_LOOKBACK_MS = 7 * 86400_000;

/** Re-query a repo's flake rates from history at most this often (the lookup is
 *  effectively cached per build — buildState runs well under this cadence). */
const FLAKE_CACHE_TTL_MS = 60_000;

/** Pool-learning dedup window (jobs-API feature): a run id fetched within this
 *  window isn't re-fetched, so re-polling the same PR across nearby cycles
 *  doesn't repeat the jobs call. Long enough to cover a hot PR's poll cadence,
 *  short enough that the in-memory cache stays small. */
const RECENTLY_FETCHED_RUN_TTL_MS = 30 * 60_000;

/** Duration-regression scan cadence (issue #41): the scan rides the deploy
 *  cycle but runs at most hourly — a step over 30 samples moves on the scale
 *  of CI runs, not poll ticks, and the whole-DB candidate query needn't run
 *  every few minutes. */
export const REGRESSION_SCAN_INTERVAL_MS = 3600_000;

/** A candidate series whose newest SUCCESS sample is older than this is
 *  dormant — skipped, so a renamed/retired check's last step can't stick as an
 *  active regression forever (mirrors the 14-day expectedSet horizon). */
const REGRESSION_DORMANT_MS = 14 * 86400_000;

/**
 * Train-killer attribution (issue #38): record each failing-class COMPLETED
 * check of a merge-group build as a culprit for that group sha. INSERT OR
 * IGNORE in HistoryStore makes this once per (repo, group sha, check) no matter
 * how many poll cycles re-ingest the same rollup. Non-failing conclusions
 * (SUCCESS/SKIPPED/NEUTRAL/CANCELLED — cancellation is an ejection side effect,
 * not a verdict) and still-running checks never record.
 */
export function ingestGroupFailures(history: HistoryStore, repo: string,
  groupSha: string, checks: CheckRun[]): void {
  for (const c of checks) {
    if (c.status !== 'COMPLETED' || !FAILING_CONCLUSIONS.has(c.conclusion ?? '')) continue;
    if (!c.completedAt) continue;
    history.recordGroupFailure(repo, c.name, groupSha, c.completedAt);
  }
}
/** Fold the push:main subset of an OID rollup into main_commits. The worst push
 *  conclusion is the commit's push-CI verdict; an empty subset records nothing
 *  (→ blind/idle, never a false green). */
export function recordMainFromOid(history: HistoryStore, repo: string, oid: string,
  mergedAt: string | null, pushChecks: CheckRun[]): void {
  if (pushChecks.length === 0) return;
  const order: Record<string, number> = { STARTUP_FAILURE: 5, TIMED_OUT: 5, FAILURE: 5, SUCCESS: 2, NEUTRAL: 1, SKIPPED: 0 };
  const worst = pushChecks.reduce<string | null>((w, c) =>
    (c.conclusion && (w == null || (order[c.conclusion] ?? 3) > (order[w] ?? 3))) ? c.conclusion : w, null);
  const completedAt = pushChecks.map((c) => c.completedAt).filter(Boolean).sort().pop() ?? null;
  history.recordMainCommit(repo, oid, mergedAt, worst, completedAt);
}
/**
 * Spot-reclaim live marker (issue #46): a CANCELLED check whose SHA already
 * has a newer-attempt check running/queued in the same rollup —
 * `re-run-on-spot-cancel` (or a human) already re-triggered, so the right
 * action is NOTHING. Detection is sha-level (any same-event check at a higher
 * run_attempt), not same-name: dedupeChecks collapses a re-created same-name
 * check into its family, so the surviving evidence of an in-flight re-run is
 * usually a SIBLING check at attempt N+1. Null attempts never match (no
 * false "do nothing" advice on old data).
 */
export function rerunInProgressFor(c: CheckRun, all: CheckRun[]): boolean {
  if (c.status !== 'COMPLETED' || c.conclusion !== 'CANCELLED' || c.runAttempt == null) return false;
  return all.some((d) => d !== c && d.event === c.event
    && d.status !== 'COMPLETED'
    && d.runAttempt != null && d.runAttempt > c.runAttempt!);
}

/** Pool-starvation scan cadence (issue #45) shares the hourly trigger with the
 *  duration-regression scan — see maybeRunHourlyScans. */
const STARVATION_BASELINE_MS = 7 * 86400_000;
const STARVATION_LAST_HOUR_MS = 3600_000;

/** One evaluated (repo, pool)'s live starvation state — metrics `runnerPools`
 *  joins this onto the window-bucketed series ("current p90 vs baseline"). */
export interface PoolHealthView {
  pool: string;
  /** p90 pickup wait over the last hour's samples; null with none. */
  lastHourP90Secs: number | null;
  /** p90 over the prior 7 days (excluding the last hour); null with none. */
  baselineP90Secs: number | null;
  /** Last-hour sample count. */
  n: number;
  /** Starvation alert currently active (entered at 4× baseline / 5min floor,
   *  clears below 2× — see estimator/starvation.ts). */
  starving: boolean;
}

/** Which config layer a per-repo setting value came from (GET /api/config). */
export type SettingSource = 'override' | 'in-repo' | 'derived' | 'default';
export interface RepoSettingsReport {
  rollupJobId: { value: string; source: SettingSource };
  workflowPath: { value: string; source: SettingSource };
  batchSize: { value: number; source: SettingSource };
  requiredCheckPrefixes: { value: string[] | null; source: SettingSource };
  deploy: { value: DeployConfig | null; source: SettingSource };
}
export interface QueueGroupView {
  oid: string;
  prNumbers: number[];
  percent: number | null;
  etaSeconds: number | null;
  failed: boolean;
}
/** Queue health (issue #39): classifier state + its remediation string +
 *  when the queue entered this state (ISO; resets on every state change). */
export interface QueueHealthView {
  state: QueueHealthState;
  detail: string;
  since: string;
}
export interface RepoQueueView {
  groups: QueueGroupView[];
  waiting: { prNumber: number; position: number; sim: MergeEtaSimulation | null }[];
  /** PR numbers of GENUINELY conflicting UNMERGEABLE entries (the PR's own
   *  snapshot is DIRTY against the base — needs a rebase, facing ejection) —
   *  excluded from group coverage and waiting, surfaced separately. */
  unmergeable: number[];
  /** PR numbers of cascade-UNMERGEABLE entries: GitHub marks queue entries
   *  UNMERGEABLE *positionally*, so one genuine conflict poisons the speculative
   *  merge of every entry behind it. These do NOT conflict with the base
   *  themselves (snapshot not DIRTY, or no snapshot yet) and revalidate once the
   *  culprit is ejected — same coverage/waiting exclusion, different advice. */
  queueBlocked: number[];
  /** The lowest-position UNMERGEABLE entry whose snapshot is DIRTY (the entry
   *  poisoning the rest); falls back to the lowest-position UNMERGEABLE entry
   *  when no DIRTY snapshot identifies it. Null without UNMERGEABLE entries. */
  unmergeableCulprit: number | null;
  batchSize: number;
  /** Ops console (issue #39): dispatch-stall vs cap-backlog discrimination. */
  health: QueueHealthView;
  /** Live queue depth — every entry, including UNMERGEABLE ones. */
  depth: number;
  /** Time-in-queue per entry (live enqueuedAt → now), ascending by position;
   *  entries without a parseable enqueuedAt are omitted. */
  entriesWithWaitSecs: { prNumber: number; position: number; waitSecs: number }[];
  /** Clean trains completed in the last 24h ÷ 24. */
  trainsPerHour: number;
  /** runs / (runs + distinct ejected groups) over the last 7d, %; null with
   *  no samples at all. */
  batchSuccessRatePct: number | null;
  /** Distinct ejected group shas in the last 24h. */
  ejects24h: number;
}
export interface DashboardState {
  generatedAt: string;
  staleSince: string | null;
  repos: { repo: string; hasDeploy: boolean; prs: PrView[]; queue: RepoQueueView | null;
    laneHealth?: RepoLaneHealth; deploy?: RepoDeployStatus; scheduled?: RepoScheduledStatus }[];
  /** Cross-cutting global cost summary (Cost lane, Spec 3) — top-level, not
   *  per-repo, because cost is cross-cutting. Computed once per cycle in
   *  refreshCostSummary and cached (spec §15: buildState never hits SQLite).
   *  Absent until the first refresh. Mirror of metrics.ts CostSummary. */
  cost?: CostSummary;
}

/** Per-repo scheduled-lane snapshot attached to DashboardState.repos[] (Spec 4).
 *  `runs` is the newest recorded run per scheduled workflow; `discovered` is the
 *  count of scheduled workflows found (so the lane can show blind vs idle even
 *  before any run is recorded). Absent for repos with no scheduled workflows. */
export interface RepoScheduledStatus {
  runs: { workflow: string; conclusion: string | null; status: string | null;
    createdAt: string | null; htmlUrl: string | null }[];
  discovered: number;
}

interface PollerDeps {
  /** Per-owner request routing (App mode: one client per installation;
   *  gh/env: `ClientRouter.forSingle` over the one shared client). */
  router: ClientRouter;
  history: HistoryStore;
  deploy: DeployWatcher;
  config: AppConfig;
  /** Notification layer (issue #19): fed every classify result + the prod
   *  ancestry signal; its 'notification' events are re-emitted on this bus. */
  notifier?: Notifier;
  now?: () => Date;
}

const STAGE_ORDER: Record<string, number> = {
  'awaiting-prod': 6, 'qa-deploy': 5, merged: 4, queue: 3, ci: 2, ready: 1, parked: 0,
};

/** After every live check has been COMPLETED this long, absent expected names are
 *  considered path-gated for this PR (they aren't coming) and drop out of the set. */
const EXPECTED_SET_STALE_MS = 10 * 60_000;

/** Delay floor for the sweep cycle when the rate-limit budget runs low. */
const SWEEP_LOW_BUDGET_MS = 300_000;

/** Re-check ancestry for the same (sha, deployedSha) pair at most once per minute. */
const ANCESTRY_THROTTLE_MS = 60_000;

/** Page cap per owner for the startup (7-day window) deep merged sweep. */
const MAX_MERGED_PAGES = 12;

/** Page cap per owner for the open-PR search, followed on EVERY sweep — open PRs
 *  are the core dataset and must always be complete (unlike the merged 7-day
 *  window, which only needs depth at startup). 5 pages = 250 open PRs per owner;
 *  beyond that the sweep logs a truncation warning. */
const MAX_OPEN_PAGES = 5;

/** Re-derive required-check prefixes from a deploy repo's ci.yml at most this often. */
const PREFIX_DERIVE_INTERVAL_MS = 24 * 3600_000;

/** Recompute the global cost summary (Cost lane, Spec 3) at most this often —
 *  a 7-day rollup of every cost row moves slowly, so a per-sweep recompute
 *  would be wasted SQLite work. */
const COST_SUMMARY_INTERVAL_MS = 3 * 60_000;

/** Re-list a repo's recent push runs (to learn push-only job pools) at most
 *  this often per repo — the push job set is near-static, so 6h is plenty to
 *  fill it in without spamming the list call. */
const PUSH_POOL_LEARN_INTERVAL_MS = 6 * 3600_000;

/** Re-discover a repo's scheduled (cron) workflows at most this often — the
 *  set of `.github/workflows/*` files with an `on: schedule:` trigger is
 *  near-static, so a daily re-list is plenty (Scheduled lane, Spec 4). */
const SCHEDULED_DISCOVERY_INTERVAL_MS = 24 * 3600_000;

/** Re-poll a repo's scheduled-workflow runs at most this often per repo. One
 *  `?per_page=8` REST request per discovered workflow per eligible cycle; ~1/hr
 *  keeps the cost trivial (nightly/weekly cadence moves far slower). */
const SCHEDULED_RUNS_INTERVAL_MS = 3600_000;

/** Stages whose first ETA prediction is scored against the actual stage duration —
 *  the same set the conformal-lite range calibration applies to (single source
 *  of truth in estimator/calibrate.ts). */
const ETA_TRACKED_STAGES = CALIBRATED_STAGES;

/** Force an SSE emission (bypassing the unchanged-signature skip) when this long
 *  has passed since the last actual emission — keeps clients' generatedAt fresh. */
const EMIT_KEEPALIVE_MS = 60_000;

interface StageTrack { stageId: string; enteredAt: number; firstEta: number | null; }

type DelayKind = 'hot' | 'sweep' | 'deploy';

/** First retry after a failure (doubles per consecutive failure). */
const RETRY_BASE_MS = 60_000;
/** Backoff ceiling between failed attempts. */
const RETRY_CAP_MS = 10 * 60_000;

/**
 * Failure-aware refresh throttle (incident 2026-06-11: a connectivity blip at
 * startup failed the repo-config fetch and ci.yml derivation, and the old
 * attempt-armed 24h throttle locked the failure in for a day).
 *
 * The long `successIntervalMs` is armed ONLY by `success()`; `failure()` arms a
 * capped exponential backoff (1m, 2m, 4m, 8m, 10m, 10m, …) so the next eligible
 * cycle retries until a success re-arms the long interval.
 */
export class RetryThrottle {
  private nextAt = new Map<string, number>();
  private failures = new Map<string, number>();

  constructor(private successIntervalMs: number) {}

  due(key: string, nowMs: number): boolean {
    return nowMs >= (this.nextAt.get(key) ?? 0);
  }

  success(key: string, nowMs: number): void {
    this.failures.delete(key);
    this.nextAt.set(key, nowMs + this.successIntervalMs);
  }

  failure(key: string, nowMs: number): void {
    const n = this.failures.get(key) ?? 0;
    this.failures.set(key, n + 1);
    this.nextAt.set(key, nowMs + Math.min(RETRY_BASE_MS * 2 ** n, RETRY_CAP_MS));
  }
}

/**
 * One-line error description including the `cause` chain when present —
 * Node's fetch wraps the actionable bit (ENOTFOUND/ETIMEDOUT/…) in `e.cause`,
 * so a bare `e.message` is just "fetch failed". No stacks.
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const causes: string[] = [];
  let cur: unknown = e.cause;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (cur instanceof Error) {
      const code = (cur as NodeJS.ErrnoException).code;
      causes.push(code && !cur.message.includes(code) ? `${code} ${cur.message}` : (cur.message || String(code ?? cur)));
      cur = cur.cause;
    } else {
      causes.push(String(cur));
      break;
    }
  }
  return causes.length ? `${e.message} (cause: ${causes.join(' ← ')})` : e.message;
}

export class Poller extends EventEmitter {
  private prs = new Map<string, PrSnapshot>();            // key repo#number
  private stages = new Map<string, StageResult>();        // previous stage per PR (UNKNOWN-hold)
  private queueEntries = new Map<string, QueueEntry[]>(); // per repo
  private groupChecks = new Map<string, CheckRun[]>();    // group head oid → checks
  private recordedGroups = new Set<string>();             // oids whose completed run was recorded
  private queueEnqueuedAt = new Map<string, string>();    // PR key → enqueuedAt while queued
  private firstGreenAt = new Map<string, string>();       // PR key → first ci→green transition (#44)
  private queueHealthSince = new Map<string, { state: QueueHealthState; since: string }>(); // repo → current health state + entry time (#39)
  private stageTracker = new Map<string, StageTrack>();   // PR key → current stage + first ETA
  private repoFileConfigs = new Map<string, RepoFileConfig>(); // repo → parsed .pr-dashboard.yml
  private repoConfigThrottle = new RetryThrottle(PREFIX_DERIVE_INTERVAL_MS); // 24h on success, backoff on failure
  private repoConfigSig = new Map<string, string>();           // repo → loaded-config signature (log-on-change)
  private discoveredWorkflowPath = new Map<string, string>();  // repo → auto-discovered rollup workflow path (file-rename tolerance)
  private derivedPrefixes = new Map<string, string[]>();  // repo → ci.yml-derived prefixes
  private derivedGraph = new Map<string, Map<string, CiGraphNode>>(); // repo → node prefix → { needs, activity }
  private derivedWorkflowName = new Map<string, string | null>();     // repo → rollup workflow display name
  // Ground-truth job→pool learning (jobs-API feature): keys already mapped in
  // observed_pools (seeded at startup), so the loop only fetches NEW job names;
  // recentlyFetchedRunIds dedups jobs-API calls across nearby cycles.
  private observedPoolKeys = new Set<string>();                        // observedKey(repo, canonicalName, event)
  private recentlyFetchedRunIds = new Map<number, number>();           // runDatabaseId → last-fetched ms
  private deriveThrottle = new RetryThrottle(PREFIX_DERIVE_INTERVAL_MS); // 24h on success, backoff on failure
  private pushPoolThrottle = new RetryThrottle(PUSH_POOL_LEARN_INTERVAL_MS); // 6h on success; list-fail arms no throttle
  private envShas = new Map<string, string | null>();     // repo/env → deployed sha
  private propagating = new Set<string>();                // merged PR keys whose sha is 'missing'
  private discovered = new Set<string>();                  // every repo ever seen by a sweep (incl. excluded)
  private seenNotLive = new Set<string>();                // "repo#number/env" observed not-live here
  private ancestryCheckedAt = new Map<string, number>();  // "sha:deployedSha" → last check (ms)
  private inaccessibleOwners = new Set<string>();        // owners with repository-inaccessible evidence (process lifetime)
  private flakeRateCache = new Map<string, { at: number; rates: Map<string, number> }>(); // repo → name\0event → ratePct (#37)
  private durationRegressions = new Map<string, Map<string, DurationRegressionView>>(); // repo → name\0event → active step (#41)
  private poolStarvation = new Map<string, Map<string, PoolHealthView>>(); // repo → pool → live health (#45)
  private workflowImpactCache = new Map<string, WorkflowImpact | null>(); // repo\0headSha → derived-graph diff (#49)
  private laneHealthCache = new Map<string, RepoLaneHealth>();            // repo → per-cycle main-lane health (spec §15)
  private deployStatusCache = new Map<string, RepoDeployStatus>();        // repo → per-deploy-cycle deploy status (Deploy lane, spec §15)
  private scheduledCache = new Map<string, RepoScheduledStatus>();        // repo → per-cycle scheduled-lane snapshot (Scheduled lane, Spec 4)
  private discoveredScheduled = new Map<string, string[]>();              // repo → discovered scheduled workflow file basenames (Spec 4)
  private scheduledDiscoveryThrottle = new RetryThrottle(SCHEDULED_DISCOVERY_INTERVAL_MS); // 24h on success, backoff on failure
  private scheduledRunsThrottle = new RetryThrottle(SCHEDULED_RUNS_INTERVAL_MS);           // ~1h per repo on success, backoff on failure
  private costSummaryCache: CostSummary | undefined;                     // global per-stage cost (Cost lane, Spec 3); buildState reads this (spec §15)
  private costSummaryAt = 0;                                              // epoch ms of the last cost recompute (throttled — cost moves slowly)
  private lastHourlyScanAt = 0;                           // epoch ms of the last hourly scan pass (#41/#45)
  private warnedAncestryFallback = new Set<string>();    // repos whose api→clone ancestry fallback was logged (log once)
  private warnedJobsApi = new Set<string>();             // repos whose jobs-API pool-learn fetch failed (log once)
  private ancestryViaApiLogged = new Set<string>();      // repos whose first compare-API ancestry answer was logged (log once)
  private readonly apiAncestry: ApiAncestry;              // ancestrySource 'api' (the default)
  private warnedInaccessibleOwners = new Set<string>();   // owner-invisible diagnosability log fired (log once)
  private warnedUnknownOwners = new Set<string>();        // no-installation skip logged (once per owner per process)
  private staleSince: string | null = null;
  private pauseUntil = 0;                                 // rate-limit pause (epoch ms)
  private inFlight = new Set<string>();                   // re-entrancy latches per cycle
  private timers = new Set<NodeJS.Timeout>();
  private running = false;
  private generation = 0;        // bumped by stop()+start(); arm closures bail on mismatch
  private lastState: DashboardState | null = null;
  private lastEmittedSig: string | null = null;   // serialization with generatedAt blanked
  private lastEmittedAt = 0;                      // epoch ms of the last actual emission
  private now: () => Date;

  constructor(private deps: PollerDeps) {
    super();
    this.now = deps.now ?? (() => new Date());
    this.apiAncestry = new ApiAncestry(deps.router);
    // The poller IS the API's event bus — relay notifier events so the SSE
    // layer needs only one EventEmitter subscription target.
    deps.notifier?.on('notification', (ev) => this.emit('notification', ev));
    this.deps.history.pruneConflatedGroupStatsOnce();
    this.restorePersisted();
  }

  /**
   * Load last-known-good in-repo configs and derived ci.yml graphs from the
   * history `meta` table (`repoConfig:<repo>` / `ciGraph:<repo>`) so a process
   * restart during a GitHub outage starts from the last successful fetch
   * instead of nothing. Live fetches overwrite these on success; restoring
   * never arms the refresh throttles, so the first cycle still fetches fresh.
   */
  private restorePersisted(): void {
    try {
      const raw = this.deps.history.getMeta('discoveredRepos');
      if (raw) for (const r of JSON.parse(raw) as string[]) this.discovered.add(r);
    } catch { /* corrupt meta — rediscovered by the next sweep */ }
    const { history } = this.deps;
    for (const { key, value } of history.listMeta('repoConfig:')) {
      const repo = key.slice('repoConfig:'.length);
      try {
        const fields = JSON.parse(value) as Omit<RepoFileConfig, 'warnings'> | null;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
        this.repoFileConfigs.set(repo, { ...fields, warnings: [] });
        this.repoConfigSig.set(repo, JSON.stringify(fields));
        console.log(`[poller] restored persisted ${REPO_CONFIG_PATH} for ${repo} (source of: ${Object.keys(fields).join(', ') || 'nothing'})`);
      } catch { /* corrupt row — ignore, live fetch will rewrite it */ }
    }
    for (const { key, value } of history.listMeta('ciGraph:')) {
      const repo = key.slice('ciGraph:'.length);
      try {
        const graph = ciGraphFromJson(JSON.parse(value));
        if (!graph) continue;
        this.derivedPrefixes.set(repo, graph.prefixes);
        this.derivedGraph.set(repo, graph.nodes);
        this.derivedWorkflowName.set(repo, graph.workflowName);
        console.log(`[poller] restored persisted ci-graph for ${repo} (prefixes: ${graph.prefixes.join(', ')})`);
      } catch { /* corrupt row — ignore, live derivation will rewrite it */ }
    }
    for (const { key, value } of history.listMeta('discoveredWorkflowPath:')) {
      const repo = key.slice('discoveredWorkflowPath:'.length);
      if (value) this.discoveredWorkflowPath.set(repo, value);
    }
    // Seed the in-memory observed-pool set so the learning loop stays quiet for
    // job names already mapped on a previous run (only NEW names trigger a
    // jobs-API call).
    try {
      for (const r of history.observedPoolsByRepo()) {
        this.observedPoolKeys.add(observedKey(r.repo, r.checkName, r.event));
      }
    } catch { /* table absent on a legacy DB until first write — fine */ }
  }

  // ---- fetch cycles -------------------------------------------------------

  /**
   * @param deepMergedSweep startup-only (fresh DB): the merged window spans 7 days and
   * can exceed one search page — follow pagination up to MAX_MERGED_PAGES per owner.
   * Routine incremental sweeps (90s..minutes window) stay single-page.
   */
  async sweepOnce(deepMergedSweep = false): Promise<void> {
    return this.withLatch('sweep', () => this.sweepImpl(deepMergedSweep));
  }

  private async sweepImpl(deepMergedSweep: boolean): Promise<void> {
    const { history, config } = this.deps;
    const sweepStartedAt = this.now(); // captured BEFORE the fetch: next window must overlap it
    const since = history.getMeta('lastSweep') ?? new Date(sweepStartedAt.getTime() - 90_000).toISOString();
    const seenOpen = new Set<string>();
    const ownerResultCounts = new Map<string, number>();
    let warnedTruncation = false;
    let allOwnersAnswered = true;
    // One search request per owner, routed to the installation that covers it —
    // results from every owner merge into this single sweep pass. An owner with
    // no installation is a config mismatch (logged once, skipped, sweep stays
    // healthy); a FAILED owner fetch is an outage (staleSince set by guard).
    for (const owner of config.owners) {
      const client = this.routedClient(owner);
      if (!client) {
        ownerResultCounts.set(owner, 0); // counted toward the inaccessible-owner warning
        continue;
      }
      const data = await this.guard(() => client.graphql<Record<string, any>>(buildSweepQuery([owner], since)));
      if (!data) { allOwnersAnswered = false; continue; }
      for (const [alias, payload] of Object.entries(data)) {
        if (!alias.startsWith('open') && !alias.startsWith('merged')) continue;
        const nodes: any[] = (payload as any)?.nodes ?? [];
        const issueCount: number = (payload as any)?.issueCount ?? 0;
        const pageInfo = (payload as any)?.pageInfo as { hasNextPage?: boolean; endCursor?: string | null } | undefined;
        ownerResultCounts.set(owner, (ownerResultCounts.get(owner) ?? 0) + nodes.length);
        // Open searches paginate on EVERY sweep (the open set must be complete —
        // see fetchOpenPages); merged searches only on the startup deep sweep.
        const willPaginate = (alias.startsWith('open') || (deepMergedSweep && alias.startsWith('merged')))
          && !!pageInfo?.hasNextPage && !!pageInfo.endCursor;
        if (!warnedTruncation && issueCount > nodes.length && !willPaginate) {
          console.warn(`[poller] sweep truncated: ${alias} (owner ${owner}) returned ${nodes.length} of ${issueCount} PRs`);
          warnedTruncation = true;
        }
        for (const node of nodes) this.ingestSweepNode(node, seenOpen);
        if (willPaginate && alias.startsWith('open')) {
          const complete = await this.fetchOpenPages(client, owner, pageInfo!.endCursor!, seenOpen);
          // a failed follow-up page leaves the open set incomplete — the prune
          // below must not read the missing pages as "closed without merge"
          if (!complete) allOwnersAnswered = false;
        } else if (willPaginate) {
          await this.fetchMergedPages(client, owner, since, pageInfo!.endCursor!, seenOpen);
        }
      }
    }
    this.warnInvisibleOwners(ownerResultCounts);
    if (allOwnersAnswered) {
      // prune + window advance only when every covered owner answered — a failed
      // owner's open PRs must not read as "vanished (closed without merge)".
      // Live queue entries also protect their PR: the open search paginates but
      // caps at MAX_OPEN_PAGES (250), so a queued PR can be absent from results
      // while still very much open and queued — the queue-entries fetch is the
      // source of truth there (its entries vanish from queueEntries when the PR
      // merges or is ejected).
      const keep = new Set(seenOpen);
      for (const [repo, entries] of this.queueEntries) {
        for (const e of entries) keep.add(`${repo}#${e.prNumber}`);
      }
      for (const key of this.prs.keys()) if (!keep.has(key)) this.prs.delete(key);
      this.pruneCaches(keep);
      history.setMeta('lastSweep', sweepStartedAt.toISOString());
    }
    // Per-cycle lane-health recompute (spec §15): once here, at the end of the
    // sweep that just updated this.prs — buildState only reads the cache.
    this.refreshLaneHealth();
    // Global cost summary (Cost lane, Spec 3) — same cycle, throttled internally
    // (cost moves slowly); buildState only reads the cache.
    this.refreshCostSummary();
    this.emitUpdate();
  }

  private ingestSweepNode(node: any, seenOpen: Set<string>): void {
    const { history, config } = this.deps;
    const repo = node.repository.nameWithOwner as string;
    this.noteDiscovered(repo);
    if (config.exclude.includes(repo)) return;
    const key = `${repo}#${node.number}`;
    if (node.mergedAt) {
      const leadTime = this.takeLeadTimeStamps(key); // before recordQueueWaitOnMerge consumes enqueuedAt
      this.recordQueueWaitOnMerge(key, repo, node.mergedAt);
      this.recordEtaAccuracyOnMerge(key, repo, node.mergedAt);
      history.upsertMergedPr({ repo, number: node.number, title: node.title, url: node.url,
        mergedAt: node.mergedAt, mergeCommitSha: node.mergeCommit?.oid ?? null,
        createdAt: node.createdAt ?? null, ...leadTime });
      this.prs.delete(key); // no longer an open PR snapshot
    } else {
      seenOpen.add(key);
      if (!this.prs.has(key)) {
        // placeholder until detail fetch fills it in
        this.prs.set(key, { repo, number: node.number, title: node.title, url: node.url,
          headSha: '', isDraft: !!node.isDraft, mergeStateStatus: null,
          createdAt: node.createdAt ?? null, mergedAt: null,
          mergeCommitSha: null, autoMergeArmed: false, touchesWorkflows: false,
          queue: null, checks: [] });
      }
    }
  }

  /** Startup deep sweep: follow merged-search pagination (pages 2..MAX) for one owner. */
  private async fetchMergedPages(client: GithubClient, owner: string, since: string,
    cursor: string, seenOpen: Set<string>): Promise<void> {
    for (let page = 2; page <= MAX_MERGED_PAGES; page++) {
      const data = await this.guard(() => client.graphql<Record<string, any>>(
        buildMergedPageQuery(owner, since, cursor)));
      if (!data) return;
      const payload = (data as any).merged;
      for (const node of payload?.nodes ?? []) this.ingestSweepNode(node, seenOpen);
      const pageInfo = payload?.pageInfo as { hasNextPage?: boolean; endCursor?: string | null } | undefined;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
      cursor = pageInfo.endCursor;
    }
    console.warn(`[poller] deep merged sweep for ${owner} stopped at the ${MAX_MERGED_PAGES}-page cap`);
  }

  /**
   * Every sweep: follow open-search pagination (pages 2..MAX) for one owner —
   * a single page drops rows for owners with >50 open PRs (live 2026-06-11:
   * cairnea had 58, so up to 8 PRs had no row unless a queue entry materialized
   * a placeholder). Returns false when a follow-up fetch failed (open set
   * incomplete — caller must skip the prune); true otherwise, including the
   * cap-truncated case, which keeps the truncation warning for >250 only.
   */
  private async fetchOpenPages(client: GithubClient, owner: string,
    cursor: string, seenOpen: Set<string>): Promise<boolean> {
    for (let page = 2; page <= MAX_OPEN_PAGES; page++) {
      const data = await this.guard(() => client.graphql<Record<string, any>>(
        buildOpenPageQuery(owner, cursor)));
      if (!data) return false;
      const payload = (data as any).open;
      for (const node of payload?.nodes ?? []) this.ingestSweepNode(node, seenOpen);
      const pageInfo = payload?.pageInfo as { hasNextPage?: boolean; endCursor?: string | null } | undefined;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return true;
      cursor = pageInfo.endCursor;
    }
    console.warn(`[poller] open sweep for ${owner} truncated at the ${MAX_OPEN_PAGES}-page cap (${MAX_OPEN_PAGES * 50} open PRs) — rows beyond the cap are dropped`);
    return true;
  }

  /** Drop cache entries whose subject is gone — these Maps are otherwise unbounded. */
  private pruneCaches(openKeys: Set<string>): void {
    const { history, config } = this.deps;
    const tracked = new Set(history.listTrackedMerged(config.retentionDays, this.now())
      .map((r) => `${r.repo}#${r.number}`));
    for (const key of this.stages.keys()) {
      if (!openKeys.has(key) && !tracked.has(key)) this.stages.delete(key);
    }
    for (const key of this.stageTracker.keys()) {
      if (!openKeys.has(key) && !tracked.has(key)) this.stageTracker.delete(key);
    }
    for (const key of this.propagating) {
      if (!tracked.has(key)) this.propagating.delete(key);
    }
    for (const envKey of this.seenNotLive) {
      const prKey = envKey.slice(0, envKey.lastIndexOf('/'));
      if (!tracked.has(prKey)) this.seenNotLive.delete(envKey);
    }
    const queuedRepos = new Set([...this.prs.values()].filter((p) => p.queue).map((p) => p.repo));
    for (const repo of this.queueEntries.keys()) {
      if (!queuedRepos.has(repo)) this.queueEntries.delete(repo);
    }
    for (const repo of this.queueHealthSince.keys()) {
      if (!this.queueEntries.has(repo)) this.queueHealthSince.delete(repo);
    }
    const liveOids = new Set([...this.queueEntries.values()].flat()
      .map((e) => e.headCommitOid).filter((o): o is string => !!o));
    for (const oid of this.groupChecks.keys()) {
      if (!liveOids.has(oid)) this.groupChecks.delete(oid);
    }
    for (const oid of this.recordedGroups) {
      if (!liveOids.has(oid)) this.recordedGroups.delete(oid);
    }
    for (const key of this.queueEnqueuedAt.keys()) {
      if (!openKeys.has(key)) this.queueEnqueuedAt.delete(key);
    }
    for (const key of this.firstGreenAt.keys()) {
      if (!openKeys.has(key)) this.firstGreenAt.delete(key);
    }
    // workflow-impact diffs (issue #49) are keyed repo\0headSha — keep only
    // entries whose sha is a live open-PR head (new pushes age old shas out)
    const liveShaKeys = new Set([...this.prs.values()]
      .filter((p) => p.headSha).map((p) => `${p.repo}\u0000${p.headSha}`));
    for (const key of this.workflowImpactCache.keys()) {
      if (!liveShaKeys.has(key)) this.workflowImpactCache.delete(key);
    }
    // lane-health cache (spec §15) is keyed by repo — drop repos no longer
    // surfaced (open-PR repos ∪ tracked-merged repos); refreshLaneHealth re-fills
    // the survivors next cycle
    const liveRepos = new Set([...this.prs.values()].map((p) => p.repo));
    for (const key of tracked) liveRepos.add(key.slice(0, key.lastIndexOf('#')));
    for (const repo of this.laneHealthCache.keys()) {
      if (!liveRepos.has(repo)) this.laneHealthCache.delete(repo);
    }
    // scheduled-lane discovery (Spec 4) is keyed by repo — drop repos no longer
    // surfaced (scheduledCache is cleared+rebuilt each cycle, so it self-prunes).
    for (const repo of this.discoveredScheduled.keys()) {
      if (!liveRepos.has(repo)) this.discoveredScheduled.delete(repo);
    }
    // notifier debounce state lives per PR key — same lifecycle as `stages`
    this.deps.notifier?.prune(new Set([...openKeys, ...tracked]));
  }

  /** Record repository-inaccessible evidence (blob/detail layer) for the repo's owner. */
  private noteInaccessibleRepo(repo: string): void {
    const owner = repo.split('/')[0];
    if (owner) this.inaccessibleOwners.add(owner);
  }

  /**
   * Route an owner to the client whose installation covers it. An owner no
   * installation covers is a CONFIG mismatch, not an outage: log once per owner
   * per process, count it as inaccessible-owner evidence, and return null so the
   * caller skips — staleSince must stay untouched.
   */
  private routedClient(owner: string): GithubClient | null {
    const client = this.deps.router.clientFor(owner);
    if (!client && !this.warnedUnknownOwners.has(owner)) {
      this.warnedUnknownOwners.add(owner);
      this.inaccessibleOwners.add(owner);
      console.warn(`[poller] owner '${owner}' has no installation — skipped`);
    }
    return client;
  }

  /**
   * Diagnosability for an owner the token cannot see at all (App-mode: the
   * installation doesn't cover that account — search just returns nothing, so
   * the owner's data silently rots). When a sweep returns 0 results for an
   * owner AND the detail/blob layer has seen repository-inaccessible errors
   * for that owner's repos this process lifetime, log once. No UI change.
   */
  private warnInvisibleOwners(ownerResultCounts: Map<string, number>): void {
    // iterate the counts map (not config.owners): an owner whose fetch FAILED this
    // sweep is absent from the map and must not read as "invisible" off one blip
    for (const [owner, count] of ownerResultCounts) {
      if (count > 0) continue;
      if (!this.inaccessibleOwners.has(owner) || this.warnedInaccessibleOwners.has(owner)) continue;
      this.warnedInaccessibleOwners.add(owner);
      console.warn(`[poller] owner '${owner}' appears inaccessible to the current token (App installation missing?)`);
    }
  }

  /** @param onlyKey webhook nudges: restrict the fetch to one tracked PR (`repo#number`). */
  async detailOnce(onlyHot = false, onlyKey?: string): Promise<void> {
    return this.withLatch('detail', () => this.detailImpl(onlyHot, onlyKey));
  }

  private async detailImpl(onlyHot: boolean, onlyKey?: string): Promise<void> {
    const targets = [...this.prs.values()].filter((pr) => onlyKey
      ? `${pr.repo}#${pr.number}` === onlyKey
      : (!onlyHot || this.isHot(pr)));
    if (!targets.length) return;
    // Partition by repo owner: one batched query per owner, routed to the
    // installation that covers it. Owners share nothing — a failed or skipped
    // owner batch leaves the other owners' snapshots fresh.
    const byOwner = new Map<string, PrSnapshot[]>();
    for (const pr of targets) {
      const owner = pr.repo.split('/')[0] ?? '';
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), pr]);
    }
    for (const [owner, ownerTargets] of byOwner) {
      const client = this.routedClient(owner);
      if (!client) continue;
      await this.detailFetchBatch(client, ownerTargets);
    }
    this.emitUpdate();
  }

  /** Fetch + ingest one owner's detail batch (see detailImpl). */
  private async detailFetchBatch(client: GithubClient, targets: PrSnapshot[]): Promise<void> {
    const { history } = this.deps;
    const data = await this.guard(() => client.graphql<Record<string, any>>(buildDetailQuery(
      targets.map((p) => {
        const [owner, name] = p.repo.split('/');
        return { owner, name, number: p.number };
      }),
    )));
    if (!data) return;
    // Alias rN → repo, matching buildDetailQuery's grouping (first-seen target
    // order) — a null alias carries no nameWithOwner, so the inaccessible repo
    // must be recovered positionally.
    const aliasRepos: string[] = [];
    for (const t of targets) {
      if (!aliasRepos.includes(t.repo)) aliasRepos.push(t.repo);
    }
    for (const [alias, repoPayload] of Object.entries(data)) {
      if (!/^r\d+$/.test(alias)) continue;
      if (repoPayload == null) {
        // Repository alias resolved to null (partial-errors path): the token
        // cannot see the repo. Keep last snapshots; note it for diagnosability.
        const repo = aliasRepos[Number(alias.slice(1))];
        if (repo) this.noteInaccessibleRepo(repo);
        continue;
      }
      if (typeof repoPayload !== 'object' || !(repoPayload as any).nameWithOwner) continue;
      const repo = (repoPayload as any).nameWithOwner as string;
      for (const [alias, node] of Object.entries(repoPayload as Record<string, any>)) {
        if (!alias.startsWith('pr')) continue;
        const snap = mapPrNode(repo, node);
        if (!snap) continue; // null alias: PR inaccessible/deleted — keep last snapshot
        const key = `${repo}#${snap.number}`;
        this.prs.set(key, snap);
        if (snap.mergedAt) {
          const leadTime = this.takeLeadTimeStamps(key); // before recordQueueWaitOnMerge consumes enqueuedAt
          this.recordQueueWaitOnMerge(key, repo, snap.mergedAt);
          this.recordEtaAccuracyOnMerge(key, repo, snap.mergedAt);
          history.upsertMergedPr({ repo, number: snap.number, title: snap.title, url: snap.url,
            mergedAt: snap.mergedAt, mergeCommitSha: snap.mergeCommitSha,
            createdAt: snap.createdAt, ...leadTime });
          this.prs.delete(key);
        } else if (snap.queue) {
          // remember enqueuedAt while the PR sits in the queue — the merged detail
          // fetch deletes the snapshot, so this must be captured beforehand
          if (snap.queue.enqueuedAt) this.queueEnqueuedAt.set(key, snap.queue.enqueuedAt);
        } else {
          this.queueEnqueuedAt.delete(key); // dequeued without merging — no wait sample
        }
        ingestCheckSet(history, repo, snap.checks, (n) => this.needsFor(repo, n),
          (p, e) => this.needActiveFor(repo, p, e), this.graphKeysFor(repo),
          this.rollupWorkflowFor(repo), snap.headSha || null,
          (n) => this.timeoutMinutesFor(repo, n), (n) => this.poolsFor(repo, n));
        // Ground-truth pool learning (jobs-API feature): map any new (check,
        // event) keys to their real runner pool via the Jobs REST API.
        await this.learnPoolsFromChecks(client, repo, snap.checks);
        // workflow-change impact (issue #49): flagged open PRs only, and only
        // when the repo has a main-derived graph to diff against; cached per
        // head sha so re-polls cost nothing.
        if (!snap.mergedAt && snap.touchesWorkflows && snap.headSha) {
          await this.computeWorkflowImpact(client, repo, snap.headSha);
        }
      }
    }
  }

  /**
   * Derived-graph diff for a workflow-touching PR head (issue #49): fetch the
   * head blob of the repo's rollup workflow, derive it, and diff against the
   * current main-derived graph. Runs at detail-fetch time only for flagged
   * PRs; the result (including null = no change) is cached per (repo, head
   * sha). A transport failure caches nothing — the next detail cycle retries.
   */
  private async computeWorkflowImpact(client: GithubClient, repo: string, headSha: string): Promise<void> {
    const cacheKey = `${repo}\u0000${headSha}`;
    if (this.workflowImpactCache.has(cacheKey)) return;
    const baseNodes = this.derivedGraph.get(repo);
    const basePrefixes = this.derivedPrefixes.get(repo);
    if (!baseNodes || !basePrefixes) return; // no derived graph — nothing to diff against
    const settings = this.settingsFor(repo);
    const [owner, name] = repo.split('/');
    let text: unknown;
    try {
      const data = await client.graphql<{ repository?: { object?: { text?: unknown } | null } | null }>(
        buildBlobQuery(owner ?? '', name ?? '', `${headSha}:${settings.workflowPath}`));
      if (data?.repository == null) {
        this.noteInaccessibleRepo(repo);
        return; // partial-errors shape — treat as transient, retry next cycle
      }
      text = data.repository.object?.text;
    } catch (e) {
      if (e instanceof RateLimitError) this.notePause(e.retryAfterSeconds);
      console.warn(`[workflow-impact] ${repo}@${headSha.slice(0, 9)}: head ${settings.workflowPath} fetch failed — will retry: ${describeError(e)}`);
      return;
    }
    // From here every outcome is deterministic for this sha — cache it.
    // Missing file at head (renamed/deleted) or unparseable YAML: nothing to
    // diff, the badge alone signals "CI change, inspect manually".
    const headGraph = typeof text === 'string' ? deriveCiGraph(text, settings.rollupJobId) : null;
    const base: CiGraph = { prefixes: basePrefixes, nodes: baseNodes,
      workflowName: this.rollupWorkflowFor(repo) };
    this.workflowImpactCache.set(cacheKey, headGraph ? diffCiGraphs(base, headGraph) : null);
  }

  /**
   * Ground-truth pool learning (jobs-API feature): for any check whose
   * (repo, canonical name, event) key is not yet mapped, fetch the jobs of its
   * workflow run ONCE (Jobs REST API) and persist every job's resolved pool to
   * observed_pools. The static ci.yml parser leaves most reusable-workflow jobs
   * pool='unknown'; the Jobs API reports each job's real labels regardless of
   * how it was invoked. Bounded + best-effort:
   *  - at most MAX_JOBS_FETCHES_PER_CYCLE distinct run ids per call (the rest
   *    next cycle), deduped against a short-lived recently-fetched cache;
   *  - a failed fetch logs once and is retried later (never crashes a cycle);
   *  - RateLimitError pauses the poller and stops the rest of this batch.
   * Goes quiet once everything is mapped (only NEW job names trigger a call).
   */
  private async learnPoolsFromChecks(client: GithubClient, repo: string,
    checks: CheckRun[]): Promise<void> {
    this.pruneRecentlyFetchedRunIds();
    const recent = new Set(this.recentlyFetchedRunIds.keys());
    const runIds = selectRunIdsToFetch(checks, this.observedPoolKeys, recent, repo);
    if (!runIds.length) return;
    const [owner, name] = repo.split('/');
    // The jobs API has no event; key observations by THIS run's event. A run is
    // one event, so the event of any check carrying this run id is the run's
    // event (checks of a given run share it).
    const eventByRunId = new Map<number, string>();
    for (const c of checks) {
      if (c.runDatabaseId != null && !eventByRunId.has(c.runDatabaseId)) {
        eventByRunId.set(c.runDatabaseId, c.event);
      }
    }
    await this.fetchAndRecordPools(client, repo, runIds,
      (id) => eventByRunId.get(id) ?? 'unknown');
  }

  /**
   * Fetch the Jobs API for each run id and record every job's pool under the
   * event `eventForRunId(id)` returns. Shared by the checks-driven loop and the
   * push-runs loop. Best-effort: a failed fetch logs once per repo and is left
   * unobserved (retried next cycle); a RateLimitError pauses the poller and
   * stops the rest of the batch. Only SUCCESSFUL fetches are marked
   * recently-fetched, so a failure retries. The caller has already capped
   * `runIds`.
   */
  private async fetchAndRecordPools(client: GithubClient, repo: string,
    runIds: number[], eventForRunId: (id: number) => string): Promise<void> {
    const [owner, name] = repo.split('/');
    const nowMs = this.now().getTime();
    for (const runId of runIds) {
      let resp: JobsApiResponse;
      try {
        resp = await client.restGet<JobsApiResponse>(jobsApiPath(owner ?? '', name ?? '', runId));
      } catch (e) {
        if (e instanceof RateLimitError) { this.notePause(e.retryAfterSeconds); return; }
        if (!this.warnedJobsApi.has(repo)) {
          this.warnedJobsApi.add(repo);
          console.warn(`[pool-learn] ${repo} run ${runId}: jobs fetch failed — will retry: ${describeError(e)}`);
        }
        continue; // best-effort: leave the key unobserved, retry next cycle
      }
      this.recentlyFetchedRunIds.set(runId, nowMs);
      const event = eventForRunId(runId);
      for (const { name: rawJobName, pool } of resolveJobsResponse(resp)) {
        const canonical = canonicalizeCheckName(rawJobName);
        this.deps.history.recordObservedPool(repo, canonical, event, pool);
        this.observedPoolKeys.add(observedKey(repo, canonical, event));
      }
    }
  }

  /**
   * Learn pools for PUSH-only jobs (Storybook deploy, smoke, axe-per-story,
   * tag): they run ONLY on push to the default branch, so the checks-driven
   * loop (PR + merge_group detail) never sees them and the sibling-event
   * fallback has no sibling to borrow from. We list the workflow's most-recent
   * completed push runs and fetch their jobs, recording observations under
   * event='push' (resolvePool's sibling fallback then lets pull_request reads
   * borrow them too). Throttled per-repo (~6h on success) so we don't spam the
   * list call; the list-call cost is one REST request per eligible cycle.
   *
   * Best-effort: a list-call failure logs once per repo and retries the next
   * eligible cycle (no throttle armed); a RateLimitError pauses the poller.
   */
  private async learnPushPools(client: GithubClient, repo: string): Promise<void> {
    if (!this.pushPoolThrottle.due(repo, this.now().getTime())) return;
    this.pruneRecentlyFetchedRunIds();
    const [owner, name] = repo.split('/');
    const settings = this.settingsFor(repo);
    const workflowFile = settings.workflowPath.split('/').pop() ?? settings.workflowPath;
    const branch = this.effectiveDeploy()[repo]?.defaultBranch ?? 'main';
    let resp: WorkflowRunsResponse;
    try {
      resp = await client.restGet<WorkflowRunsResponse>(
        pushRunsApiPath(owner ?? '', name ?? '', workflowFile, branch, 5));
    } catch (e) {
      if (e instanceof RateLimitError) { this.notePause(e.retryAfterSeconds); return; }
      if (!this.warnedJobsApi.has(repo)) {
        this.warnedJobsApi.add(repo);
        console.warn(`[pool-learn] ${repo}: push-runs list failed — will retry: ${describeError(e)}`);
      }
      return; // no throttle armed → retry next eligible cycle
    }
    // List call succeeded — arm the 6h throttle even if there's nothing to fetch
    // (don't re-list every cycle just because everything is already mapped).
    this.pushPoolThrottle.success(repo, this.now().getTime());
    const recent = new Set(this.recentlyFetchedRunIds.keys());
    const ids = selectPushRunIds(resp, recent);
    if (!ids.length) return;
    await this.fetchAndRecordPools(client, repo, ids, () => 'push');
  }

  /** Drop recently-fetched run ids older than the dedup window so a long-lived
   *  process doesn't grow the cache unbounded (and a genuinely new run reusing
   *  a recycled id — impossible in practice — would re-fetch). */
  private pruneRecentlyFetchedRunIds(): void {
    const cutoff = this.now().getTime() - RECENTLY_FETCHED_RUN_TTL_MS;
    for (const [id, at] of this.recentlyFetchedRunIds) {
      if (at < cutoff) this.recentlyFetchedRunIds.delete(id);
    }
  }

  async queueOnce(): Promise<void> {
    return this.withLatch('queue', () => this.queueImpl());
  }

  private async queueImpl(): Promise<void> {
    const queuedRepos = new Set([...this.prs.values()].filter((p) => p.queue).map((p) => p.repo));
    for (const repo of queuedRepos) {
      const [owner, name] = repo.split('/');
      const client = this.routedClient(owner ?? ''); // repo-scoped: route via the repo owner
      if (!client) continue;
      const branch = this.effectiveDeploy()[repo]?.defaultBranch ?? 'main';
      const data = await this.guard(() => client.graphql<any>(buildQueueQuery(owner, name, branch)));
      if (!data) continue;
      const entries = mapQueueEntries(data.repository?.mergeQueue);
      this.queueEntries.set(repo, entries);
      // The queue-entries fetch is the source of truth for queue membership: an
      // entry's PR can be missing from this.prs entirely (the open-PR sweep
      // paginates but caps at MAX_OPEN_PAGES, and a follow-up page can fail —
      // live incident 2026-06-11: #8878's train car had no matching row when the
      // sweep was single-page). Materialize a placeholder snapshot so the PR gets a row
      // and the hot detail cycle (isHot: no stage yet → hot) fills it in.
      for (const e of entries) {
        const key = `${repo}#${e.prNumber}`;
        if (this.prs.has(key)) continue;
        this.prs.set(key, { repo, number: e.prNumber, title: '',
          url: `https://github.com/${repo}/pull/${e.prNumber}`, headSha: '',
          isDraft: false, mergeStateStatus: null, createdAt: null,
          mergedAt: null, mergeCommitSha: null,
          autoMergeArmed: false, touchesWorkflows: false,
          queue: { position: e.position, state: e.state,
            enqueuedAt: e.enqueuedAt, groupHeadOid: e.headCommitOid }, checks: [] });
      }
      const oids = entries.map((e) => e.headCommitOid).filter((o): o is string => !!o)
        .filter((o) => !this.groupCompleted(o));
      if (oids.length) {
        const rollups = await this.guard(() => client.graphql<any>(buildOidRollupQuery(owner, name, oids)));
        if (rollups) {
          for (const node of Object.values(rollups.repository ?? {})) {
            const commit = node as any;
            if (!commit?.oid) continue;
            const checks = mapRollupContexts(commit.statusCheckRollup?.contexts?.nodes ?? [], true);
            const split = splitOidChecks(checks);
            recordMainFromOid(this.deps.history, repo, commit.oid as string, null, split.push);
            this.groupChecks.set(commit.oid, split.mergeGroup);
            ingestCheckSet(this.deps.history, repo, checks, (n) => this.needsFor(repo, n),
              (p, e) => this.needActiveFor(repo, p, e), this.graphKeysFor(repo),
              this.rollupWorkflowFor(repo), commit.oid as string,
              (n) => this.timeoutMinutesFor(repo, n), (n) => this.poolsFor(repo, n));
            // Ground-truth pool learning (jobs-API feature): merge_group jobs
            // carry their own (often distinct, e.g. on-demand) pool — learn it.
            await this.learnPoolsFromChecks(client, repo, checks);
            // failed-group attribution (#38): maybeRecordGroupRun skips failed
            // groups (their wall-clock would skew medians) — culprits record here
            ingestGroupFailures(this.deps.history, repo, commit.oid as string, split.mergeGroup);
            this.maybeRecordGroupRun(repo, commit.oid, split.mergeGroup);
          }
        }
      }
    }
    this.emitUpdate();
  }

  async deployOnce(): Promise<void> {
    return this.withLatch('deploy', () => this.deployImpl());
  }

  private async deployImpl(): Promise<void> {
    const { deploy, history, config } = this.deps;
    // In-repo config refresh shares this cycle (24h per-repo throttle inside) —
    // a repo that BECOMES a deploy repo via its file activates in the same pass.
    await this.refreshRepoConfigs();
    // ci.yml re-derivation shares this cycle too (24h per-repo throttle inside).
    await this.refreshDerivedGraphs();
    // Push-only job pool learning shares this cycle too (6h per-repo throttle inside).
    await this.refreshPushPools();
    // Scheduled-lane discovery + run polling shares this SLOW cycle (Scheduled
    // lane, Spec 4) — 24h discovery / ~1h run-poll per-repo throttles inside.
    await this.refreshScheduled();
    const now = this.now();
    // expire old throttle entries so the map stays bounded
    for (const [k, at] of this.ancestryCheckedAt) {
      if (now.getTime() - at > 10 * ANCESTRY_THROTTLE_MS) this.ancestryCheckedAt.delete(k);
    }
    for (const [repo, dc] of Object.entries(this.effectiveDeploy())) {
      // clones exist only in clone mode — api mode never creates one (issue #18)
      if (config.ancestrySource === 'clone') await deploy.ensureClone(repo, dc.cloneUrl).catch(() => {});
      for (const env of dc.environments) {
        const sha = await deploy.health(env.healthUrl, env.shaKey);
        this.envShas.set(`${repo}/${env.name}`, sha);
        if (!sha) continue;
        for (const rec of history.listTrackedMerged(config.retentionDays, now)) {
          if (rec.repo !== repo || !rec.mergeCommitSha) continue;
          const liveAt = env.name === 'qa' ? rec.qaLiveAt : rec.prodLiveAt;
          if (liveAt) continue;
          // Throttle per (sha, deployedSha), transport-agnostic: clone-mode
          // 'missing' answers trigger a git fetch inside isAncestor (fetch
          // storm without the throttle), api-mode answers each cost a REST
          // request — re-asking every cycle would burn rate-limit budget.
          const throttleKey = `${rec.mergeCommitSha}:${sha}`;
          const lastChecked = this.ancestryCheckedAt.get(throttleKey);
          if (lastChecked != null && now.getTime() - lastChecked < ANCESTRY_THROTTLE_MS) continue;
          this.ancestryCheckedAt.set(throttleKey, now.getTime());
          const anc = await this.checkAncestry(repo, rec.mergeCommitSha, sha);
          const key = `${repo}#${rec.number}`;
          const envKey = `${key}/${env.name}`;
          if (anc === 'missing') this.propagating.add(key);
          else this.propagating.delete(key);
          if (anc === 'no') this.seenNotLive.add(envKey);
          if (anc === 'yes') {
            history.markEnvLive(repo, rec.number, env.name, now.toISOString());
            // "shipped" signal (issue #19): the merge commit just became prod
            // ancestry — markEnvLive's liveAt guard makes this a true edge.
            if (env.name === 'prod') this.deps.notifier?.prodLive(repo, rec.number, rec.title);
            // Record a deploy-gap sample only when THIS instance previously observed the
            // PR not-live on this env. A PR found already live at first observation has
            // an unknowable merged→live wall-clock gap (e.g. process started hours after
            // the deploy) — recording now-mergedAt would poison the median (~31h vs ~10m).
            if (env.name === 'qa' && this.seenNotLive.has(envKey)) {
              history.recordDeployGap(repo, 'qa', (now.getTime() - Date.parse(rec.mergedAt)) / 1000);
            }
            this.seenNotLive.delete(envKey);
          }
        }
      }
    }
    // Recompute the per-repo deploy snapshot once now that envShas is fresh
    // (Deploy lane, spec §15) — buildState only reads the cache.
    this.refreshDeployStatus();
    // Hourly scans (duration regressions #41, pool starvation #45) ride this
    // cycle with a shared hourly throttle — local SQLite only, no API budget.
    this.maybeRunHourlyScans();
    this.emitUpdate();
  }

  /**
   * Ancestry dispatch (issue #18): 'clone' mode goes straight to the local bare
   * clone; 'api' mode (the default) asks the compare API, falling back to a
   * PRE-EXISTING clone for this evaluation when the API call fails
   * transport-wise (once-logged per repo). Without a clone the error propagates
   * to the caller's existing failure handling (runCycle containment).
   */
  private async checkAncestry(repo: string, sha: string, deployedSha: string): Promise<AncestryAnswer> {
    const { deploy, config } = this.deps;
    if (config.ancestrySource === 'clone') return deploy.isAncestor(repo, sha, deployedSha);
    try {
      const answer = await this.apiAncestry.isAncestor(repo, sha, deployedSha);
      if (!this.ancestryViaApiLogged.has(repo)) {
        this.ancestryViaApiLogged.add(repo);
        console.log(`[deploy] ${repo}: ancestry via compare API (no local clone needed)`);
      }
      return answer;
    } catch (e) {
      if (e instanceof RateLimitError) throw e; // budget exhausted — pause, don't hammer git either
      if (!deploy.hasClone(repo)) throw e;
      if (!this.warnedAncestryFallback.has(repo)) {
        this.warnedAncestryFallback.add(repo);
        console.warn(`[deploy] ${repo}: compare-API ancestry failed — falling back to the local clone: ${describeError(e)}`);
      }
      return deploy.isAncestor(repo, sha, deployedSha);
    }
  }

  // ---- in-repo .pr-dashboard.yml --------------------------------------------

  /** Repos whose in-repo config is worth fetching: every repo with a live PR
   *  snapshot plus everything the instance config mentions. */
  private watchedRepos(): Set<string> {
    const repos = new Set<string>();
    for (const pr of this.prs.values()) repos.add(pr.repo);
    for (const repo of Object.keys(this.deps.config.deploy)) repos.add(repo);
    for (const repo of Object.keys(this.deps.config.repos ?? {})) repos.add(repo);
    // repos known only via a (possibly restored) in-repo file stay watched, so a
    // restart during an outage keeps refreshing them even with no open PRs yet
    for (const repo of this.repoFileConfigs.keys()) repos.add(repo);
    return repos;
  }

  /** Per-repo settings with every layer applied except derivation:
   *  instance override > in-repo `.pr-dashboard.yml` > defaults. */
  settingsFor(repo: string): RepoSettings {
    return effectiveRepoSettings(repo, this.deps.config, this.repoFileConfigs.get(repo));
  }

  /** Effective deploy map (instance `deploy.*` override > in-repo file). */
  effectiveDeploy(): Record<string, DeployConfig> {
    return effectiveDeployMap(this.deps.config, this.repoFileConfigs);
  }

  /** Parsed in-repo config for a repo (Z2 source attribution); undefined when absent. */
  repoFileConfigFor(repo: string): RepoFileConfig | undefined {
    return this.repoFileConfigs.get(repo);
  }

  /**
   * Hot-apply a new instance config: swap it in and re-arm the timer chain so the
   * new intervals take effect immediately (stop+start also fires an immediate
   * sweep, which prunes by the new exclude/retention). No fetch state is lost —
   * caches, history, and in-repo configs all survive the swap.
   */
  private noteDiscovered(repo: string): void {
    if (this.discovered.has(repo)) return;
    this.discovered.add(repo);
    this.deps.history.setMeta('discoveredRepos', JSON.stringify([...this.discovered].sort()));
  }

  /** Settings-panel repo toggle list: every repo we know about (sweep-discovered
   *  even when excluded, anything with history traces, and the exclude list
   *  itself) with its current excluded flag. */
  repoToggleList(): { repo: string; excluded: boolean }[] {
    const all = new Set<string>([
      ...this.discovered,
      ...this.deps.history.distinctRepos(),
      ...this.deps.config.exclude,
    ]);
    const excluded = new Set(this.deps.config.exclude);
    return [...all].sort().map((repo) => ({ repo, excluded: excluded.has(repo) }));
  }

  /** Live (post-reconfigure) exclude list — metrics filtering reads this. */
  currentExclude(): string[] {
    return [...this.deps.config.exclude];
  }

  /** Live (post-reconfigure) notifications config — the Notifier's command
   *  sink reads this through its config getter, so a PUT-applied
   *  notifications.enabled flip arms/disarms it without a restart. */
  currentNotifications(): NotificationsConfig {
    return this.deps.config.notifications;
  }

  reconfigure(cfg: AppConfig): void {
    const wasEnabled = this.deps.config.notifications.enabled;
    this.deps.config = cfg;
    console.log('[poller] reconfigured (hot-apply)');
    if (cfg.notifications.enabled !== wasEnabled) {
      console.log(cfg.notifications.enabled
        ? '[notifier] command sink armed (hot-apply: notifications.enabled=true)'
        : '[notifier] command sink disarmed (hot-apply: notifications.enabled=false)');
    }
    if (!this.running) return;
    this.stop();
    this.start();
  }

  /** Effective per-repo settings with per-field source attribution (GET /api/config). */
  reposReport(): Record<string, RepoSettingsReport> {
    const out: Record<string, RepoSettingsReport> = {};
    const deployMap = this.effectiveDeploy();
    const src = (override: boolean, inRepo: boolean, derived = false): SettingSource =>
      override ? 'override' : inRepo ? 'in-repo' : derived ? 'derived' : 'default';
    for (const repo of [...this.watchedRepos()].sort()) {
      if (this.deps.config.exclude.includes(repo)) continue;
      const rc = this.deps.config.repos?.[repo] ?? {};
      const fc = this.repoFileConfigs.get(repo);
      const s = this.settingsFor(repo);
      out[repo] = {
        rollupJobId: { value: s.rollupJobId,
          source: src(rc.rollupJobId != null, fc?.rollupJobId != null) },
        workflowPath: { value: s.workflowPath,
          source: src(rc.workflowPath != null, fc?.workflowPath != null) },
        batchSize: { value: s.batchSize,
          source: src(rc.batchSize != null, fc?.batchSize != null) },
        requiredCheckPrefixes: { value: this.effectivePrefixes(repo) ?? null,
          source: src(rc.requiredCheckPrefixes != null, fc?.requiredCheckPrefixes != null,
            this.derivedPrefixes.has(repo)) },
        deploy: { value: deployMap[repo] ?? null,
          source: src(repo in this.deps.config.deploy, fc?.deploy != null) },
      };
    }
    return out;
  }

  /**
   * Fetch + parse `.pr-dashboard.yml` for every watched repo via a GraphQL blob
   * read (no clone needed), at most once per repo per 24h (same cadence as ci.yml
   * derivation). The 24h interval is armed ONLY on a successful fetch — a failed
   * fetch arms a capped exponential backoff (1m..10m) so subsequent deploy cycles
   * retry until a success re-arms the long throttle. Best-effort like derivation:
   * a failed fetch keeps the prior parsed config; an unparseable file keeps it
   * too; an INACCESSIBLE repository (alias resolved to null — token can't see
   * it) keeps it as well; only a genuinely absent file (repo resolved, object
   * null) clears it (including the persisted last-known-good copy).
   */
  async refreshRepoConfigs(): Promise<void> {
    const { history, config } = this.deps;
    for (const repo of this.watchedRepos()) {
      if (config.exclude.includes(repo)) continue;
      if (!this.repoConfigThrottle.due(repo, this.now().getTime())) continue;
      const [owner, name] = repo.split('/');
      // repo-scoped blob read: route via the repo owner; an uncovered owner is a
      // config mismatch (logged once by routedClient) — skip without arming the
      // failure backoff, so a later registry refresh picks the repo up cleanly
      const client = this.routedClient(owner ?? '');
      if (!client) continue;
      let data: { repository?: { object?: { text?: unknown } | null } | null } | null = null;
      try {
        data = await client.graphql(buildBlobQuery(owner ?? '', name ?? '', `HEAD:${REPO_CONFIG_PATH}`));
      } catch (e) {
        this.repoConfigThrottle.failure(repo, this.now().getTime());
        if (e instanceof RateLimitError) this.notePause(e.retryAfterSeconds);
        console.warn(`[repo-config] ${repo}: ${REPO_CONFIG_PATH} fetch failed — will retry with backoff: ${describeError(e)}`);
        continue; // best-effort: prior layers keep working
      }
      const repoNode = data?.repository;
      if (repoNode == null) {
        // The HTTP request succeeded but the repository alias itself is null —
        // the partial-errors shape ("Could not resolve to a Repository…"): the
        // token cannot see the repo (App installation missing, rename, SSO).
        // NOT the same as file-deleted (repo resolved, object null below):
        // keep the loaded AND persisted last-known-good config, retry with
        // backoff. Incident 2026-06-11: treating this as "removed" cleared the
        // persisted config the resilience layer exists to protect.
        this.repoConfigThrottle.failure(repo, this.now().getTime());
        this.noteInaccessibleRepo(repo);
        console.warn(`[repo-config] ${repo}: repository inaccessible (token cannot see it?) — keeping last-known-good`);
        continue;
      }
      this.repoConfigThrottle.success(repo, this.now().getTime());
      const text = repoNode.object?.text;
      if (typeof text !== 'string') {
        history.deleteMeta(`repoConfig:${repo}`);
        if (this.repoFileConfigs.delete(repo)) {
          this.repoConfigSig.delete(repo);
          console.log(`[repo-config] ${repo}: ${REPO_CONFIG_PATH} removed — instance/derived settings apply`);
        }
        continue;
      }
      const parsed = parseRepoConfig(repo, text);
      if (!parsed) {
        console.warn(`[repo-config] ${repo}: ${REPO_CONFIG_PATH} is not a valid YAML mapping — ignored`);
        continue;
      }
      for (const w of parsed.warnings) console.warn(`[repo-config] ${repo}: ${w}`);
      const { warnings: _warnings, ...fields } = parsed;
      this.repoFileConfigs.set(repo, parsed);
      history.setMeta(`repoConfig:${repo}`, JSON.stringify(fields)); // last-known-good for restarts
      const applied = history.applyCheckAliases(repo, parsed.aliases);
      if (applied) console.log(`[repo-config] ${repo}: folded ${applied} check-name alias(es) into history`);
      const sig = JSON.stringify(fields);
      if (sig !== this.repoConfigSig.get(repo)) {
        this.repoConfigSig.set(repo, sig);
        console.log(`[repo-config] ${repo}: loaded ${REPO_CONFIG_PATH} (source of: ${Object.keys(fields).join(', ') || 'nothing'})`);
      }
    }
  }

  // ---- required-check prefix derivation ------------------------------------

  /** Cache ci.yml-derived required-check prefixes for a repo (see required-checks.ts). */
  setDerivedPrefixes(repo: string, prefixes: string[]): void {
    this.derivedPrefixes.set(repo, prefixes);
    console.log(`[poller] derived required-check prefixes for ${repo}: ${prefixes.join(', ')}`);
  }

  /** Adopt a successfully derived ci.yml graph: cache all three derived layers,
   *  persist the last-known-good copy (`ciGraph:<repo>` in history meta), and
   *  arm the 24h re-derivation throttle. Used by the startup derivation in
   *  index.ts and by the deploy-cycle re-derivation. */
  adoptDerivedGraph(repo: string, graph: CiGraph): void {
    this.setDerivedPrefixes(repo, graph.prefixes);
    this.setDerivedGraph(repo, graph.nodes);
    this.setRollupWorkflowName(repo, graph.workflowName);
    this.deriveThrottle.success(repo, this.now().getTime());
    this.deps.history.setMeta(`ciGraph:${repo}`, JSON.stringify(ciGraphToJson(graph)));
  }

  /** Cache the ci.yml-derived graph (display-name-level adjacency + event activity). */
  setDerivedGraph(repo: string, nodes: Map<string, CiGraphNode>): void {
    this.derivedGraph.set(repo, nodes);
  }

  /** Every repo's derived graph nodes — the static side of the metrics
   *  critical-path (#42) and workflow-lint (#48) joins. Live reference (the
   *  metrics pass only reads). */
  allDerivedGraphs(): Map<string, Map<string, CiGraphNode>> {
    return this.derivedGraph;
  }

  /** Cache the ci.yml-derived rollup workflow display name (YAML top-level `name:`). */
  setRollupWorkflowName(repo: string, name: string | null): void {
    this.derivedWorkflowName.set(repo, name);
  }

  /** Rollup workflow display name for a repo; null when unknown (no scoping). */
  rollupWorkflowFor(repo: string): string | null {
    return this.derivedWorkflowName.get(repo) ?? null;
  }

  /**
   * Needed node prefixes for a canonical check name, matched against the derived
   * graph with the shared startsWith semantics (a check `static-checks / TypeScript`
   * matches graph node `static-checks /`). Null when the repo has no derived graph
   * or the name matches no node.
   */
  needsFor(repo: string, canonicalCheckName: string): string[] | null {
    const graph = this.derivedGraph.get(repo);
    if (!graph) return null;
    const node = matchingPrefix(canonicalCheckName, graph.keys());
    return node !== null ? graph.get(node)!.needs : null;
  }

  /** Per-repo canonical names of LIVE checks that provably belong to a foreign
   *  workflow (≠ the rollup workflow the derived graph describes). History
   *  rows carry no workflow identity, so the metrics static×runtime joins
   *  (lint #48, critical path #42) take this live knowledge to keep e.g.
   *  `ci-gate` (`Auto-merge PRs`) from startsWith-matching the `ci` node —
   *  the same pattern as the classify-layer expectedSet exclusion. */
  liveForeignNames(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const pr of this.prs.values()) {
      const rollupWf = this.rollupWorkflowFor(pr.repo);
      if (rollupWf == null) continue; // no scoping possible
      for (const c of pr.checks) {
        if (workflowScopeAllows(c.workflowName, rollupWf)) continue;
        let set = out.get(pr.repo);
        if (!set) out.set(pr.repo, set = new Set());
        set.add(c.name);
      }
    }
    return out;
  }

  /** Derived `timeout-minutes` for the graph node a check name maps to — feeds
   *  the duration-ingestion plausibility guard (issue #61). Null when the repo
   *  has no derived graph, the name matches no node, or the node sets none. */
  timeoutMinutesFor(repo: string, canonicalCheckName: string): number | null {
    const graph = this.derivedGraph.get(repo);
    if (!graph) return null;
    const node = matchingPrefix(canonicalCheckName, graph.keys());
    return node !== null ? graph.get(node)!.timeoutMinutes : null;
  }

  /** All derived-graph node prefixes for a repo — lets the wait matcher assign a
   *  candidate check to its own node (longest match) instead of bare startsWith,
   *  so `build-test` never satisfies a need on `build`. Null without a graph. */
  graphKeysFor(repo: string): string[] | null {
    const graph = this.derivedGraph.get(repo);
    return graph ? [...graph.keys()] : null;
  }

  /** Runner-pool label candidates for a canonical check name (issue #34): the
   *  `runs-on` strings of the derived-graph node the name matches (raw labels;
   *  for `${{ … }}` ternaries both branches are listed as candidates). Null
   *  when the repo has no derived graph, the name matches no node, or the
   *  node's pool is unknowable (reusable workflow without an outer label
   *  input). Persisted/restored with the `ciGraph:<repo>` meta bundle. */
  poolsFor(repo: string, canonicalCheckName: string): string[] | null {
    const graph = this.derivedGraph.get(repo);
    if (!graph) return null;
    const node = matchingPrefix(canonicalCheckName, graph.keys());
    return node !== null ? graph.get(node)!.runsOn : null;
  }

  /**
   * Ground-truth-first pool resolution for cost attribution (jobs-API feature):
   * observed_pools (a real runner label learned from the Jobs API) beats the
   * ci.yml-derived runsOn, which beats null. The github-hosted flag rides along
   * so the cost layer can exclude hosted minutes from the EC2 fleet-actuals
   * coverage join. Observed lookups are event-scoped (ARC vs on-demand can
   * differ per event); the derived fallback is event-agnostic (runsOn carries
   * no event), joined '|' like poolsFor for a stable composite key. Returns null
   * only when NEITHER source knows the pool.
   */
  resolvePool(repo: string, canonicalCheckName: string, event: string): ObservedPool | null {
    const observed = this.deps.history.observedPoolWithFallback(repo, canonicalCheckName, event);
    if (observed) return observed;
    const derived = this.poolsFor(repo, canonicalCheckName);
    if (derived?.length) return { pool: derived.join('|'), githubHosted: false };
    return null;
  }

  /**
   * Best-effort sha → PR-number join for the cost explorer's per-run table:
   * matches the CURRENT head sha of a tracked open PR, or a queued PR's
   * merge-group head oid (the sha merge_group runs report). Historical heads
   * (older pushes, PRs merged/closed since) are unknowable from live state —
   * null, and the UI shows the sha without a PR link.
   */
  prNumberForSha(repo: string, sha: string): number | null {
    if (!sha) return null;
    for (const pr of this.prs.values()) {
      if (pr.repo !== repo) continue;
      if (pr.headSha === sha || pr.queue?.groupHeadOid === sha) return pr.number;
    }
    return null;
  }

  /**
   * Whether the graph node `neededPrefix` can run for `event` — true unless its
   * `if:` provably gates it off that event (e.g. a merge_group-only job seen
   * from a pull_request check). True when the repo/node is unknown: the graph
   * is event-agnostic storage; activity is evaluated here at classification time.
   */
  needActiveFor(repo: string, neededPrefix: string, event: string): boolean {
    const node = this.derivedGraph.get(repo)?.get(neededPrefix);
    return node ? activeForEvent(node.activity, event) : true;
  }

  /**
   * Effective required-check prefixes for a repo:
   * explicit config (an empty array disables prefixes entirely) → ci.yml-derived
   * → undefined (no prefixes).
   */
  private effectivePrefixes(repo: string): string[] | undefined {
    // instance override > in-repo file (both via settingsFor) > derived
    const configured = this.settingsFor(repo).requiredCheckPrefixes;
    if (configured) return configured;
    return this.derivedPrefixes.get(repo);
  }

  /** Repos whose ci.yml graph is worth deriving. Clone mode: deploy repos only
   *  (derivation reads the bare clone). Api mode (blob read — issue #18):
   *  additionally every repo with an instance `repos.*` entry or an in-repo
   *  `.pr-dashboard.yml` — explicit configuration opts a non-deploy repo in
   *  (deriving for EVERY watched repo would guess a 'ci' rollup that may not
   *  exist and pollute classification for unconfigured repos). */
  private derivationRepos(): Set<string> {
    const repos = new Set<string>(Object.keys(this.effectiveDeploy()));
    if (this.deps.config.ancestrySource === 'clone') return repos;
    for (const repo of Object.keys(this.deps.config.repos ?? {})) repos.add(repo);
    for (const repo of this.repoFileConfigs.keys()) repos.add(repo);
    return repos;
  }

  /** Derive/refresh the ci.yml graph for every derivation-eligible repo, at most
   *  once per repo per 24h (failure → capped backoff). Runs at startup
   *  (index.ts) and on every deploy cycle. */
  async refreshDerivedGraphs(): Promise<void> {
    const deployMap = this.effectiveDeploy();
    for (const repo of [...this.derivationRepos()].sort()) {
      if (this.deps.config.exclude.includes(repo)) continue;
      await this.maybeRederivePrefixes(repo, deployMap[repo]?.defaultBranch);
    }
  }

  /** Learn push-only job pools for every derivation-eligible repo (those with a
   *  rollup workflow / explicitly watched), at most once per repo per 6h. Rides
   *  the deploy cycle alongside the 24h ci.yml re-derivation. */
  async refreshPushPools(): Promise<void> {
    for (const repo of [...this.derivationRepos()].sort()) {
      if (this.deps.config.exclude.includes(repo)) continue;
      if (!this.pushPoolThrottle.due(repo, this.now().getTime())) continue;
      const [owner] = repo.split('/');
      const client = this.routedClient(owner ?? '');
      if (!client) continue; // owner has no installation — skip without arming
      await this.learnPushPools(client, repo);
    }
  }

  /**
   * Scheduled lane (Spec 4): for every surfaced repo, discover its cron-scheduled
   * workflows (24h throttle) and REST-poll their recent runs (~1h throttle),
   * recording run-level rows into the SEPARATE `scheduled_runs` table (never the
   * estimator's check_durations). Then repopulate the per-cycle `scheduledCache`
   * from `latestScheduledRuns` so buildState only reads the cache (spec §15).
   *
   * Best-effort + failure-aware (the RetryThrottle pattern): a failed discovery
   * or run-poll arms a capped backoff so the next eligible deploy cycle retries;
   * a RateLimitError pauses the poller (PR data is the priority dataset).
   */
  private async refreshScheduled(): Promise<void> {
    const nowMs = this.now().getTime();
    for (const repo of [...this.trackedRepos()].sort()) {
      if (this.deps.config.exclude.includes(repo)) continue;
      const [owner, name] = repo.split('/');
      const client = this.routedClient(owner ?? '');
      if (!client) continue; // owner has no installation — skip without arming

      // 1) Discovery (24h): list .github/workflows/* and keep the cron-scheduled.
      if (this.scheduledDiscoveryThrottle.due(repo, nowMs)) {
        const branch = this.effectiveDeploy()[repo]?.defaultBranch;
        try {
          const files = await this.listWorkflowFiles(repo, branch);
          if (files === undefined) continue; // no installation — no backoff
          const basenames = parseScheduledWorkflows(files)
            .map((p) => p.split('/').pop() ?? p);
          this.discoveredScheduled.set(repo, basenames);
          this.scheduledDiscoveryThrottle.success(repo, nowMs);
        } catch (e) {
          if (e instanceof RateLimitError) { this.notePause(e.retryAfterSeconds); return; }
          this.scheduledDiscoveryThrottle.failure(repo, nowMs);
        }
      }

      // 2) Run poll (~1h): one runs?per_page=8 REST call per discovered workflow.
      const workflows = this.discoveredScheduled.get(repo) ?? [];
      if (workflows.length && this.scheduledRunsThrottle.due(repo, nowMs)) {
        let ok = true;
        for (const file of workflows) {
          try {
            const resp = await client.restGet<ScheduledRunsApiResponse>(
              scheduledRunsApiPath(owner ?? '', name ?? '', file));
            this.recordScheduledRunsResponse(repo, file, resp);
          } catch (e) {
            if (e instanceof RateLimitError) { this.notePause(e.retryAfterSeconds); return; }
            ok = false; // some workflow failed — retry the repo next eligible cycle
          }
        }
        if (ok) this.scheduledRunsThrottle.success(repo, nowMs);
        else this.scheduledRunsThrottle.failure(repo, nowMs);
      }
    }
    this.refreshScheduledCache();
  }

  /** Persist one workflow's recent-runs REST response into scheduled_runs
   *  (run-level upserts). Tolerant of a missing/empty list or rows missing ids. */
  private recordScheduledRunsResponse(repo: string, workflow: string,
    resp: ScheduledRunsApiResponse): void {
    const observedAt = this.now().toISOString();
    for (const run of resp.workflow_runs ?? []) {
      if (run?.id == null) continue;
      this.deps.history.recordScheduledRun({
        repo, workflow, runId: run.id, runAttempt: run.run_attempt ?? 1,
        runNumber: run.run_number ?? null,
        conclusion: run.conclusion ?? null, status: run.status ?? null,
        createdAt: run.created_at ?? null, htmlUrl: run.html_url ?? null,
        observedAt });
    }
  }

  /**
   * Repopulate the per-cycle scheduled-lane cache (Scheduled lane, Spec 4) —
   * buildState only reads this, never SQLite. A repo gets an entry only when it
   * has discovered scheduled workflows (so a repo with none stays absent → no
   * scheduled field → lane renders not-wired for it). `discovered` carries the
   * workflow count so the lane can distinguish blind (workflows, no runs) from
   * idle (no workflows).
   */
  private refreshScheduledCache(): void {
    this.scheduledCache.clear();
    const now = this.now();
    for (const repo of this.trackedRepos()) {
      const discovered = this.discoveredScheduled.get(repo) ?? [];
      if (discovered.length === 0) continue;
      this.scheduledCache.set(repo, {
        runs: this.deps.history.latestScheduledRuns(repo, this.deps.config.retentionDays, now),
        discovered: discovered.length,
      });
    }
  }

  /** Re-read + re-derive a repo's ci.yml at most once per 24h — armed ONLY when
   *  the read succeeds. A failed fetch/read arms a capped exponential backoff
   *  (1m..10m) so later deploy cycles retry.
   *
   *  Clone mode reads the bare clone (ensure + fetch + show); api mode reads a
   *  GraphQL blob — no clone involved (issue #18).
   *
   *  Inaccessible-repo ≠ removed-file holds in both transports (audited with
   *  the 2026-06-11 blob-path incident): an inaccessible repo THROWS (clone
   *  mode: the git fetch fails; api mode: the null-repository partial-errors
   *  shape is re-thrown below) → failure path keeps the prior graph + backoff,
   *  while a missing ci.yml reads as null (keep prior graph) — nothing ever
   *  deletes the persisted `ciGraph:<repo>` copy. */
  private async maybeRederivePrefixes(repo: string, branch?: string): Promise<void> {
    if (!this.deriveThrottle.due(repo, this.now().getTime())) return;
    const settings = this.settingsFor(repo);
    try {
      // Prefer a path auto-discovered on a prior cycle (survives a file rename)
      // over the configured/default one; both fall back to discovery below.
      const path = this.discoveredWorkflowPath.get(repo) ?? settings.workflowPath;
      const text = this.deps.config.ancestrySource === 'clone'
        ? await this.readWorkflowViaClone(repo, path, branch ?? 'main')
        : await this.readWorkflowViaBlob(repo, path, branch);
      if (text === undefined) return; // owner has no installation — config mismatch, no backoff (mirrors refreshRepoConfigs)
      this.deriveThrottle.success(repo, this.now().getTime());

      // Happy path: the file is present AND genuinely defines the rollup job.
      if (text != null && fileDefinesJob(text, settings.rollupJobId)) {
        this.adoptDerivedGraph(repo, deriveCiGraph(text, settings.rollupJobId)!);
        return;
      }

      // The configured/discovered file is gone or no longer defines the rollup
      // job — likely a workflow-FILE rename. Auto-discover which file owns the
      // rollup job now, unless the path is explicitly pinned (then honor it) or
      // we're in clone mode (no tree listing). On a hit, remember the path so
      // later cycles read it directly without re-listing.
      if (this.deps.config.ancestrySource !== 'clone' && !this.workflowPathPinned(repo)) {
        const found = await this.discoverWorkflow(repo, branch, settings.rollupJobId);
        if (found) {
          this.discoveredWorkflowPath.set(repo, found.path);
          this.deps.history.setMeta(`discoveredWorkflowPath:${repo}`, found.path);
          this.adoptDerivedGraph(repo, found.graph);
          if (found.path !== path) console.log(`[poller] ${repo}: auto-discovered rollup workflow at ${found.path} (was ${path})`);
          return;
        }
      }

      // Discovery off/failed. Preserve prior behavior: adopt the degraded
      // rollup-only graph if the file at least parsed; otherwise keep the prior
      // derived graph. Either way the 24h throttle is armed (never silent).
      const graph = text != null ? deriveCiGraph(text, settings.rollupJobId) : null;
      if (graph) this.adoptDerivedGraph(repo, graph);
      else console.warn(`[poller] ${repo}: ${path} ${text == null ? `not readable at ${branch ?? 'HEAD'}` : 'unparseable'} — keeping prior derived graph (next attempt in 24h)`);
    } catch (e) {
      // best-effort: config/derived-so-far prefixes keep working
      this.deriveThrottle.failure(repo, this.now().getTime());
      console.warn(`[poller] ${repo}: ci.yml derivation failed — will retry with backoff: ${describeError(e)}`);
    }
  }

  /** Clone-mode workflow read: ensure the bare clone exists (deploy repos
   *  carry a cloneUrl), refresh it, and read the file at the branch tip. */
  private async readWorkflowViaClone(repo: string, path: string, branch: string): Promise<string | null> {
    const dc = this.effectiveDeploy()[repo];
    if (dc) await this.deps.deploy.ensureClone(repo, dc.cloneUrl);
    await this.deps.deploy.fetchClone(repo);
    return this.deps.deploy.readFileAtHead(repo, path, branch);
  }

  /** Api-mode workflow read: GraphQL blob query (the `.pr-dashboard.yml`
   *  mechanism — no clone needed; works for non-deploy repos too).
   *  `undefined` = no client covers the owner (caller skips, no throttle);
   *  `null` = repo resolved but the file is absent at the branch. */
  private async readWorkflowViaBlob(repo: string, path: string, branch?: string): Promise<string | null | undefined> {
    const [owner, name] = repo.split('/');
    const client = this.routedClient(owner ?? '');
    if (!client) return undefined;
    const data = await client.graphql<{ repository?: { object?: { text?: unknown } | null } | null }>(
      buildBlobQuery(owner ?? '', name ?? '', `${branch ?? 'HEAD'}:${path}`));
    if (data?.repository == null) {
      // partial-errors shape: the token cannot see the repo — NOT file-removed
      this.noteInaccessibleRepo(repo);
      throw new Error('repository inaccessible (token cannot see it?)');
    }
    const text = data.repository.object?.text;
    return typeof text === 'string' ? text : null;
  }

  /** True when `workflowPath` is explicitly pinned (instance config or in-repo
   *  `.pr-dashboard.yml`) — auto-discovery then defers to the declared path. */
  private workflowPathPinned(repo: string): boolean {
    return this.deps.config.repos?.[repo]?.workflowPath != null
      || this.repoFileConfigFor(repo)?.workflowPath != null;
  }

  /** List every workflow file under `.github/workflows/` WITH its text, in one
   *  GraphQL call. `undefined` = no client for the owner; `[]` = dir absent. */
  private async listWorkflowFiles(repo: string, branch?: string): Promise<{ path: string; text: string }[] | undefined> {
    const [owner, name] = repo.split('/');
    const client = this.routedClient(owner ?? '');
    if (!client) return undefined;
    const data = await client.graphql<{ repository?: { object?: { entries?: { name: string; path: string; object?: { text?: unknown } | null }[] } | null } | null }>(
      buildTreeFilesQuery(owner ?? '', name ?? '', `${branch ?? 'HEAD'}:.github/workflows`));
    const entries = data?.repository?.object?.entries;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e) => /\.ya?ml$/.test(e.name) && typeof e.object?.text === 'string')
      .map((e) => ({ path: e.path, text: e.object!.text as string }));
  }

  /** Find the workflow file that currently owns the rollup job. The configured
   *  basename is tried first so unchanged repos pick the conventional file on
   *  ties; ties otherwise break alphabetically (deterministic). */
  private async discoverWorkflow(repo: string, branch: string | undefined, rollupJobId: string): Promise<{ path: string; graph: CiGraph } | null> {
    const files = await this.listWorkflowFiles(repo, branch);
    if (!files || !files.length) return null;
    const preferred = this.settingsFor(repo).workflowPath.split('/').pop() ?? '';
    files.sort((a, b) => {
      const ap = a.path.endsWith(`/${preferred}`) ? 0 : 1;
      const bp = b.path.endsWith(`/${preferred}`) ? 0 : 1;
      return ap !== bp ? ap - bp : a.path.localeCompare(b.path);
    });
    return discoverRollupWorkflow(files, rollupJobId);
  }

  // ---- state assembly -----------------------------------------------------

  /**
   * The repos the poller is currently surfacing: the unique repos of the open-PR
   * snapshots (`this.prs`) plus the merged PRs inside the retention window
   * (`listTrackedMerged`), minus the configured excludes. This is the SINGLE
   * source of truth for "which repos" — buildState derives its repo rows from
   * exactly these two collections, and refreshLaneHealth recomputes lane-health
   * for exactly this set. Keep them in lockstep: never add a second enumeration.
   */
  private trackedRepos(): Set<string> {
    const { history, config } = this.deps;
    const repos = new Set<string>();
    for (const pr of this.prs.values()) repos.add(pr.repo);
    for (const rec of history.listTrackedMerged(config.retentionDays, this.now())) {
      if (!config.exclude.includes(rec.repo)) repos.add(rec.repo);
    }
    return repos;
  }

  /**
   * Recompute per-repo lane-health once per cycle (spec §15) — buildState only
   * reads the cache, never SQLite.
   */
  private refreshLaneHealth(): void {
    for (const repo of this.trackedRepos()) {
      this.laneHealthCache.set(repo, computeRepoLaneHealth(this.deps.history, repo, this.now()));
    }
  }

  /**
   * Recompute the global per-stage cost summary (Cost lane, Spec 3), throttled
   * to COST_SUMMARY_INTERVAL_MS — buildState only reads the cache (spec §15:
   * never a per-buildState SQLite hit). Reuses the SAME cost-engine inputs as
   * the metrics endpoint (resolvePool + liveForeignNames + the file-only
   * cost rate config), so pool resolution and pricing have a single home.
   */
  private refreshCostSummary(): void {
    const nowMs = this.now().getTime();
    if (this.costSummaryCache !== undefined && nowMs - this.costSummaryAt < COST_SUMMARY_INTERVAL_MS) return;
    const { history, config } = this.deps;
    this.costSummaryCache = computeCostSummary(
      history, this.now(), this.currentExclude(),
      (repo, name, event) => this.resolvePool(repo, name, event),
      this.liveForeignNames(), config.poolMeta ?? null, config.costPerMinute ?? null);
    this.costSummaryAt = nowMs;
  }

  /**
   * Recompute per-repo deploy status once per deploy cycle (Deploy lane, spec
   * §15) — runs after the env loop has refreshed `envShas`, so the cached live
   * sha is current. buildState only reads the cache. Only repos with an
   * effective deploy config get an entry; others stay absent (no deploy field).
   */
  private refreshDeployStatus(): void {
    const { history, config } = this.deps;
    const now = this.now();
    const deployMap = this.effectiveDeploy();
    this.deployStatusCache.clear();
    for (const [repo, dc] of Object.entries(deployMap)) {
      this.deployStatusCache.set(repo,
        computeRepoDeploy(history, repo, dc, this.envShas, config.retentionDays, now));
    }
  }

  buildState(): DashboardState {
    const { history, config } = this.deps;
    const now = this.now();
    const byRepo = new Map<string, PrView[]>();
    const push = (repo: string, view: PrView) => byRepo.set(repo, [...(byRepo.get(repo) ?? []), view]);

    // Pre-compute per-repo group progress once (not once per PR) so all callers share the
    // same results. This map is keyed by repo and holds the GroupProgress[] for that repo.
    // Iterate unique OIDs only: batch entries sharing an OID would otherwise trigger
    // identical computeProgress calls N times with the same inputs.
    const repoGroupProgress = new Map<string, GroupProgress[]>();
    for (const [repo, entries] of this.queueEntries) {
      if (!entries.length) continue;
      const lookupMg = (n: string) => history.expected(repo, n, 'merge_group');
      const seenOids = new Set<string>();
      const groups: GroupProgress[] = [];
      for (const e of entries) {
        if (!e.headCommitOid || !this.groupChecks.has(e.headCommitOid)) continue;
        if (seenOids.has(e.headCommitOid)) continue;
        seenOids.add(e.headCommitOid);
        const checks = this.groupChecks.get(e.headCommitOid)!;
        // Scope to the REQUIRED needs-closure: non-blocking checks that run in the
        // queue but don't gate the merge (accessibility, android-build) must not
        // inflate the train ETA — the queue merges when the required checks finish.
        const { checks: reqChecks, expectedSet } = this.requiredMergeGroupScope(repo, checks, now);
        const p = computeProgress({ checks: reqChecks,
          expectedSet, lookup: lookupMg, now,
          samples: (n) => history.samples(repo, n, 'merge_group'),
          queueDelay: (n) => this.expectedRunnerWaitFor(repo, n, 'merge_group') });
        groups.push({ oid: e.headCommitOid, percent: p.percent, etaSeconds: p.etaSeconds,
          overdue: p.overdue, failed: p.failed });
      }
      repoGroupProgress.set(repo, groups);
    }

    for (const pr of this.prs.values()) {
      const view = this.viewForOpenPr(pr, now, repoGroupProgress.get(pr.repo) ?? []);
      if (view) push(pr.repo, view);
    }
    for (const rec of history.listTrackedMerged(config.retentionDays, now)) {
      if (config.exclude.includes(rec.repo)) continue; // exclude applies on reconfigure too
      const view = this.viewForMergedPr(rec, now);
      if (view) push(rec.repo, view);
    }

    const deployMap = this.effectiveDeploy();
    const repos = [...byRepo.entries()]
      .map(([repo, prs]) => {
        const queue = this.buildQueueView(repo, repoGroupProgress.get(repo) ?? [], now);
        return {
          repo,
          hasDeploy: repo in deployMap,
          prs: prs.sort((a, b) =>
            (STAGE_ORDER[b.stage.stage] ?? 0) - (STAGE_ORDER[a.stage.stage] ?? 0) ||
            (b.stage.percent ?? -1) - (a.stage.percent ?? -1)),
          queue,
          // pure cache read — lane-health is computed once per cycle in
          // refreshLaneHealth (spec §15), never via a SQLite hit here
          laneHealth: this.laneHealthCache.get(repo),
          // pure cache read — deploy status computed once per deploy cycle in
          // refreshDeployStatus; absent for repos without a deploy config
          deploy: this.deployStatusCache.get(repo),
          // pure cache read — scheduled-lane snapshot computed once per deploy
          // cycle in refreshScheduled; absent for repos with no scheduled workflows
          scheduled: this.scheduledCache.get(repo),
        };
      })
      .sort((a, b) => a.repo.localeCompare(b.repo));
    // pure cache read — the global cost summary is computed once per cycle in
    // refreshCostSummary (spec §15), never via a SQLite hit here
    return { generatedAt: now.toISOString(), staleSince: this.staleSince, repos,
      cost: this.costSummaryCache };
  }

  /** Build a RepoQueueView from the pre-computed group progress for a repo.
   *
   *  Groups are identified by unique headCommitOid among AWAITING_CHECKS entries.
   *  A group's "position" is the maximum position of all entries sharing its OID.
   *  Batch semantics: a group at position N covers all entries in the range
   *  (prevGroupPos, N] — so group.prNumbers includes all entries between it and
   *  the previous group.
   *
   *  UNMERGEABLE entries are facing ejection: they are surfaced in `unmergeable`
   *  (genuine conflicts — snapshot DIRTY) or `queueBlocked` (cascade victims —
   *  poisoned by a conflicting entry ahead) and treated as transparent everywhere
   *  else — excluded from group coverage, prNumbers, and waiting (a group at
   *  position N still covers the remaining entries in (prevGroupPos, N]).
   *
   *  Waiting = entries whose position is beyond the last group's coverage
   *  (i.e. they have no CI group yet), returned ascending by position.
   *
   *  Returns null when there are no queue entries for this repo.
   */
  /** Scope live merge_group checks + their history expectedSet to the rollup's
   *  REQUIRED needs-closure, so non-blocking checks that run in the queue but
   *  don't gate the merge (e.g. accessibility, android-build) stop inflating the
   *  train ETA. Falls back to the unfiltered inputs when no prefixes are derived
   *  yet — a not-yet-known graph must never blank the estimate. Mirrors the
   *  pull_request scoping in viewForOpenPr, but keyed on matchesRequiredPrefix
   *  because requiredChecks() intentionally excludes merge_group events. */
  private requiredMergeGroupScope(repo: string, checks: CheckRun[], now: Date):
    { checks: CheckRun[]; expectedSet: string[] } {
    const expectedAll = this.deps.history.expectedSet(repo, 'merge_group', now);
    const prefixes = this.effectivePrefixes(repo);
    if (!prefixes?.length) return { checks, expectedSet: expectedAll };
    const rollupWf = this.rollupWorkflowFor(repo);
    const req = checks.filter((c) =>
      matchesRequiredPrefix(c.name, prefixes) && workflowScopeAllows(c.workflowName, rollupWf));
    const reqNames = new Set(req.map((c) => c.name));
    // history names carry no workflow identity → exclude any whose LIVE check is foreign
    const foreign = new Set(checks
      .filter((c) => !workflowScopeAllows(c.workflowName, rollupWf)).map((c) => c.name));
    const expectedSet = expectedAll.filter((n) =>
      (matchesRequiredPrefix(n, prefixes) && !foreign.has(n)) || reqNames.has(n));
    return { checks: req, expectedSet };
  }

  private buildQueueView(repo: string, groups: GroupProgress[], now: Date): RepoQueueView | null {
    const entries = this.queueEntries.get(repo);
    if (!entries?.length) return null;

    const byOid = new Map(groups.map((g) => [g.oid, g]));

    // UNMERGEABLE entries are surfaced separately and transparent to coverage.
    // Split genuine conflicts (own snapshot DIRTY against the base) from cascade
    // victims (UNMERGEABLE only because a conflicting entry ahead poisons their
    // speculative merge — snapshot not DIRTY, or no snapshot yet).
    const unmergeableEntries = entries
      .filter((e) => e.state === 'UNMERGEABLE')
      .sort((a, b) => a.position - b.position);
    const isDirty = (prNumber: number) =>
      this.prs.get(`${repo}#${prNumber}`)?.mergeStateStatus === 'DIRTY';
    const unmergeable = unmergeableEntries
      .filter((e) => isDirty(e.prNumber)).map((e) => e.prNumber);
    const queueBlocked = unmergeableEntries
      .filter((e) => !isDirty(e.prNumber)).map((e) => e.prNumber);
    const unmergeableCulprit = this.unmergeableCulpritFor(repo);

    // Sort the remaining entries by position for batch-range calculation.
    const sorted = entries
      .filter((e) => e.state !== 'UNMERGEABLE')
      .sort((a, b) => a.position - b.position);

    // Collect unique building groups (AWAITING_CHECKS with headCommitOid).
    // A group is identified by its OID; its representative position is the max
    // position among all entries sharing that OID.
    const groupPositions = new Map<string, number>(); // oid → max position
    for (const e of sorted) {
      if (e.state === 'AWAITING_CHECKS' && e.headCommitOid) {
        const prev = groupPositions.get(e.headCommitOid) ?? 0;
        if (e.position > prev) groupPositions.set(e.headCommitOid, e.position);
      }
    }

    // Sort groups by their max position so we can apply batch-range semantics.
    const orderedGroups = [...groupPositions.entries()]
      .sort(([, pa], [, pb]) => pa - pb); // ascending by max position

    const maxBuildingPos = orderedGroups.length > 0
      ? orderedGroups[orderedGroups.length - 1]![1]
      : 0;

    // Build QueueGroupView[] — one per unique OID, covering (prevGroupPos, thisGroupPos].
    const queueGroups: QueueGroupView[] = [];
    let prevGroupPos = 0;
    for (const [oid, groupMaxPos] of orderedGroups) {
      // All non-unmergeable entries in (prevGroupPos, groupMaxPos]
      const covered = sorted.filter(
        (e) => e.position > prevGroupPos && e.position <= groupMaxPos);
      const prNumbers = covered.map((e) => e.prNumber);
      const gp = byOid.get(oid);
      queueGroups.push({
        oid,
        prNumbers,
        percent: gp?.percent ?? null,
        etaSeconds: gp?.etaSeconds ?? null,
        failed: gp?.failed ?? false,
      });
      prevGroupPos = groupMaxPos;
    }

    // Waiting = entries whose position is beyond all building groups' coverage.
    // Each carries its multi-train ETA simulation (issue #40) when computable.
    const waiting = sorted
      .filter((e) => e.position > maxBuildingPos)
      .map((e) => ({ prNumber: e.prNumber, position: e.position,
        sim: this.mergeEtaSimFor(repo, entries, e.prNumber, groups) }));

    // ---- ops console (issue #39) ----
    const telemetry = orderedGroups.map(([oid]) => this.groupTelemetryFor(repo, oid, now));
    const classified = classifyQueueHealth(telemetry, now);
    const prev = this.queueHealthSince.get(repo);
    const since = prev?.state === classified.state ? prev.since : now.toISOString();
    this.queueHealthSince.set(repo, { state: classified.state, since });
    // repo-level stall notification — debounced once per state entry by the notifier
    this.deps.notifier?.queueHealth(repo, classified.state, classified.detail);
    const entriesWithWaitSecs = [...entries]
      .sort((a, b) => a.position - b.position)
      .flatMap((e) => {
        if (!e.enqueuedAt) return [];
        const at = Date.parse(e.enqueuedAt);
        if (!Number.isFinite(at)) return [];
        return [{ prNumber: e.prNumber, position: e.position,
          waitSecs: Math.max(0, Math.round((now.getTime() - at) / 1000)) }];
      });
    const { history } = this.deps;
    const dayAgo = new Date(now.getTime() - 86400_000).toISOString();
    const weekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
    const runs7d = history.countGroupRuns(repo, weekAgo);
    const ejects7d = history.countGroupEjects(repo, weekAgo);
    // Trains/hr from merged_prs (durable, sweep-fed): cluster the last 24h of
    // merge timestamps — merges within 90s of each other are one train. The
    // old source (group_runs) is observation-biased: a row only exists when a
    // poll catches a group all-completed before it leaves the queue, so most
    // trains were missed (user-reported 0.1/hr on a queue merging dozens/day).
    const mergedTs24h = history.mergedTimestampsSince(repo, dayAgo)
      .map((t) => Date.parse(t));

    return { groups: queueGroups, waiting, unmergeable, queueBlocked, unmergeableCulprit,
      batchSize: this.settingsFor(repo).batchSize,
      health: { ...classified, since },
      depth: entries.length,
      entriesWithWaitSecs,
      trainsPerHour: Math.round((countMergeTrains(mergedTs24h) / 24) * 10) / 10,
      // NOTE: still sourced from group_runs/group_failures, which carries the
      // same observation bias as the old trains/hr (clean runs are only
      // recorded when a poll catches the completed group, while ejects are
      // durable) — so this skews pessimistic on busy queues. Follow-up
      // candidate: derive successes from merged_prs train clusters instead.
      batchSuccessRatePct: runs7d + ejects7d > 0
        ? Math.round((runs7d / (runs7d + ejects7d)) * 100) : null,
      ejects24h: history.countGroupEjects(repo, dayAgo),
    };
  }

  /**
   * Build the per-group telemetry the queue-health classifier (issue #39)
   * consumes, from the group rollup's checks. `runStartedAt` is always null:
   * GraphQL's WorkflowRun exposes no run_started_at, so "the run never
   * started" derives from no check having left the queued statuses.
   */
  private groupTelemetryFor(repo: string, oid: string, now: Date): GroupBuildTelemetry {
    const checks = this.groupChecks.get(oid) ?? [];
    const graphKeys = this.graphKeysFor(repo);
    const rollupWf = this.rollupWorkflowFor(repo);
    const createds = checks.map((c) => c.runCreatedAt)
      .filter((t): t is string => t != null);
    let runnerWaitsInProgress = 0;
    let maxRunnerWaitSecs: number | null = null;
    for (const c of checks) {
      const inRollupWorkflow = workflowScopeAllows(c.workflowName, rollupWf);
      const wait = classifyWait(c, checks,
        inRollupWorkflow ? this.needsFor(repo, c.name) : null, now,
        (pfx, e) => this.needActiveFor(repo, pfx, e), graphKeys, rollupWf);
      if (wait?.kind !== 'runner') continue;
      runnerWaitsInProgress++;
      if (wait.waitingSeconds != null) {
        maxRunnerWaitSecs = Math.max(maxRunnerWaitSecs ?? 0, wait.waitingSeconds);
      }
    }
    return {
      oid,
      runCreatedAt: createds.length ? createds.reduce((a, b) => (a < b ? a : b)) : null,
      runStartedAt: null,
      anyCheckStarted: checks.some((c) => c.status === 'IN_PROGRESS' || c.status === 'COMPLETED'),
      runnerWaitsInProgress,
      maxRunnerWaitSecs,
    };
  }

  /**
   * Multi-train merge ETA simulation (issue #40) for one WAITING queue entry.
   * Mirrors queueStage's waiting-line decomposition (queuedAhead, deepest
   * building train's remaining ETA) and feeds it the observed train-duration
   * samples + 7-day eject probability. Null for building/covered/UNMERGEABLE
   * entries and when no train durations have been observed yet.
   */
  private mergeEtaSimFor(repo: string, entries: QueueEntry[], prNumber: number,
    groups: GroupProgress[]): MergeEtaSimulation | null {
    const me = entries.find((x) => x.prNumber === prNumber);
    if (!me || me.state === 'UNMERGEABLE' || me.state === 'MERGEABLE') return null;
    if (me.state === 'AWAITING_CHECKS' && me.headCommitOid) return null; // building — group ETA applies
    if (this.coveringGroupOidFor(entries, prNumber)) return null;        // covered — rides that group
    const durationSamples = this.deps.history.groupRunSamples(repo);
    if (!durationSamples.length) return null; // simulateMergeEta would return null anyway
    const byOid = new Map(groups.map((g) => [g.oid, g]));
    const ahead = entries.filter((x) => x.position < me.position
      && x.state !== 'MERGEABLE' && x.state !== 'UNMERGEABLE');
    const building = ahead.filter((x) => x.state === 'AWAITING_CHECKS' && x.headCommitOid);
    const queuedAhead = ahead.length - building.length;
    const deepest = [...building].sort((a, b) => b.position - a.position)[0];
    const currentTrainEtaSecs = deepest
      ? (byOid.get(deepest.headCommitOid!)?.etaSeconds ?? this.medianGroupSecs(repo))
      : null;
    const weekAgo = new Date(this.now().getTime() - 7 * 86400_000).toISOString();
    return simulateMergeEta({
      queuedAhead,
      batchSize: this.settingsFor(repo).batchSize,
      durationSamples,
      ejectProb: ejectProbability(this.deps.history.countGroupRuns(repo, weekAgo),
        this.deps.history.countGroupEjects(repo, weekAgo)),
      currentTrainEtaSecs,
    });
  }

  /**
   * The queue's conflicting culprit: lowest-position UNMERGEABLE entry whose
   * own snapshot is DIRTY against the base (the entry poisoning the cascade);
   * falls back to the front-most UNMERGEABLE entry when no snapshot proves
   * DIRTY. Null without UNMERGEABLE entries. Shared by buildQueueView and the
   * notifier's queue-blocked detail.
   */
  private unmergeableCulpritFor(repo: string): number | null {
    let candidates = (this.queueEntries.get(repo) ?? [])
      .filter((e) => e.state === 'UNMERGEABLE')
      .map((e) => ({ prNumber: e.prNumber, position: e.position }));
    if (!candidates.length) {
      // queue-entries fetch hasn't run yet this cycle — the PR snapshots carry
      // their own queue position/state (detail fetch), use those as fallback
      candidates = [...this.prs.values()]
        .filter((p) => p.repo === repo && p.queue?.state === 'UNMERGEABLE')
        .map((p) => ({ prNumber: p.number, position: p.queue!.position }));
    }
    candidates.sort((a, b) => a.position - b.position);
    const dirty = candidates.find((c) =>
      this.prs.get(`${repo}#${c.prNumber}`)?.mergeStateStatus === 'DIRTY');
    return dirty?.prNumber ?? candidates[0]?.prNumber ?? null;
  }

  /**
   * The building-group oid covering a queued PR (HEADGREEN multi-PR groups):
   * its own AWAITING_CHECKS oid when assigned, else the building group whose
   * batch coverage range — (prevGroupPos, groupMaxPos], UNMERGEABLE entries
   * transparent — includes the PR's position. Null for UNMERGEABLE entries,
   * unknown PRs, and entries beyond all building groups.
   */
  private coveringGroupOidFor(entries: QueueEntry[], prNumber: number): string | null {
    const me = entries.find((e) => e.prNumber === prNumber);
    if (!me || me.state === 'UNMERGEABLE') return null;
    if (me.state === 'AWAITING_CHECKS' && me.headCommitOid) return me.headCommitOid;
    const groupPositions = new Map<string, number>(); // oid → max position
    for (const e of entries) {
      if (e.state === 'AWAITING_CHECKS' && e.headCommitOid) {
        const prev = groupPositions.get(e.headCommitOid) ?? 0;
        if (e.position > prev) groupPositions.set(e.headCommitOid, e.position);
      }
    }
    const ordered = [...groupPositions.entries()].sort(([, pa], [, pb]) => pa - pb);
    for (const [oid, maxPos] of ordered) {
      if (me.position <= maxPos) return oid; // first group whose range reaches me
    }
    return null;
  }

  /** Memoized view of the last emitted state; never rebuilds per API consumer. */
  getState(): DashboardState {
    return this.lastState ?? this.buildState();
  }

  /**
   * Metrics trends sampling (round 12): persist per-repo state counts on the
   * existing emitUpdate path — no new timer. HistoryStore throttles to one row
   * per 15 minutes per repo and prunes samples older than 90 days, so calling
   * this on every cycle is cheap and safe.
   */
  private sampleState(state: DashboardState): void {
    const OPEN_STAGES = new Set(['ci', 'ready', 'parked', 'queue']);
    for (const r of state.repos) {
      const counts = { open: 0, ci: 0, queue: 0, failed: 0 };
      for (const pr of r.prs) {
        const { stage, substate } = pr.stage;
        if (OPEN_STAGES.has(stage)) counts.open++;
        if (stage === 'ci') counts.ci++;
        if (stage === 'queue') counts.queue++;
        if ((stage === 'parked' && substate === 'ci-failed') ||
            (stage === 'queue' && substate === 'group-failed')) counts.failed++;
      }
      this.deps.history.recordStateSample(r.repo, state.generatedAt, counts);
    }
  }

  private emitUpdate(): void {
    const state = this.buildState();
    this.sampleState(state); // before the unchanged-signature skip: sampling has its own throttle
    // Compute a signature with generatedAt blanked so pure timestamp churn
    // (every tick changes generatedAt) doesn't trigger a spurious SSE frame.
    const sig = JSON.stringify({ ...state, generatedAt: '' });
    this.lastState = state;
    const nowMs = this.now().getTime();
    // identical snapshot — skip emission, unless the keepalive window elapsed
    // (clients drive their "live · updated" stamp off generatedAt)
    if (sig === this.lastEmittedSig && nowMs - this.lastEmittedAt < EMIT_KEEPALIVE_MS) return;
    this.lastEmittedSig = sig;
    this.lastEmittedAt = nowMs;
    this.emit('update');
  }

  private viewForOpenPr(pr: PrSnapshot, now: Date, groups: GroupProgress[]): PrView | null {
    const { history, config } = this.deps;
    const key = `${pr.repo}#${pr.number}`;
    const lookupPr = (n: string) => history.expected(pr.repo, n, 'pull_request');

    // Expected-set rule: when the repo marks required checks (or configures required
    // prefixes), progress runs over the history expectedSet intersected with required
    // names. Without required marking, use the full expectedSet — except when every
    // live check finished long ago, in which case absent expected names are
    // path-gated and aren't coming.
    const prefixes = this.effectivePrefixes(pr.repo);
    const rollupWf = this.rollupWorkflowFor(pr.repo);
    const req = requiredChecks(pr.checks, prefixes, rollupWf);
    const requiredNames = new Set(req.map((c) => c.name));
    const hasRequiredMarking = pr.checks.some((c) => c.isRequired);
    let expectedSet = history.expectedSet(pr.repo, 'pull_request', now);
    if (prefixes?.length) {
      // prefix predicate over history names: keeps the full required denominator even
      // mid-run when GitHub hasn't marked anything isRequired yet (stops the bar
      // collapsing to {ci} and jumping backwards). History names carry no workflow
      // identity, so workflow scoping happens via the LIVE checks: a name whose live
      // check provably belongs to a foreign workflow (e.g. `ci-gate` from
      // `Auto-merge PRs` prefix-matching `ci`) is excluded from the denominator.
      const foreignNames = new Set(pr.checks
        .filter((c) => !workflowScopeAllows(c.workflowName, rollupWf))
        .map((c) => c.name));
      expectedSet = expectedSet.filter((n) =>
        (matchesRequiredPrefix(n, prefixes) && !foreignNames.has(n)) || requiredNames.has(n));
    } else if (hasRequiredMarking) {
      expectedSet = expectedSet.filter((n) => requiredNames.has(n));
    } else {
      const allDone = pr.checks.length > 0 && pr.checks.every((c) => c.status === 'COMPLETED');
      const newest = Math.max(0, ...pr.checks.map((c) => (c.completedAt ? Date.parse(c.completedAt) : 0)));
      if (allDone && now.getTime() - newest > EXPECTED_SET_STALE_MS) {
        const liveNames = new Set(pr.checks.map((c) => c.name));
        expectedSet = expectedSet.filter((n) => liveNames.has(n));
      }
    }
    const ciProgress = computeProgress({ checks: req, expectedSet, lookup: lookupPr, now,
      samples: (n) => history.samples(pr.repo, n, 'pull_request'),
      queueDelay: (n) => this.expectedRunnerWaitFor(pr.repo, n, 'pull_request') });

    let queueProgress: QueueStageResult | null = null;
    let coveringOid: string | null = null;
    if (pr.queue) {
      const entries = this.queueEntries.get(pr.repo) ?? [];
      // HEADGREEN: a member covered by a building group (own AWAITING_CHECKS oid,
      // else the building group whose batch range includes its position) rides
      // that group's progress instead of waiting-line math.
      coveringOid = this.coveringGroupOidFor(entries, pr.number);
      // groups pre-computed once per repo per buildState call (not per PR)
      queueProgress = queueStage({ entries, prNumber: pr.number, groups,
        medianGroupSecs: this.medianGroupSecs(pr.repo),
        batchSize: this.settingsFor(pr.repo).batchSize,
        coveringGroupOid: coveringOid });
    }
    const prevStage = this.stages.get(key) ?? null;
    const rawStage = classify({
      pr, prev: prevStage, ciProgress, queueProgress,
      deploy: { hasDeploy: pr.repo in this.effectiveDeploy(), qaLive: null, prodLive: null, propagating: false, deployProgress: null },
      retentionDays: config.retentionDays, now, requiredCheckPrefixes: prefixes,
      rollupWorkflowName: rollupWf,
    });
    if (!rawStage) return null;
    const stage = this.calibrateStage(pr.repo, rawStage);
    // Lead time (issue #44): the PR "first went green" when it leaves ci for
    // ready (armed|idle) — or straight into the queue, the common path for
    // auto-merge-armed PRs whose enqueue races the poll cadence. Recorded once
    // per PR (later ci round-trips — new pushes — don't move it); persisted
    // onto merged_prs at merge time.
    if (prevStage?.stage === 'ci' && (stage.stage === 'ready' || stage.stage === 'queue')
        && !this.firstGreenAt.has(key)) {
      this.firstGreenAt.set(key, now.toISOString());
    }
    this.stages.set(key, stage);
    // Queued PRs: the merge-group build's checks (already fetched into
    // groupChecks by queueOnce). Covered members whose own snapshot carries no
    // groupHeadOid use the covering building group's oid — the run actually
    // driving their queue-stage ETA.
    const effectiveGroupOid = pr.queue ? (pr.queue.groupHeadOid ?? coveringOid) : null;
    this.deps.notifier?.observe({ repo: pr.repo, prNumber: pr.number, title: pr.title,
      prev: prevStage, next: stage,
      queueCulprit: stage.stage === 'queue' ? this.unmergeableCulpritFor(pr.repo) : null,
      // group-failed detail (#38): name the culprit check(s) when the group's
      // rollup already shows failing-class conclusions
      groupCulpritChecks: stage.stage === 'queue'
        ? this.groupCulpritNamesFor(effectiveGroupOid) : null });
    this.trackStageEta(key, pr.repo, stage, now);
    const queueAheadCount = stage.stage === 'queue' && queueProgress != null
      ? queueProgress.aheadCount
      : null;
    // (groupChecks payload: isRequired true via mapRollupContexts;
    // merge_group-event history supplies expected durations)
    const storedGroup = effectiveGroupOid
      ? this.groupChecks.get(effectiveGroupOid) : undefined;
    const groupChecks = storedGroup?.length
      ? this.toCheckViews(pr.repo, storedGroup, now, prefixes) : null;
    // multi-train ETA (issue #40): waiting queue entries only (the helper
    // returns null for building/covered/unmergeable entries)
    const mergeEtaSim = stage.stage === 'queue'
      ? this.mergeEtaSimFor(pr.repo, this.queueEntries.get(pr.repo) ?? [], pr.number, groups)
      : null;
    // PR-level CI cost (cost explorer): the current head's runner occupancy
    const { costMinutes, costDollars, costDollarsPartial } = computePrCost(pr.checks,
      this.rollupWorkflowFor(pr.repo), (n) => this.poolsFor(pr.repo, n),
      this.deps.config.costPerMinute ?? null, this.deps.config.poolMeta ?? null, now);
    return { repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, stage,
      queueAheadCount, costMinutes, costDollars, costDollarsPartial,
      checks: this.checkViews(pr, now, prefixes),
      timeline: null,
      touchesWorkflows: pr.touchesWorkflows,
      workflowImpact: pr.touchesWorkflows && pr.headSha
        ? this.workflowImpactCache.get(`${pr.repo}\u0000${pr.headSha}`) ?? null
        : null,
      groupChecks, mergeEtaSim };
  }

  private viewForMergedPr(rec: MergedPrRecord, now: Date): PrView | null {
    const { history, config } = this.deps;
    const dc = this.effectiveDeploy()[rec.repo];
    const qaSha = this.envShas.get(`${rec.repo}/qa`);
    const prodSha = this.envShas.get(`${rec.repo}/prod`);
    const deploy: DeployInfo = {
      hasDeploy: !!dc,
      qaLive: rec.qaLiveAt ? true : (qaSha == null ? null : false),
      prodLive: rec.prodLiveAt ? true : (prodSha == null ? null : false),
      // no squash sha yet, or sha not visible in the clone even after fetch
      propagating: !rec.mergeCommitSha || this.propagating.has(`${rec.repo}#${rec.number}`),
      deployProgress: null,
    };
    if (dc && !rec.qaLiveAt && deploy.qaLive === false) {
      const gap = history.medianDeployGap(rec.repo, 'qa') ?? 600;
      const elapsed = (now.getTime() - Date.parse(rec.mergedAt)) / 1000;
      deploy.deployProgress = {
        percent: Math.min(Math.round((elapsed / gap) * 100), 97),
        etaSeconds: elapsed > 1.5 * gap ? null : Math.max(Math.round(gap - elapsed), 0),
        overdue: elapsed > 1.5 * gap,
      };
    }
    const rawStage = classify({
      pr: { repo: rec.repo, number: rec.number, title: rec.title, url: rec.url, headSha: '',
        isDraft: false, mergeStateStatus: null, createdAt: rec.createdAt, mergedAt: rec.mergedAt,
        mergeCommitSha: rec.mergeCommitSha, autoMergeArmed: false, touchesWorkflows: false,
        queue: null, checks: [] },
      prev: null, ciProgress: null, queueProgress: null, deploy,
      retentionDays: config.retentionDays, now,
    });
    if (!rawStage) return null;
    const stage = this.calibrateStage(rec.repo, rawStage);
    // merged PRs share the key space — captures qa-deploy ETA accuracy too
    const key = `${rec.repo}#${rec.number}`;
    this.trackStageEta(key, rec.repo, stage, now);
    // Same transition tracking as open PRs (e.g. qa-deploy overdue flipping
    // true). classify's own prev stays null — only the notifier consumes this.
    const prevStage = this.stages.get(key) ?? null;
    this.stages.set(key, stage);
    this.deps.notifier?.observe({ repo: rec.repo, prNumber: rec.number, title: rec.title,
      prev: prevStage, next: stage });
    return { repo: rec.repo, number: rec.number, title: rec.title, url: rec.url, stage,
      queueAheadCount: null, checks: [],
      // waterfall spine (issue #50): the merged record IS the source of truth —
      // missing waypoints stay null, the UI omits those segments
      timeline: { createdAt: rec.createdAt, firstGreenAt: rec.firstGreenAt,
        enqueuedAt: rec.enqueuedAt, mergedAt: rec.mergedAt,
        qaLiveAt: rec.qaLiveAt, prodLiveAt: rec.prodLiveAt },
      touchesWorkflows: false, workflowImpact: null,
      groupChecks: null, mergeEtaSim: null, costMinutes: null, costDollars: null,
      costDollarsPartial: false };
  }

  private checkViews(pr: PrSnapshot, now: Date, prefixes?: string[]): CheckView[] {
    return this.toCheckViews(pr.repo, pr.checks, now, prefixes);
  }

  /** Failing-class check names of a merge-group build (notifier group-failed
   *  detail, #38); null when the oid/rollup is unknown or nothing failed yet. */
  private groupCulpritNamesFor(oid: string | null): string[] | null {
    if (!oid) return null;
    const names = (this.groupChecks.get(oid) ?? [])
      .filter((c) => c.status === 'COMPLETED' && FAILING_CONCLUSIONS.has(c.conclusion ?? ''))
      .map((c) => c.name);
    return names.length ? names : null;
  }

  /** Map a CheckRun set (head-commit PR checks or a merge-group build's checks)
   *  to CheckViews — shared by `checks` and `groupChecks` in PrView. */
  private toCheckViews(repo: string, checks: CheckRun[], now: Date, prefixes?: string[]): CheckView[] {
    const graphKeys = this.graphKeysFor(repo); // computed once per set, not per check
    const rollupWf = this.rollupWorkflowFor(repo);
    const flakeRates = this.flakeRatesFor(repo); // 7-day rates, cached per build (#37)
    const regressions = this.durationRegressions.get(repo); // hourly-scan cache (#41)
    return checks.map((c) => {
      const inRollupWorkflow = workflowScopeAllows(c.workflowName, rollupWf);
      const flakeRatePct = flakeRates.get(flakeKey(c.name, c.event)) ?? null;
      const reg = regressions?.get(flakeKey(c.name, c.event)) ?? null;
      const failingNow = c.status === 'COMPLETED' && FAILING_CONCLUSIONS.has(c.conclusion ?? '');
      // waitKind applies to live queued checks only; everything else carries nulls.
      // The derived needs graph describes the rollup workflow's jobs — a check
      // from a foreign workflow must not be assigned a node (needs: null → unknown).
      const wait = classifyWait(c, checks,
        inRollupWorkflow ? this.needsFor(repo, c.name) : null, now,
        (p, e) => this.needActiveFor(repo, p, e), graphKeys, rollupWf);
      const exp = this.deps.history.expected(repo, c.name, c.event);
      return {
        name: familyDisplayName(c), status: c.status, conclusion: c.conclusion,
        // same predicate as classification: mid-run prefix-matched checks sort under
        // "required" in the UI even before GitHub marks them isRequired — scoped to
        // the rollup workflow so foreign jobs (`ci-gate`) never read as required
        isRequired: c.isRequired
          || (matchesRequiredPrefix(c.name, prefixes) && inRollupWorkflow),
        workflowName: c.workflowName,
        elapsedSeconds: c.startedAt
          ? Math.round(((c.completedAt ? Date.parse(c.completedAt) : now.getTime()) - Date.parse(c.startedAt)) / 1000)
          : null,
        expectedSeconds: exp?.p50 ?? null,
        expectedLowSeconds: exp?.p10 ?? null,
        expectedHighSeconds: exp?.p90 ?? null,
        url: c.url,
        waitKind: wait?.kind ?? null,
        blockedOn: wait?.kind === 'blocked' ? wait.blockedOn : null,
        waitingSeconds: wait?.kind === 'runner' ? wait.waitingSeconds : null,
        // a pickup estimate only makes sense for runner-waiting checks — blocked/unknown
        // checks aren't eligible to run yet, so skip the history lookups entirely
        expectedRunnerWaitSeconds: wait?.kind === 'runner'
          ? this.expectedRunnerWaitFor(repo, c.name, c.event) : null,
        flakeRatePct,
        likelyFlake: failingNow && flakeRatePct != null
          && flakeRatePct >= LIKELY_FLAKE_MIN_RATE_PCT,
        regressed: reg != null,
        regression: reg ? { priorP50Secs: reg.priorP50Secs, recentP50Secs: reg.recentP50Secs,
          ratio: reg.ratio, sinceApprox: reg.sinceApprox } : null,
        rerunInProgress: rerunInProgressFor(c, checks),
      };
    });
  }

  /**
   * Conformal-lite range calibration (issue #35, part 2): when (repo, stage)
   * has ≥10 accuracy samples and their p90 actual/predicted ratio exceeds the
   * churn threshold, widen/set the displayed ETA range to what history says
   * the stage actually takes. Stages without an ETA, non-tracked stages, and
   * thin/benign factors pass through unchanged (heuristic range kept).
   */
  private calibrateStage(repo: string, stage: StageResult): StageResult {
    if (!CALIBRATED_STAGES.has(stage.stage) || stage.etaSeconds == null) return stage;
    return applyEtaCalibration(stage, this.deps.history.calibrationFactor(repo, stage.stage));
  }

  /**
   * 7-day flake rates for a repo (issue #37), keyed name+NUL+event, only for
   * checks with ≥ FLAKE_MIN_RUNS samples. Cached for FLAKE_CACHE_TTL_MS so the
   * history query runs at most once a minute per repo (≈ once per build).
   */
  private flakeRatesFor(repo: string): Map<string, number> {
    const nowMs = this.now().getTime();
    const cached = this.flakeRateCache.get(repo);
    if (cached && nowMs - cached.at < FLAKE_CACHE_TTL_MS) return cached.rates;
    const since = new Date(nowMs - FLAKE_LOOKBACK_MS).toISOString();
    const rates = new Map<string, number>();
    for (const s of this.deps.history.flakeStats(repo, since)) {
      if (s.totalRuns >= FLAKE_MIN_RUNS) rates.set(flakeKey(s.name, s.event), s.flakeRatePct);
    }
    this.flakeRateCache.set(repo, { at: nowMs, rates });
    return rates;
  }

  /** Hourly trigger for the duration-regression scan (issue #41) and the
   *  pool-starvation scan (issue #45) — rides the deploy cycle, so the
   *  effective cadence is max(deployMs, 1h). */
  private maybeRunHourlyScans(): void {
    const nowMs = this.now().getTime();
    if (nowMs - this.lastHourlyScanAt < REGRESSION_SCAN_INTERVAL_MS) return;
    this.lastHourlyScanAt = nowMs;
    this.scanDurationRegressions();
    this.scanRunnerStarvation();
  }

  /**
   * One full duration-regression scan (issue #41): for every (repo, check,
   * event) series with ≥ REGRESSION_MIN_SAMPLES SUCCESS samples, run the
   * rolling-median step test (estimator/regression.ts) and rebuild the active
   * cache. Hysteresis: a series that WAS active stays active while the ratio
   * holds ≥ the clear threshold even when it no longer trips the entry guards.
   * Each evaluation also feeds the notifier, which debounces one
   * 'duration-regression' event per series activation.
   */
  scanDurationRegressions(): void {
    const { history, config } = this.deps;
    const nowMs = this.now().getTime();
    const next = new Map<string, Map<string, DurationRegressionView>>();
    const evaluated = new Set<string>(); // `${repo}\0${name}\0${event}` seen this scan
    let scanned = 0;
    for (const cand of history.regressionCandidates(REGRESSION_MIN_SAMPLES)) {
      if (config.exclude.includes(cand.repo)) continue;
      if (nowMs - Date.parse(cand.newestAt) > REGRESSION_DORMANT_MS) continue; // dormant series
      const key = flakeKey(cand.name, cand.event);
      evaluated.add(`${cand.repo}\u0000${key}`);
      const m = measureDurationStep(
        history.recentDurationSamples(cand.repo, cand.name, cand.event, REGRESSION_MIN_SAMPLES));
      if (!m) continue; // degenerate series (the candidate query guarantees the count)
      scanned++;
      const wasActive = this.durationRegressions.get(cand.repo)?.has(key) ?? false;
      const active = flagsRegression(m) || (wasActive && holdsRegression(m));
      if (active) {
        let repoMap = next.get(cand.repo);
        if (!repoMap) next.set(cand.repo, repoMap = new Map());
        repoMap.set(key, { check: cand.name, event: cand.event, priorP50Secs: m.priorP50,
          recentP50Secs: m.recentP50, ratio: m.ratio, sinceApprox: m.sinceApprox });
      }
      this.deps.notifier?.durationRegression(cand.repo, cand.name, cand.event, active,
        regressionDetail(m, cand.event));
    }
    // Previously-active series that left the candidate set entirely (repo
    // excluded, series gone dormant): clear the notifier debounce so a
    // returning regression can re-fire. The cache rebuild drops them already.
    for (const [repo, repoMap] of this.durationRegressions) {
      for (const v of repoMap.values()) {
        if (!evaluated.has(`${repo}\u0000${flakeKey(v.check, v.event)}`)) {
          this.deps.notifier?.durationRegression(repo, v.check, v.event, false, '');
        }
      }
    }
    this.durationRegressions = next;
    const active = [...next.values()].reduce((s, m2) => s + m2.size, 0);
    // quiet when there was nothing to evaluate (fresh/shallow DBs) — otherwise
    // one journal line per scan, the live "is it running?" probe
    if (scanned > 0) {
      console.log(`[regression] scanned ${scanned} check series — `
        + `${active} active duration regression${active === 1 ? '' : 's'}`);
    }
  }

  /** Current ACTIVE duration regressions per repo (sorted) — the metrics
   *  payload's `regressions[]` section reads this live cache. */
  activeRegressions(): { repo: string; checks: DurationRegressionView[] }[] {
    return [...this.durationRegressions]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, byCheck]) => ({
        repo,
        checks: [...byCheck.values()].sort((a, b) =>
          a.check.localeCompare(b.check) || a.event.localeCompare(b.event)),
      }));
  }

  /**
   * One pool-starvation scan (issue #45): read the last 7 days of pool-labeled
   * pickup waits, split each (repo, pool) series at now−1h, and evaluate the
   * starvation thresholds (estimator/starvation.ts — enter at p90 >
   * max(5min, 4× the 7d baseline p90) with ≥5 last-hour samples; hysteresis
   * holds an active alert until p90 falls below 2×). Rebuilds the live
   * poolHealth cache and feeds the notifier, which debounces one
   * 'runner-starvation' event per (repo, pool) episode.
   */
  scanRunnerStarvation(): void {
    const { history, config } = this.deps;
    const nowMs = this.now().getTime();
    const since = new Date(nowMs - STARVATION_BASELINE_MS).toISOString();
    const hourAgo = new Date(nowMs - STARVATION_LAST_HOUR_MS).toISOString();
    const byPool = new Map<string, { repo: string; pool: string; lastHour: number[]; baseline: number[] }>();
    for (const r of history.runnerPoolWaitsSince(since)) {
      if (config.exclude.includes(r.repo)) continue;
      const k = `${r.repo}\u0000${r.pool}`;
      let g = byPool.get(k);
      if (!g) byPool.set(k, g = { repo: r.repo, pool: r.pool, lastHour: [], baseline: [] });
      (r.at >= hourAgo ? g.lastHour : g.baseline).push(r.waitSecs);
    }
    const next = new Map<string, Map<string, PoolHealthView>>();
    let starvingCount = 0;
    for (const g of byPool.values()) {
      const e = evaluateStarvation(g.lastHour, g.baseline);
      const wasStarving = this.poolStarvation.get(g.repo)?.get(g.pool)?.starving ?? false;
      const starving = nextStarving(e, wasStarving);
      if (starving) starvingCount++;
      let repoMap = next.get(g.repo);
      if (!repoMap) next.set(g.repo, repoMap = new Map());
      repoMap.set(g.pool, { pool: g.pool, lastHourP90Secs: e.lastHourP90,
        baselineP90Secs: e.baselineP90, n: e.n, starving });
      this.deps.notifier?.runnerStarvation(g.repo, g.pool, starving,
        starving ? starvationDetail(g.pool, e) : '');
    }
    // pools that left the evaluated set entirely (no samples in 7d, repo
    // excluded): clear the notifier debounce so a returning episode re-fires
    for (const [repo, repoMap] of this.poolStarvation) {
      for (const pool of repoMap.keys()) {
        if (!next.get(repo)?.has(pool)) {
          this.deps.notifier?.runnerStarvation(repo, pool, false, '');
        }
      }
    }
    this.poolStarvation = next;
    if (byPool.size > 0) {
      console.log(`[starvation] scanned ${byPool.size} repo×pool series — `
        + `${starvingCount} starving`);
    }
  }

  /** Live pool-health snapshot per repo (sorted) — the metrics payload's
   *  `runnerPools` section joins this onto its window-bucketed series. */
  poolHealth(): { repo: string; pools: PoolHealthView[] }[] {
    return [...this.poolStarvation]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, byPool]) => ({
        repo,
        pools: [...byPool.values()].sort((a, b) => a.pool.localeCompare(b.pool)),
      }));
  }

  /** Learned pickup-wait estimate: name-level median, falling back to the event pool. */
  private expectedRunnerWaitFor(repo: string, name: string, event: string): number | null {
    const { history } = this.deps;
    return history.expectedRunnerWait(repo, name, event)
      ?? history.expectedRunnerWaitForEvent(repo, event);
  }

  // ---- helpers ------------------------------------------------------------

  private isHot(pr: PrSnapshot): boolean {
    const stage = this.stages.get(`${pr.repo}#${pr.number}`)?.stage;
    return stage === 'ci' || stage === 'queue' || !stage;
  }

  private groupCompleted(oid: string): boolean {
    const checks = this.groupChecks.get(oid);
    return !!checks?.length && checks.every((c) => c.status === 'COMPLETED');
  }

  /** Record the whole-group wall-clock duration the first time a group's checks
   *  are observed all-COMPLETED (queueOnce stops refetching completed groups, and
   *  recordedGroups guards against duplicate fetches racing the filter).
   *
   *  Only records when every check's conclusion is one of {SUCCESS, SKIPPED, NEUTRAL} —
   *  a CANCELLED or FAILURE group is an ejected/fail-fast run whose artificially short
   *  wall-clock would skew queue-duration medians. */
  private maybeRecordGroupRun(repo: string, oid: string, checks: CheckRun[]): void {
    if (this.recordedGroups.has(oid)) return;
    if (!checks.length || !checks.every((c) => c.status === 'COMPLETED')) return;
    this.recordedGroups.add(oid); // bad timestamps won't improve on a refetch — mark regardless
    const CLEAN_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
    if (!checks.every((c) => CLEAN_CONCLUSIONS.has(c.conclusion ?? ''))) return;
    const starts = checks.map((c) => c.startedAt).filter((t): t is string => !!t).map(Date.parse);
    const ends = checks.map((c) => c.completedAt).filter((t): t is string => !!t);
    if (!starts.length || !ends.length) return;
    const lastEnd = ends.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
    const durationSecs = (Date.parse(lastEnd) - Math.min(...starts)) / 1000;
    if (!Number.isFinite(durationSecs)) return;
    this.deps.history.recordGroupRun(repo, durationSecs, lastEnd);
  }

  /**
   * Per-PR stage tracker for ETA accuracy. Called on every classify result
   * (buildState runs on each emitUpdate — transitions are detected there):
   * - same stage: capture the first non-null etaSeconds seen in this stage
   * - stage change: if the OLD stage is ETA-tracked and had a first ETA, score
   *   predicted (firstEta) against actual (time spent in the stage)
   */
  private trackStageEta(key: string, repo: string, stage: StageResult, now: Date): void {
    const prev = this.stageTracker.get(key);
    if (prev && prev.stageId === stage.stage) {
      if (prev.firstEta == null && stage.etaSeconds != null) prev.firstEta = stage.etaSeconds;
      return;
    }
    if (prev && prev.firstEta != null && ETA_TRACKED_STAGES.has(prev.stageId)) {
      this.deps.history.recordEtaAccuracy(repo, prev.stageId, prev.firstEta,
        (now.getTime() - prev.enteredAt) / 1000, now.toISOString());
    }
    this.stageTracker.set(key, { stageId: stage.stage, enteredAt: now.getTime(), firstEta: stage.etaSeconds });
  }

  /**
   * A merging PR leaves the open-PR board without a final classify pass — score
   * its last pre-merge ETA-tracked stage (ci/queue) here. Post-merge stages
   * (qa-deploy/awaiting-prod) are left alone: merged search results re-ingest the
   * same PR across overlapping sweeps, and resetting the entry would skew their
   * enteredAt.
   */
  private recordEtaAccuracyOnMerge(key: string, repo: string, mergedAt: string): void {
    const prev = this.stageTracker.get(key);
    if (!prev) return;
    if (prev.stageId === 'qa-deploy' || prev.stageId === 'awaiting-prod' || prev.stageId === 'merged') return;
    this.stageTracker.delete(key);
    if (prev.firstEta == null || !ETA_TRACKED_STAGES.has(prev.stageId)) return;
    this.deps.history.recordEtaAccuracy(repo, prev.stageId, prev.firstEta,
      (Date.parse(mergedAt) - prev.enteredAt) / 1000, mergedAt);
  }

  /**
   * Lead-time timestamps to persist onto the merged_prs row (issue #44),
   * captured BEFORE recordQueueWaitOnMerge consumes queueEnqueuedAt. The
   * firstGreenAt entry is consumed here (the upsert's COALESCE keeps the first
   * persisted value when overlapping merged sweeps re-ingest the same PR).
   */
  private takeLeadTimeStamps(key: string): { firstGreenAt: string | null; enqueuedAt: string | null } {
    const firstGreenAt = this.firstGreenAt.get(key) ?? null;
    this.firstGreenAt.delete(key);
    return { firstGreenAt, enqueuedAt: this.queueEnqueuedAt.get(key) ?? null };
  }

  /** Record enqueue→merge wall-clock wait if this PR was last seen in the queue. */
  private recordQueueWaitOnMerge(key: string, repo: string, mergedAt: string): void {
    const enqueuedAt = this.queueEnqueuedAt.get(key);
    if (!enqueuedAt) return;
    this.queueEnqueuedAt.delete(key);
    const waitSecs = (Date.parse(mergedAt) - Date.parse(enqueuedAt)) / 1000;
    if (!Number.isFinite(waitSecs)) return;
    this.deps.history.recordQueueWait(repo, waitSecs, mergedAt);
  }

  private medianGroupSecs(repo: string): number | null {
    const observed = this.deps.history.medianGroupRun(repo);
    if (observed != null) return observed;
    // fallback proxy: expected duration of the longest merge_group check
    const names = this.deps.history.expectedSet(repo, 'merge_group', this.now());
    const p50s = names.map((n) => this.deps.history.expected(repo, n, 'merge_group')?.p50 ?? 0);
    return p50s.length ? Math.max(...p50s) : null;
  }

  /**
   * Webhook-driven out-of-band cycle trigger (round 8 Task A3). Routes through
   * the SAME entry points as the timer chains — runCycle containment plus the
   * per-cycle withLatch latches — so a nudge can never double-run a cycle that
   * is already in flight, and a rejected fetch never escapes to the process.
   * Generation-guard compatible by construction: nudges run once and never re-arm.
   */
  async nudge(route: WebhookRoute): Promise<void> {
    if (route.kind === 'queue') return this.runCycle('queue', () => this.queueOnce());
    if (route.kind === 'pr-detail') {
      const key = `${route.repo}#${route.prNumber}`;
      // tracked → targeted detail refresh; unknown PR → full sweep discovers it
      if (this.prs.has(key)) {
        return this.runCycle('detail', () => this.detailOnce(false, key));
      }
    }
    return this.runCycle('sweep', () => this.sweepAndRefresh());
  }

  effectiveHotMs(): number {
    // worst per-installation budget: each installation token meters separately
    const remaining = this.deps.router.minRemaining();
    if (remaining != null && remaining < this.deps.config.rateLimitFloor) return 60_000;
    const { hotMs } = this.deps.config.intervals;
    // Webhooks deliver hot-PR signals out-of-band — relax the hot polling tick ×4,
    // unless the operator explicitly pinned intervals.hotMs in the config file.
    return this.deps.config.webhooks.enabled && !this.deps.config.hotMsExplicit
      ? hotMs * 4 : hotMs;
  }

  /** Delay before the next run of a cycle kind; honors any rate-limit pause. */
  nextDelayMs(kind: DelayKind): number {
    const { intervals, rateLimitFloor } = this.deps.config;
    const remaining = this.deps.router.minRemaining();
    const base = kind === 'hot' ? this.effectiveHotMs()
      : kind === 'sweep'
        ? (remaining != null && remaining < rateLimitFloor ? SWEEP_LOW_BUDGET_MS : intervals.sweepMs)
        : intervals.deployMs;
    return Math.max(base, this.pauseUntil - this.now().getTime());
  }

  private notePause(retryAfterSeconds: number): void {
    this.pauseUntil = Math.max(this.pauseUntil, this.now().getTime() + retryAfterSeconds * 1000);
  }

  /** Skip a cycle entirely if the same cycle is still in flight (slow fetch + tick overlap). */
  private async withLatch(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.inFlight.has(name)) return;
    this.inFlight.add(name);
    try {
      await fn();
    } finally {
      this.inFlight.delete(name);
    }
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      const result = await fn();
      this.staleSince = null;
      return result;
    } catch (e) {
      console.error('[poller] fetch failed:', describeError(e));
      if (e instanceof RateLimitError) {
        this.notePause(e.retryAfterSeconds);
        this.emit('ratelimited', e.retryAfterSeconds);
      }
      if (!this.staleSince) this.staleSince = this.now().toISOString();
      return null;
    }
  }

  /** Containment wrapper: no cycle rejection may ever escape to the process. */
  private async runCycle(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error(`[poller] ${name} cycle failed:`, describeError(e));
      if (e instanceof RateLimitError) this.notePause(e.retryAfterSeconds);
      if (!this.staleSince) this.staleSince = this.now().toISOString();
    }
  }

  /** Sweep + full detail refresh: keeps cold PRs (ready/parked/draft) warm every sweep tick. */
  private async sweepAndRefresh(): Promise<void> {
    await this.sweepOnce();
    await this.detailOnce(false);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    // Self-re-arming setTimeout chains (not setInterval): the next delay is computed
    // AFTER each run, so rate-limit pauses and low-budget floors take effect immediately.
    // Each arm closure captures `gen` and bails when the generation has advanced —
    // this prevents an in-flight sweep that resolves after reconfigure() from re-arming
    // the old chain and creating duplicate self-perpetuating timer chains.
    const chain = (kind: DelayKind, name: string, fn: () => Promise<void>) => {
      const arm = () => {
        if (!this.running || this.generation !== gen) return;
        const t = setTimeout(() => {
          this.timers.delete(t);
          if (this.generation !== gen) return; // stale chain — bail before running
          void this.runCycle(name, fn).finally(arm);
        }, this.nextDelayMs(kind));
        t.unref();
        this.timers.add(t);
      };
      arm();
    };
    void this.runCycle('sweep', () => this.sweepAndRefresh()); // initial kick, contained
    chain('sweep', 'sweep', () => this.sweepAndRefresh());
    chain('hot', 'detail', () => this.detailOnce(true));
    chain('hot', 'queue', () => this.queueOnce());
    chain('deploy', 'deploy', () => this.deployOnce());
  }

  stop(): void {
    this.running = false;
    this.generation++;             // invalidate any in-flight arm closures from the old chain
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
