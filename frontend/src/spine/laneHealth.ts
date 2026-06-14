import type { DashboardState, Lane } from '../types';
import { prCiLane } from './lanes/prCiLane';
import { mergeQueueLane } from './lanes/mergeQueueLane';
import { mainLane } from './lanes/mainLane';
import { deployLane } from './lanes/deployLane';
import { scheduledLane } from './lanes/scheduledLane';
import { failuresLane } from './lanes/failuresLane';
import { costLane } from './lanes/costLane';

/** A lane's health facts WITHOUT its expanded-panel renderer — the serializable
 *  half of {@link Lane}. Single source of truth for lane status: the Delivery
 *  spine re-attaches `renderExpanded` by id, and the global HealthHeader reads
 *  these straight, so the overview and the detail tab can never drift. */
export type LaneHealth = Omit<Lane, 'renderExpanded'>;

/** Derive every lane's status/summary/wiredness from the dashboard state.
 *  Order is the lifecycle order shown on the rail and in the header. */
export function buildLaneHealth(state: DashboardState | null): LaneHealth[] {
  const repos = state?.repos ?? [];
  const prc = state ? prCiLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const mq = state ? mergeQueueLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const ml = state ? mainLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const dp = state ? deployLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const sl = state ? scheduledLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const fl = state ? failuresLane(repos) : { status: 'blind' as const, summary: 'loading…' };
  const cl = state ? costLane(state.cost) : { status: 'blind' as const, summary: 'loading…' };
  // Advisory + not-wired whenever no repo ships a deploy snapshot, so the lane
  // is excluded from the worst-wins rollup (it must never red the spine).
  const deployWired = repos.some((r) => r.deploy);
  // Scheduled is gating, but not-wired (excluded from the rollup) whenever no
  // repo has discovered scheduled workflows — a spine with no nightly can't red.
  const scheduledWired = repos.some((r) => r.scheduled && r.scheduled.discovered > 0);

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
    { id: 'pr-ci', title: 'PR CI', glyphPosition: 'dot', wiredness: 'wired', gating: true,
      status: prc.status, summary: prc.summary, costChip: stageDollars('pr') },
    { id: 'merge-queue', title: 'Merge queue', glyphPosition: 'dot', wiredness: 'wired', gating: true,
      status: mq.status, summary: mq.summary, costChip: stageDollars('queue') },
    { id: 'main', title: 'main', glyphPosition: 'dot', wiredness: 'wired', gating: true,
      status: ml.status, summary: ml.summary, costChip: stageDollars('main') },
    { id: 'deploy', title: 'Deploy', glyphPosition: 'dot',
      wiredness: deployWired ? 'wired' : 'not-wired', gating: false,
      status: dp.status, summary: dp.summary },
    { id: 'scheduled', title: 'Scheduled', glyphPosition: 'dot',
      wiredness: scheduledWired ? 'wired' : 'not-wired', gating: true,
      status: sl.status, summary: sl.summary },
    { id: 'failures', title: 'Failures & flake', glyphPosition: 'crosscut',
      wiredness: 'wired', gating: false,
      status: fl.status, summary: fl.summary, costChip: undefined },
    { id: 'cost', title: 'Cost', glyphPosition: 'crosscut',
      wiredness: costWired ? 'wired' : 'not-wired', gating: false,
      status: cl.status, summary: cl.summary, costChip: undefined },
  ];
}
