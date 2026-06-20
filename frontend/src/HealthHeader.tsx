import { useMemo } from 'react';
import type { DashboardState, LaneStatus } from './types';
import { buildLaneHealth } from './spine/laneHealth';
import { rollup, LANE_GLYPH, LANE_WORD } from './spine/laneStatus';

/** Global at-a-glance CI health band shown above the tabs. Reads the SAME lane
 *  derivations the Delivery spine renders in detail (via buildLaneHealth), so
 *  the overview and the detail tab can never disagree. A click routes to the
 *  richest detail for that lane (App owns the routing); the status is passed so
 *  PR CI can land on the matching Pipeline filter. */
export function HealthHeader({ state, onJumpToLane }: {
  state: DashboardState;
  onJumpToLane: (laneId: string | null, status: LaneStatus | null) => void;
}) {
  const lanes = useMemo(() => buildLaneHealth(state), [state]);
  const roll = useMemo(() => rollup(lanes), [lanes]);
  const allGreen = roll.state === 'green';
  const firstAttentionStatus =
    lanes.find((l) => l.id === roll.firstAttentionId)?.status ?? null;

  return (
    <div className="health-header" role="group" aria-label="Overall CI health">
      <button
        type="button"
        className={`health-rollup r-${roll.state}`}
        data-testid="health-rollup"
        aria-label={allGreen
          ? 'All lanes healthy — open the Delivery tab'
          : `${roll.count} lane${roll.count === 1 ? '' : 's'} need attention — open the Delivery tab`}
        onClick={() => onJumpToLane(roll.firstAttentionId, firstAttentionStatus)}
      >
        <span className={`spine-glyph s-${roll.state}`} aria-hidden="true">{LANE_GLYPH[roll.state]}</span>
        <span className="health-rollup-label">
          {allGreen ? 'All systems green'
            : `${roll.count} lane${roll.count === 1 ? '' : 's'} need attention`}
        </span>
      </button>
      <ul className="health-lanes" role="list">
        {lanes.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              className={`health-lane${l.wiredness === 'not-wired' ? ' not-wired' : ''}`}
              data-testid={`health-lane-${l.id}`}
              aria-label={`${l.title}: ${LANE_WORD[l.status]} — ${l.summary}`}
              title={`${l.title} — ${l.summary}`}
              onClick={() => onJumpToLane(l.id, l.status)}
            >
              <span className={`spine-glyph s-${l.status}`} aria-hidden="true">{LANE_GLYPH[l.status]}</span>
              <span className="health-lane-title">{l.title}</span>
              {/* #189: surface the already-computed lane summary inline on
                  non-green chips (was hover-only); the full text stays in aria-label. */}
              {l.status !== 'green' && l.summary && (
                <span className="health-lane-summary" aria-hidden="true">{l.summary}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
