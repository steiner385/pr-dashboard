// Durable persistence for the workspace capabilities that the rolling telemetry
// tables don't cover (spec 001): the applied-change ledger (Group H outcomes),
// the action audit log (Group L2 — a trust artifact, never auto-pruned), and the
// declarative-policy store (Group I2). Mirrors the HistoryStore better-sqlite3
// pattern; `:memory:` for tests. These records outlive the 7–90d telemetry
// retention (review I-4) — no pruning here by design.
import Database from 'better-sqlite3';
import type { AppliedChange } from '../analytics/outcomes';
import type { AuditRow } from '../analytics/changelog';
import type { PolicyRule } from '../analytics/policy';
import type { Budget } from '../analytics/budgets';

export class WorkspaceStore {
  private db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applied_changes (
        repo TEXT NOT NULL, pr_number INTEGER NOT NULL, check_name TEXT NOT NULL,
        projected_cost REAL NOT NULL, projected_cov REAL NOT NULL,
        realized_cost REAL NOT NULL, realized_cov REAL NOT NULL,
        window_days INTEGER NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (repo, pr_number, check_name)
      );
      CREATE TABLE IF NOT EXISTS action_audit (
        at TEXT NOT NULL, repo TEXT NOT NULL, action TEXT NOT NULL, target TEXT, result TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_repo_at ON action_audit (repo, at DESC);
      CREATE TABLE IF NOT EXISTS workspace_policies (repo TEXT PRIMARY KEY, rules_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_budgets (scope TEXT PRIMARY KEY, budgets_json TEXT NOT NULL);
    `);
  }

  // --- Group H: applied-change ledger ---
  recordAppliedChange(repo: string, c: AppliedChange): void {
    this.db.prepare(
      `INSERT INTO applied_changes (repo, pr_number, check_name, projected_cost, projected_cov, realized_cost, realized_cov, window_days, at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repo, pr_number, check_name) DO UPDATE SET
         realized_cost=excluded.realized_cost, realized_cov=excluded.realized_cov, window_days=excluded.window_days, at=excluded.at`,
    ).run(repo, c.prNumber, c.check, c.projected.costDeltaMinutes, c.projected.coverageDelta, c.realized.costDeltaMinutes, c.realized.coverageDelta, c.windowDays, new Date().toISOString());
  }
  appliedChanges(repo: string): AppliedChange[] {
    return (this.db.prepare('SELECT * FROM applied_changes WHERE repo=? ORDER BY at DESC').all(repo) as Record<string, number | string>[])
      .map((r) => ({
        prNumber: r.pr_number as number, check: r.check_name as string,
        projected: { costDeltaMinutes: r.projected_cost as number, coverageDelta: r.projected_cov as number },
        realized: { costDeltaMinutes: r.realized_cost as number, coverageDelta: r.realized_cov as number },
        windowDays: r.window_days as number,
      }));
  }

  // --- Group L2: action audit (append-only, never pruned) ---
  recordAction(row: AuditRow): void {
    this.db.prepare('INSERT INTO action_audit (at, repo, action, target, result) VALUES (?,?,?,?,?)')
      .run(row.at, row.repo, row.action, row.target ?? null, row.result ?? null);
  }
  auditLog(repo: string, limit = 100): AuditRow[] {
    return (this.db.prepare('SELECT at, repo, action, target, result FROM action_audit WHERE repo=? ORDER BY at DESC LIMIT ?').all(repo, limit) as Record<string, string | null>[])
      .map((r) => ({ at: r.at as string, repo: r.repo as string, action: r.action as string, target: r.target ?? undefined, result: r.result ?? undefined }));
  }

  // --- Group I2: declarative policy store ---
  getPolicies(repo: string): PolicyRule[] {
    const row = this.db.prepare('SELECT rules_json FROM workspace_policies WHERE repo=?').get(repo) as { rules_json: string } | undefined;
    return row ? JSON.parse(row.rules_json) as PolicyRule[] : [];
  }
  putPolicies(repo: string, rules: PolicyRule[]): void {
    this.db.prepare('INSERT INTO workspace_policies (repo, rules_json) VALUES (?,?) ON CONFLICT(repo) DO UPDATE SET rules_json=excluded.rules_json')
      .run(repo, JSON.stringify(rules));
  }

  // --- Group J2/J3: budget thresholds (scope-keyed; 'fleet' is the default) ---
  getBudgets(scope = 'fleet'): Budget[] {
    const row = this.db.prepare('SELECT budgets_json FROM workspace_budgets WHERE scope=?').get(scope) as { budgets_json: string } | undefined;
    return row ? JSON.parse(row.budgets_json) as Budget[] : [];
  }
  putBudgets(scope: string, budgets: Budget[]): void {
    this.db.prepare('INSERT INTO workspace_budgets (scope, budgets_json) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET budgets_json=excluded.budgets_json')
      .run(scope, JSON.stringify(budgets));
  }

  close(): void { this.db.close(); }
}
