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
  ({ state: STATE, connected: true, stale: false,
    notifySupported: true, notifyEnabled: false, toggleNotify: vi.fn(), ...overrides });

beforeEach(() => {
  mockUseDashboard.mockReturnValue(hook());
  // Tabs write the URL hash; reset it between tests so one test's navigation
  // can't seed another's initial tab. replaceState doesn't fire hashchange.
  window.history.replaceState(null, '', window.location.pathname);
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

  it('shows the "live · last change" stamp while connected (UX-M5)', () => {
    render(<App />);
    expect(screen.getByText(/live · last change /)).toBeInTheDocument();
  });

  it('hides the last-change stamp while disconnected (badge covers the state)', () => {
    mockUseDashboard.mockReturnValue(hook({ connected: false }));
    render(<App />);
    expect(screen.queryByText(/last change /)).not.toBeInTheDocument();
    expect(screen.getByText('disconnected — retrying…')).toBeInTheDocument();
  });

  it('StatusStrip filter hides non-matching rows and shows (n hidden) in section header', () => {
    // repo1: 1 ci PR; repo2: 1 ci PR — filter by "running" (ci): all visible, no hidden
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }));
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
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }));
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
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }));
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
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }));
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
  it('defaults to the Pipeline tab and shows the board (spine lazy-mounted)', () => {
    render(<App />);
    expect(screen.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('group', { name: 'Status overview' })).toBeInTheDocument();
    // the Delivery spine is not built until its tab is visited
    expect(screen.queryByTestId('spine-lane-pr-ci')).not.toBeInTheDocument();
  });

  it('renders Pipeline | Delivery | Metrics | Designer tabs with Pipeline selected by default', () => {
    render(<App />);
    const tablist = screen.getByRole('tablist', { name: 'Dashboard views' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Pipeline', 'Delivery', 'Metrics', 'Designer']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    // metrics is lazy/hidden until visited
    expect(screen.queryByTestId('metrics-view-stub')).not.toBeInTheDocument();
  });

  it('switching to Delivery mounts the spine and selects the Delivery tab', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: /delivery/i }));
    const tabs = within(screen.getByRole('tablist', { name: 'Dashboard views' })).getAllByRole('tab');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');   // Delivery is now the 2nd tab
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');  // Pipeline
    expect(screen.getByTestId('spine-lane-pr-ci')).toBeInTheDocument();
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

  // ---- URL hash anchors (#pipeline / #delivery / #metrics) ----
  it('writes the active tab to the URL hash on switch, default stays bare', () => {
    render(<App />);
    expect(window.location.hash).toBe('');                  // bare URL = default pipeline
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(window.location.hash).toBe('#metrics');
    fireEvent.click(screen.getByRole('tab', { name: /delivery/i }));
    expect(window.location.hash).toBe('#delivery');
  });

  it('opens the tab named by the initial URL hash (deep link) and mounts it', () => {
    window.history.replaceState(null, '', '#metrics');
    render(<App />);
    expect(screen.getByRole('tab', { name: 'Metrics' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('metrics-view-stub')).toBeInTheDocument();   // lazy-mount seeded
  });

  it('a deep link to #delivery mounts the spine up front', () => {
    window.history.replaceState(null, '', '#delivery');
    render(<App />);
    expect(screen.getByRole('tab', { name: /delivery/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('spine-lane-pr-ci')).toBeInTheDocument();
  });

  it('an unknown hash falls back to the default Pipeline tab', () => {
    window.history.replaceState(null, '', '#nonsense');
    render(<App />);
    expect(screen.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('back/forward (hashchange) switches the active tab', () => {
    render(<App />);
    act(() => {
      window.history.replaceState(null, '', '#metrics');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('tab', { name: 'Metrics' })).toHaveAttribute('aria-selected', 'true');
    act(() => {
      window.history.replaceState(null, '', window.location.pathname);   // back to bare
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true');
  });

  // ---- global CI-health header (above the tabs) ----
  it('shows the global CI-health header above the tabs', () => {
    render(<App />);
    expect(screen.getByRole('group', { name: 'Overall CI health' })).toBeInTheDocument();
    const rollup = screen.getByTestId('health-rollup');
    const tablist = screen.getByRole('tablist', { name: 'Dashboard views' });
    // header precedes the tab bar in document order
    expect(rollup.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a Delivery-owned lane chip opens Delivery and AUTO-EXPANDS that lane', () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('health-lane-main'));
    expect(screen.getByRole('tab', { name: /delivery/i })).toHaveAttribute('aria-selected', 'true');
    const laneBtn = within(screen.getByTestId('spine-lane-main')).getByRole('button');
    expect(laneBtn).toHaveAttribute('aria-expanded', 'true');   // expanded, not just scrolled-to
  });

  it('the PR CI chip routes to the Pipeline tab (its richest per-PR detail)', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));   // leave Pipeline first
    fireEvent.click(screen.getByTestId('health-lane-pr-ci'));
    expect(screen.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the Cost chip routes to the Metrics tab (the coverage view)', () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('health-lane-cost'));
    expect(screen.getByRole('tab', { name: 'Metrics' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('metrics-view-stub')).toBeInTheDocument();
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

  it('?kiosk=1 hides the gear, legend, bell, and tab bar; the spine is pinned', () => {
    setUrl('?kiosk=1');
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Legend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Browser notifications (this tab)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    // the wall display pins the Delivery spine read-only
    expect(screen.getByTestId('spine-lane-pr-ci')).toBeInTheDocument();
    expect(document.getElementById('tabpanel-delivery')).not.toHaveAttribute('hidden');
    expect(document.getElementById('tabpanel-pipeline')).toHaveAttribute('hidden');
    expect(document.getElementById('tabpanel-metrics')).toHaveAttribute('hidden');
  });

  it('hides the global health header in kiosk (the spine carries its own rollup)', () => {
    setUrl('?kiosk=1');
    render(<App />);
    expect(screen.queryByRole('group', { name: 'Overall CI health' })).not.toBeInTheDocument();
  });

  it('has no dangling aria-controls/aria-labelledby in kiosk mode (UX-L3)', () => {
    setUrl('?kiosk=1');
    const { container } = render(<App />);
    for (const attr of ['aria-controls', 'aria-labelledby']) {
      for (const el of container.querySelectorAll(`[${attr}]`)) {
        for (const id of el.getAttribute(attr)!.split(/\s+/).filter(Boolean)) {
          expect(document.getElementById(id), `${attr}="${id}" must resolve to a node`).not.toBeNull();
        }
      }
    }
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

  it('kiosk pins the Delivery spine and never rotates away from it over time', () => {
    setUrl('?kiosk=1&cycle=10');
    vi.useFakeTimers();
    render(<App />);
    expect(document.getElementById('tabpanel-delivery')).not.toHaveAttribute('hidden');

    // advance well past several cycle ticks — the spine stays pinned, no rotation
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(document.getElementById('tabpanel-delivery')).not.toHaveAttribute('hidden');
    expect(document.getElementById('tabpanel-pipeline')).toHaveAttribute('hidden');
    expect(document.getElementById('tabpanel-metrics')).toHaveAttribute('hidden');
    expect(screen.queryByTestId('metrics-view-stub')).not.toBeInTheDocument();
  });

  it('does not switch tabs outside kiosk mode (Pipeline stays the default)', () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(document.getElementById('tabpanel-pipeline')).not.toHaveAttribute('hidden');
    expect(document.getElementById('tabpanel-delivery')).toHaveAttribute('hidden');
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

describe('App repo headings (UX-L1)', () => {
  it('renders each repo name as a heading for screen-reader navigation', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /acme\/widgets/ })).toBeInTheDocument();
  });
});
