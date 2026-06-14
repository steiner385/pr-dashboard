import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScheduledPanel } from '../ScheduledPanel';
import type { DashboardState } from '../../../types';

const run = (workflow: string, conclusion: string | null, over: object = {}) =>
  ({ workflow, conclusion, status: conclusion ? 'completed' : 'in_progress',
    createdAt: '2026-06-13T06:00:00Z', htmlUrl: `https://github.com/x/runs/${workflow}`, ...over });

const repo = (over: object) => ({ repo: 'cairnea/KinDash', hasDeploy: false, prs: [], queue: null, ...over });

describe('ScheduledPanel', () => {
  it('shows an empty note when no repo has scheduled workflows', () => {
    render(<ScheduledPanel repos={[repo({})] as unknown as DashboardState['repos']} />);
    expect(screen.getByText(/no scheduled workflows/i)).toBeInTheDocument();
  });

  it('renders a row per latest run: name, glyph, relative time, and a link', () => {
    const repos = [repo({ scheduled: { discovered: 2, runs: [
      run('nightly.yml', 'success'), run('weekly.yml', 'failure'),
    ] } })];
    render(<ScheduledPanel repos={repos as unknown as DashboardState['repos']} />);
    const rows = screen.getAllByTestId('spine-scheduled-run');
    expect(rows).toHaveLength(2);
    const nightly = screen.getByTestId('spine-scheduled-run-nightly.yml');
    expect(nightly).toHaveTextContent(/nightly/);
    // the link points at the run's html_url
    const link = nightly.querySelector('a');
    expect(link).toHaveAttribute('href', 'https://github.com/x/runs/nightly.yml');
  });

  it('marks a failing run with the fail glyph and a passing run with the ok glyph', () => {
    const repos = [repo({ scheduled: { discovered: 2, runs: [
      run('nightly.yml', 'success'), run('weekly.yml', 'failure'),
    ] } })];
    render(<ScheduledPanel repos={repos as unknown as DashboardState['repos']} />);
    expect(screen.getByTestId('spine-scheduled-run-nightly.yml')).toHaveTextContent('✓');
    expect(screen.getByTestId('spine-scheduled-run-weekly.yml')).toHaveTextContent('✗');
  });

  it('shows an in-progress (●) glyph for a run with no conclusion', () => {
    const repos = [repo({ scheduled: { discovered: 1, runs: [run('audit.yml', null)] } })];
    render(<ScheduledPanel repos={repos as unknown as DashboardState['repos']} />);
    expect(screen.getByTestId('spine-scheduled-run-audit.yml')).toHaveTextContent('●');
  });

  it('notes discovered-but-no-runs when a repo has scheduled workflows but none recorded', () => {
    const repos = [repo({ scheduled: { discovered: 3, runs: [] } })];
    render(<ScheduledPanel repos={repos as unknown as DashboardState['repos']} />);
    expect(screen.getByText(/no runs/i)).toBeInTheDocument();
  });

  it('labels each repo when more than one repo has scheduled workflows', () => {
    const repos = [
      repo({ scheduled: { discovered: 1, runs: [run('nightly.yml', 'success')] } }),
      { ...repo({ scheduled: { discovered: 1, runs: [run('weekly.yml', 'success')] } }), repo: 'other/repo' },
    ];
    render(<ScheduledPanel repos={repos as unknown as DashboardState['repos']} />);
    expect(screen.getByText('cairnea/KinDash')).toBeInTheDocument();
    expect(screen.getByText('other/repo')).toBeInTheDocument();
  });
});
