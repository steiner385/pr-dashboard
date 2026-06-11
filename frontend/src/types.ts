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
}
export interface PrView {
  repo: string; number: number; title: string; url: string;
  stage: StageResult;
  queueAheadCount: number | null;
  checks: CheckView[];
  /** Queued PRs only: the merge-group build's checks (drives the queue stage ETA);
   *  null when not queued or the group rollup hasn't been fetched yet. */
  groupChecks: CheckView[] | null;
}
export interface StageAccuracy { medianAbsErrSecs: number; n: number; }
export interface QueueGroupView {
  oid: string;
  prNumbers: number[];
  percent: number | null;
  etaSeconds: number | null;
  failed: boolean;
}
export interface RepoQueueView {
  groups: QueueGroupView[];
  waiting: { prNumber: number; position: number }[];
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
}
export interface DashboardState {
  generatedAt: string; staleSince: string | null;
  repos: { repo: string; hasDeploy: boolean; accuracy: Record<string, StageAccuracy>; prs: PrView[]; queue: RepoQueueView | null }[];
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
  /** read-only (tokenSource/apiUrl/port) */
  tokenSource: string;
  apiUrl: string;
  port: number;
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
