import type { DashboardState, LaneStatus } from '../../types';

export function mainLane(repos: DashboardState['repos']): { status: LaneStatus; summary: string } {
  const states = repos.map((r) => r.laneHealth?.main).filter(Boolean) as LaneStatus[];
  if (states.length === 0) return { status: 'blind', summary: 'no signal' };
  const worst: LaneStatus = states.includes('red') ? 'red'
    : states.includes('blind') ? 'blind' : states.includes('amber') ? 'amber'
    : states.includes('green') ? 'green' : 'idle';
  const word = { green: 'green', amber: 'watch', red: 'red', blind: 'no signal', idle: 'idle' }[worst];
  return { status: worst, summary: word };
}
