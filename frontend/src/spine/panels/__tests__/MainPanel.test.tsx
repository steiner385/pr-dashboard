import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MainPanel } from '../MainPanel';
import type { DashboardState } from '../../../types';

const repos = (lh: object | undefined) =>
  [{ repo: 'acme/widgets', hasDeploy: false, prs: [], queue: null, laneHealth: lh }] as unknown as DashboardState['repos'];

describe('MainPanel', () => {
  it('shows the last-green commit and renders a sparkline bar per series point', () => {
    render(<MainPanel repos={repos({ main: 'green', lastGreenSha: 'abc1234def', lastGreenAt: '2026-06-10T10:00:00Z', mainSeries: [{ ok: true }, { ok: false }, { ok: null }] })} />);
    expect(screen.getByText(/abc1234/)).toBeInTheDocument();
    expect(screen.getAllByTestId('spine-main-spark-bar')).toHaveLength(3);
  });
  it('reads as no-signal when no repo has main lane-health', () => {
    render(<MainPanel repos={repos(undefined)} />);
    expect(screen.getByText(/no signal/i)).toBeInTheDocument();
  });
});
