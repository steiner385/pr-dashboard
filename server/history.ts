import Database from 'better-sqlite3';
import { median, percentile } from './math';

export interface Expected { p10: number; p50: number; p90: number; n: number; }
export interface MergedPrInput {
  repo: string; number: number; title: string; url: string;
  mergedAt: string; mergeCommitSha: string | null;
  /** PR creation time (lifespan metric). Optional: pre-migration callers/rows lack it. */
  createdAt?: string | null;
}
export interface MergedPrRecord extends MergedPrInput {
  createdAt: string | null;
  qaLiveAt: string | null; prodLiveAt: string | null;
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
  private readonly stmtSelectQueueWaitsSince: Database.Statement;
  private readonly stmtSelectGroupRunsSince: Database.Statement;
  private readonly stmtSelectMergedSince: Database.Statement;
  // Flake radar (#37) + train-killer leaderboard (#38)
  private readonly stmtSelectFlakeRows: Database.Statement;
  private readonly stmtInsertGroupFailure: Database.Statement;
  private readonly stmtSelectGroupFailuresSince: Database.Statement;
  private readonly stmtCountGroupRuns: Database.Statement;
  private readonly stmtCountGroupEjects: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS check_durations (
        repo TEXT NOT NULL, check_name TEXT NOT NULL, event TEXT NOT NULL,
        duration_secs REAL NOT NULL, completed_at TEXT NOT NULL, conclusion TEXT NOT NULL,
        head_sha TEXT, run_attempt INTEGER,
        UNIQUE(repo, check_name, event, completed_at)
      );
      CREATE INDEX IF NOT EXISTS idx_durations ON check_durations(repo, check_name, event, completed_at);
      CREATE TABLE IF NOT EXISTS merged_prs (
        repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
        merged_at TEXT NOT NULL, merge_commit_sha TEXT,
        qa_live_at TEXT, prod_live_at TEXT, created_at TEXT,
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
        wait_secs REAL NOT NULL, started_at TEXT NOT NULL,
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
        UNIQUE(repo, group_sha, check_name)
      );
      CREATE INDEX IF NOT EXISTS idx_group_failures_observed ON group_failures(observed_at);
    `);

    // Migration: merged_prs gains created_at (PR lifespan metric). Fresh DBs get
    // the column from CREATE TABLE above; pre-existing DBs get it from this ALTER
    // (duplicate-column tolerated, everything else rethrown).
    addColumnIfMissing(this.db, 'merged_prs', 'created_at TEXT');
    // Migration (issue #34): check_durations gains head_sha + run_attempt —
    // shared plumbing for flake radar / spot-reclaim ledger / attempt
    // waterfalls. Both nullable; the UNIQUE constraint is unchanged.
    addColumnIfMissing(this.db, 'check_durations', 'head_sha TEXT');
    addColumnIfMissing(this.db, 'check_durations', 'run_attempt INTEGER');

    // Prepare all statements after schema is guaranteed to exist.
    this.stmtInsertDuration = this.db.prepare(
      'INSERT OR IGNORE INTO check_durations (repo, check_name, event, duration_secs, completed_at, conclusion, head_sha, run_attempt) VALUES (?,?,?,?,?,?,?,?)'
    );
    this.stmtSelectDurations = this.db.prepare(
      `SELECT duration_secs FROM check_durations
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
    this.stmtUpsertPr = this.db.prepare(
      `INSERT INTO merged_prs (repo, number, title, url, merged_at, merge_commit_sha, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(repo, number) DO UPDATE SET title=excluded.title,
         merge_commit_sha=COALESCE(excluded.merge_commit_sha, merge_commit_sha),
         created_at=COALESCE(excluded.created_at, created_at)`
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
      'INSERT OR IGNORE INTO runner_waits (repo, check_name, event, wait_secs, started_at) VALUES (?,?,?,?,?)'
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
      `SELECT repo, merged_at, created_at, qa_live_at
       FROM merged_prs WHERE merged_at >= ? ORDER BY repo, merged_at`
    );
    // Flake detection (#37) needs every conclusion (not just SUCCESS) plus the
    // sha/attempt identity; rows without head_sha (pre-#34) can't participate.
    this.stmtSelectFlakeRows = this.db.prepare(
      `SELECT repo, check_name, event, head_sha, run_attempt, completed_at, conclusion
       FROM check_durations
       WHERE completed_at >= ? AND head_sha IS NOT NULL
       ORDER BY repo, check_name, event, completed_at`
    );
    this.stmtInsertGroupFailure = this.db.prepare(
      'INSERT OR IGNORE INTO group_failures (repo, check_name, group_sha, observed_at) VALUES (?,?,?,?)'
    );
    this.stmtSelectGroupFailuresSince = this.db.prepare(
      `SELECT repo, check_name, group_sha, observed_at AS at
       FROM group_failures WHERE observed_at >= ? ORDER BY repo, check_name, observed_at`
    );
  }

  /** `headSha`/`runAttempt` (issue #34): the PR/group head commit the check ran
   *  against and the workflow-run attempt; both nullable ('' sha — placeholder
   *  snapshots — normalizes to NULL). On a UNIQUE collision the first row wins
   *  (INSERT OR IGNORE), exactly as before. */
  recordCheckDuration(repo: string, name: string, event: string,
    startedAt: string | null, completedAt: string | null, conclusion: string,
    headSha: string | null = null, runAttempt: number | null = null): boolean {
    if (!startedAt || !completedAt) return false;
    const secs = (Date.parse(completedAt) - Date.parse(startedAt)) / 1000;
    if (!(secs > 0)) return false; // rejects negative durations (SKIPPED placeholders) and NaN
    this.stmtInsertDuration.run(repo, name, event, secs, completedAt, conclusion,
      headSha || null, runAttempt ?? null);
    return true;
  }

  expected(repo: string, name: string, event: string): Expected | null {
    const rows = this.stmtSelectDurations.all(repo, name, event) as { duration_secs: number }[];
    if (rows.length === 0) return null;
    const sorted = rows.map((r) => r.duration_secs).sort((a, b) => a - b);
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

  /** Raw last-20 SUCCESS duration samples for (repo, check, event), newest first. */
  samples(repo: string, name: string, event: string): number[] {
    const rows = this.stmtSelectDurations.all(repo, name, event) as { duration_secs: number }[];
    return rows.map((r) => r.duration_secs);
  }

  expectedSet(repo: string, event: string, now: Date, windowDays = 14): string[] {
    const cutoff = new Date(now.getTime() - windowDays * 86400_000).toISOString();
    const rows = this.stmtSelectExpectedSet.all(repo, event, cutoff) as { check_name: string }[];
    return rows.map((r) => r.check_name);
  }

  upsertMergedPr(pr: MergedPrInput): void {
    this.stmtUpsertPr.run(pr.repo, pr.number, pr.title, pr.url, pr.mergedAt, pr.mergeCommitSha,
      pr.createdAt ?? null);
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
      qaLiveAt: (r.qa_live_at as string) ?? null, prodLiveAt: (r.prod_live_at as string) ?? null,
    }));
  }

  recordDeployGap(repo: string, env: string, gapSecs: number): void {
    this.stmtInsertGap.run(repo, env, gapSecs);
  }

  medianDeployGap(repo: string, env: string): number | null {
    const rows = this.stmtSelectGaps.all(repo, env) as { gap_secs: number }[];
    return rows.length ? median(rows.map((r) => r.gap_secs)) : null;
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
  recordGroupFailure(repo: string, checkName: string, groupSha: string, observedAt: string): boolean {
    if (!checkName || !groupSha || !observedAt) return false;
    const info = this.stmtInsertGroupFailure.run(repo, checkName, groupSha, observedAt);
    return info.changes > 0;
  }

  /** All group-failure rows at/after `since`, ordered repo → check → observed_at. */
  groupFailuresSince(since: string): GroupFailureRow[] {
    const rows = this.stmtSelectGroupFailuresSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({
      repo: r.repo as string, checkName: r.check_name as string,
      groupSha: r.group_sha as string, at: r.at as string,
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
   *  rejects negative/NaN. */
  recordRunnerWait(repo: string, name: string, event: string,
    waitSecs: number, startedAt: string): boolean {
    if (!(waitSecs >= 0)) return false; // rejects <0 and NaN
    this.stmtInsertRunnerWait.run(repo, name, event, waitSecs, startedAt);
    return true;
  }

  /** Median runner-pickup wait over the last 20 samples for (repo, name, event). */
  expectedRunnerWait(repo: string, name: string, event: string): number | null {
    const rows = this.stmtSelectRunnerWaits.all(repo, name, event) as { wait_secs: number }[];
    return rows.length ? median(rows.map((r) => r.wait_secs)) : null;
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

  /** SUCCESS check durations at/after `since` with full timestamps (bucketing happens in metrics). */
  checkDurationsSince(since: string): { repo: string; name: string; event: string; at: string; durationSecs: number }[] {
    const rows = this.stmtSelectDurationsSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, name: r.check_name as string,
      event: r.event as string, at: r.at as string, durationSecs: r.duration_secs as number }));
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

  /** Merged PRs at/after `since` (full timestamps — bucketing happens in metrics). */
  mergedSince(since: string): { repo: string; mergedAt: string; createdAt: string | null; qaLiveAt: string | null }[] {
    const rows = this.stmtSelectMergedSince.all(since) as Record<string, unknown>[];
    return rows.map((r) => ({ repo: r.repo as string, mergedAt: r.merged_at as string,
      createdAt: (r.created_at as string) ?? null, qaLiveAt: (r.qa_live_at as string) ?? null }));
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
