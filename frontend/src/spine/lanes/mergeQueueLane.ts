import type { DashboardState, LaneStatus } from '../../types';

const MAP: Record<string, LaneStatus> = { 'dispatch-stall': 'red', 'cap-backlog': 'amber', healthy: 'green' };

export function mergeQueueLane(repos: DashboardState['repos']): { status: LaneStatus; summary: string } {
  const queues = repos.map((r) => r.queue).filter((q): q is NonNullable<typeof q> => !!q);
  // A queue is "active" when it has entries OR when its health state signals a problem
  // (dispatch-stall can leave groups/waiting empty while the queue is stuck).
  const active = queues.filter(
    (q) => (q.groups?.length ?? 0) > 0 || (q.waiting?.length ?? 0) > 0 || (q.health?.state && q.health.state !== 'healthy'),
  );
  if (active.length === 0) return { status: 'idle', summary: 'idle · queue empty' };
  let status: LaneStatus = 'green';
  for (const q of active) {
    const s = MAP[q.health?.state ?? 'healthy'] ?? 'blind';
    if (s === 'red') status = 'red';
    else if (s === 'amber' && status !== 'red') status = 'amber';
  }
  const trains = active.reduce((n, q) => n + (q.groups?.length ?? 0), 0);
  return { status, summary: `${trains} train${trains === 1 ? '' : 's'}` };
}
