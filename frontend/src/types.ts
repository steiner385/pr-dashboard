// Notification event-type registry — single shared source of truth (server +
// frontend); see shared/notification-events.ts. Imported for local use below and
// re-exported so existing frontend importers are unchanged.
import type { NotificationEventType, NotificationKind } from '../../shared/notification-events';
export type { NotificationEventType, NotificationKind };

export type StageId = 'ci' | 'parked' | 'ready' | 'queue' | 'qa-deploy' | 'awaiting-prod' | 'merged';
export interface StageResult {
  stage: StageId; substate: string | null;
  percent: number | null; etaSeconds: number | null;
  etaRangeSeconds: [number, number] | null; overdue: boolean;
}
export interface CheckView {
  name: string; status: string; conclusion: string | null; isRequired: boolean;
  /** Workflow display name (e.g. `CI`, `Auto-merge PRs`); null when unknown. */
  workflowName: string | null;
  elapsedSeconds: number | null; expectedSeconds: number | null; url: string | null;
  /** Lower/upper expected-duration bounds (p10/p90 over the same last-20 SUCCESS
   *  window as expectedSeconds); null whenever expectedSeconds is null. */
  expectedLowSeconds: number | null; expectedHighSeconds: number | null;
  /** Queued-check runner classification (null for non-queued checks):
   *  'runner' = needs satisfied, waiting for a runner; 'blocked' = waiting on
   *  blockedOn; 'unknown' = needs graph unknown or root job. */
  waitKind: 'runner' | 'blocked' | 'unknown' | null;
  blockedOn: string | null;
  waitingSeconds: number | null;
  expectedRunnerWaitSeconds: number | null;
  /** Flake radar (issue #37): 7-day flake rate when the check has enough
   *  history (≥5 distinct (sha, attempt) samples); null otherwise. */
  flakeRatePct: number | null;
  /** True when the check is currently failing-class AND its flake rate ≥ 20% —
   *  the failure is likely a flake; consider a re-run. */
  likelyFlake: boolean;
  /** Duration regression (issue #41): true while the check's (name, event)
   *  series has an active p50 step-up — the Gantt's ↑ badge. Optional to
   *  tolerate pre-upgrade payloads. */
  regressed?: boolean;
  /** The step behind the badge (tooltip numbers); null/absent when not regressed. */
  regression?: DurationRegressionInfo | null;
  /** Spot-reclaim ledger (issue #46): a CANCELLED check whose sha has a newer
   *  attempt running/queued — render '↻ re-run in progress — likely spot
   *  reclaim, do nothing'. Optional to tolerate pre-upgrade payloads. */
  rerunInProgress?: boolean;
}

/** Mirror of server poller.ts DurationRegressionInfo (issue #41). */
export interface DurationRegressionInfo {
  priorP50Secs: number;
  recentP50Secs: number;
  ratio: number;
  /** ISO time of the recent window's first sample — the approximate onset. */
  sinceApprox: string;
}
/** Mirror of server poller.ts PrTimeline (issue #50): the merged_prs waterfall
 *  spine. A null waypoint was never observed — the segment is omitted. */
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
  /** GitHub mergeStateStatus (…|DIRTY|CLEAN|UNKNOWN|DRAFT) for OPEN PRs; null for
   *  merged-PR views and pre-upgrade payloads. Gates the ready+auto-merge button:
   *  disabled when DIRTY (conflict). Optional to tolerate older payloads. */
  mergeStateStatus?: string | null;
  queueAheadCount: number | null;
  checks: CheckView[];
  /** Per-PR waterfall spine (issue #50) — merged PRs only; null for open PRs.
   *  Optional to tolerate pre-upgrade payloads. */
  timeline?: PrTimeline | null;
  /** Workflow-change flag (issue #49): the PR touches `.github/workflows/**` —
   *  render the '⚙ CI change' badge. Optional for pre-upgrade payloads. */
  touchesWorkflows?: boolean;
  /** Mirror of server workflow-impact.ts WorkflowImpact (issue #49): derived
   *  CI-graph diff summary lines vs main. Null/absent = no diff available
   *  (no graph, not computed yet) or no change. */
  workflowImpact?: { summary: string[] } | null;
  /** Queued PRs only: the merge-group build's checks (drives the queue stage ETA);
   *  null when not queued or the group rollup hasn't been fetched yet. */
  groupChecks: CheckView[] | null;
  /** Multi-train merge ETA simulation (issue #40) — WAITING queue entries only;
   *  null elsewhere (and on pre-upgrade payloads). */
  mergeEtaSim: MergeEtaSimulation | null;
  /** PR-level CI cost (cost explorer): elapsed runner-minutes of the CURRENT
   *  head's checks (running checks count started→now). Null when no check has
   *  started / merged PRs; optional to tolerate pre-upgrade payloads. */
  costMinutes?: number | null;
  /** The priced subset of costMinutes in dollars (poolMeta > costPerMinute >
   *  'default'); null in minutes-only mode. */
  costDollars?: number | null;
  /** True when costDollars is a known undercount: rates exist but at least
   *  one counted check ran on an unpriced pool — rendered '(partial)'. */
  costDollarsPartial?: boolean;
}

