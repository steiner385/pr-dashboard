import Database from 'better-sqlite3';
import { median, percentile } from './math';
import type { SuccessStat } from './estimator/demotion-candidates';

export type { SuccessStat } from './estimator/demotion-candidates';

export interface Expected { p10: number; p50: number; p90: number; n: number; }
export interface MergedPrInput {
  repo: string; number: number; title: string; url: string;
  mergedAt: string; mergeCommitSha: string | null;
  /** PR creation time (lifespan metric). Optional: pre-migration callers/rows lack it. */
  createdAt?: string | null;
  /** Lead-time decomposition (issue #44): when the PR first went green
   *  (ci → ready/queue transition observed by the poller). Optional: rows
   *  merged before the feature shipped, and PRs whose transition was never
   *  observed (merged between polls, process restart mid-CI), lack it. */
  firstGreenAt?: string | null;
  /** Lead-time decomposition (issue #44): the merge-queue enqueuedAt the
   *  poller last observed while the PR sat in the queue. Optional like
   *  firstGreenAt; null for PRs merged outside the queue. */
  enqueuedAt?: string | null;
  /** GitHub login that merged the PR (admin-bypass metric, issue #23). Null
   *  for pre-migration rows and PRs whose merger GitHub didn't report. */
  mergedBy?: string | null;
}
export interface MergedPrRecord extends MergedPrInput {
  createdAt: string | null;
  firstGreenAt: string | null; enqueuedAt: string | null;
  qaLiveAt: string | null; prodLiveAt: string | null;
  mergedBy: string | null;
}

/** One merged_prs row projected for the lead-time decomposition (issue #44). */
export interface LeadTimeRow {
  repo: string;
  createdAt: string | null; firstGreenAt: string | null; enqueuedAt: string | null;
  mergedAt: string; qaLiveAt: string | null; prodLiveAt: string | null;
}

/** Per-repo dashboard-state counts captured by the poller (metrics trends panel). */
export interface StateSampleCounts { open: number; ci: number; queue: number; failed: number; }
export interface StateSampleRow extends StateSampleCounts { repo: string; at: string; }

/** One ETA-accuracy sample (predicted first stage ETA vs actual stage duration). */
export interface EtaAccuracyRow {
  repo: string; stage: string; predictedSecs: number; actualSecs: number; at: string;
}

/**
 * Conclusions that count as "failing-class" for flake detection (#37) and
 * group-failure attribution (#38). CANCELLED is deliberately excluded — a
 * cancelled check is a spot kill / queue ejection side effect, not a verdict.
 */
export const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);

/** Minimum distinct (sha, attempt) samples before a flake rate is meaningful —
 *  shared by the metrics flakiness leaderboard and the live likelyFlake flag. */
export const FLAKE_MIN_RUNS = 5;

/** Per-(check, event) flake statistics over a window (issue #37). */
export interface FlakeStat {
  name: string; event: string;
  /** Failing-class samples later resolved by a SUCCESS on the SAME head sha. */
  flakeEvents: number;
  /** Distinct (head_sha, run_attempt) samples observed (the rate denominator). */
  totalRuns: number;
  flakeRatePct: number;
  /** completed_at of each flake event's failing sample (trend bucketing). */
  flakeAts: string[];
  /** completed_at of one sample per distinct run (trend bucketing). */
  runAts: string[];
}

/** One recorded merge-group culprit: (repo, group sha, check) — issue #38. */
export interface GroupFailureRow {
  repo: string; checkName: string; groupSha: string; at: string;
  /** The failing check's GHA conclusion (FAILURE/TIMED_OUT/STARTUP_FAILURE), for
   *  the eject-reason taxonomy. Null on rows recorded before the column existed. */
  conclusion: string | null;
}

/** One active flake-quarantine (roadmap 4.5). `until` is the auto-unquarantine
 *  expiry (ISO); a row is active only while now < until. */
export interface QuarantineRow {
  repo: string; checkName: string; until: string; reason: string | null; createdAt: string;
}

/** One completed merge_group check (queue-efficiency panel, #23). */
export interface MergeGroupCheckRow {
  repo: string; checkName: string; conclusion: string;
  headSha: string | null; runNumber: number | null; completedAt: string;
}

/** One imported actual-spend row (cost explorer phase 2): `scope` is 'fleet'
 *  or a single pool label; `date` is the bill's YYYY-MM-DD day. */
export interface CostActualRow {
  scope: string; date: string; dollars: number; source: string | null;
}

/** A ground-truth pool observation (jobs-API feature): the resolved pool key +
 *  github-hosted flag for one (repo, canonical check_name, event). */
export interface ObservedPool { pool: string; githubHosted: boolean; }
export interface ObservedPoolRow extends ObservedPool {
  repo: string; checkName: string; event: string; lastSeen: string;
}

/**
 * `ALTER TABLE … ADD COLUMN` that tolerates exactly one failure mode: the
 * column already existing (idempotent re-open of a migrated DB). Any other
 * SQLite error (missing table, I/O, locked DB) is rethrown — swallowing it
 * would resurface later as a confusing prepare-time error far from the cause.
 */
export function addColumnIfMissing(db: Database.Database, table: string, columnDef: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/duplicate column name/i.test(msg)) throw e;
  }
}

/**
 * ETA-accuracy flap guard (issue #54): minimum actual stage duration before a
 * predicted-vs-actual sample is scored. Stage flaps (classification bouncing
 * ci→ready→ci within one poll cycle) score a full multi-hour first ETA against
 * a seconds-long actual, poisoning calibration (live: predicted=8534s,
 * actual=8.3s ×8 → KinDash ci medianErrorPct −99.6%). A sample only counts when
 * actual ≥ max(60s, 5% of predicted) — the 60s floor drops one-poll-cycle
 * artifacts, the 5% term scales the bar up for hours-long predictions.
 * Trade-off: stages that genuinely complete in under 60s are never scored;
 * acceptable because every ETA-tracked stage (ci/queue/qa-deploy) runs
 * minutes-to-hours in practice.
 */
export const ETA_ACCURACY_MIN_ACTUAL_SECS = 60;
export const ETA_ACCURACY_MIN_ACTUAL_FRACTION = 0.05;

// Duration-sample recency (issue #36). `expected()`/`samples()` pull the last 20
// SUCCESS samples; without a freshness bound a regime change (e.g. an ARC
// cutover) takes 20 runs PER JOB to wash out, and the denominator set already
// has a 14-day window — an asymmetry. Fix: prefer samples within
// DURATION_FRESH_DAYS of the job's OWN newest sample (age-based washout, ~14d
// not 20 runs), measured relative-to-newest so a dormant-but-valid job is never
// blinded. Fall back to the last DURATION_FALLBACK_LIMIT any-age when fewer than
// DURATION_FRESH_MIN are fresh, so a rarely-run job still gets an estimate.
export const DURATION_FRESH_DAYS = 14;
export const DURATION_FRESH_MIN = 5;
export const DURATION_FALLBACK_LIMIT = 10;

/** Minimum spacing between state samples for one repo (recordStateSample throttle). */
const STATE_SAMPLE_MIN_MS = 15 * 60_000;
/** State samples older than this are pruned whenever a new sample lands. */
const STATE_SAMPLE_RETENTION_MS = 90 * 86400_000;

export class HistoryStore {
  private db: Database.Database;

