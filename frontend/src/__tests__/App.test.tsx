import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { App } from '../App';
import { useDashboard } from '../useDashboard';
import type { DashboardHook } from '../useDashboard';
import type { DashboardState, PrView } from '../types';

vi.mock('../useDashboard');
const mockUseDashboard = vi.mocked(useDashboard);

const prView = (number: number): PrView => ({
  repo: 'x', number, title: `pr ${number}`, url: `https://x/${number}`,
  stage: { stage: 'ci', substate: null, percent: 10, etaSeconds: null, etaRangeSeconds: null, overdue: false },
  queueAheadCount: null,
  checks: [], groupChecks: null,
});

const STATE: DashboardState = {
  generatedAt: '2026-06-10T12:00:00Z', staleSince: null,
  repos: [
    { repo: 'acme/widgets', hasDeploy: true, prs: [prView(1)], queue: null },
    { repo: 'octo/bridge', hasDeploy: false, prs: [prView(2)], queue: null },
  ],
};

const hook = (overrides?: Partial<DashboardHook>): DashboardHook =>
  ({ state: STATE, connected: true, ...overrides });

beforeEach(() => {
  mockUseDashboard.mockReturnValue(hook());
});

describe('App', () => {
  it('uses the server-provided hasDeploy per repo group (5-node vs 3-node track)', () => {
    render(<App />);
    const tracks = screen.getAllByLabelText(/stage \d+ of \d+/);
    // deploy repo renders the 5-stage track (CI/Queue/Merged/QA/Prod), non-deploy the 3-stage one
    expect(tracks[0]).toHaveAttribute('aria-label', 'stage 1 of 5');
    expect(tracks[1]).toHaveAttribute('aria-label', 'stage 1 of 3');
  });

  it('renders a loading state until the first SSE frame', () => {
    mockUseDashboard.mockReturnValue(hook({ state: null }));
    render(<App />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders disconnected badge when connected=false', () => {
    mockUseDashboard.mockReturnValue(hook({ connected: false }));
    render(<App />);
    expect(screen.getByText('disconnected — retrying…')).toBeInTheDocument();
    const badge = screen.getByText('disconnected — retrying…');
    expect(badge.className).toContain('stale');
  });

  it('does not render disconnected badge when connected=true', () => {
    render(<App />);
    expect(screen.queryByText('disconnected — retrying…')).not.toBeInTheDocument();
  });

  it('shows the "live · updated" stamp while connected', () => {
    render(<App />);
    expect(screen.getByText(/^live · updated /)).toBeInTheDocument();
  });

  it('hides the updated stamp while disconnected (badge covers the state)', () => {
    mockUseDashboard.mockReturnValue(hook({ connected: false }));
    render(<App />);
    expect(screen.queryByText(/updated /)).not.toBeInTheDocument();
    expect(screen.getByText('disconnected — retrying…')).toBeInTheDocument();
  });

  it('StatusStrip filter hides non-matching rows and shows (n hidden) in section header', () => {
    // repo1: 1 ci PR; repo2: 1 ci PR — filter by "running" (ci): all visible, no hidden
    render(<App />);
    const strip = screen.getByRole('group', { name: 'Status overview' });
    const runningTile = within(strip).getAllByRole('button')[0]!; // first tile = running
    fireEvent.click(runningTile);
    // both repos have ci PRs so nothing is hidden
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument();
  });

  it('StatusStrip filter collapses repos with zero matching PRs to show (n hidden)', () => {
    const ciPr: PrView = { ...prView(10), stage: { stage: 'ci', substate: null, percent: null,
      etaSeconds: null, etaRangeSeconds: null, overdue: false } };
    const queuePr: PrView = { ...prView(20), stage: { stage: 'queue', substate: null, percent: null,
      etaSeconds: null, etaRangeSeconds: null, overdue: false } };
    // repo1 has only a ci PR; repo2 has only a queue PR
    mockUseDashboard.mockReturnValue(hook({ state: { ...STATE, repos: [
      { repo: 'acme/widgets', hasDeploy: true, prs: [ciPr], queue: null },
      { repo: 'octo/bridge', hasDeploy: false, prs: [queuePr], queue: null },
    ] } }));
    render(<App />);
    const strip = screen.getByRole('group', { name: 'Status overview' });
    const runningTile = within(strip).getAllByRole('button')[0]!; // first tile = running
    fireEvent.click(runningTile);
    // repo2 has a queue PR, not ci → (1 hidden) shown for that repo
    expect(screen.getByText(/\(1 hidden\)/)).toBeInTheDocument();
    // repo1's ci PR should still be visible
    expect(screen.getByText('#10')).toBeInTheDocument();
    // repo2's queue PR should be hidden
    expect(screen.queryByText('#20')).not.toBeInTheDocument();
  });

  it('merged rows filter under the idle tile, not Awaiting prod', () => {
    const ciPr: PrView = { ...prView(10), stage: { stage: 'ci', substate: null, percent: null,
      etaSeconds: null, etaRangeSeconds: null, overdue: false } };
    const mergedPr: PrView = { ...prView(30), stage: { stage: 'merged', substate: null, percent: null,
      etaSeconds: null, etaRangeSeconds: null, overdue: false } };
    // non-deploy repo: merged is the retention-window stage, not a deploy stage
    mockUseDashboard.mockReturnValue(hook({ state: { ...STATE, repos: [
      { repo: 'octo/bridge', hasDeploy: false, prs: [ciPr, mergedPr], queue: null },
    ] } }));
    render(<App />);
    const strip = screen.getByRole('group', { name: 'Status overview' });
    const tiles = within(strip).getAllByRole('button');
    const deployTile = tiles[2]!; // third tile = deploy (Awaiting prod)
    const idleTile = tiles[4]!;   // fifth tile = idle (Ready / other)
    // deploy bucket is empty (merged no longer counts) → tile disabled
    expect(deployTile).toHaveAttribute('disabled');
    // filtering by idle shows the merged row and hides the ci row
    fireEvent.click(idleTile);
    expect(screen.getByText('#30')).toBeInTheDocument();
    expect(screen.queryByText('#10')).not.toBeInTheDocument();
    expect(screen.getByText(/\(1 hidden\)/)).toBeInTheDocument();
  });

  it('clicking active tile again clears the filter', () => {
    const queuePr: PrView = { ...prView(20), stage: { stage: 'queue', substate: null, percent: null,
      etaSeconds: null, etaRangeSeconds: null, overdue: false } };
    mockUseDashboard.mockReturnValue(hook({ state: { ...STATE, repos: [
      { repo: 'acme/widgets', hasDeploy: true, prs: [prView(1), queuePr], queue: null },
    ] } }));
    render(<App />);
    const strip = screen.getByRole('group', { name: 'Status overview' });
    const runningTile = within(strip).getAllByRole('button')[0]!; // first tile = running
    // filter to running
    fireEvent.click(runningTile);
    expect(screen.queryByText('#20')).not.toBeInTheDocument();
    // click running again to clear
    fireEvent.click(runningTile);
    expect(screen.getByText('#20')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Round 12 (metrics tab): Pipeline | Metrics tab bar
// ---------------------------------------------------------------------------

vi.mock('../MetricsView', () => ({
  MetricsView: () => <div data-testid="metrics-view-stub">metrics-view</div>,
}));

describe('App tab bar', () => {
  it('renders a tablist with Pipeline selected by default; pipeline content visible', () => {
    render(<App />);
    const tablist = screen.getByRole('tablist', { name: 'Dashboard views' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Pipeline', 'Metrics']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    // pipeline content (status strip + repos) is rendered, metrics is not
    expect(screen.getByRole('group', { name: 'Status overview' })).toBeInTheDocument();
    expect(screen.queryByTestId('metrics-view-stub')).not.toBeInTheDocument();
  });

  it('tabs wire aria-controls to tabpanel ids that exist in the DOM', () => {
    render(<App />);
    for (const tab of screen.getAllByRole('tab')) {
      const controls = tab.getAttribute('aria-controls')!;
      expect(document.getElementById(controls)).not.toBeNull();
    }
  });

  it('switching to Metrics shows MetricsView and hides the pipeline panel', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(screen.getByRole('tab', { name: 'Metrics' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('metrics-view-stub')).toBeInTheDocument();
    expect(document.getElementById('tabpanel-pipeline')).toHaveAttribute('hidden');
    expect(document.getElementById('tabpanel-metrics')).not.toHaveAttribute('hidden');
  });

  it('switching back to Pipeline restores the board (state preserved, panel unhidden)', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }));
    expect(document.getElementById('tabpanel-pipeline')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('group', { name: 'Status overview' })).toBeInTheDocument();
    // metrics stays mounted (no refetch churn) but hidden
    expect(document.getElementById('tabpanel-metrics')).toHaveAttribute('hidden');
  });

  // ---- legend (? button + slide-over) ----

  describe('legend', () => {
    it('header has a ? button labelled Legend that opens the legend dialog', () => {
      render(<App />);
      const btn = screen.getByRole('button', { name: 'Legend' });
      expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
      expect(btn).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(btn);
      expect(btn).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('heading', { name: 'Legend' })).toBeInTheDocument();
    });

    it('Esc closes the legend and focus returns to the ? button', () => {
      render(<App />);
      const btn = screen.getByRole('button', { name: 'Legend' });
      fireEvent.click(btn);
      expect(screen.getByRole('heading', { name: 'Legend' })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('heading', { name: 'Legend' })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(btn);
    });
  });
});
