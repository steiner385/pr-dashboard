import { useMemo, useState } from 'react';
import type { DashboardState, Lane } from '../types';
import { SpineLane } from './SpineLane';
import { rollup } from './laneStatus';
import { ErrorBoundary } from '../ErrorBoundary';
import { prCiLane } from './lanes/prCiLane';
import { mergeQueueLane } from './lanes/mergeQueueLane';
import { mainLane } from './lanes/mainLane';
import { scrollBehavior } from '../motion';

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
  const prc = state ? prCiLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const mq = state ? mergeQueueLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const ml = state ? mainLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  return [
    {
      id: 'pr-ci', title: 'PR CI', glyphPosition: 'dot', wiredness: 'wired', gating: true,
      status: prc.status, summary: prc.summary, renderExpanded: () => null,
    },
    {
      id: 'merge-queue', title: 'Merge queue', glyphPosition: 'dot', wiredness: 'wired', gating: true,
      status: mq.status, summary: mq.summary, renderExpanded: () => null,
    },
    {
      id: 'main', title: 'main', glyphPosition: 'dot', wiredness: 'wired', gating: true,
      status: ml.status, summary: ml.summary, renderExpanded: () => null,
    },
  ];
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
