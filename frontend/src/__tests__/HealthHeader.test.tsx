import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HealthHeader } from '../HealthHeader';
import type { DashboardState } from '../types';

// A repo whose only PR failed CI → the PR CI lane is red.
const redState = (): DashboardState => ({
  generatedAt: '', staleSince: null,
  repos: [{ repo: 'acme/widgets', hasDeploy: false, queue: null,
    prs: [{ number: 1, title: 't', url: 'u',
      stage: { stage: 'ci', substate: 'ci-failed', percent: null, etaSeconds: null,
        etaRangeSeconds: null, overdue: false }, queueAheadCount: null, checks: [] }] }],
}) as unknown as DashboardState;

// No PRs in CI, main green, no deploy/scheduled/cost data → nothing needs attention.
const greenState = (): DashboardState => ({
  generatedAt: '', staleSince: null,
  repos: [{ repo: 'acme/widgets', hasDeploy: false, prs: [], queue: null,
    laneHealth: { main: 'green', lastGreenSha: 'abc1234', lastGreenAt: '2026-06-10T10:00:00Z',
      mainSeries: [{ ok: true }] } }],
}) as unknown as DashboardState;

describe('HealthHeader', () => {
  it('renders the rollup pill and one chip per lifecycle lane', () => {
    render(<HealthHeader state={redState()} onJumpToLane={vi.fn()} />);
    expect(screen.getByTestId('health-rollup')).toBeInTheDocument();
    for (const id of ['pr-ci', 'merge-queue', 'main', 'deploy', 'scheduled', 'failures', 'cost']) {
      expect(screen.getByTestId(`health-lane-${id}`)).toBeInTheDocument();
    }
  });

  it('rolls up to "need attention" when a wired lane is red', () => {
    render(<HealthHeader state={redState()} onJumpToLane={vi.fn()} />);
    expect(screen.getByTestId('health-rollup')).toHaveTextContent(/need attention/i);
    expect(screen.getByTestId('health-rollup')).toHaveClass('r-red');
  });

  it('rolls up to all-green when nothing needs attention', () => {
    render(<HealthHeader state={greenState()} onJumpToLane={vi.fn()} />);
    const rollup = screen.getByTestId('health-rollup');
    expect(rollup).toHaveTextContent(/all systems green/i);
    expect(rollup).toHaveClass('r-green');
  });

  it('clicking the rollup jumps to the first lane needing attention', () => {
    const onJump = vi.fn();
    render(<HealthHeader state={redState()} onJumpToLane={onJump} />);
    fireEvent.click(screen.getByTestId('health-rollup'));
    expect(onJump).toHaveBeenCalledWith('pr-ci');   // the red lane
  });

  it('clicking a lane chip jumps to that lane', () => {
    const onJump = vi.fn();
    render(<HealthHeader state={greenState()} onJumpToLane={onJump} />);
    fireEvent.click(screen.getByTestId('health-lane-main'));
    expect(onJump).toHaveBeenCalledWith('main');
  });

  it('dims lanes with no data source (not-wired)', () => {
    render(<HealthHeader state={greenState()} onJumpToLane={vi.fn()} />);
    // no repo ships deploy/scheduled data and no rates → those lanes are not-wired
    expect(screen.getByTestId('health-lane-deploy')).toHaveClass('not-wired');
    expect(screen.getByTestId('health-lane-cost')).toHaveClass('not-wired');
    // a wired lane is not dimmed
    expect(screen.getByTestId('health-lane-main')).not.toHaveClass('not-wired');
  });

  it('lane chip exposes its title + summary to assistive tech via aria-label', () => {
    render(<HealthHeader state={redState()} onJumpToLane={vi.fn()} />);
    expect(screen.getByTestId('health-lane-pr-ci'))
      .toHaveAttribute('aria-label', expect.stringContaining('PR CI'));
  });
});