/** Mirror of server estimator/queue.ts MergeEtaSimulation (issue #40). */
export interface MergeEtaSimulation {
  p50Secs: number;
  p90Secs: number;
  /** Trains that must complete before this PR merges. */
  trainsAhead: number;
  /** True when the p90 budgets one extra train for a likely eject. */
  assumesEjects: boolean;
}

/** Mirror of server estimator/queue-health.ts (issue #39). */
export type QueueHealthState = 'healthy' | 'cap-backlog' | 'dispatch-stall';
export interface QueueHealthView {
  state: QueueHealthState;
  /** Human remediation string ('dispatch-stall: … do NOT admin-merge', …). */
  detail: string;
  /** ISO time the queue entered this state. */
  since: string;
}
export interface QueueGroupView {
  oid: string;
  prNumbers: number[];
  percent: number | null;
  etaSeconds: number | null;
  failed: boolean;
}
export interface RepoQueueView {
  groups: QueueGroupView[];
  waiting: { prNumber: number; position: number; sim?: MergeEtaSimulation | null }[];
  /** PR numbers of GENUINELY conflicting UNMERGEABLE entries (DIRTY against the
   *  base — needs a rebase) — excluded from group coverage and waiting. */
  unmergeable: number[];
  /** Cascade-UNMERGEABLE entries: poisoned by a conflicting entry ahead, not
   *  conflicting with the base themselves — must not be told to rebase. */
  queueBlocked: number[];
  /** Lowest-position genuine conflict (presumed front-most UNMERGEABLE when no
   *  snapshot proves DIRTY); null without UNMERGEABLE entries. */
  unmergeableCulprit: number | null;
  batchSize: number;
  /** Ops console (issue #39) — optional only to tolerate pre-upgrade payloads. */
  health?: QueueHealthView;
  depth?: number;
  entriesWithWaitSecs?: { prNumber: number; position: number; waitSecs: number }[];
  trainsPerHour?: number;
  batchSuccessRatePct?: number | null;
  ejects24h?: number;
}
export interface DashboardState {
  generatedAt: string; staleSince: string | null;
  repos: { repo: string; hasDeploy: boolean; prs: PrView[]; queue: RepoQueueView | null;
    laneHealth?: { main: LaneStatus; lastGreenSha?: string | null; lastGreenAt?: string | null; mainSeries?: { ok: boolean | null }[] };
    /** Advisory Deploy-lane snapshot (Spec 2): per-env live commit sha (from
     *  /health) + awaiting-QA/awaiting-prod drift. Absent for repos with no
     *  deploy config. Mirror of server estimator/deploy-status.ts. */
    deploy?: { envs: { name: string; liveSha: string | null; reachable: boolean }[];
      awaitingQa: number; awaitingProd: number;
      /** QA→prod chain with SHA supersession (roadmap 4.4c). */
      chain?: { entries: { prNumber: number; sha: string | null; mergedAt: string;
        stage: 'merged' | 'qa' | 'prod'; qaLiveAt: string | null; prodLiveAt: string | null; superseded: boolean }[];
        inFlight: { prNumber: number; sha: string | null; stage: string } | null; supersededCount: number } };
    /** Advisory Scheduled-lane snapshot (Spec 4): the newest run per
     *  cron-scheduled workflow + the discovered-workflow count. Absent for
     *  repos with no scheduled workflows. Mirror of server poller.ts
     *  RepoScheduledStatus. Optional to tolerate pre-upgrade payloads. */
    scheduled?: { runs: { workflow: string; conclusion: string | null;
      status: string | null; createdAt: string | null; htmlUrl: string | null }[];
      discovered: number };
    /** Advisory Failures & flake-lane snapshot (Spec 5): the top flaky checks
     *  (≥ FLAKE_MIN_RUNS runs with same-sha fail-then-pass events) over a 14-day
     *  window + the flaky-check count. Absent for repos with no flaky checks.
     *  Mirror of server estimator/flake-summary.ts RepoFlakeSummary. Optional to
     *  tolerate pre-upgrade payloads. */
    flake?: { topChecks: { name: string; event: string; flakeRatePct: number; flakeEvents: number }[];
      flakyCount: number }; }[];
  /** Cross-cutting global CI cost summary (Cost lane, Spec 3) — top-level, not
   *  per-repo. Priced runner-minutes over a 7-day window across all repos,
   *  split by pipeline stage. `dollars` is null for an unpriced stage subset;
   *  `totalDollars`/`retryWastePct` are null in minutes-only mode (no rate
   *  configured) — never a fabricated $0. Mirror of server metrics.ts
   *  CostSummary. Optional to tolerate pre-upgrade payloads. */
  cost?: {
    totalDollars: number | null;
    days: number;
    byStage: { stage: 'pr' | 'queue' | 'main' | 'scheduled'; dollars: number | null; minutes: number }[];
    retryWastePct: number | null;
  };
}

