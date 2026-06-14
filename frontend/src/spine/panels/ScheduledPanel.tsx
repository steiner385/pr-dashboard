import type { DashboardState } from '../../types';

const FAILING = new Set(['failure', 'timed_out', 'startup_failure']);
const isFail = (c: string | null) => c != null && FAILING.has(c.toLowerCase());
const isSuccess = (c: string | null) => (c ?? '').toLowerCase() === 'success';

/** Workflow file → short label (`nightly.yml` → `nightly`). */
function shortName(workflow: string): string {
  return workflow.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
}

/** Compact relative time ('3h ago', 'just now') for a run's created_at. */
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Drill-down for the Scheduled lane (Spec 4): per repo, the most-recent run of
 * each cron-scheduled workflow — name, a status glyph (✓ / ✗ / ●), a relative
 * timestamp, and a link to the run on GitHub. Repos with scheduled workflows but
 * no recorded runs get an explanatory note (blind, not a false green).
 */
export function ScheduledPanel({ repos }: { repos: DashboardState['repos'] }) {
  const active = repos.filter((r) => r.scheduled && r.scheduled.discovered > 0);
  if (active.length === 0) return <p className="spine-panel-empty">No scheduled workflows discovered.</p>;
  return (
    <div className="spine-scheduled-list">
      {active.map((r) => {
        const s = r.scheduled!;
        return (
          <div key={r.repo} data-testid={`spine-scheduled-${r.repo}`}>
            {active.length > 1 && <div className="spine-panel-label">{r.repo}</div>}
            {s.runs.length === 0 ? (
              <p className="spine-panel-empty">{s.discovered} scheduled · no runs recorded yet.</p>
            ) : (
              <ul className="spine-scheduled-runs" role="list">
                {s.runs.map((run) => {
                  const glyph = isFail(run.conclusion) ? '✗' : isSuccess(run.conclusion) ? '✓' : '●';
                  const cls = isFail(run.conclusion) ? 'fail' : isSuccess(run.conclusion) ? 'ok' : 'pending';
                  return (
                    <li key={run.workflow} data-testid={`spine-scheduled-run-${run.workflow}`}
                      className="spine-scheduled-run">
                      <span data-testid="spine-scheduled-run" className="spine-scheduled-run-row">
                        <span className={`spine-scheduled-glyph ${cls}`} aria-hidden="true">{glyph}</span>
                        <span className="spine-scheduled-name">{shortName(run.workflow)}</span>
                        <span className="spine-scheduled-time">{relativeTime(run.createdAt)}</span>
                        {run.htmlUrl && (
                          <a className="spine-scheduled-link" href={run.htmlUrl}
                            target="_blank" rel="noreferrer"
                            aria-label={`${shortName(run.workflow)} run on GitHub`}>↗</a>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
