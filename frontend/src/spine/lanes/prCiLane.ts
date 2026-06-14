import type { DashboardState, LaneStatus } from '../../types';

export function prCiLane(repos: DashboardState['repos']): { status: LaneStatus; summary: string } {
  const prs = repos.flatMap((r) => r.prs);
  const running = prs.filter((p) => p.stage?.stage === 'ci').length;
  const failed = prs.filter((p) => p.stage?.substate === 'ci-failed').length;
  if (failed > 0) return { status: 'red', summary: `${running} running · ${failed} red` };
  if (running === 0) return { status: 'idle', summary: 'idle · no PRs in CI' };
  return { status: 'green', summary: `${running} running` };
}
