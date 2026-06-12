import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
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
  checks: [], groupChecks: null, mergeEtaSim: null,
});

const STATE: DashboardState = {
  generatedAt: '2026-06-10T12:00:00Z', staleSince: null,
  repos: [
    { repo: 'acme/widgets', hasDeploy: true, prs: [prView(1)], queue: null },
    { repo: 'octo/bridge', hasDeploy: false, prs: [prView(2)], queue: null },
  ],
};

const hook = (overrides?: Partial<DashboardHook>): DashboardHook =>
  ({ state: STATE, connected: true,
    notifySupported: true, notifyEnabled: false, toggleNotify: vi.fn(), ...overrides });

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

// `metricsBomb.throws` lets the error-boundary tests crash MetricsView on demand.
const metricsBomb = vi.hoisted(() => ({ throws: false }));
vi.mock('../MetricsView', () => ({
  MetricsView: () => {
    if (metricsBomb.throws) throw new Error('metrics exploded');
    return <div data-testid="metrics-view-stub">metrics-view</div>;
  },
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

  // ---- per-tab error boundary ----

  describe('per-tab error boundary', () => {
    beforeEach(() => {
      // React logs caught render errors — silence them for these tests only
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      metricsBomb.throws = false;
      vi.restoreAllMocks();
    });

    it('a crash in the Metrics tab renders the inline fallback instead of white-screening', () => {
      metricsBomb.throws = true;
      render(<App />);
      fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'something broke rendering this tab — metrics exploded — try refresh');
    });

    it('the Pipeline tab still works after the Metrics tab crashed', () => {
      metricsBomb.throws = true;
      render(<App />);
      fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
      expect(screen.getByRole('alert')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }));
      expect(document.getElementById('tabpanel-pipeline')).not.toHaveAttribute('hidden');
      expect(screen.getByRole('group', { name: 'Status overview' })).toBeInTheDocument();
      expect(screen.getAllByText(/pr \d/).length).toBeGreaterThan(0);
    });
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

// ---------------------------------------------------------------------------
// Kiosk mode (issue #20): ?kiosk=1 read-only wall-display view + auto-cycling
// ---------------------------------------------------------------------------

describe('App kiosk mode (issue #20)', () => {
  const setUrl = (search: string) => window.history.replaceState(null, '', `/${search}`);
  type ScrollIntoViewFn = (arg?: boolean | ScrollIntoViewOptions) => void;
  let scrollIntoView: ReturnType<typeof vi.fn<ScrollIntoViewFn>>;

  beforeEach(() => {
    scrollIntoView = vi.fn<ScrollIntoViewFn>();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    setUrl('');
    delete (document as { hidden?: boolean }).hidden;
    localStorage.removeItem('prdash.collapsed');
    vi.useRealTimers();
  });

  it('?kiosk=1 hides the gear, legend, bell, and tab bar; status strip stays', () => {
    setUrl('?kiosk=1');
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Legend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Browser notifications (this tab)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    // the glanceable summary strip stays
    expect(screen.getByRole('group', { name: 'Status overview' })).toBeInTheDocument();
  });

  it('adds the kiosk class to the app root', () => {
    setUrl('?kiosk=1');
    const { container } = render(<App />);
    expect(container.querySelector('main.app')!.className).toContain('kiosk');
  });

  it('non-kiosk root has no kiosk class', () => {
    const { container } = render(<App />);
    expect(container.querySelector('main.app')!.className).not.toContain('kiosk');
  });

  it('status tiles are non-interactive in kiosk (no buttons in the strip)', () => {
    setUrl('?kiosk=1');
    render(<App />);
    const strip = screen.getByRole('group', { name: 'Status overview' });
    expect(within(strip).queryAllByRole('button')).toHaveLength(0);
    // counts/labels still render
    expect(within(strip).getByText('CI running')).toBeInTheDocument();
  });

  it('PR rows are non-expandable in kiosk (click does not open the check panel)', () => {
    setUrl('?kiosk=1');
    const checkedPr: PrView = { ...prView(1), checks: [
      { name: 'fast-checks / ESLint', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true,
        workflowName: null, elapsedSeconds: 180, expectedSeconds: 200, url: null,
        expectedLowSeconds: null, expectedHighSeconds: null,
        waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false },
    ] };
    mockUseDashboard.mockReturnValue(hook({ state: { ...STATE, repos: [
      { repo: 'acme/widgets', hasDeploy: true, prs: [checkedPr], queue: null },
    ] } }));
    render(<App />);
    fireEvent.click(screen.getByText('#1'));
    expect(screen.queryByText('fast-checks / ESLint')).not.toBeInTheDocument();
  });

  it('repo headers are plain headings (not collapse buttons) and persisted collapse is ignored', () => {
    localStorage.setItem('prdash.collapsed', JSON.stringify(['acme/widgets']));
    setUrl('?kiosk=1');
    render(<App />);
    expect(screen.queryByRole('button', { name: /acme\/widgets/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'acme/widgets' })).toBeInTheDocument();
    // collapsed state from localStorage must not hide rows on a wall display
    expect(screen.getByText('#1')).toBeInTheDocument();
  });

  it('cycles repo → repo → metrics on the cycle timer, then wraps to the first repo', () => {
    setUrl('?kiosk=1&cycle=10');
    vi.useFakeTimers();
    render(<App />);
    // initial view = first repo section (scrolled into view on mount)
    expect((scrollIntoView.mock.contexts.at(-1) as HTMLElement).id).toBe('repo-section-0');

    act(() => { vi.advanceTimersByTime(10_000); });
    expect((scrollIntoView.mock.contexts.at(-1) as HTMLElement).id).toBe('repo-section-1');
    expect(document.getElementById('tabpanel-pipeline')).not.toHaveAttribute('hidden');

    act(() => { vi.advanceTimersByTime(10_000); });
    // final view = Metrics (trends panel visible)
    expect(screen.getByTestId('metrics-view-stub')).toBeInTheDocument();
    expect(document.getElementById('tabpanel-pipeline')).toHaveAttribute('hidden');
    expect(document.getElementById('tabpanel-metrics')).not.toHaveAttribute('hidden');

    act(() => { vi.advanceTimersByTime(10_000); });
    // wraps back to the pipeline / first repo
    expect(document.getElementById('tabpanel-pipeline')).not.toHaveAttribute('hidden');
    expect((scrollIntoView.mock.contexts.at(-1) as HTMLElement).id).toBe('repo-section-0');
  });

  it('pauses cycling while document.hidden, resumes when visible', () => {
    setUrl('?kiosk=1&cycle=10');
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    render(<App />);
    const callsAfterMount = scrollIntoView.mock.calls.length;
    act(() => { vi.advanceTimersByTime(30_000); });
    // no advancement while hidden
    expect(scrollIntoView.mock.calls.length).toBe(callsAfterMount);
    expect(document.getElementById('tabpanel-pipeline')).not.toHaveAttribute('hidden');
    // tab becomes visible again → next tick advances
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect((scrollIntoView.mock.contexts.at(-1) as HTMLElement).id).toBe('repo-section-1');
  });

  it('does not run a cycle timer outside kiosk mode', () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.getElementById('tabpanel-pipeline')).not.toHaveAttribute('hidden');
  });
});

describe('App notification bell (issue #19)', () => {
  it('renders the bell with aria-pressed=false when disabled', () => {
    render(<App />);
    const bell = screen.getByRole('button', { name: 'Browser notifications (this tab)' });
    expect(bell).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders aria-pressed=true when enabled', () => {
    mockUseDashboard.mockReturnValue(hook({ notifyEnabled: true }));
    render(<App />);
    expect(screen.getByRole('button', { name: 'Browser notifications (this tab)' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking the bell calls toggleNotify', () => {
    const toggleNotify = vi.fn();
    mockUseDashboard.mockReturnValue(hook({ toggleNotify }));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Browser notifications (this tab)' }));
    expect(toggleNotify).toHaveBeenCalledTimes(1);
  });

  it('hides the bell entirely when the browser lacks Notification support', () => {
    mockUseDashboard.mockReturnValue(hook({ notifySupported: false }));
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Browser notifications (this tab)' }))
      .not.toBeInTheDocument();
  });

  it('documents the tab-must-stay-open caveat in the bell tooltip', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Browser notifications (this tab)' }))
      .toHaveAttribute('title', expect.stringContaining('tab must stay open'));
  });
});