// ---- Notifications (issue #19) ----
// Mirrors of server/notifier.ts — the payload of the named `notification` SSE
// event and the file-only `notifications` config block (read-only in the UI).
// (The event-type registry is imported from shared/ at the top of this file.)

export interface NotificationEvent {
  repo: string;
  prNumber: number;
  /** PR title. For 'digest': the pre-rendered subject line (repo is ''). */
  title: string;
  type: NotificationKind;
  detail: string;
  /** Server-rendered display strings — the single source of truth for what the
   *  bell shows (server/notifier.ts renderNotification). The browser displays
   *  these verbatim and never re-derives labels/subjects. */
  rendered?: { title: string; body: string };
}

export interface NotificationsConfig {
  enabled: boolean;
  command: string[];
  /** Masked by the server to scheme+host — the path may carry a token. */
  webhookUrl?: string;
  digest: { enabled: boolean; hourLocal: number };
  events: Record<NotificationEventType, boolean>;
}

// ---- Config API mirrors (GET/PUT /api/config) ----
// These mirror the server shapes in server/config.ts + server/poller.ts. The UI
// only edits the safe subset (owners/exclude/retentionDays/batchSize/intervals);
// everything else is read-only display.

/** Interval config — stored as milliseconds; the UI displays/edits in seconds. */
export interface AppIntervals {
  sweepMs: number;
  hotMs: number;
  deployMs: number;
}

