import type { DashboardState } from '../../types';

/** Display label per stage (scheduled → 'nightly'). */
const STAGE_LABEL: Record<'pr' | 'queue' | 'main' | 'scheduled', string> = {
  pr: 'PR', queue: 'queue', main: 'main', scheduled: 'nightly',
};

/**
 * Drill-down for the Cost lane (Spec 3): the per-stage cost breakdown
 * ($ when priced, % of priced total, runner-minutes), the 7-day total, and the
 * retry-waste %. Advisory — no red/amber surfaces. Empty note when no rates are
 * configured (no `cost`, or every stage dollar is null — minutes-only mode), so
 * it never displays a false $0.
 */
export function CostPanel({ cost }: { cost: DashboardState['cost'] | null }) {
  const stages = cost?.byStage ?? [];
  const priced = stages.filter((s) => s.dollars != null);
  const total = priced.reduce((sum, s) => sum + (s.dollars ?? 0), 0);
  if (!cost || priced.length === 0 || total <= 0) {
    return <p className="spine-panel-empty">Cost — no rates configured.</p>;
  }
  return (
    <div className="spine-cost-panel">
      <div className="spine-cost-total" data-testid="spine-cost-total">
        ${Math.round(total)} · {cost.days}d
      </div>
      <ul className="spine-cost-stages" role="list">
        {cost.byStage.map((s) => {
          const pct = s.dollars != null && total > 0
            ? Math.round((s.dollars / total) * 100) : null;
          return (
            <li key={s.stage} data-testid="spine-cost-stage" className="spine-cost-stage">
              <span data-testid={`spine-cost-stage-${s.stage}`} className="spine-cost-stage-row">
                <span className="spine-cost-stage-name">{STAGE_LABEL[s.stage]}</span>
                {s.dollars != null
                  ? <span className="spine-cost-stage-dollars">${Math.round(s.dollars)}</span>
                  : null}
                {pct != null
                  ? <span className="spine-cost-stage-pct">{pct}%</span>
                  : null}
                <span className="spine-cost-stage-minutes">{Math.round(s.minutes)}m</span>
              </span>
            </li>
          );
        })}
      </ul>
      {cost.retryWastePct != null && (
        <div className="spine-cost-retry" data-testid="spine-cost-retry">
          retry waste {Math.round(cost.retryWastePct)}%
        </div>
      )}
    </div>
  );
}
