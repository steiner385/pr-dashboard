import { useMemo, useState } from 'react';
import type { DashboardState, Lane } from '../types';
import { SpineLane } from './SpineLane';
import { rollup } from './laneStatus';
import { ErrorBoundary } from '../ErrorBoundary';
import { prCiLane } from './lanes/prCiLane';
import { mergeQueueLane } from './lanes/mergeQueueLane';
import { mainLane } from './lanes/mainLane';
import { deployLane } from './lanes/deployLane';
import { costLane } from './lanes/costLane';
import { scrollBehavior } from '../motion';
import { PrCiPanel } from './panels/PrCiPanel';
import { MergeQueuePanel } from './panels/MergeQueuePanel';
import { MainPanel } from './panels/MainPanel';
import { DeployPanel } from './panels/DeployPanel';
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
  const prc = state ? prCiLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const mq = state ? mergeQueueLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const ml = state ? mainLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const dp = state ? deployLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const cl = state ? costLane(state.cost) : { status: 'blind' as const, summary: 'loading…' };
  // Advisory + not-wired whenever no repo ships a deploy snapshot, so the lane
  // is excluded from the worst-wins rollup (it must never red the spine).
  const deployWired = repos.some((r) => r.deploy);

  // Per-lane cost chips (Spec 3): weave each linear lane's stage dollars in as a
  // chip, omitted when that stage is unpriced (null) — never a false $0.
  const days = state?.cost?.days ?? 0;
  const stageDollars = (stage: 'pr' | 'queue' | 'main'): { dollars: number; days: number } | undefined => {
    const s = state?.cost?.byStage.find((x) => x.stage === stage);
    return s?.dollars != null ? { dollars: Math.round(s.dollars), days } : undefined;
  };
  // The Cost lane is advisory: not-wired (excluded from the rollup) whenever no
  // rates are configured (blind), so it can never red/blind the spine.
  const costWired = cl.status !== 'blind';

  return [
    {
      id: 'pr-ci', title: 'PR CI', glyphPosition: 'dot', wiredness: 'wired', gating: true,
      status: prc.status, summary: prc.summary, costChip: stageDollars('pr'),
      renderExpanded: () => <PrCiPanel repos={repos} />,
    },
    {
      id: 'merge-queue', title: 'Merge queue', glyphPosition: 'dot', wiredness: 'wired', gating: true,
      status: mq.status, summary: mq.summary, costChip: stageDollars('queue'),
      renderExpanded: () => <MergeQueuePanel repos={repos} />,
    },
    {
      id: 'main', title: 'main', glyphPosition: 'dot', wiredness: 'wired', gating: true,
      status: ml.status, summary: ml.summary, costChip: stageDollars('main'),
      renderExpanded: () => <MainPanel repos={repos} />,
    },
    {
      id: 'deploy', title: 'Deploy', glyphPosition: 'dot',
      wiredness: deployWired ? 'wired' : 'not-wired', gating: false,
      status: dp.status, summary: dp.summary, renderExpanded: () => <DeployPanel repos={repos} />,
    },
    {
      id: 'cost', title: 'Cost', glyphPosition: 'crosscut',
      wiredness: costWired ? 'wired' : 'not-wired', gating: false,
      status: cl.status, summary: cl.summary, costChip: undefined,
      renderExpanded: () => <CostPanel cost={state?.cost ?? null} />,
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
