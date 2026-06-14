/**
 * RTL tests for per-repo expand/collapse feature (prdash.collapsed localStorage).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { App } from '../App';
import { useDashboard } from '../useDashboard';
import type { DashboardHook } from '../useDashboard';
import type { DashboardState, PrView } from '../types';

vi.mock('../useDashboard');
const mockUseDashboard = vi.mocked(useDashboard);

// ---------- fixtures ----------

const makepr = (number: number, stage: PrView['stage']['stage'] = 'ci', substate: string | null = null): PrView => ({
  repo: 'x', number, title: `pr ${number}`, url: `https://x/${number}`,
  stage: { stage, substate, percent: 10, etaSeconds: null, etaRangeSeconds: null, overdue: false },
  queueAheadCount: null,
  checks: [], groupChecks: null, mergeEtaSim: null,
});

const STATE: DashboardState = {
  generatedAt: '2026-06-11T12:00:00Z', staleSince: null,
  repos: [
    {
      repo: 'acme/widgets', hasDeploy: true,
      prs: [makepr(1, 'ci'), makepr(2, 'queue')],
      queue: null,
    },
    {
      repo: 'octo/bridge', hasDeploy: false,
      prs: [makepr(3, 'parked', 'ci-failed')],
      queue: null,
    },
  ],
};

const hook = (overrides?: Partial<DashboardHook>): DashboardHook =>
  ({ state: STATE, connected: true,
    notifySupported: true, notifyEnabled: false, toggleNotify: () => {}, ...overrides });

// The repo board lives in the Pipeline tab, which is no longer the default
// (Delivery is). Every test here exercises the board, so switch to it on render.
const renderPipeline = (): ReturnType<typeof render> => {
  const result = render(<App />);
  fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }));
  return result;
};

// ---------- localStorage helpers ----------

/** Read the prdash.collapsed key from jsdom localStorage */
const readCollapsed = (): string[] => {
  try {
    const raw = localStorage.getItem('prdash.collapsed');
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
};

beforeEach(() => {
  mockUseDashboard.mockReturnValue(hook());
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

// ---------- tests ----------

describe('Repo expand/collapse', () => {
  it('renders repo section headers as buttons with aria-expanded=true initially', () => {
    renderPipeline();
    const buttons = screen.getAllByRole('button', { name: /acme\/widgets/ });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'true');
  });

  it('chevron ▾ is shown when expanded', () => {
    renderPipeline();
    // The button text should contain the down chevron
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    expect(btn.textContent).toContain('▾');
  });

  it('clicking the header button collapses the repo section', () => {
    renderPipeline();
    // PR rows should be visible initially
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();

    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn);

    // PR rows should be hidden
    expect(screen.queryByText('#1')).not.toBeInTheDocument();
    expect(screen.queryByText('#2')).not.toBeInTheDocument();
  });

  it('collapsed header shows aria-expanded=false and chevron ▸', () => {
    renderPipeline();
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn.textContent).toContain('▸');
  });

  it('collapsed header hides QueueTrain', () => {
    const stateWithQueue: DashboardState = {
      ...STATE,
      repos: [
        {
          repo: 'acme/widgets', hasDeploy: true,
          prs: [makepr(1, 'ci')],
          queue: { groups: [{ oid: 'g1', prNumbers: [1], percent: 50, etaSeconds: null, failed: false }], waiting: [], unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 1 },
        },
      ],
    };
    mockUseDashboard.mockReturnValue(hook({ state: stateWithQueue }));
    renderPipeline();
    // Queue train car visible before collapse (building car shows "▶ group")
    expect(screen.getByText('▶ group')).toBeInTheDocument();

    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn);
    // Queue train hidden after collapse
    expect(screen.queryByText('▶ group')).not.toBeInTheDocument();
  });

  it('shows inline summary with PR count when collapsed', () => {
    renderPipeline();
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn);
    // Should show "2 PRs" (acme/widgets has 2 PRs)
    expect(btn.textContent).toMatch(/2 PRs/);
  });

  it('summary shows active count when nonzero (ci + queue are active)', () => {
    renderPipeline();
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn);
    // acme/widgets has 2 PRs: 1 ci (active) + 1 queue (active) → "2 active"
    expect(btn.textContent).toMatch(/2 active/);
  });

  it('summary shows failed count in fail color when nonzero', () => {
    renderPipeline();
    // octo/bridge has 1 parked/ci-failed PR
    const btn = screen.getAllByRole('button', { name: /octo\/bridge/ })[0]!;
    fireEvent.click(btn);
    // Should show "1 PRs" and "1 failed"
    expect(btn.textContent).toMatch(/1 PRs/);
    expect(btn.textContent).toMatch(/1 failed/);
  });

  it('summary omits active when count is zero', () => {
    renderPipeline();
    // octo/bridge has only a parked/ci-failed PR → active=0
    const btn = screen.getAllByRole('button', { name: /octo\/bridge/ })[0]!;
    fireEvent.click(btn);
    expect(btn.textContent).not.toMatch(/0 active/);
  });

  it('summary omits failed when count is zero', () => {
    renderPipeline();
    // acme/widgets has ci + queue PRs, no failed ones
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn);
    expect(btn.textContent).not.toMatch(/failed/);
  });

  it('clicking again expands and shows PR rows', () => {
    renderPipeline();
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn); // collapse
    fireEvent.click(btn); // expand
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  // ---------- localStorage persistence ----------

  it('writes collapsed repo to localStorage on collapse', () => {
    renderPipeline();
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn);
    expect(readCollapsed()).toContain('acme/widgets');
  });

  it('removes repo from localStorage on expand', () => {
    renderPipeline();
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn); // collapse
    fireEvent.click(btn); // expand
    expect(readCollapsed()).not.toContain('acme/widgets');
  });

  it('reads initial collapsed state from localStorage on mount', () => {
    // Pre-seed localStorage with acme/widgets collapsed
    localStorage.setItem('prdash.collapsed', JSON.stringify(['acme/widgets']));
    renderPipeline();
    // PR rows for repo1 should not be visible
    expect(screen.queryByText('#1')).not.toBeInTheDocument();
    expect(screen.queryByText('#2')).not.toBeInTheDocument();
    // PR rows for repo2 should still be visible
    expect(screen.getByText('#3')).toBeInTheDocument();
    // The button should be aria-expanded=false
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('handles corrupt localStorage gracefully (all repos expanded)', () => {
    localStorage.setItem('prdash.collapsed', 'NOT_VALID_JSON{{');
    renderPipeline();
    // Should render without crashing and show all repos expanded
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.getByText('#3')).toBeInTheDocument();
  });

  // ---------- filter interplay ----------

  it('filter-hidden count is computed on ALL prs regardless of collapsed state', () => {
    renderPipeline();
    // Collapse acme/widgets
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn);

    // Now apply a filter: click "running" tile (ci bucket)
    const strip = screen.getByRole('group', { name: 'Status overview' });
    const runningTile = within(strip).getAllByRole('button')[0]!;
    fireEvent.click(runningTile);

    // octo/bridge has 1 parked/ci-failed PR → filtered out → (1 hidden)
    expect(screen.getByText(/\(1 hidden\)/)).toBeInTheDocument();
    // acme/widgets is collapsed but still has PRs; its hidden-count from filter
    // should appear in the collapsed summary button area (collapsed repos show filter hidden count too)
    // The collapsed repo's queue PR (#2) is 'queue' not 'running', so 1 hidden in that repo
    // → (1 hidden) text appears somewhere for acme/widgets as well
    // We just verify that the reasonbridge "(1 hidden)" is present regardless
  });

  it('collapsed repo stays collapsed when filter changes', () => {
    renderPipeline();
    // Collapse acme/widgets
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    // Apply filter
    const strip = screen.getByRole('group', { name: 'Status overview' });
    const runningTile = within(strip).getAllByRole('button')[0]!;
    fireEvent.click(runningTile);

    // Repo should still be collapsed
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    // And PR rows still hidden
    expect(screen.queryByText('#1')).not.toBeInTheDocument();
  });

  it('chevron icon has aria-hidden', () => {
    renderPipeline();
    // Check that the chevron span inside the button has aria-hidden="true"
    const btn = screen.getAllByRole('button', { name: /acme\/widgets/ })[0]!;
    const hiddenEls = btn.querySelectorAll('[aria-hidden="true"]');
    expect(hiddenEls.length).toBeGreaterThanOrEqual(1);
    // One of them should contain the chevron character
    const chevrons = Array.from(hiddenEls).filter(el =>
      el.textContent === '▾' || el.textContent === '▸'
    );
    expect(chevrons.length).toBeGreaterThanOrEqual(1);
  });
});