  // ── Prepared statements (cached for performance) ──────────────────────────
  private readonly stmtInsertDuration: Database.Statement;
  private readonly stmtSelectDurations: Database.Statement;
  private readonly stmtSelectDurationsP99: Database.Statement;
  private readonly stmtSelectExpectedSet: Database.Statement;
  private readonly stmtSelectMergeGroupChecks: Database.Statement;
  private readonly stmtInsertConfigChange: Database.Statement;
  private readonly stmtSelectConfigChangesSince: Database.Statement;
  private readonly stmtLatestConfigValues: Database.Statement;
  private readonly stmtUpsertQuarantine: Database.Statement;
  private readonly stmtSelectActiveQuarantines: Database.Statement;
  private readonly stmtUpsertPr: Database.Statement;
  private readonly stmtMarkQaLive: Database.Statement;
  private readonly stmtMarkProdLive: Database.Statement;
  private readonly stmtListTracked: Database.Statement;
  private readonly stmtInsertGap: Database.Statement;
  private readonly stmtSelectGaps: Database.Statement;
  private readonly stmtInsertGroupRun: Database.Statement;
  private readonly stmtSelectGroupRuns: Database.Statement;
  private readonly stmtInsertQueueWait: Database.Statement;
  private readonly stmtSelectQueueWaits: Database.Statement;
  private readonly stmtInsertRunnerWait: Database.Statement;
  private readonly stmtSelectRunnerWaits: Database.Statement;
  private readonly stmtSelectRunnerWaitsByEvent: Database.Statement;
  private readonly stmtInsertEtaAccuracy: Database.Statement;
  private readonly stmtSelectEtaAccuracy: Database.Statement;
  private readonly stmtSelectEtaAccuracySince: Database.Statement;
  private readonly stmtSelectEtaAccuracyRecent: Database.Statement;
  private readonly stmtGetMeta: Database.Statement;
  private readonly stmtSetMeta: Database.Statement;
  private readonly stmtDeleteMeta: Database.Statement;
  private readonly stmtListMeta: Database.Statement;
  // Metrics (round 12): state sampling + windowed day-bucketed reads
  private readonly stmtInsertStateSample: Database.Statement;
  private readonly stmtLastStateSampleAt: Database.Statement;
  private readonly stmtPruneStateSamples: Database.Statement;
  private readonly stmtSelectStateSamplesSince: Database.Statement;
  private readonly stmtSelectRunnerWaitsSince: Database.Statement;
  private readonly stmtSelectDurationsSince: Database.Statement;
  private readonly stmtSelectSuccessStatsSince: Database.Statement;
  private readonly stmtSelectFailureIncidentsSince: Database.Statement;
  private readonly stmtSelectQueueWaitsSince: Database.Statement;
  private readonly stmtSelectGroupRunsSince: Database.Statement;
  private readonly stmtSelectMergedSince: Database.Statement;
  private readonly stmtSelectMergedTimestamps: Database.Statement;
  // Lead-time decomposition (issue #44)
  private readonly stmtSelectLeadTimeRows: Database.Statement;
  // Flake radar (#37) + train-killer leaderboard (#38)
  private readonly stmtSelectFlakeRows: Database.Statement;
  // Duration-regression scan (issue #41)
  private readonly stmtSelectRegressionCandidates: Database.Statement;
  private readonly stmtSelectRecentDurations: Database.Statement;
  private readonly stmtInsertGroupFailure: Database.Statement;
  private readonly stmtSelectGroupFailuresSince: Database.Statement;
  private readonly stmtCountGroupRuns: Database.Statement;
  private readonly stmtCountGroupEjects: Database.Statement;
  // Fleet telemetry (issues #45/#47): pool-keyed waits + job intervals
  private readonly stmtSelectPoolWaitsSince: Database.Statement;
  private readonly stmtSelectIntervalsSince: Database.Statement;
  // CI cost attribution (issue #43): runner-minute rows
  private readonly stmtSelectCostRows: Database.Statement;
  // Cost actuals import (cost explorer phase 2)
  private readonly stmtUpsertCostActual: Database.Statement;
  private readonly stmtSelectCostActuals: Database.Statement;
  // Ground-truth job→pool mapping (jobs-API feature)
  private readonly stmtUpsertObservedPool: Database.Statement;
  private readonly stmtSelectObservedPool: Database.Statement;
  private readonly stmtSelectObservedPoolSibling: Database.Statement;
  private readonly stmtSelectObservedPools: Database.Statement;
  // Delivery spine main lane (spec §4.1, §8.4): post-merge push:main verdicts
  private readonly stmtUpsertMainCommit: Database.Statement;
  private readonly stmtRecentMainCommits: Database.Statement;
  private readonly stmtMainSeries: Database.Statement;
  // Delivery spine scheduled lane (Spec 4): run-level cron-workflow health
  private readonly stmtUpsertScheduledRun: Database.Statement;
  private readonly stmtLatestScheduledRuns: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS check_durations (
        repo TEXT NOT NULL, check_name TEXT NOT NULL, event TEXT NOT NULL,
        duration_secs REAL NOT NULL, completed_at TEXT NOT NULL, conclusion TEXT NOT NULL,
        head_sha TEXT, run_attempt INTEGER, started_at TEXT,
        UNIQUE(repo, check_name, event, completed_at)
      );
      CREATE INDEX IF NOT EXISTS idx_durations ON check_durations(repo, check_name, event, completed_at);
      CREATE TABLE IF NOT EXISTS merged_prs (
        repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
        merged_at TEXT NOT NULL, merge_commit_sha TEXT,
        qa_live_at TEXT, prod_live_at TEXT, created_at TEXT,
        first_green_at TEXT, enqueued_at TEXT,
        PRIMARY KEY (repo, number)
      );
      CREATE TABLE IF NOT EXISTS deploy_gaps (
        repo TEXT NOT NULL, environment TEXT NOT NULL, gap_secs REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_runs (
        repo TEXT NOT NULL, duration_secs REAL NOT NULL, completed_at TEXT NOT NULL,
        UNIQUE(repo, completed_at)
      );
      CREATE TABLE IF NOT EXISTS queue_waits (
        repo TEXT NOT NULL, wait_secs REAL NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_waits (
        repo TEXT NOT NULL, check_name TEXT NOT NULL, event TEXT NOT NULL,
        wait_secs REAL NOT NULL, started_at TEXT NOT NULL, pool TEXT,
        UNIQUE(repo, check_name, event, started_at)
      );
      CREATE INDEX IF NOT EXISTS idx_runner_waits ON runner_waits(repo, check_name, event, started_at);
      CREATE TABLE IF NOT EXISTS eta_accuracy (
        repo TEXT NOT NULL, stage TEXT NOT NULL,
        predicted_secs REAL NOT NULL, actual_secs REAL NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state_samples (
        repo TEXT NOT NULL, sampled_at TEXT NOT NULL,
        open_count INT NOT NULL, ci_count INT NOT NULL,
        queue_count INT NOT NULL, failed_count INT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_samples ON state_samples(repo, sampled_at);
      -- Metrics windowed reads filter on the time column alone; idx_durations /
      -- idx_runner_waits are prefixed by repo+name+event and can't serve them.
      CREATE INDEX IF NOT EXISTS idx_durations_completed ON check_durations(completed_at);
      CREATE INDEX IF NOT EXISTS idx_runner_waits_started ON runner_waits(started_at);
      CREATE INDEX IF NOT EXISTS idx_eta_accuracy_observed ON eta_accuracy(observed_at);
      -- Train-killer leaderboard (issue #38): which check ejected a merge-group
      -- build. One row per (repo, group sha, check) — re-ingestion dedupes.
      CREATE TABLE IF NOT EXISTS group_failures (
        repo TEXT NOT NULL, check_name TEXT NOT NULL, group_sha TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        conclusion TEXT,
        UNIQUE(repo, group_sha, check_name)
      );
      CREATE INDEX IF NOT EXISTS idx_group_failures_observed ON group_failures(observed_at);
      -- Config-change annotations (tuning tool): one edge-triggered row when a
      -- repo's tuning knob (batch size, requiredCheckPrefixes, workflow path)
      -- changes between polls — overlaid as markers on the metric charts so a
      -- change's effect is visible. UNIQUE keeps re-detection idempotent.
      CREATE TABLE IF NOT EXISTS config_changes (
        repo TEXT NOT NULL, observed_at TEXT NOT NULL, field TEXT NOT NULL,
        old_value TEXT, new_value TEXT,
        UNIQUE(repo, observed_at, field)
      );
      CREATE INDEX IF NOT EXISTS idx_config_changes ON config_changes(observed_at);
      -- Flake-quarantine registry (roadmap 4.5): one row per quarantined check,
      -- with an until expiry that drives AUTO-unquarantine — a quarantine is
      -- active only while now < until, so the surface can flag auto-expiry and
      -- stop re-proposing it. Re-quarantine UPSERTs (extends the window).
      CREATE TABLE IF NOT EXISTS quarantines (
        repo TEXT NOT NULL, check_name TEXT NOT NULL,
        until TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (repo, check_name)
      );
      CREATE INDEX IF NOT EXISTS idx_quarantines_until ON quarantines(until);
      -- Cost actuals import (cost explorer phase 2): operator-pushed ACTUAL
      -- daily spend per scope ('fleet', or a single pool label) — deliberately
      -- provider-agnostic: anything that can curl POST /api/cost/actuals can
      -- feed it (AWS Cost Explorer cron, a spreadsheet export, …).
      -- UNIQUE(scope, date) makes re-imports idempotent upserts.
      CREATE TABLE IF NOT EXISTS cost_actuals (
        scope TEXT NOT NULL, date TEXT NOT NULL, dollars REAL NOT NULL, source TEXT,
        UNIQUE(scope, date)
      );
      -- Ground-truth job→pool mapping (jobs-API feature): the resolved pool key
      -- + github-hosted flag for one (repo, canonical check_name, event),
      -- learned from the Jobs REST API. check_name is stored CANONICAL
      -- (matrix-collapsed) so it joins against the canonical names everything
      -- else uses. github_hosted is 0/1. last_seen refreshes on every
      -- re-observation. UNIQUE(repo, check_name, event) makes it an upsert.
      CREATE TABLE IF NOT EXISTS observed_pools (
        repo TEXT NOT NULL, check_name TEXT NOT NULL, event TEXT NOT NULL,
        pool TEXT NOT NULL, github_hosted INTEGER NOT NULL, last_seen TEXT NOT NULL,
        UNIQUE(repo, check_name, event)
      );
      -- Idempotency ledger for check-name aliases (.pr-dashboard.yml aliases):
      -- once an (repo, old -> new) rename has been folded into the history
      -- tables, it is recorded here so re-running the migration each config load
      -- is a cheap no-op. UNIQUE makes the marker insert itself idempotent.
      CREATE TABLE IF NOT EXISTS applied_aliases (
        repo TEXT NOT NULL, old_name TEXT NOT NULL, new_name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        UNIQUE(repo, old_name, new_name)
      );
      -- Delivery spine main lane (spec §4.1, §8.4): the post-merge push:main CI
      -- verdict per main commit. One row per (repo, commit_sha); re-recording a
      -- commit upserts its conclusion as the push:main run progresses (null →
      -- SUCCESS/FAILURE). e2e_* columns are reserved for the later e2e lane.
      CREATE TABLE IF NOT EXISTS main_commits (
        repo TEXT NOT NULL, commit_sha TEXT NOT NULL,
        merged_at TEXT, run_number INTEGER,
        push_ci_conclusion TEXT, push_ci_completed_at TEXT,
        e2e_conclusion TEXT, e2e_completed_at TEXT,
        observed_at TEXT NOT NULL,
        UNIQUE(repo, commit_sha)
      );
      CREATE INDEX IF NOT EXISTS idx_main_commits ON main_commits(repo, merged_at);
      -- Delivery spine scheduled lane (Spec 4): run-level health of a repo's
      -- cron-scheduled workflows (nightly/weekly/audit-*). Kept in its OWN table
      -- so nightly cold-pod durations never pollute the estimator's
      -- check_durations medians. UNIQUE(repo, workflow, run_id, run_attempt)
      -- makes a re-poll of the same run an idempotent upsert (null → conclusion).
      -- Per-job drill-down + missed-run detection are DEFERRED (run-level only).
      CREATE TABLE IF NOT EXISTS scheduled_runs (
        repo TEXT NOT NULL, workflow TEXT NOT NULL, run_id INTEGER NOT NULL, run_attempt INTEGER NOT NULL,
        run_number INTEGER, conclusion TEXT, status TEXT, created_at TEXT, html_url TEXT,
        observed_at TEXT NOT NULL,
        UNIQUE(repo, workflow, run_id, run_attempt)
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_runs ON scheduled_runs(repo, workflow, created_at);
    `);

    // Migration: merged_prs gains created_at (PR lifespan metric). Fresh DBs get
    // the column from CREATE TABLE above; pre-existing DBs get it from this ALTER
    // (duplicate-column tolerated, everything else rethrown).
    addColumnIfMissing(this.db, 'merged_prs', 'created_at TEXT');
    // Migration (issue #44): merged_prs gains first_green_at + enqueued_at —
    // the lead-time decomposition's two new waypoints. Old rows stay null
    // (segments are computed per-pair over rows that have both ends).
    addColumnIfMissing(this.db, 'merged_prs', 'first_green_at TEXT');
    addColumnIfMissing(this.db, 'merged_prs', 'enqueued_at TEXT');
    // Migration (issue #23): merged_prs gains merged_by — the GitHub login that
    // merged the PR, for the admin-bypass rate. Old rows stay null and are
    // excluded from the ratio (it ramps up as new merges are observed).
    addColumnIfMissing(this.db, 'merged_prs', 'merged_by TEXT');
    // Migration (issue #34): check_durations gains head_sha + run_attempt —
    // shared plumbing for flake radar / spot-reclaim ledger / attempt
    // waterfalls. Both nullable; the UNIQUE constraint is unchanged.
    addColumnIfMissing(this.db, 'check_durations', 'head_sha TEXT');
    addColumnIfMissing(this.db, 'check_durations', 'run_attempt INTEGER');
    // Migration (issue #47): check_durations gains started_at — exact job
    // intervals for the concurrency demand curve. Old rows stay NULL; reads
    // derive started = completed − duration (identical for non-clamped rows).
    addColumnIfMissing(this.db, 'check_durations', 'started_at TEXT');
    // Migration (cost explorer): check_durations gains run_number — the
    // workflow-run number the check belonged to, so the cost explorer can
    // group runner-minutes into whole workflow runs (event, head_sha,
    // run_number). NULL on rows ingested before the column existed — those
    // rows can't participate in the per-run grouping (per-job is unaffected).
    addColumnIfMissing(this.db, 'check_durations', 'run_number INTEGER');
    // Migration (issue #45): runner_waits gains pool — the runs-on label
    // candidates of the job's derived-graph node at ingestion time.
    // Multi-candidate pools (runs-on ternaries) store the JOINED candidates
    // string ('a|b') — one composite pool key, since the actually-chosen label
    // is unknowable from the GraphQL rollup. NULL when unknown (no derived
    // graph, unmatched name, reusable workflow without an outer label input,
    // or rows persisted before #45).
    addColumnIfMissing(this.db, 'runner_waits', 'pool TEXT');
    // Migration (roadmap 4.4b): group_failures gains conclusion — the failing
    // check's GHA conclusion, so the train-killer leaderboard can classify each
    // eject's reason (timeout/test-fail/infra → remedy). NULL on rows recorded
    // before the column existed; those count as 'unknown' reason.
    addColumnIfMissing(this.db, 'group_failures', 'conclusion TEXT');

    // Prepare all statements after schema is guaranteed to exist.
    this.stmtInsertDuration = this.db.prepare(
      'INSERT OR IGNORE INTO check_durations (repo, check_name, event, duration_secs, completed_at, conclusion, head_sha, run_attempt, started_at, run_number) VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    this.stmtSelectDurations = this.db.prepare(
      `SELECT duration_secs, completed_at FROM check_durations
       WHERE repo=? AND check_name=? AND event=? AND conclusion='SUCCESS'
       ORDER BY completed_at DESC LIMIT 20`
    );
    // Timeout lint (issue #48): p99 wants a wider sample window than the
    // expected-duration p50/p90 (LIMIT 20) — tails need more history.
    this.stmtSelectDurationsP99 = this.db.prepare(
      `SELECT duration_secs FROM check_durations
       WHERE repo=? AND check_name=? AND event=? AND conclusion='SUCCESS'
       ORDER BY completed_at DESC LIMIT 50`
    );
    this.stmtSelectExpectedSet = this.db.prepare(
      `SELECT DISTINCT check_name FROM check_durations
       WHERE repo=? AND event=? AND conclusion='SUCCESS' AND completed_at >= ?`
    );
    // Queue-efficiency panel (issue #23): every completed merge_group check in a
    // window — run-counting (distinct head_sha/run_number) + the run-level vs
    // required-gate conclusion split.
    this.stmtSelectMergeGroupChecks = this.db.prepare(
      `SELECT repo, check_name, conclusion, head_sha, run_number, completed_at
       FROM check_durations
       WHERE event='merge_group' AND completed_at >= ? ORDER BY completed_at`
    );
    this.stmtInsertConfigChange = this.db.prepare(
      'INSERT OR IGNORE INTO config_changes (repo, observed_at, field, old_value, new_value) VALUES (?,?,?,?,?)'
    );
    this.stmtSelectConfigChangesSince = this.db.prepare(
      `SELECT repo, observed_at AS at, field, old_value, new_value
       FROM config_changes WHERE observed_at >= ? ORDER BY repo, observed_at`
    );
    // Flake-quarantine registry (roadmap 4.5). UPSERT extends an existing
    // quarantine's window; active reads filter on until > now (auto-unquarantine).
    this.stmtUpsertQuarantine = this.db.prepare(
      `INSERT INTO quarantines (repo, check_name, until, reason, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(repo, check_name) DO UPDATE SET until=excluded.until, reason=excluded.reason`
    );
    this.stmtSelectActiveQuarantines = this.db.prepare(
      `SELECT repo, check_name, until, reason, created_at FROM quarantines
       WHERE until > ? AND (? = '' OR repo = ?) ORDER BY repo, check_name`
    );
    // Latest new_value per (repo, field) — seeds the poller's in-memory baseline
    // on restart so the first cycle doesn't re-emit unchanged config as a change.
    this.stmtLatestConfigValues = this.db.prepare(
      `SELECT repo, field, new_value FROM config_changes
       WHERE observed_at = (SELECT MAX(observed_at) FROM config_changes c2
         WHERE c2.repo = config_changes.repo AND c2.field = config_changes.field)`
    );
    this.stmtUpsertPr = this.db.prepare(
      `INSERT INTO merged_prs (repo, number, title, url, merged_at, merge_commit_sha, created_at,
         first_green_at, enqueued_at, merged_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repo, number) DO UPDATE SET title=excluded.title,
         merge_commit_sha=COALESCE(excluded.merge_commit_sha, merge_commit_sha),
         created_at=COALESCE(excluded.created_at, created_at),
         first_green_at=COALESCE(excluded.first_green_at, first_green_at),
         enqueued_at=COALESCE(excluded.enqueued_at, enqueued_at),
         merged_by=COALESCE(excluded.merged_by, merged_by)`
    );
    // Two separate statements — SQLite prepared statements cannot switch column names dynamically.
    this.stmtMarkQaLive = this.db.prepare(
      'UPDATE merged_prs SET qa_live_at=? WHERE repo=? AND number=? AND qa_live_at IS NULL'
    );
    this.stmtMarkProdLive = this.db.prepare(
      'UPDATE merged_prs SET prod_live_at=? WHERE repo=? AND number=? AND prod_live_at IS NULL'
    );
    this.stmtListTracked = this.db.prepare(
      'SELECT * FROM merged_prs WHERE merged_at >= ? ORDER BY merged_at DESC'
    );
    this.stmtInsertGap = this.db.prepare(
      'INSERT INTO deploy_gaps (repo, environment, gap_secs) VALUES (?,?,?)'
    );
    this.stmtSelectGaps = this.db.prepare(
      'SELECT gap_secs FROM deploy_gaps WHERE repo=? AND environment=? ORDER BY rowid DESC LIMIT 20'
    );
    this.stmtInsertGroupRun = this.db.prepare(
      'INSERT OR IGNORE INTO group_runs (repo, duration_secs, completed_at) VALUES (?,?,?)'
    );
    this.stmtSelectGroupRuns = this.db.prepare(
      'SELECT duration_secs FROM group_runs WHERE repo=? ORDER BY completed_at DESC LIMIT 20'
    );
    this.stmtCountGroupRuns = this.db.prepare(
      'SELECT COUNT(*) AS n FROM group_runs WHERE repo=? AND completed_at >= ?'
    );
    this.stmtCountGroupEjects = this.db.prepare(
      'SELECT COUNT(DISTINCT group_sha) AS n FROM group_failures WHERE repo=? AND observed_at >= ?'
    );
    this.stmtInsertQueueWait = this.db.prepare(
      'INSERT INTO queue_waits (repo, wait_secs, observed_at) VALUES (?,?,?)'
    );
    this.stmtSelectQueueWaits = this.db.prepare(
      'SELECT wait_secs FROM queue_waits WHERE repo=? ORDER BY rowid DESC LIMIT 20'
    );
    this.stmtInsertRunnerWait = this.db.prepare(
      'INSERT OR IGNORE INTO runner_waits (repo, check_name, event, wait_secs, started_at, pool) VALUES (?,?,?,?,?,?)'
    );
    this.stmtSelectRunnerWaits = this.db.prepare(
      `SELECT wait_secs FROM runner_waits
       WHERE repo=? AND check_name=? AND event=?
       ORDER BY started_at DESC LIMIT 20`
    );
    this.stmtSelectRunnerWaitsByEvent = this.db.prepare(
      'SELECT wait_secs FROM runner_waits WHERE repo=? AND event=? ORDER BY started_at DESC LIMIT 50'
    );
    this.stmtInsertEtaAccuracy = this.db.prepare(
      'INSERT INTO eta_accuracy (repo, stage, predicted_secs, actual_secs, observed_at) VALUES (?,?,?,?,?)'
    );
    this.stmtSelectEtaAccuracy = this.db.prepare(
      'SELECT predicted_secs, actual_secs FROM eta_accuracy WHERE repo=? AND stage=? ORDER BY rowid DESC LIMIT 20'
    );
    this.stmtSelectEtaAccuracySince = this.db.prepare(
      `SELECT repo, stage, predicted_secs, actual_secs, observed_at AS at
       FROM eta_accuracy WHERE observed_at >= ? ORDER BY repo, stage, observed_at`
    );
    // predicted_secs > 0: predicted=0 rows are recordable but carry no usable
    // actual/predicted ratio (division by zero) — they don't count toward n.
    this.stmtSelectEtaAccuracyRecent = this.db.prepare(
      `SELECT predicted_secs, actual_secs FROM eta_accuracy
       WHERE repo=? AND stage=? AND predicted_secs > 0 ORDER BY rowid DESC LIMIT 30`
    );
    this.stmtGetMeta = this.db.prepare('SELECT value FROM meta WHERE key=?');
    this.stmtSetMeta = this.db.prepare(
      'INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );
    this.stmtDeleteMeta = this.db.prepare('DELETE FROM meta WHERE key=?');
    this.stmtListMeta = this.db.prepare(
      "SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key"
    );
    this.stmtInsertStateSample = this.db.prepare(
      `INSERT INTO state_samples (repo, sampled_at, open_count, ci_count, queue_count, failed_count)
       VALUES (?,?,?,?,?,?)`
    );
    this.stmtLastStateSampleAt = this.db.prepare(
      'SELECT MAX(sampled_at) AS at FROM state_samples WHERE repo=?'
    );
    this.stmtPruneStateSamples = this.db.prepare(
      'DELETE FROM state_samples WHERE sampled_at < ?'
    );
    this.stmtSelectStateSamplesSince = this.db.prepare(
      `SELECT repo, sampled_at, open_count, ci_count, queue_count, failed_count
       FROM state_samples WHERE sampled_at >= ? ORDER BY repo, sampled_at`
    );
    this.stmtSelectRunnerWaitsSince = this.db.prepare(
      `SELECT repo, event, started_at AS at, wait_secs
       FROM runner_waits WHERE started_at >= ? ORDER BY repo, event, started_at`
    );
    this.stmtSelectDurationsSince = this.db.prepare(
      `SELECT repo, check_name, event, completed_at AS at, duration_secs
       FROM check_durations WHERE conclusion='SUCCESS' AND completed_at >= ?
       ORDER BY repo, check_name, event, completed_at`
    );
    this.stmtSelectQueueWaitsSince = this.db.prepare(
      `SELECT repo, observed_at AS at, wait_secs
       FROM queue_waits WHERE observed_at >= ? ORDER BY repo, observed_at`
    );
    this.stmtSelectGroupRunsSince = this.db.prepare(
      `SELECT repo, completed_at AS at, duration_secs
       FROM group_runs WHERE completed_at >= ? ORDER BY repo, completed_at`
    );
    this.stmtSelectMergedSince = this.db.prepare(
      `SELECT repo, merged_at, created_at, qa_live_at, merged_by, enqueued_at
       FROM merged_prs WHERE merged_at >= ? ORDER BY repo, merged_at`
    );
    // Trains/hour (queue ops): per-repo merge timestamps for train clustering.
    this.stmtSelectMergedTimestamps = this.db.prepare(
      'SELECT merged_at FROM merged_prs WHERE repo=? AND merged_at >= ? ORDER BY merged_at'
    );
    // Lead-time decomposition (issue #44): rows merged in-window (segment
    // medians) PLUS rows that went prod-live in-window even if merged earlier
    // (deployment frequency counts prod-live EVENTS, and manual prod deploys
    // often ship merges older than the window).
    this.stmtSelectLeadTimeRows = this.db.prepare(
      `SELECT repo, created_at, first_green_at, enqueued_at, merged_at, qa_live_at, prod_live_at
       FROM merged_prs WHERE merged_at >= ? OR (prod_live_at IS NOT NULL AND prod_live_at >= ?)
       ORDER BY repo, merged_at`
    );
    // Flake detection (#37) needs every conclusion (not just SUCCESS) plus the
    // sha/attempt identity; rows without head_sha (pre-#34) can't participate.
    this.stmtSelectFlakeRows = this.db.prepare(
      `SELECT repo, check_name, event, head_sha, run_attempt, completed_at, conclusion
       FROM check_durations
       WHERE completed_at >= ? AND head_sha IS NOT NULL
       ORDER BY repo, check_name, event, completed_at`
    );
    // Demotion candidates (#almost-always-green): per (repo, check, event)
    // success aggregate over the window. Counts DISTINCT (sha, attempt) runs so a
    // re-poll never double-counts and a fail-then-pass flake shows its failing
    // attempt (→ below 100%, excluded). CANCELLED excluded (a spot-kill is not a
    // failure — same rule as flake detection). FAILING_CONCLUSIONS inlined here.
    this.stmtSelectSuccessStatsSince = this.db.prepare(
      `SELECT repo, check_name AS name, event,
              COUNT(DISTINCT head_sha || '@' || IFNULL(run_attempt, 'x')) AS total,
              COUNT(DISTINCT CASE WHEN conclusion IN ('FAILURE','TIMED_OUT','STARTUP_FAILURE')
                    THEN head_sha || '@' || IFNULL(run_attempt, 'x') END) AS failing,
              SUM(duration_secs) AS sum_secs
       FROM check_durations
       WHERE completed_at >= ? AND head_sha IS NOT NULL AND conclusion != 'CANCELLED'
       GROUP BY repo, check_name, event`
    );
    // Real-failure INCIDENTS per (repo, check, event) over the window (#150.3):
    // collapse a stretch of CONSECUTIVE real-failing shas (one root cause, fixed on
    // a later sha) into one incident, so a week-long red doesn't read as N separate
    // failures. A sha is a real failure if it failed and never SUCCEEDED on that sha
    // (same same-sha-resolved-flake exclusion as realFailures). Counts a new
    // incident at each non-failing→failing transition in time order.
    this.stmtSelectFailureIncidentsSince = this.db.prepare(
      `WITH sv AS (
         SELECT repo, check_name, event, head_sha,
                MAX(CASE WHEN conclusion IN ('FAILURE','TIMED_OUT','STARTUP_FAILURE') THEN 1 ELSE 0 END) AS any_fail,
                MAX(CASE WHEN conclusion = 'SUCCESS' THEN 1 ELSE 0 END) AS any_succ,
                MIN(completed_at) AS first_at
         FROM check_durations
         WHERE completed_at >= ? AND head_sha IS NOT NULL AND conclusion != 'CANCELLED'
         GROUP BY repo, check_name, event, head_sha
       ),
       r AS (SELECT repo, check_name, event, first_at,
                    CASE WHEN any_fail = 1 AND any_succ = 0 THEN 1 ELSE 0 END AS rf FROM sv),
       s AS (SELECT repo, check_name, event, rf,
                    LAG(rf, 1, 0) OVER (PARTITION BY repo, check_name, event ORDER BY first_at) AS prf FROM r)
       SELECT repo, check_name AS name, event,
              SUM(CASE WHEN rf = 1 AND prf = 0 THEN 1 ELSE 0 END) AS incidents
       FROM s GROUP BY repo, check_name, event`
    );
    this.stmtInsertGroupFailure = this.db.prepare(
      'INSERT OR IGNORE INTO group_failures (repo, check_name, group_sha, observed_at, conclusion) VALUES (?,?,?,?,?)'
    );
    this.stmtSelectGroupFailuresSince = this.db.prepare(
      `SELECT repo, check_name, group_sha, observed_at AS at, conclusion
       FROM group_failures WHERE observed_at >= ? ORDER BY repo, check_name, observed_at`
    );
    // Duration-regression scan (issue #41): one whole-DB pass enumerates the
    // (repo, check, event) series deep enough for the step test; the per-series
    // read then pulls the newest samples WITH timestamps (sinceApprox needs them).
    this.stmtSelectRegressionCandidates = this.db.prepare(
      `SELECT repo, check_name, event, MAX(completed_at) AS newest_at
       FROM check_durations WHERE conclusion='SUCCESS'
       GROUP BY repo, check_name, event HAVING COUNT(*) >= ?
       ORDER BY repo, check_name, event`
    );
    this.stmtSelectRecentDurations = this.db.prepare(
      `SELECT duration_secs, completed_at FROM check_durations
       WHERE repo=? AND check_name=? AND event=? AND conclusion='SUCCESS'
       ORDER BY completed_at DESC LIMIT ?`
    );
    // Pool telemetry (issue #45): only rows WITH a pool label participate —
    // pre-#45 history and unmappable jobs carry NULL and would otherwise read
    // as a phantom pool.
    this.stmtSelectPoolWaitsSince = this.db.prepare(
      `SELECT repo, pool, started_at AS at, wait_secs
       FROM runner_waits WHERE started_at >= ? AND pool IS NOT NULL
       ORDER BY repo, pool, started_at`
    );
    // Concurrency sweep (issue #47): every conclusion counts — a CANCELLED or
    // FAILED job occupied a runner for its whole span just the same.
    this.stmtSelectIntervalsSince = this.db.prepare(
      `SELECT repo, check_name, event, started_at, completed_at, duration_secs
       FROM check_durations WHERE completed_at >= ?
       ORDER BY repo, completed_at`
    );
    // Cost attribution (issue #43): every conclusion counts — a failed or
    // cancelled job occupied its runner for the whole span just the same.
    this.stmtSelectCostRows = this.db.prepare(
      `SELECT repo, check_name, event, head_sha, run_number, started_at, completed_at,
              duration_secs, run_attempt
       FROM check_durations WHERE completed_at >= ?
       ORDER BY repo, completed_at`
    );
    this.stmtUpsertCostActual = this.db.prepare(
      `INSERT INTO cost_actuals (scope, date, dollars, source) VALUES (?,?,?,?)
       ON CONFLICT(scope, date) DO UPDATE SET dollars=excluded.dollars, source=excluded.source`
    );
    this.stmtSelectCostActuals = this.db.prepare(
      'SELECT scope, date, dollars, source FROM cost_actuals WHERE date >= ? ORDER BY scope, date'
    );
    this.stmtUpsertObservedPool = this.db.prepare(
      `INSERT INTO observed_pools (repo, check_name, event, pool, github_hosted, last_seen)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(repo, check_name, event) DO UPDATE SET
         pool=excluded.pool, github_hosted=excluded.github_hosted, last_seen=excluded.last_seen`
    );
    this.stmtSelectObservedPool = this.db.prepare(
      'SELECT pool, github_hosted FROM observed_pools WHERE repo=? AND check_name=? AND event=?'
    );
    // Sibling lookup: a non-merge_group event borrowing another non-merge_group
    // event's pool (push ↔ pull_request always hit the same runs-on branch;
    // only merge_group can differ via a runs-on ternary). Newest first.
    this.stmtSelectObservedPoolSibling = this.db.prepare(
      `SELECT pool, github_hosted FROM observed_pools
       WHERE repo=? AND check_name=? AND event != 'merge_group'
       ORDER BY last_seen DESC LIMIT 1`
    );
    this.stmtSelectObservedPools = this.db.prepare(
      'SELECT repo, check_name, event, pool, github_hosted, last_seen FROM observed_pools'
    );
    this.stmtUpsertMainCommit = this.db.prepare(
      `INSERT INTO main_commits (repo, commit_sha, merged_at, push_ci_conclusion, push_ci_completed_at, observed_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(repo, commit_sha) DO UPDATE SET
         merged_at=excluded.merged_at,
         push_ci_conclusion=excluded.push_ci_conclusion,
         push_ci_completed_at=excluded.push_ci_completed_at,
         observed_at=excluded.observed_at`);
    this.stmtRecentMainCommits = this.db.prepare(
      `SELECT commit_sha, merged_at, push_ci_conclusion, push_ci_completed_at
       FROM main_commits WHERE repo=? AND COALESCE(merged_at, observed_at) >= ?
       ORDER BY COALESCE(merged_at, observed_at) DESC LIMIT 20`);
    this.stmtMainSeries = this.db.prepare(
      `SELECT commit_sha, push_ci_conclusion, COALESCE(merged_at, observed_at) AS at
       FROM main_commits WHERE repo=? AND COALESCE(merged_at, observed_at) >= ?
       ORDER BY COALESCE(merged_at, observed_at) DESC LIMIT 20`);
    this.stmtUpsertScheduledRun = this.db.prepare(
      `INSERT INTO scheduled_runs
         (repo, workflow, run_id, run_attempt, run_number, conclusion, status, created_at, html_url, observed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repo, workflow, run_id, run_attempt) DO UPDATE SET
         run_number=excluded.run_number,
         conclusion=excluded.conclusion,
         status=excluded.status,
         created_at=excluded.created_at,
         html_url=excluded.html_url,
         observed_at=excluded.observed_at`);
    // Newest run per workflow within the window: rank by created_at DESC,
    // run_attempt DESC (a re-run attempt supersedes its earlier attempt) and
    // keep rank 1. created_at is ISO-8601 so a lexical MAX is chronological.
    this.stmtLatestScheduledRuns = this.db.prepare(
      `SELECT workflow, conclusion, status, created_at, html_url
       FROM scheduled_runs s
       WHERE repo=? AND created_at >= ?
         AND NOT EXISTS (
           SELECT 1 FROM scheduled_runs t
           WHERE t.repo=s.repo AND t.workflow=s.workflow AND t.created_at >= ?
             AND (t.created_at > s.created_at
               OR (t.created_at = s.created_at AND t.run_attempt > s.run_attempt))
         )
       ORDER BY workflow`);
  }

  /** `headSha`/`runAttempt` (issue #34): the PR/group head commit the check ran
   *  against and the workflow-run attempt; both nullable ('' sha — placeholder
   *  snapshots — normalizes to NULL). `runNumber` (cost explorer): the
   *  workflow-run number — the per-run cost grouping key; nullable for old
   *  callers/data. On a UNIQUE collision the first row wins (INSERT OR
   *  IGNORE), exactly as before. */
  recordCheckDuration(repo: string, name: string, event: string,
    startedAt: string | null, completedAt: string | null, conclusion: string,
    headSha: string | null = null, runAttempt: number | null = null,
    runNumber: number | null = null): boolean {
    if (!startedAt || !completedAt) return false;
    const secs = (Date.parse(completedAt) - Date.parse(startedAt)) / 1000;
    if (!(secs > 0)) return false; // rejects negative durations (SKIPPED placeholders) and NaN
    // started_at persisted verbatim (issue #47): exact job intervals for the
    // concurrency sweep — pre-#47 rows derive it as completed − duration.
    this.stmtInsertDuration.run(repo, name, event, secs, completedAt, conclusion,
      headSha || null, runAttempt ?? null, startedAt, runNumber ?? null);
    return true;
  }

  /**
   * Fold check-name renames into the learned history so a renamed check keeps
   * its ETA / pool / runner-wait / flake history instead of cold-starting.
   * `aliases` maps `oldCanonicalName -> newCanonicalName` (from a repo's
   * `.pr-dashboard.yml`). Each pair is applied at most once (tracked in
   * `applied_aliases`), so calling this every config load is a cheap no-op.
   *
   * The four `check_name`-keyed tables split by their UNIQUE shape:
   *  - APPEND tables (`check_durations`, `runner_waits`) include a timestamp in
   *    the key, so a rename can never collide — a plain UPDATE moves every row.
   *  - UPSERT tables (`observed_pools`, `group_failures`) are keyed on the name
   *    itself; if the new name already learned a row, UPDATE would violate the
   *    constraint — so UPDATE OR IGNORE moves what it can, then the stranded old
   *    rows are deleted (the surviving new-name row is the fresher truth).
   * (`eta_accuracy` is keyed by stage, not check_name — unaffected by renames.)
   *
   * Returns the number of (old -> new) pairs newly applied this call.
   */
  applyCheckAliases(repo: string, aliases: Record<string, string> | undefined): number {
    if (!aliases) return 0;
    const already = new Set(
      (this.db.prepare('SELECT old_name, new_name FROM applied_aliases WHERE repo = ?').all(repo) as {
        old_name: string; new_name: string;
      }[]).map((r) => `${r.old_name}\x00${r.new_name}`),
    );
    const pending = Object.entries(aliases).filter(([from, to]) => !already.has(`${from}\x00${to}`));
    if (!pending.length) return 0;

    const move = this.db.transaction((pairs: [string, string][]) => {
      const appendTables = ['check_durations', 'runner_waits'];
      const upsertTables = ['observed_pools', 'group_failures'];
      const markStmt = this.db.prepare(
        'INSERT OR IGNORE INTO applied_aliases (repo, old_name, new_name, applied_at) VALUES (?,?,?,?)',
      );
      const now = new Date().toISOString();
      for (const [from, to] of pairs) {
        for (const t of appendTables) {
          this.db.prepare(`UPDATE ${t} SET check_name = ? WHERE repo = ? AND check_name = ?`).run(to, repo, from);
        }
        for (const t of upsertTables) {
          this.db.prepare(`UPDATE OR IGNORE ${t} SET check_name = ? WHERE repo = ? AND check_name = ?`).run(to, repo, from);
          this.db.prepare(`DELETE FROM ${t} WHERE repo = ? AND check_name = ?`).run(repo, from);
        }
        markStmt.run(repo, from, to, now);
      }
    });
    move(pending as [string, string][]);
    return pending.length;
  }

  /** Last-20 SUCCESS durations for (repo, check, event), recency-filtered (issue
   *  #36), newest first. Prefers samples within DURATION_FRESH_DAYS of the job's
   *  OWN newest sample so a regime change washes out by age (~14d) not by count
   *  (20 runs); falls back to the last DURATION_FALLBACK_LIMIT any-age when too
   *  few are fresh, so a rarely-run job is never blinded. */
  private recentDurations(repo: string, name: string, event: string): number[] {
    const rows = this.stmtSelectDurations.all(repo, name, event) as
      { duration_secs: number; completed_at: string }[];
    if (rows.length === 0) return [];
    const cutoff = Date.parse(rows[0]!.completed_at) - DURATION_FRESH_DAYS * 86400_000;
    const fresh = rows.filter((r) => Date.parse(r.completed_at) >= cutoff);
    const chosen = fresh.length >= DURATION_FRESH_MIN ? fresh : rows.slice(0, DURATION_FALLBACK_LIMIT);
    return chosen.map((r) => r.duration_secs);
  }

  expected(repo: string, name: string, event: string): Expected | null {
    const vals = this.recentDurations(repo, name, event);
    if (vals.length === 0) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    return {
      p10: percentile(sorted, 0.1), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9),
      n: sorted.length,
    };
  }

  /** p99 duration over the last 50 SUCCESS samples for (repo, check, event) —
   *  the observed-tail side of the timeout-calibration lint (issue #48).
   *  Null when no samples; `n` lets callers gate on sample depth. */
  durationP99(repo: string, name: string, event: string): { p99Secs: number; n: number } | null {
    const rows = this.stmtSelectDurationsP99.all(repo, name, event) as { duration_secs: number }[];
    if (rows.length === 0) return null;
    const sorted = rows.map((r) => r.duration_secs).sort((a, b) => a - b);
    return { p99Secs: percentile(sorted, 0.99), n: sorted.length };
  }

  /** Raw recency-filtered SUCCESS duration samples for (repo, check, event),
   *  newest first (issue #36 — see recentDurations). */
  samples(repo: string, name: string, event: string): number[] {
    return this.recentDurations(repo, name, event);
  }

  expectedSet(repo: string, event: string, now: Date, windowDays = 14): string[] {
    const cutoff = new Date(now.getTime() - windowDays * 86400_000).toISOString();
    const rows = this.stmtSelectExpectedSet.all(repo, event, cutoff) as { check_name: string }[];
    return rows.map((r) => r.check_name);
  }

  upsertMergedPr(pr: MergedPrInput): void {
    this.stmtUpsertPr.run(pr.repo, pr.number, pr.title, pr.url, pr.mergedAt, pr.mergeCommitSha,
      pr.createdAt ?? null, pr.firstGreenAt ?? null, pr.enqueuedAt ?? null, pr.mergedBy ?? null);
  }

  markEnvLive(repo: string, number: number, env: 'qa' | 'prod', at: string): void {
    // Defense in depth: untyped callers must never write an unknown env column.
    if (env !== 'qa' && env !== 'prod') {
      throw new Error(`markEnvLive: env must be 'qa' or 'prod', got '${String(env)}'`);
    }
    const stmt = env === 'qa' ? this.stmtMarkQaLive : this.stmtMarkProdLive;
    stmt.run(at, repo, number);
  }

  /**
   * Returns merged PRs within the retention window, ordered newest-first.
   *
   * NOTE: rows that already have `prodLiveAt` set are included — the caller
   * (classify layer) is responsible for dropping fully-deployed entries when
   * building the dashboard view.
   */
  listTrackedMerged(retentionDays: number, now: Date): MergedPrRecord[] {
    const cutoff = new Date(now.getTime() - retentionDays * 86400_000).toISOString();
    const rows = this.stmtListTracked.all(cutoff) as Record<string, unknown>[];
    return rows.map((r) => ({
      repo: r.repo as string, number: r.number as number, title: r.title as string,
      url: r.url as string, mergedAt: r.merged_at as string,
      mergeCommitSha: (r.merge_commit_sha as string) ?? null,
      createdAt: (r.created_at as string) ?? null,
      firstGreenAt: (r.first_green_at as string) ?? null,
      enqueuedAt: (r.enqueued_at as string) ?? null,
      qaLiveAt: (r.qa_live_at as string) ?? null, prodLiveAt: (r.prod_live_at as string) ?? null,
      mergedBy: (r.merged_by as string) ?? null,
    }));
  }

  recordDeployGap(repo: string, env: string, gapSecs: number): void {
    this.stmtInsertGap.run(repo, env, gapSecs);
  }

  medianDeployGap(repo: string, env: string): number | null {
    const rows = this.stmtSelectGaps.all(repo, env) as { gap_secs: number }[];
    return rows.length ? median(rows.map((r) => r.gap_secs)) : null;
  }

  /** One-time cleanup of group_runs/group_failures rows written before the
   *  merge_group↔push:main de-conflation fix (every pre-fix row may be
   *  contaminated; 7-day retention re-accumulates clean). Idempotent via a meta
   *  flag. Returns true the first time it actually pruned. */
  pruneConflatedGroupStatsOnce(): boolean {
    if (this.getMeta('deconflation_prune_v1')) return false;
    this.db.exec('DELETE FROM group_runs; DELETE FROM group_failures;');
    this.setMeta('deconflation_prune_v1', new Date().toISOString());
    return true;
  }

  /** Observed wall-clock duration of a whole merge-group CI run. Rejects ≤0/NaN. */
  recordGroupRun(repo: string, durationSecs: number, completedAt: string): boolean {
    if (!(durationSecs > 0)) return false; // rejects ≤0 and NaN
    this.stmtInsertGroupRun.run(repo, durationSecs, completedAt);
    return true;
  }

  medianGroupRun(repo: string): number | null {
    const rows = this.stmtSelectGroupRuns.all(repo) as { duration_secs: number }[];
    return rows.length ? median(rows.map((r) => r.duration_secs)) : null;
  }

  /** Record the post-merge push:main CI verdict for one main commit (spec
   *  §4.1, §8.4). Upserts on (repo, sha): re-recording a commit overwrites its
   *  conclusion as the push:main run progresses (null → SUCCESS/FAILURE). */
  recordMainCommit(repo: string, sha: string, mergedAt: string | null,
    pushConclusion: string | null, pushCompletedAt: string | null): void {
    this.stmtUpsertMainCommit.run(repo, sha, mergedAt, pushConclusion, pushCompletedAt, new Date().toISOString());
  }

  /** Main-branch health (spec §4.1, §8.4). The scan is bounded to the retention
   *  window; a lone newest red over a green is amber (watch), two consecutive
   *  newest reds is red, a newest with no conclusion is blind (never green). */
  mainLaneHealth(repo: string, retentionDays = 7, now: Date = new Date()):
    { status: 'green' | 'amber' | 'red' | 'blind' | 'idle'; lastGreenSha: string | null } {
    const cutoff = new Date(now.getTime() - retentionDays * 86400_000).toISOString();
    const rows = this.stmtRecentMainCommits.all(repo, cutoff) as
      { commit_sha: string; push_ci_conclusion: string | null }[];
    if (rows.length === 0) return { status: 'idle', lastGreenSha: null };
    const lastGreen = rows.find((r) => r.push_ci_conclusion === 'SUCCESS')?.commit_sha ?? null;
    const fail = (c: string | null) => c != null && FAILING_CONCLUSIONS.has(c);
    const newest = rows[0];
    if (newest.push_ci_conclusion == null) return { status: 'blind', lastGreenSha: lastGreen };
    if (!fail(newest.push_ci_conclusion)) return { status: 'green', lastGreenSha: lastGreen };
    const secondRed = rows[1] != null && fail(rows[1].push_ci_conclusion);
    return { status: secondRed ? 'red' : 'amber', lastGreenSha: lastGreen };
  }

  /** Recent main-commit series for the lane's sparkline (oldest→newest), plus
   *  last-green metadata. `ok`: true=SUCCESS, false=failing, null=no conclusion. */
  mainCommitSeries(repo: string, retentionDays = 7, now: Date = new Date()):
    { points: { ok: boolean | null }[]; lastGreenSha: string | null; lastGreenAt: string | null } {
    const cutoff = new Date(now.getTime() - retentionDays * 86400_000).toISOString();
    const rows = (this.stmtMainSeries.all(repo, cutoff) as
      { commit_sha: string; push_ci_conclusion: string | null; at: string }[]);
    const lastGreenRow = rows.find((r) => r.push_ci_conclusion === 'SUCCESS') ?? null;
    const fail = (c: string | null) => c != null && FAILING_CONCLUSIONS.has(c);
    const points = rows.slice().reverse().map((r) => ({
      ok: r.push_ci_conclusion == null ? null : !fail(r.push_ci_conclusion),
    }));
    return { points, lastGreenSha: lastGreenRow?.commit_sha ?? null, lastGreenAt: lastGreenRow?.at ?? null };
  }

  /** Record one scheduled-workflow run (Delivery spine, Spec 4). Upserts on
   *  (repo, workflow, run_id, run_attempt): re-polling the same run overwrites
   *  its conclusion as the run progresses (null → SUCCESS/FAILURE). Run-level
   *  only — per-job rows are deferred. */
  recordScheduledRun(r: { repo: string; workflow: string; runId: number; runAttempt: number;
    runNumber: number | null; conclusion: string | null; status: string | null;
    createdAt: string | null; htmlUrl: string | null; observedAt: string }): void {
    this.stmtUpsertScheduledRun.run(r.repo, r.workflow, r.runId, r.runAttempt,
      r.runNumber, r.conclusion, r.status, r.createdAt, r.htmlUrl, r.observedAt);
  }

  /** Newest recorded run per scheduled workflow for a repo, within the last
   *  `sinceDays` (by run created_at). One row per workflow (Spec 4 lane status). */
  latestScheduledRuns(repo: string, sinceDays = 14, now: Date = new Date()):
    { workflow: string; conclusion: string | null; status: string | null;
      createdAt: string | null; htmlUrl: string | null }[] {
    const cutoff = new Date(now.getTime() - sinceDays * 86400_000).toISOString();
    const rows = this.stmtLatestScheduledRuns.all(repo, cutoff, cutoff) as
      { workflow: string; conclusion: string | null; status: string | null;
        created_at: string | null; html_url: string | null }[];
    return rows.map((r) => ({ workflow: r.workflow, conclusion: r.conclusion,
      status: r.status, createdAt: r.created_at, htmlUrl: r.html_url }));
  }

  /** Raw last-20 whole-group run durations for a repo, newest first —
   *  the duration sample set for the merge ETA simulation (issue #40). */
  groupRunSamples(repo: string): number[] {
    const rows = this.stmtSelectGroupRuns.all(repo) as { duration_secs: number }[];
    return rows.map((r) => r.duration_secs);
  }

  /** Count of clean whole-group runs at/after `since` (queue ops: trains/hour,
   *  batch success rate — issue #39). */
  countGroupRuns(repo: string, since: string): number {
    return (this.stmtCountGroupRuns.get(repo, since) as { n: number }).n;
  }

  /** Count of DISTINCT ejected group shas at/after `since` — a group with
   *  several failing checks is ONE eject (issues #39/#40). */
  countGroupEjects(repo: string, since: string): number {
    return (this.stmtCountGroupEjects.get(repo, since) as { n: number }).n;
  }

  /** Record a merge-group culprit check (issue #38) — once per
   *  (repo, group sha, check); returns false on the dedupe path or bad input. */
  recordGroupFailure(repo: string, checkName: string, groupSha: string, observedAt: string,
    conclusion: string | null = null): boolean {
    if (!checkName || !groupSha || !observedAt) return false;
    const info = this.stmtInsertGroupFailure.run(repo, checkName, groupSha, observedAt, conclusion);
    return info.changes > 0;
  }

  /** All group-failure rows at/after `since`, ordered repo → check → observed_at. */
  groupFailuresSince(since: string): GroupFailureRow[] {
    const rows = this.stmtSelectGroupFailuresSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({
      repo: r.repo as string, checkName: r.check_name as string,
      groupSha: r.group_sha as string, at: r.at as string,
      conclusion: (r.conclusion as string | null) ?? null,
    }));
  }

  /** Record a config-change annotation (tuning tool). Idempotent on
   *  (repo, observed_at, field); returns false on the dedupe path. */
  recordConfigChange(repo: string, observedAt: string, field: string,
    oldValue: string | null, newValue: string | null): boolean {
    return this.stmtInsertConfigChange.run(repo, observedAt, field, oldValue, newValue).changes > 0;
  }

  /** Register (or extend) a flake quarantine (roadmap 4.5). `until` is the
   *  auto-unquarantine expiry; re-quarantine UPSERTs the window. Rejects empties. */
  recordQuarantine(repo: string, checkName: string, until: string, reason: string | null,
    createdAt: string): boolean {
    if (!repo || !checkName || !until || !createdAt) return false;
    this.stmtUpsertQuarantine.run(repo, checkName, until, reason, createdAt);
    return true;
  }

  /** Quarantines still active at `now` (now < until) — expired ones auto-drop out.
   *  Pass a repo to scope, or '' for the whole fleet. */
  activeQuarantines(now: string, repo = ''): QuarantineRow[] {
    const rows = this.stmtSelectActiveQuarantines.all(now, repo, repo) as Record<string, unknown>[];
    return rows.map((r) => ({
      repo: r.repo as string, checkName: r.check_name as string, until: r.until as string,
      reason: (r.reason as string | null) ?? null, createdAt: r.created_at as string,
    }));
  }

  /** Config-change rows at/after `since`, ordered repo → observed_at. */
  configChangesSince(since: string): { repo: string; at: string; field: string;
    oldValue: string | null; newValue: string | null }[] {
    const rows = this.stmtSelectConfigChangesSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, at: r.at as string, field: r.field as string,
      oldValue: (r.old_value as string | null) ?? null, newValue: (r.new_value as string | null) ?? null }));
  }

  /** Latest recorded value per (repo, field) — `${repo}::${field}` → value. */
  latestConfigValues(): Map<string, string> {
    const rows = this.stmtLatestConfigValues.all() as Record<string, unknown>[];
    const m = new Map<string, string>();
    for (const r of rows) m.set(`${r.repo as string}::${r.field as string}`, (r.new_value as string) ?? '');
    return m;
  }

  /** Every completed merge_group check at/after `since` (queue-efficiency, #23).
   *  One row per check; callers group by (headSha, runNumber) to form runs. */
  mergeGroupChecksSince(since: string): MergeGroupCheckRow[] {
    const rows = this.stmtSelectMergeGroupChecks.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({
      repo: r.repo as string, checkName: r.check_name as string,
      conclusion: r.conclusion as string,
      headSha: (r.head_sha as string | null) ?? null,
      runNumber: (r.run_number as number | null) ?? null,
      completedAt: r.completed_at as string,
    }));
  }

  /**
   * Flake statistics (issue #37) for one repo over a window: a flake event is a
   * failing-class sample (FAILURE/TIMED_OUT/STARTUP_FAILURE) on (check, event,
   * head_sha) later resolved by a SUCCESS on the SAME sha — at a higher
   * run_attempt when both attempts are known, otherwise at a later completed_at.
   * A failure followed only by a success on a NEW sha is a real failure that got
   * fixed, not a flake. `totalRuns` counts distinct (sha, attempt) samples
   * (rows missing run_attempt count individually by timestamp). Rows without
   * head_sha (pre-#34 history) are excluded entirely.
   */
  flakeStats(repo: string, since: string): FlakeStat[] {
    return this.flakeStatsByRepo(since).get(repo) ?? [];
  }

  /** flakeStats for every repo with eligible rows in the window (metrics path). */
  flakeStatsByRepo(since: string): Map<string, FlakeStat[]> {
    interface Row { repo: string; check_name: string; event: string; head_sha: string;
      run_attempt: number | null; completed_at: string; conclusion: string }
    const rows = this.stmtSelectFlakeRows.all(since) as unknown as Row[];
    // Group rows by (repo, check, event) — names contain spaces and ' / ', so
    // a NUL separator keys the map; identity fields are re-read from the
    // group's first row, never split back out of the key.
    const SEP = '\u0000';
    const byCheck = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.repo}${SEP}${r.check_name}${SEP}${r.event}`;
      byCheck.set(k, [...(byCheck.get(k) ?? []), r]);
    }
    const out = new Map<string, FlakeStat[]>();
    for (const checkRows of byCheck.values()) {
      const { repo, check_name: name, event } = checkRows[0]!;
      const runKeys = new Set<string>();
      const runAts: string[] = [];
      const bySha = new Map<string, Row[]>();
      for (const r of checkRows) {
        // run identity: (sha, attempt); attempt-less rows fall back to their
        // timestamp so two attempt-less samples on one sha still read as two runs
        const runKey = `${r.head_sha}${SEP}${r.run_attempt ?? `t:${r.completed_at}`}`;
        if (!runKeys.has(runKey)) { runKeys.add(runKey); runAts.push(r.completed_at); }
        bySha.set(r.head_sha, [...(bySha.get(r.head_sha) ?? []), r]);
      }
      const flakeAts: string[] = [];
      for (const shaRows of bySha.values()) {
        const successes = shaRows.filter((r) => r.conclusion === 'SUCCESS');
        if (!successes.length) continue;
        for (const f of shaRows) {
          if (!FAILING_CONCLUSIONS.has(f.conclusion)) continue;
          const resolved = successes.some((s) =>
            s.run_attempt != null && f.run_attempt != null
              ? s.run_attempt > f.run_attempt
              : s.completed_at > f.completed_at);
          if (resolved) flakeAts.push(f.completed_at);
        }
      }
      const totalRuns = runKeys.size;
      const stat: FlakeStat = {
        name, event, flakeEvents: flakeAts.length, totalRuns,
        flakeRatePct: totalRuns ? (flakeAts.length / totalRuns) * 100 : 0,
        flakeAts: flakeAts.sort(), runAts,
      };
      out.set(repo, [...(out.get(repo) ?? []), stat]);
    }
    return out;
  }

  /** Every (repo, check, event) series with at least `minSamples` SUCCESS rows —
   *  the duration-regression scan's candidate list (issue #41). `newestAt` lets
   *  the caller skip dormant checks without reading their samples. */
  regressionCandidates(minSamples: number):
    { repo: string; name: string; event: string; newestAt: string }[] {
    const rows = this.stmtSelectRegressionCandidates.all(minSamples) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, name: r.check_name as string,
      event: r.event as string, newestAt: r.newest_at as string }));
  }

  /** Newest-first SUCCESS duration samples WITH completed_at for one
   *  (repo, check, event) series, capped at `limit` — the duration-regression
   *  step test's input (issue #41). */
  recentDurationSamples(repo: string, name: string, event: string, limit: number):
    { durationSecs: number; completedAt: string }[] {
    const rows = this.stmtSelectRecentDurations.all(repo, name, event, limit) as
      { duration_secs: number; completed_at: string }[];
    return rows.map((r) => ({ durationSecs: r.duration_secs, completedAt: r.completed_at }));
  }

  /** Observed enqueue→merge wall-clock wait for a merge-queue PR. Rejects ≤0/NaN. */
  recordQueueWait(repo: string, waitSecs: number, observedAt: string): boolean {
    if (!(waitSecs > 0)) return false; // rejects ≤0 and NaN
    this.stmtInsertQueueWait.run(repo, waitSecs, observedAt);
    return true;
  }

  medianQueueWait(repo: string): number | null {
    const rows = this.stmtSelectQueueWaits.all(repo) as { wait_secs: number }[];
    return rows.length ? median(rows.map((r) => r.wait_secs)) : null;
  }

  /** Observed runner-pickup wait for a check (needs-complete → startedAt).
   *  Accepts 0 (same-second warm pickups are real samples; UNIQUE dedupes);
   *  rejects negative/NaN. `pool` (issue #45): the job's runner-pool label —
   *  multi-candidate runs-on ternaries arrive pre-joined ('a|b'); null when
   *  unknown. */
  recordRunnerWait(repo: string, name: string, event: string,
    waitSecs: number, startedAt: string, pool: string | null = null): boolean {
    if (!(waitSecs >= 0)) return false; // rejects <0 and NaN
    this.stmtInsertRunnerWait.run(repo, name, event, waitSecs, startedAt, pool || null);
    return true;
  }

  /** Median runner-pickup wait over the last 20 samples for (repo, name, event). */
  expectedRunnerWait(repo: string, name: string, event: string): number | null {
    const rows = this.stmtSelectRunnerWaits.all(repo, name, event) as { wait_secs: number }[];
    return rows.length ? median(rows.map((r) => r.wait_secs)) : null;
  }

  /** Last-20 runner-pickup-wait p50 WITH its sample count for
   *  (repo, name, event) — the wait-dominated lint gates on n (issue #48).
   *  Null with no samples. Same sample window as expectedRunnerWait. */
  runnerWaitStats(repo: string, name: string, event: string):
    { p50Secs: number; n: number } | null {
    const rows = this.stmtSelectRunnerWaits.all(repo, name, event) as { wait_secs: number }[];
    if (!rows.length) return null;
    return { p50Secs: median(rows.map((r) => r.wait_secs)), n: rows.length };
  }

  /** Event-level fallback: median pickup wait over the last 50 samples across names.
   *  Null below 3 samples — one or two waits are too thin to generalize to other jobs. */
  expectedRunnerWaitForEvent(repo: string, event: string): number | null {
    const rows = this.stmtSelectRunnerWaitsByEvent.all(repo, event) as { wait_secs: number }[];
    return rows.length >= 3 ? median(rows.map((r) => r.wait_secs)) : null;
  }

  /** Predicted (first stage ETA) vs actual stage duration. Rejects bad inputs
   *  and stage-flap artifacts (actual below max(60s, 5% of predicted) — see
   *  ETA_ACCURACY_MIN_ACTUAL_SECS, issue #54). */
  recordEtaAccuracy(repo: string, stage: string, predictedSecs: number, actualSecs: number,
    observedAt: string): boolean {
    if (!Number.isFinite(predictedSecs) || predictedSecs < 0 || !(actualSecs > 0)) return false;
    const minActual = Math.max(ETA_ACCURACY_MIN_ACTUAL_SECS,
      predictedSecs * ETA_ACCURACY_MIN_ACTUAL_FRACTION);
    if (actualSecs < minActual) return false;
    this.stmtInsertEtaAccuracy.run(repo, stage, predictedSecs, actualSecs, observedAt);
    return true;
  }

  /** Median |predicted − actual| over the last 20 samples for (repo, stage).
   *  No UI consumer since the Gantt bound bands; retained as the calibration dataset for a future metrics panel. */
  etaAccuracy(repo: string, stage: string): { medianAbsErrSecs: number; n: number } | null {
    const rows = this.stmtSelectEtaAccuracy.all(repo, stage) as
      { predicted_secs: number; actual_secs: number }[];
    if (!rows.length) return null;
    return {
      medianAbsErrSecs: median(rows.map((r) => Math.abs(r.predicted_secs - r.actual_secs))),
      n: rows.length,
    };
  }

  /** All eta-accuracy rows at/after `since`, ordered repo → stage → observed_at
   *  (bucketing happens in metrics — the issue #35 calibration panel). */
  etaAccuracySince(since: string): EtaAccuracyRow[] {
    const rows = this.stmtSelectEtaAccuracySince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({
      repo: r.repo as string, stage: r.stage as string,
      predictedSecs: r.predicted_secs as number, actualSecs: r.actual_secs as number,
      at: r.at as string,
    }));
  }

  /**
   * Conformal-lite calibration factor for (repo, stage): the 90th percentile of
   * actual/predicted ratios over the last 30 usable accuracy rows. Null under
   * 10 rows — too thin to widen displayed ranges from. Factor > 1 means ETAs
   * run optimistic (stages take longer than first predicted).
   */
  calibrationFactor(repo: string, stage: string): number | null {
    const rows = this.stmtSelectEtaAccuracyRecent.all(repo, stage) as
      { predicted_secs: number; actual_secs: number }[];
    if (rows.length < 10) return null;
    const ratios = rows.map((r) => r.actual_secs / r.predicted_secs).sort((a, b) => a - b);
    return percentile(ratios, 0.9);
  }

  getMeta(key: string): string | null {
    const row = this.stmtGetMeta.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.stmtSetMeta.run(key, value);
  }

  deleteMeta(key: string): void {
    this.stmtDeleteMeta.run(key);
  }

  /** All meta rows whose key starts with `prefix` (LIKE wildcards in the prefix
   *  are escaped — `repoConfig:a_b/c` only matches itself). */
  listMeta(prefix: string): { key: string; value: string }[] {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.stmtListMeta.all(`${escaped}%`) as { key: string; value: string }[];
  }

  // ---- metrics (round 12): state sampling + windowed day-bucketed reads -----

  /**
   * Record a per-repo dashboard-state sample (metrics trends panel), throttled
   * to at most one row per 15 minutes per repo — callers (the poller's
   * emitUpdate path) invoke this every cycle and rely on the throttle here.
   * A successful insert also prunes samples older than 90 days (cheap DELETE).
   * Returns false when throttled or `sampledAt` is unparseable.
   */
  recordStateSample(repo: string, sampledAt: string, counts: StateSampleCounts): boolean {
    const atMs = Date.parse(sampledAt);
    if (!Number.isFinite(atMs)) return false;
    const last = this.stmtLastStateSampleAt.get(repo) as { at: string | null } | undefined;
    if (last?.at != null && atMs - Date.parse(last.at) < STATE_SAMPLE_MIN_MS) return false;
    this.stmtInsertStateSample.run(repo, sampledAt,
      counts.open, counts.ci, counts.queue, counts.failed);
    this.stmtPruneStateSamples.run(new Date(atMs - STATE_SAMPLE_RETENTION_MS).toISOString());
    return true;
  }

  /** All state samples at/after `since`, ordered by repo then time (oldest first). */
  stateSamplesSince(since: string): StateSampleRow[] {
    const rows = this.stmtSelectStateSamplesSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({
      repo: r.repo as string, at: r.sampled_at as string,
      open: r.open_count as number, ci: r.ci_count as number,
      queue: r.queue_count as number, failed: r.failed_count as number,
    }));
  }

  /** Runner-pickup waits at/after `since` with full timestamps (bucketing happens in metrics). */
  runnerWaitsSince(since: string): { repo: string; event: string; at: string; waitSecs: number }[] {
    const rows = this.stmtSelectRunnerWaitsSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, event: r.event as string,
      at: r.at as string, waitSecs: r.wait_secs as number }));
  }

  /** Pool-labeled runner-pickup waits at/after `since` (issue #45) — rows
   *  without a pool label (pre-#45 history, unmappable jobs) are excluded.
   *  Multi-candidate pools arrive as the stored JOINED string ('a|b'). */
  runnerPoolWaitsSince(since: string):
    { repo: string; pool: string; at: string; waitSecs: number }[] {
    const rows = this.stmtSelectPoolWaitsSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, pool: r.pool as string,
      at: r.at as string, waitSecs: r.wait_secs as number }));
  }

  /** Job occupancy intervals completing at/after `since` (issue #47), every
   *  conclusion — a cancelled job held its runner too. Rows persisted before
   *  the started_at column derive start = completed − duration (exact for
   *  uncontaminated rows; recordCheckDuration computes duration from the same
   *  pair). `startedAt` is therefore never null. */
  checkIntervalsSince(since: string):
    { repo: string; name: string; event: string; startedAt: string; completedAt: string }[] {
    const rows = this.stmtSelectIntervalsSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => {
      const completedAt = r.completed_at as string;
      const startedAt = (r.started_at as string | null)
        ?? new Date(Date.parse(completedAt) - (r.duration_secs as number) * 1000).toISOString();
      return { repo: r.repo as string, name: r.check_name as string,
        event: r.event as string, startedAt, completedAt };
    });
  }

  /**
   * Spot-reclaim / infra-kill events (issue #46) per repo over a window: a
   * CANCELLED sample at run_attempt N on (check, event, head_sha) where a
   * SUCCESS exists on the SAME sha at a HIGHER attempt — the re-run that
   * `re-run-on-spot-cancel` (or a human) triggered went green, proving the
   * cancellation was an infra kill, not a verdict. Deliberately disjoint from
   * flake detection: a flake is FAILING-class (FAILURE/TIMED_OUT/
   * STARTUP_FAILURE) resolved on the same sha; a reclaim is CANCELLED-class.
   * Both attempts must be known (run_attempt non-null) — unlike flakeStats
   * there is no timestamp fallback, because the attempt relationship IS the
   * signal. Rows without head_sha (pre-#34) are excluded entirely.
   */
  reclaimEventsByRepo(since: string): Map<string, { name: string; event: string; at: string }[]> {
    interface Row { repo: string; check_name: string; event: string; head_sha: string;
      run_attempt: number | null; completed_at: string; conclusion: string }
    const rows = this.stmtSelectFlakeRows.all(since) as unknown as Row[];
    const SEP = '\u0000'; // names contain spaces and ' / '
    const bySha = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.repo}${SEP}${r.check_name}${SEP}${r.event}${SEP}${r.head_sha}`;
      bySha.set(k, [...(bySha.get(k) ?? []), r]);
    }
    const out = new Map<string, { name: string; event: string; at: string }[]>();
    for (const shaRows of bySha.values()) {
      const successes = shaRows.filter((r) => r.conclusion === 'SUCCESS' && r.run_attempt != null);
      if (!successes.length) continue;
      for (const c of shaRows) {
        if (c.conclusion !== 'CANCELLED' || c.run_attempt == null) continue;
        if (!successes.some((s) => s.run_attempt! > c.run_attempt!)) continue;
        const ev = { name: c.check_name, event: c.event, at: c.completed_at };
        out.set(c.repo, [...(out.get(c.repo) ?? []), ev]);
      }
    }
    for (const events of out.values()) events.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }

  /** Runner-minute rows for cost attribution (issue #43): every conclusion at/
   *  after `since` (completed_at filter), with the job's start time, duration
   *  and workflow-run attempt. Pre-#47 rows (NULL started_at) derive
   *  started = completed − duration, exactly like checkIntervalsSince.
   *  `event`/`headSha`/`runNumber` (cost explorer): the per-job and per-run
   *  grouping identity — headSha/runNumber are null on rows ingested before
   *  their columns existed (those rows skip the per-run grouping). */
  costRowsSince(since: string):
    { repo: string; name: string; event: string; headSha: string | null;
      runNumber: number | null; startedAt: string; durationSecs: number;
      runAttempt: number | null }[] {
    const rows = this.stmtSelectCostRows.all(since) as Record<string, unknown>[];
    return rows.map((r) => {
      const completedAt = r.completed_at as string;
      const durationSecs = r.duration_secs as number;
      const startedAt = (r.started_at as string | null)
        ?? new Date(Date.parse(completedAt) - durationSecs * 1000).toISOString();
      return { repo: r.repo as string, name: r.check_name as string,
        event: r.event as string, headSha: (r.head_sha as string | null) ?? null,
        runNumber: (r.run_number as number | null) ?? null,
        startedAt, durationSecs, runAttempt: (r.run_attempt as number | null) ?? null };
    });
  }

  /** Cost actuals import (cost explorer phase 2): write-or-replace one
   *  (scope, date) row — re-imports are idempotent; the latest POST wins. */
  upsertCostActual(scope: string, date: string, dollars: number, source: string | null): void {
    this.stmtUpsertCostActual.run(scope, date, dollars, source);
  }

  /** Ground-truth job→pool observation (jobs-API feature): upsert the resolved
   *  pool + github-hosted flag for one (repo, canonical check_name, event),
   *  refreshing last_seen. `checkName` MUST be canonical (matrix-collapsed) so
   *  it joins against the canonical names poolsFor/cost use. */
  recordObservedPool(repo: string, checkName: string, event: string,
    observed: ObservedPool, lastSeen: string = new Date().toISOString()): void {
    this.stmtUpsertObservedPool.run(repo, checkName, event,
      observed.pool, observed.githubHosted ? 1 : 0, lastSeen);
  }

  /** The ground-truth pool for one (repo, canonical check_name, event), or null
   *  when no job has been observed for that key yet. */
  observedPool(repo: string, checkName: string, event: string): ObservedPool | null {
    const row = this.stmtSelectObservedPool.get(repo, checkName, event) as
      { pool: string; github_hosted: number } | undefined;
    return row ? { pool: row.pool, githubHosted: row.github_hosted !== 0 } : null;
  }

  /** Like {@link observedPool} but, on an exact miss for a non-merge_group
   *  event, borrows a sibling non-merge_group event's pool for the same job
   *  (push and pull_request share the runner; the learning loop only fetches
   *  PR + merge_group runs, so push-event rows otherwise stay 'unknown').
   *  merge_group misses are NOT borrowed — a runs-on ternary can put that
   *  branch on a different pool. */
  observedPoolWithFallback(repo: string, checkName: string, event: string): ObservedPool | null {
    const exact = this.observedPool(repo, checkName, event);
    if (exact) return exact;
    if (event === 'merge_group') return null;
    const row = this.stmtSelectObservedPoolSibling.get(repo, checkName) as
      { pool: string; github_hosted: number } | undefined;
    return row ? { pool: row.pool, githubHosted: row.github_hosted !== 0 } : null;
  }

  /** Every ground-truth pool observation (metrics: pool breakdown / coverage). */
  observedPoolsByRepo(): ObservedPoolRow[] {
    const rows = this.stmtSelectObservedPools.all() as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, checkName: r.check_name as string,
      event: r.event as string, pool: r.pool as string,
      githubHosted: (r.github_hosted as number) !== 0, lastSeen: r.last_seen as string }));
  }

  /** Imported actual-spend rows with date ≥ `sinceDate` (a YYYY-MM-DD key —
   *  actual bills are daily), ordered scope → date. */
  costActualsSince(sinceDate: string): CostActualRow[] {
    const rows = this.stmtSelectCostActuals.all(sinceDate) as Record<string, unknown>[];
    return rows.map((r) => ({ scope: r.scope as string, date: r.date as string,
      dollars: r.dollars as number, source: (r.source as string | null) ?? null }));
  }

  /** SUCCESS check durations at/after `since` with full timestamps (bucketing happens in metrics). */
  checkDurationsSince(since: string): { repo: string; name: string; event: string; at: string; durationSecs: number }[] {
    const rows = this.stmtSelectDurationsSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, name: r.check_name as string,
      event: r.event as string, at: r.at as string, durationSecs: r.duration_secs as number }));
  }

  /** Per-(check, event) success aggregate since `since`, grouped by repo. Feeds
   *  the demotion-candidate detector (estimator/demotion-candidates.ts). Runs are
   *  DISTINCT (sha, attempt) with CANCELLED excluded; `failingRuns` counts
   *  FAILING_CONCLUSIONS; `sumDurationSecs` is the cost basis. */
  successStatsByRepo(since: string): Map<string, SuccessStat[]> {
    const rows = this.stmtSelectSuccessStatsSince.all(since) as Record<string, unknown>[];
    const out = new Map<string, SuccessStat[]>();
    for (const r of rows) {
      const repo = r.repo as string;
      const list = out.get(repo) ?? [];
      list.push({
        name: r.name as string,
        event: r.event as string,
        totalRuns: (r.total as number) ?? 0,
        failingRuns: (r.failing as number) ?? 0,
        sumDurationSecs: (r.sum_secs as number) ?? 0,
      });
      out.set(repo, list);
    }
    return out;
  }

  /** Real-failure incident counts per (repo, check, event) since `since` (#150.3):
   *  `${name}\0${event}` → number of distinct consecutive-real-failing streaks.
   *  Keyed for a cheap join in the promotion lane. */
  failureIncidentsByRepo(since: string): Map<string, Map<string, number>> {
    const rows = this.stmtSelectFailureIncidentsSince.all(since) as Record<string, unknown>[];
    const out = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const repo = r.repo as string;
      const m = out.get(repo) ?? new Map<string, number>();
      m.set(`${r.name as string}\x00${r.event as string}`, (r.incidents as number) ?? 0);
      out.set(repo, m);
    }
    return out;
  }

  /** Enqueue→merge queue waits at/after `since` with full timestamps (bucketing happens in metrics). */
  queueWaitsSince(since: string): { repo: string; at: string; waitSecs: number }[] {
    const rows = this.stmtSelectQueueWaitsSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, at: r.at as string,
      waitSecs: r.wait_secs as number }));
  }

  /** Whole-group merge-queue run durations at/after `since`, full timestamps. */
  groupRunsSince(since: string): { repo: string; at: string; durationSecs: number }[] {
    const rows = this.stmtSelectGroupRunsSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, at: r.at as string,
      durationSecs: r.duration_secs as number }));
  }

  /** Per-repo merge timestamps at/after `since`, ascending — the train-clustering
   *  input for trains/hour (merged_prs is sweep-fed and durable, unlike group_runs
   *  which only exists when a poll happens to observe a completed group). */
  mergedTimestampsSince(repo: string, since: string): string[] {
    const rows = this.stmtSelectMergedTimestamps.all(repo, since) as { merged_at: string }[];
    return rows.map((r) => r.merged_at);
  }

  /** Merged PRs at/after `since` (full timestamps — bucketing happens in metrics). */
  mergedSince(since: string): { repo: string; mergedAt: string; createdAt: string | null;
    qaLiveAt: string | null; mergedBy: string | null; enqueuedAt: string | null }[] {
    const rows = this.stmtSelectMergedSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, mergedAt: r.merged_at as string,
      createdAt: (r.created_at as string) ?? null, qaLiveAt: (r.qa_live_at as string) ?? null,
      mergedBy: (r.merged_by as string) ?? null, enqueuedAt: (r.enqueued_at as string) ?? null }));
  }

  /** Lead-time decomposition rows (issue #44): merged_prs rows merged at/after
   *  `since` OR prod-live at/after `since` (deploy-frequency rows can be merged
   *  before the window). Ordered repo → merged_at; bucketing/segmenting happens
   *  in metrics. */
  leadTimeRowsSince(since: string): LeadTimeRow[] {
    const rows = this.stmtSelectLeadTimeRows.all(since, since) as Record<string, unknown>[];
    return rows.map((r) => ({
      repo: r.repo as string,
      createdAt: (r.created_at as string) ?? null,
      firstGreenAt: (r.first_green_at as string) ?? null,
      enqueuedAt: (r.enqueued_at as string) ?? null,
      mergedAt: r.merged_at as string,
      qaLiveAt: (r.qa_live_at as string) ?? null,
      prodLiveAt: (r.prod_live_at as string) ?? null,
    }));
  }

  /** Every repo that has left any trace in history (durations, merged PRs,
   *  state samples) — feeds the settings panel's repo toggle list. */
  distinctRepos(): string[] {
    const rows = this.db.prepare(
      `SELECT repo FROM check_durations
       UNION SELECT repo FROM merged_prs
       UNION SELECT repo FROM state_samples
       ORDER BY repo`
    ).all() as { repo: string }[];
    return rows.map((r) => r.repo);
  }

  close(): void {
    this.db.close();
  }
}
