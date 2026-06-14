import { useMemo } from 'react';
import type { DashboardState } from './types';
import { buildLaneHealth } from './spine/laneHealth';
import { rollup, LANE_GLYPH, LANE_WORD } from './spine/laneStatus';

/** Global at-a-glance CI health band shown above the tabs. Reads the SAME lane
 *  derivations the Delivery spine renders in detail (via buildLaneHealth), so
 *  the overview and the detail tab can never disagree. A click on the rollup or
 *  any lane chip jumps to the Delivery tab (and scrolls to that lane). */
export function HealthHeader({ state, onJumpToLane }: {
  state: DashboardState;
  onJumpToLane: (laneId: string | null) => void;
}) {
  const lanes = useMemo(() => buildLaneHealth(state), [state]);
  const roll = useMemo(() => rollup(lanes), [lanes]);
  const allGreen = roll.state === 'green';

  return (
    <div className="health-header" role="group" aria-label="Overall CI health">
      <button
        type="button"
        className={`health-rollup r-${roll.state}`}
        data-testid="health-rollup"
        aria-label={allGreen
          ? 'All lanes healthy — open the Delivery tab'
          : `${roll.count} lane${roll.count === 1 ? '' : 's'} need attention — open the Delivery tab`}
        onClick={() => onJumpToLane(roll.firstAttentionId)}
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
              onClick={() => onJumpToLane(l.id)}
            >
              <span className={`spine-glyph s-${l.status}`} aria-hidden="true">{LANE_GLYPH[l.status]}</span>
              <span className="health-lane-title">{l.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
