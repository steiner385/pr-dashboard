// Health section (spec 001, US1 / FR-005): the live monitor. Composes the existing
// HealthHeader (lane band) with an attention-sorted fleet roll-up so "healthy vs
// needs-attention" is answerable at a glance (SC-001) and a problem is one click
// away (SC-002). Pure roll-up + a thin presentational component; data is the live
// DashboardState (Tier-1).
import type { DashboardState, LaneStatus } from '../../types';
import { HealthHeader } from '../../HealthHeader';
import { fleetLeaderboard } from './leaderboard';

export type RepoVerdict = 'down' | 'attention' | 'healthy';
export interface RepoRollup { repo: string; prCount: number; verdict: RepoVerdict; reason: string }

const RANK: Record<RepoVerdict, number> = { down: 0, attention: 1, healthy: 2 };

/** Per-repo verdict from the live state: main-lane red = down; amber / blocked
 *  queue / conflicts = attention; else healthy. Pure + testable. */
export function fleetRollup(state: DashboardState): RepoRollup[] {
  const rows = state.repos.map((r): RepoRollup => {
    const main: LaneStatus | undefined = r.laneHealth?.main;
    const blocked = (r.queue?.queueBlocked?.length ?? 0) + (r.queue?.unmergeable?.length ?? 0);
    let verdict: RepoVerdict = 'healthy';
    let reason = 'healthy';
    if (main === 'red') { verdict = 'down'; reason = 'main is red'; }
    else if (main === 'amber') { verdict = 'attention'; reason = 'main is amber'; }
    if (blocked > 0 && verdict !== 'down') { verdict = 'attention'; reason = `${blocked} queue entr${blocked === 1 ? 'y' : 'ies'} blocked`; }
    return { repo: r.repo, prCount: r.prs.length, verdict, reason };
  });
  // attention-first (FR-005), then busiest first within a verdict band
  return rows.sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || b.prCount - a.prCount || a.repo.localeCompare(b.repo));
}

export interface HealthViewProps {
  state: DashboardState;
  connected: boolean;
  onJumpToLane?: (laneId: string | null, status: LaneStatus | null) => void;
  onFocusRepo?: (repo: string) => void;
}

export function HealthView({ state, connected, onJumpToLane, onFocusRepo }: HealthViewProps) {
  const fleet = fleetRollup(state);
  const leaderboard = fleetLeaderboard(state).filter((r) => r.flakyChecks > 0).slice(0, 5);
  return (
    <div className="health-view">
      {!connected && (
        <div className="health-liveness" role="status">Reconnecting to the live feed…</div>
      )}
      <HealthHeader state={state} onJumpToLane={onJumpToLane ?? (() => {})} />
      <section className="fleet-rollup" aria-label="Pipeline fleet">
        <h2 className="fleet-rollup-title">Pipelines ({fleet.length})</h2>
        <ul role="list">
          {fleet.map((r) => (
            <li key={r.repo} className={`fleet-row verdict-${r.verdict}`} data-verdict={r.verdict}>
              <button type="button" className="fleet-row-btn" onClick={() => onFocusRepo?.(r.repo)}
                aria-label={`${r.repo} — ${r.prCount} PRs, ${r.verdict}: ${r.reason}`}>
                <span className="fleet-repo">{r.repo}</span>
                <span className="fleet-prs">{r.prCount} PR{r.prCount === 1 ? '' : 's'}</span>
                <span className="fleet-verdict" aria-hidden="true" title={r.reason}>{r.verdict === 'healthy' ? '✓' : r.verdict === 'attention' ? '⚠' : '✕'}</span>
              </button>
            </li>
          ))}
          {fleet.length === 0 && <li className="fleet-row empty">No pipelines watched.</li>}
        </ul>
      </section>
      {leaderboard.length > 0 && (
        <section className="fleet-leaderboard" aria-label="Flakiest pipelines">
          <h3 className="fleet-leaderboard-title">Flakiest pipelines</h3>
          <ol>
            {leaderboard.map((r) => (
              <li key={r.repo} className="leaderboard-row">
                <button type="button" className="leaderboard-row-btn" onClick={() => onFocusRepo?.(r.repo)}
                  aria-label={`${r.repo} — ${r.flakyChecks} flaky checks`}>
                  <span className="leaderboard-repo">{r.repo}</span>
                  <span className="leaderboard-flaky">{r.flakyChecks} flaky check{r.flakyChecks === 1 ? '' : 's'}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
