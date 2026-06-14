import { useMemo, useState } from 'react';
import type { DashboardState, Lane } from '../types';
import { SpineLane } from './SpineLane';
import { rollup } from './laneStatus';
import { buildLaneHealth } from './laneHealth';
import { ErrorBoundary } from '../ErrorBoundary';
import { scrollBehavior } from '../motion';
import { PrCiPanel } from './panels/PrCiPanel';
import { MergeQueuePanel } from './panels/MergeQueuePanel';
import { MainPanel } from './panels/MainPanel';
import { DeployPanel } from './panels/DeployPanel';
import { ScheduledPanel } from './panels/ScheduledPanel';
import { FailuresPanel } from './panels/FailuresPanel';
import { CostPanel } from './panels/CostPanel';

const LS_KEY = 'prdash.spine.expanded';
function readExpanded(): Set<string> {
  try {
    const r = localStorage.getItem(LS_KEY);
    if (r) {
      const p = JSON.parse(r);
      if (Array.isArray(p)) return new Set(p as string[]);
    }
  } catch { /* ignore */ }
  return new Set();
}

function buildLanes(state: DashboardState | null): Lane[] {
  const repos = state?.repos ?? [];
  // Health (status/summary/wiredness) comes from the shared source of truth so
  // the spine and the global HealthHeader can't drift; the spine alone attaches
  // the expanded-panel renderer per lane id.
  const panelById: Record<string, () => import('react').ReactNode> = {
    'pr-ci': () => <PrCiPanel repos={repos} />,
    'merge-queue': () => <MergeQueuePanel repos={repos} />,
    'main': () => <MainPanel repos={repos} />,
    'deploy': () => <DeployPanel repos={repos} />,
    'scheduled': () => <ScheduledPanel repos={repos} />,
    'failures': () => <FailuresPanel repos={repos} />,
    'cost': () => <CostPanel cost={state?.cost ?? null} />,
  };
  return buildLaneHealth(state).map((h) => ({
    ...h,
    renderExpanded: panelById[h.id] ?? (() => null),
  }));
}

export function DeliverySpine({ state, kiosk }: { state: DashboardState | null; kiosk: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const lanes = useMemo(() => buildLanes(state), [state]);
  const roll = useMemo(() => rollup(lanes), [lanes]);

  const toggle = (id: string) => {
    if (kiosk) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(LS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const jumpToRed = () => {
    if (!roll.firstAttentionId) return;
    setExpanded((p) => new Set(p).add(roll.firstAttentionId!));
    document.getElementById(`spine-lane-${roll.firstAttentionId}`)?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  };

  return (
    <div className="delivery-spine">
      <span role="status" aria-live="polite" aria-atomic="true" className="spine-rollup-live" />
      {!kiosk && (
        <button type="button" data-testid="spine-rollup" className={`spine-rollup r-${roll.state}`}
          aria-label={roll.state === 'green' ? 'All lanes healthy' : `${roll.count} lanes need attention — go to first`}
          onClick={jumpToRed}>
          {roll.state === 'green' ? '● all green' : `${roll.count} lanes need attention`}
        </button>
      )}
      <ul className="spine-rail" role="list">
        {lanes.map((lane) => (
          <ErrorBoundary key={lane.id}>
            <SpineLane lane={lane} expanded={kiosk || expanded.has(lane.id)} onToggle={() => toggle(lane.id)} />
          </ErrorBoundary>
        ))}
      </ul>
    </div>
  );
}