/** Resolved instance config returned in `GET /api/config`'s `resolved` field. */
export interface AppConfig {
  owners: string[];
  exclude: string[];
  retentionDays: number;
  batchSize: number;
  intervals: AppIntervals;
  /** read-only (tokenSource/apiUrl/port/ancestrySource/notifications) */
  tokenSource: string;
  apiUrl: string;
  port: number;
  ancestrySource: 'api' | 'clone';
  notifications: NotificationsConfig;
  /** CI cost attribution (issue #43): pool label → $ per runner-minute
   *  ('default' prices unlisted pools). File-only; absent = minutes only. */
  costPerMinute?: Record<string, number>;
  /** Cost explorer: per-pool metadata — instance type (display), an optional
   *  $/min that SUPERSEDES costPerMinute for the same label, and an optional
   *  podsPerNode divisor (bin-packing correction: N runner pods on one node
   *  each cost 1/N of the node rate). File-only; read-only in settings. */
  poolMeta?: Record<string, { instanceType?: string; dollarsPerMinute?: number;
    podsPerNode?: number; note?: string }>;
}

/** Which config layer a per-repo setting value came from. */
export type SettingSource = 'override' | 'in-repo' | 'derived' | 'default';

/** A per-repo effective setting paired with its source attribution. */
export interface SettingField<T> {
  value: T;
  source: SettingSource;
}

/** Minimal deploy summary shown in the per-repo section. */
export interface RepoDeploySummary {
  environments: { name: string }[];
}

/** Per-repo effective settings report (mirror of server RepoSettingsReport). */
export interface RepoSettingsReport {
  rollupJobId: SettingField<string>;
  workflowPath: SettingField<string>;
  batchSize: SettingField<number>;
  requiredCheckPrefixes: SettingField<string[] | null>;
  deploy: SettingField<RepoDeploySummary | null>;
}

/** Full response of `GET /api/config`. */
export interface ConfigResponse {
  resolved: AppConfig;
  readOnlyKeys: string[];
  sources: {
    configPath: string;
    perField?: Record<string, 'default' | 'file'>;
  };
  repos: Record<string, RepoSettingsReport>;
  writableTo: string;
}

/** Safe-subset body of `PUT /api/config`. */
export interface ConfigPatch {
  owners?: string[];
  exclude?: string[];
  retentionDays?: number;
  batchSize?: number;
  intervals?: Partial<AppIntervals>;
  /** Carve-out: `enabled` is the ONLY writable notifications sub-key —
   *  command/events stay file-only (server-enforced). */
  notifications?: { enabled: boolean };
}

/** Success body of `PUT /api/config`. */
export interface ConfigPutResult {
  applied: string[];
  restartRequired: string[];
}

/** Error body of a 400 `PUT /api/config`. */
export interface ConfigPutError {
  error?: string;
  offendingKeys?: string[];
  fieldErrors?: Record<string, string>;
}

// ---- Metrics API mirror (GET /api/metrics) ----
// BINDING CONTRACT with `server/metrics.ts` (metrics-readability revision) —
// change both together. All p50/p90 values are seconds; meanHours is hours.
// `bucket` keys are ISO UTC hours (YYYY-MM-DDTHH) or days (YYYY-MM-DD)
// depending on the payload-level `bucket`. Headline stats carry { value, prev }
// where prev is the same aggregate over the previous equal window (null when
// not computable).

export type MetricsWindow = '24h' | '3d' | '7d' | '14d' | '30d';
export type MetricsBucket = 'hour' | 'day';

/** Mirror of server LEAD_TIME_SEGMENTS ids (issue #44), pipeline order. */
export type LeadTimeSegmentId =
  'toFirstGreen' | 'greenToEnqueued' | 'queue' | 'qaDeploy' | 'awaitingProd';

export interface HeadlineStat { value: number | null; prev: number | null }

/** One demotion candidate (mirror of server/estimator/demotion-candidates.ts). */
export interface DemotionCandidate {
  name: string;
  event: string;
  currentTier: string;
  suggestedTier: string;
  successRatePct: number;
  runsInWindow: number;
  minutesInWindow: number;
  reason: string;
}

