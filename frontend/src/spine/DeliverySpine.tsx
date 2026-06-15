import { useEffect, useMemo, useState } from 'react';
import type { DashboardState, Lane } from '../types';
import { SpineLane } from './SpineLane';
import { rollup, attentionLanes } from './laneStatus';
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

export function DeliverySpine({ state, kiosk, focus, hideRollup = false }: {
  state: DashboardState | null;
  kiosk: boolean;
  /** Bumped by the global health header: expand this lane, scroll to it, and
   *  move focus there. `nonce` makes a repeat click on the same lane retrigger. */
  focus?: { id: string; nonce: number } | null;
  /** Suppress the spine's own rollup pill when the global HealthHeader band is
   *  already on screen showing the same thing (UX-L2). */
  hideRollup?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const lanes = useMemo(() => buildLanes(state), [state]);
  const roll = useMemo(() => rollup(lanes), [lanes]);
  // Live-region text (UX-H4): announced by screen readers whenever it changes —
  // a lane flipping red, the count moving, or recovery to all-green. Rendered as
  // the region's text content; SRs re-announce only on a real change.
  const liveSummary = useMemo(() => {
    if (roll.state === 'green') return 'All delivery lanes healthy';
    const names = attentionLanes(lanes).map((l) => l.title).join(', ');
    return `${roll.count} ${roll.count === 1 ? 'lane needs' : 'lanes need'} attention: ${names}`;
  }, [roll, lanes]);

  // Auto-expand + reveal a lane requested from the header (not in kiosk, where
  // every lane is already open and the header isn't shown).
  useEffect(() => {
    if (!focus || kiosk) return;
    setExpanded((prev) => {
      if (prev.has(focus.id)) return prev;
      const next = new Set(prev).add(focus.id);
      try { localStorage.setItem(LS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
    // Focus is handled by the target SpineLane (own-component effect, below);
    // here we just bring it into view once expanded.
    requestAnimationFrame(() => {
      document.getElementById(`spine-lane-${focus.id}`)
        ?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'start' });
    });
  }, [focus, kiosk]);

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
      <span role="status" aria-live="polite" aria-atomic="true" className="spine-rollup-live">
        {liveSummary}
      </span>
      {!kiosk && !hideRollup && (
        <button type="button" data-testid="spine-rollup" className={`spine-rollup r-${roll.state}`}
          aria-label={roll.state === 'green' ? 'All lanes healthy' : `${roll.count} lanes need attention — go to first`}
          onClick={jumpToRed}>
          {roll.state === 'green' ? '● all green' : `${roll.count} lanes need attention`}
        </button>
      )}
      <ul className="spine-rail" role="list">
        {lanes.map((lane) => (
          <ErrorBoundary key={lane.id}>
            <SpineLane lane={lane} expanded={kiosk || expanded.has(lane.id)} onToggle={() => toggle(lane.id)}
              focusNonce={focus?.id === lane.id ? focus.nonce : undefined} />
          </ErrorBoundary>
        ))}
      </ul>
    </div>
  );
}