/** One promotion candidate (mirror of server/estimator/promotion-candidates.ts). */
export interface PromotionCandidate {
  name: string;
  event: string;
  currentTier: string;
  suggestedTier: string;
  realFailures: number;
  failRatePct: number;
  runsInWindow: number;
  minutesInWindow: number;
  reason: string;
}

export interface MetricsPayload {
  window: MetricsWindow;
  bucket: MetricsBucket;
  runnerWaits: { repo: string; event: string; p50: HeadlineStat;
    buckets: { bucket: string; p50: number; p90: number; n: number }[] }[];
  queue: { repo: string;
    merges: HeadlineStat; queueWaitP50: HeadlineStat; groupRunP50: HeadlineStat;
    mergesPerBucket: { bucket: string; count: number }[];
    queueWaitBuckets: { bucket: string; p50: number; n: number }[];
    groupRunBuckets: { bucket: string; p50: number; n: number }[] }[];
  /** Queue efficiency (issue #23): merge_group runs per merged PR + the
   *  run-level vs required-gate conclusion split. Optional to tolerate
   *  pre-upgrade / captured payloads. */
  queueEfficiency?: { repo: string;
    mergeGroupRuns: number; queueMerges: number; runsPerMerge: number | null;
    runConclusion: { total: number; runFailed: number; requiredFailed: number;
      advisoryNoise: number; requiredConfigured: boolean };
    adminBypass: { merges: number; bypasses: number; rate: number | null } }[];
  /** Batch-size what-if advisor (issue #52). Optional to tolerate captured /
   *  pre-upgrade payloads. */
  batchAdvisor?: { repo: string;
    arrivalPerHour: number; trainDurationSecs: number;
    ejectProbPerGroup: number; ejectProbPerPr: number; arrivalsPerTrain?: number;
    currentBatch: number; recommendedBatch: number;
    curve: { batch: number; throughputPerHour: number;
      timeInQueueSecs: number | null; stable: boolean }[] }[];
  /** Recommendations digest (tuning tool). Optional to tolerate captured /
   *  pre-upgrade payloads. */
  recommendations?: { repo: string; kind: string;
    priority: 'high' | 'medium' | 'low'; title: string; detail: string }[];
  /** Config-change annotations (tuning tool) — auto-detected tuning-knob changes,
   *  overlaid as chart markers. Optional for captured / pre-upgrade payloads. */
  configChanges?: { repo: string; at: string; field: string;
    oldValue: string | null; newValue: string | null }[];
  slowestJobs: { repo: string; jobs: { name: string; event: string; p50: number; p90: number;
    variability: number; n: number;
    trend: { bucket: string; p50: number; p90: number; n: number }[] }[] }[]; // top 10 by p50, variability = p90/p50
  velocity: { repo: string;
    merged: HeadlineStat; mergeToQaP50: HeadlineStat; lifespanMeanHours: HeadlineStat;
    mergedPerBucket: { bucket: string; count: number }[];
    mergeToQaBuckets: { bucket: string; p50: number; n: number }[];
    avgLifespanBuckets: { bucket: string; meanHours: number; n: number }[] }[];
  trends: { repo: string;
    points: { bucket: string; open: number; ci: number; queue: number; failed: number }[] }[]; // last state sample per bucket (closing value)
  /** ETA calibration (issue #35): signed error % per (repo, stage) —
   *  POSITIVE medianErrorPct = ETAs run optimistic (stages take longer than
   *  promised). `points` = (predicted, actual) scatter, newest ≤200. */
  calibration: { repo: string; stage: string; n: number;
    medianErrorPct: number; p90AbsErrorPct: number;
    buckets: { bucket: string; medianErrorPct: number; n: number }[];
    points: { predicted: number; actual: number }[] }[];
  /** Flake radar (issue #37): top checks by flake rate per repo (min 5 runs,
   *  cap 10). A flake = failing then passing on the SAME head sha (re-run). */
  flakiness: { repo: string; checks: { name: string; event: string;
    flakeEvents: number; totalRuns: number; flakeRatePct: number;
    trend: { bucket: string; flakeEvents: number; runs: number }[] }[] }[];
  /** Demotion candidates (almost-always-green → lower frequency): per repo, the
   *  checks whose success rate clears the bar over enough distinct runs, ranked
   *  by runner-minutes spent (cost × greenness). Advisory; disjoint from
   *  flakiness (a flaky check fails the success bar). */
  demotionCandidates: { repo: string; candidates: DemotionCandidate[] }[];
  /** Promotion candidates (real-failing late → shift left): per repo, checks with
   *  a real (non-flaky) failure rate at a late tier that don't already run
   *  earlier. Inverse of demotionCandidates; disjoint by construction. Advisory. */
  promotionCandidates: { repo: string; candidates: PromotionCandidate[] }[];
  /** Train killers (issue #38): checks ranked by merge-group ejections.
   *  estCostTrainHours ≈ ejects × median group run × batchSize (hours); null
   *  without an observed median. flakeRatePct cross-references the flake radar. */
  trainKillers: { repo: string; batchSize: number; medianGroupRunSecs: number | null;
    checks: { name: string; ejects: number; estCostTrainHours: number | null;
      flakeRatePct: number | null;
      /** Per-reason eject tally (roadmap 4.4b). */
      reasonCounts: Record<'timeout' | 'test-fail' | 'infra' | 'unknown', number>;
      /** Reason to lead with (most ejects; ties → most actionable); null if none. */
      dominantReason: 'timeout' | 'test-fail' | 'infra' | 'unknown' | null;
      /** Lead remedy for `dominantReason`; null when no ejects. */
      remedy: string | null }[] }[];
  /** Critical path (issue #42): static expected longest chain per repo×event
   *  (node weight = median wait + median duration); offPath = 10 lowest-slack
   *  jobs. Window-independent (last-N medians) — label it as such. */
  criticalPath: { repo: string; event: string; endToEndP50Secs: number;
    path: { name: string; durationP50: number; waitP50: number }[];
    offPath: { name: string; slackSecs: number }[] }[];
  /** Interactive needs-graph (issue #74): the full needs-DAG per (repo, event).
   *  Optional to tolerate captured / pre-upgrade payloads. */
  needsGraph?: { repo: string; event: string; endToEndP50Secs: number;
    nodes: { name: string; needs: string[]; durationP50: number | null;
      waitP50: number | null; onCriticalPath: boolean; slackSecs: number | null }[] }[];
  /** Lead-time decomposition + DORA-lite headlines (issue #44). Segment
   *  medians (seconds) over PRs MERGED in the window, computed pairwise — a
   *  row counts toward a segment only when it has both endpoint timestamps
   *  (medianSecs null at n=0; first_green/enqueued only populate from merges
   *  after 2026-06, so those segments start 'collecting'). totalP50Secs =
   *  created→prod p50; deploysPerDay = prod-live events in window / days. */
  leadTime: { repo: string;
    segments: { id: LeadTimeSegmentId; medianSecs: number | null; n: number }[];
    totalP50Secs: number | null; totalN: number;
    prodDeploys: number; deploysPerDay: number }[];
  /** Duration regressions (issue #41): CURRENTLY-ACTIVE p50 step-ups from the
   *  server's hourly scan — a live alert strip, not window-scoped (the window
   *  selector never applies). Repos with no active regressions are omitted. */
  regressions: { repo: string;
    checks: ({ check: string; event: string } & DurationRegressionInfo)[] }[];
  /** Workflow lint (issue #48 rule 1 — timeout calibration). observed /
   *  configured are seconds; configured null = timeout-minutes unset (360m
   *  GitHub default). Repos with zero findings are omitted. */
  lint: { repo: string; findings: { rule: 'timeout'; severity: 'warn' | 'info';
    job: string; message: string; observed: number; configured: number | null }[] }[];
  /** Per-pool runner telemetry (issue #45): like runnerWaits but keyed by the
   *  job's runs-on pool ('a|b' = a multi-candidate ternary, one composite
   *  pool). lastHour/baseline p90 + starving = the live starvation snapshot
   *  from the server's hourly scan (window-independent; nulls until the first
   *  scan). */
  runnerPools: { repo: string; pool: string; p50: HeadlineStat;
    buckets: { bucket: string; p50: number; p90: number; n: number }[];
    lastHourP90Secs: number | null; baselineP90Secs: number | null;
    starving: boolean }[];
  /** Spot-reclaim ledger (issue #46): infra-kill events (CANCELLED at attempt
   *  N, SUCCESS on the same sha at a higher attempt) — count trend + by-pool
   *  split. Repos with zero events are omitted. */
  reclaims: { repo: string; total: number;
    perBucket: { bucket: string; count: number }[];
    byPool: { pool: string; count: number }[];
    /** Spot-reclaim rate (spot pools only). Optional to tolerate pre-upgrade payloads. */
    spot?: { reclaims: number; jobs: number; ratePct: number | null; perHour: number;
      perBucket: { bucket: string; reclaims: number; jobs: number }[] } }[];
  /** Concurrency demand curve (issue #47): per repo×pool, PEAK concurrent
   *  jobs per bucket (sweep-line over stored job intervals). No cap overlay
   *  in v1 — the fleet cap isn't known to the dashboard. */
  concurrency: { repo: string; pool: string; peak: number;
    buckets: { bucket: string; peak: number }[] }[];
  /** CI cost attribution (issue #43): runner-minutes per repo by runs-on pool
   *  ('a|b' = composite ternary label; 'unknown' = unmappable). Every
   *  conclusion counts; rows attribute to the bucket they STARTED in. Dollar
   *  figures are null unless the operator configured the file-only
   *  costPerMinute map (pool → $/min, 'default' fallback); a pool without a
   *  rate carries null dollars and stays out of the $ totals. retry* = the
   *  run_attempt > 1 subset. Optional to tolerate pre-upgrade payloads. */
  cost?: { repo: string; totalMinutes: number; totalDollars: number | null;
    retryMinutes: number; retryDollars: number | null;
    mergesInWindow: number; minutesPerMergedPr: number | null;
    pools: { pool: string; minutes: number; dollars: number | null;
      /** Display instance type from the file-only poolMeta config (cost
       *  explorer); null/absent when unset or on pre-upgrade payloads. */
      instanceType?: string | null;
      buckets: { bucket: string; minutes: number }[] }[] }[];
  /** Cost explorer — per-job leaderboard: top 15 jobs per repo by window
   *  runner-minutes (every conclusion). dollars null when the job's pool is
   *  unpriced. Optional to tolerate pre-upgrade payloads. */
  costJobs?: { repo: string; jobs: { name: string; event: string; minutes: number;
    dollars: number | null; pool: string; samples: number }[] }[];
  /** Cost explorer — per-run table: top 20 workflow runs per repo by window
   *  runner-minutes, grouped by (event, head sha, run number). Only rows with
   *  a stored run_number participate — records from new ingestion onward.
   *  prNumber = best-effort live head-sha join (anchor link); null unknown. */
  costRuns?: { repo: string; runs: { event: string; runNumber: number;
    headShaShort: string; minutes: number; dollars: number | null;
    jobCount: number; prNumber: number | null }[] }[];
  /** Cost actuals + attribution coverage (cost explorer phase 2): imported
   *  per-day ACTUAL spend per scope ('fleet' first) vs the per-day ATTRIBUTED
   *  job dollars. ALWAYS day-keyed (bills are daily). attributedDollars /
   *  coveragePct are null in minutes-only mode (and coverage when actual = 0).
   *  Optional to tolerate pre-upgrade payloads. */
  costActuals?: { scope: string;
    days: { date: string; actualDollars: number; attributedDollars: number | null;
      coveragePct: number | null; cumulativeCoveragePct: number | null }[];
    totalActualDollars: number; totalAttributedDollars: number | null;
    /** Coverage is computed over COMPARABLE days only (tracked + fully billed);
     *  `coverageSince` is the first such day. Not the naive total ratio. */
    coveragePct: number | null; coverageSince: string | null;
    recentCoveragePct: number | null; recentCoverageDate: string | null }[];
  /** Cost empirical auto-rate (issue #100): the derived fully-loaded $/runner-
   *  minute applied to non-github-hosted pools when `costAutoRate` is enabled
   *  (fleet actuals ÷ tracked EC2 runner-minutes over the window). Null when the
   *  flag is off or no fleet actuals exist yet (static rate is used instead).
   *  Optional to tolerate pre-upgrade payloads. */
  costAutoRate?: { dollarsPerMinute: number; fleetDollars: number;
    trackedMinutes: number; windowDays: number } | null;
}

// ---- Runner routing API mirror (GET /api/runner-plan, PUT /api/runner-routing) ----

/** A single job row from the runner-plan optimizer. */
export interface PlanRow {
  /** Job key (e.g. 'unit', 'integration'). */
  key: string;
  /** Observed p90 duration in seconds. */
  p90Secs: number;
  /** Score in minutes used for the shed/on-demand boundary. */
  scoreMinutes: number;
  /** Routing decision: on-demand runner or spot runner. */
  decision: 'kindash-arc' | 'kindash-arc-spot';
  /** Textual reason for the decision. */
  reason: string;
  /** Whether this row came from an operator override or was auto-computed. */
  source: 'auto' | 'override';
  /** True while the job doesn't have enough samples to produce a reliable p90. */
  collecting: boolean;
  /** Real CI check name (e.g. 'test: unit'); absent for keys without metadata. */
  label?: string;
  /** Reusable workflow that owns this job's runs-on (e.g. '_static-checks.yml'). */
  workflow?: string;
}

/** Full response of `GET /api/runner-plan`. */
export interface RunnerPlanResponse {
  /** Whether the runner-routing feature is enabled (pushing RUNNER_MAP). */
  enabled: boolean;
  /** Current in-effect RUNNER_MAP as a key→pool object. */
  map: Record<string, string>;
  /** Number of jobs currently routed to on-demand due to shed. */
  shedCount: number;
  /** The live knob value (minutes) — what the threshold input shows/edits. */
  shedThresholdMinutes: number;
  /** Reclaim rate (percent) the decision was made from; null when no spot jobs ran. */
  reclaimRatePct: number | null;
  /** ISO timestamp of the last successful RUNNER_MAP push; null if never pushed. */
  lastPushedAt: string | null;
  /** Canonical-map JSON hash of the last push (NOT a commit SHA); null if never pushed. */
  lastPushedHash: string | null;
  /** ISO timestamp of the last map-vs-GH verification pass; null if never run. */
  lastVerifiedAt: string | null;
  /** Last push/verify error message; null when healthy. */
  lastError: string | null;
  /** Per-job routing plan rows. */
  plan: PlanRow[];
}

// ---- Delivery Spine (spec §2, §3.1, §4.2, §14) ----

/** The single public status vocabulary for Delivery-spine lanes (spec §2). */
export type LaneStatus = 'green' | 'amber' | 'red' | 'blind' | 'idle';

/** The serializable lane facts the server may compute and ship over SSE
 *  (spec §14: a positive allowlist — never tokens/errors/secrets). */
export interface LaneView {
  id: string;
  title: string;
  status: LaneStatus;
  summary: string;            // ≤200 chars, truncated '…'
  costChip?: { dollars: number; days: number } | null;
  efficiencyChip?: string | null;
  wiredness: 'wired' | 'not-wired';
  gating: boolean;
}

/** A fully-realized lane: a LaneView plus the client-only render function for
 *  its expanded panel (spec §3.1 — a render FUNCTION so it re-renders on SSE). */
export interface Lane extends LaneView {
  glyphPosition: 'dot' | 'crosscut';
  renderExpanded: () => import('react').ReactNode;
}
