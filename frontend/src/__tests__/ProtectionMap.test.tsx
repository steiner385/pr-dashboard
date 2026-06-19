import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { ProtectionMap, type DerivedModel } from '../ProtectionMap';

const MODEL: DerivedModel = {
  tiers: [
    { id: 'pr', label: 'PR', event: 'pull_request' },
    { id: 'queue', label: 'Queue', event: 'merge_group' },
  ],
  checks: ['build: production', 'a11y: axe'],
  cells: [
    { check: 'build: production', tierId: 'pr', intent: { runs: true, gates: true, conditional: false },
      observed: null, drift: true, state: 'gate' },
    { check: 'build: production', tierId: 'queue', intent: { runs: true, gates: true, conditional: false },
      observed: { ran: true, runs: 200, realFailures: 0, failRatePct: 0, flakeRatePct: 0, minutes: 1000 }, drift: false, state: 'gate' },
    { check: 'a11y: axe', tierId: 'pr', intent: { runs: true, gates: false, conditional: true },
      observed: null, drift: false, state: 'conditional' },
    { check: 'a11y: axe', tierId: 'queue', intent: { runs: false, gates: false, conditional: false },
      observed: null, drift: false, state: 'absent' },
  ],
};

const METRICS = {
  demotionCandidates: [{ repo: 'cairnea/KinDash', candidates: [{ name: 'lint: eslint', currentTier: 'every PR push', suggestedTier: 'merge queue only', minutesInWindow: 240 }] }],
  promotionCandidates: [{ repo: 'cairnea/KinDash', candidates: [{ name: 'e2e: smoke', suggestedTier: 'merge queue', realFailures: 6 }] }],
};

function mockFetch(model: DerivedModel | { error: string }, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/repos')) {
      // real API shape: { repos: [...] } — NOT a bare array (regression: #designer empty)
      return { ok: true, json: async () => ({ repos: [{ repo: 'cairnea/KinDash', excluded: false }] }) } as Response;
    }
    if (String(url).includes('/api/metrics')) {
      return { ok: true, json: async () => METRICS } as Response;
    }
    return { ok: status === 200, status, json: async () => model } as Response;
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('ProtectionMap', () => {
  it('renders the matrix with state-coded cells and a health strip', async () => {
    mockFetch(MODEL);
    render(<ProtectionMap />);
    await screen.findByTestId('pm-grid');
    // build: production gates at both PR and Queue
    expect(screen.getByTestId('pm-cell-build: production-queue')).toHaveAttribute('data-state', 'gate');
    // a11y is conditional at PR, absent at Queue
    expect(screen.getByTestId('pm-cell-a11y: axe-pr')).toHaveAttribute('data-state', 'conditional');
    expect(screen.getByTestId('pm-cell-a11y: axe-queue')).toHaveAttribute('data-state', 'absent');
    // health strip: verdict (drift present) + headline stats (2 gates, 1 drift)
    const strip = screen.getByTestId('pm-summary');
    expect(within(strip).getByText('1 drift')).toBeInTheDocument(); // verdict
    expect(strip.textContent).toMatch(/2gates/);
    expect(strip.textContent).toMatch(/1drift/);
  });

  it('states the merge contract (which checks block the queue)', async () => {
    mockFetch(MODEL);
    render(<ProtectionMap />);
    const contract = await screen.findByTestId('pm-contract');
    expect(contract.textContent).toMatch(/Blocks merge \(1\)/); // build:production gates at queue
    expect(contract.textContent).toMatch(/build: production/);
  });

  it('marks drift cells', async () => {
    mockFetch(MODEL);
    render(<ProtectionMap />);
    await screen.findByTestId('pm-grid');
    expect(screen.getByTestId('pm-cell-build: production-pr')).toHaveAttribute('data-drift', '1');
    expect(screen.getByTestId('pm-cell-build: production-queue')).toHaveAttribute('data-drift', '0');
    expect(screen.getByText('1 drift')).toBeInTheDocument();
  });

  it('renders a findings rail joining demotion (cost), promotion (quality), and drift', async () => {
    mockFetch(MODEL);
    render(<ProtectionMap />);
    const rail = await screen.findByTestId('pm-findings');
    // demotion (cost) + promotion (quality) come from /api/metrics, which is
    // fetched only AFTER the model loads (deferred) — so await them.
    await within(rail).findByText('lint: eslint');
    await within(rail).findByText('e2e: smoke');
    // drift finding from the model (build: production @ pr has drift:true)
    const driftRows = within(rail).getAllByText('build: production');
    expect(driftRows.length).toBeGreaterThan(0);
    expect(rail.querySelector('[data-goal="cost"]')).toBeTruthy();
    expect(rail.querySelector('[data-goal="quality"]')).toBeTruthy();
    expect(rail.querySelector('[data-goal="drift"]')).toBeTruthy();
  });

  it('applies a cost overlay tint to cells with observed runtime', async () => {
    mockFetch(MODEL);
    render(<ProtectionMap />);
    await screen.findByTestId('pm-grid');
    const queue = screen.getByTestId('pm-cell-build: production-queue'); // observed minutes: 1000
    expect(queue.getAttribute('style') ?? '').not.toMatch(/background/); // no tint under States
    fireEvent.click(screen.getByTestId('pm-overlay-cost'));
    expect(screen.getByTestId('pm-overlay-cost')).toHaveAttribute('aria-pressed', 'true');
    expect(queue.getAttribute('style') ?? '').toMatch(/background/); // tinted under Cost
    // a cell with no observed data stays untinted
    expect(screen.getByTestId('pm-cell-build: production-pr').getAttribute('style') ?? '').not.toMatch(/background/);
  });

  it('clicking a finding opens the drill-down drawer with evidence + a constrained simulator', async () => {
    mockFetch(MODEL);
    render(<ProtectionMap />);
    const rail = await screen.findByTestId('pm-findings');
    fireEvent.click(within(rail).getAllByText('build: production')[0]); // drift finding
    await screen.findByTestId('pm-drawer');
    expect(screen.getByTestId('pm-evidence')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('pm-sim-from'), { target: { value: 'queue' } });
    fireEvent.change(screen.getByTestId('pm-sim-to'), { target: { value: '__remove__' } });
    const result = screen.getByTestId('pm-sim-result');
    expect(result.getAttribute('data-cost-delta')).toBe('-1000');
    expect(result.textContent).toMatch(/saves 1,?000 min/);
  });

  it('the drawer offers a Copy Claude Code prompt action with feedback', async () => {
    mockFetch(MODEL);
    render(<ProtectionMap />);
    const rail = await screen.findByTestId('pm-findings');
    fireEvent.click(within(rail).getAllByText('build: production')[0]);
    const copy = await screen.findByTestId('pm-copy-prompt');
    expect(copy.textContent).toMatch(/Copy Claude Code prompt/);
    fireEvent.click(copy);
    expect(copy.textContent).toMatch(/Copied/);
  });

  it('shows an error when the map cannot be derived', async () => {
    mockFetch({ error: 'no derivable ci.yml for x/y' }, 404);
    render(<ProtectionMap />);
    expect((await screen.findByTestId('pm-error')).textContent).toMatch(/no derivable ci.yml/);
  });

  it('renders matrix tbody with keyed Fragments (no React key warnings)', async () => {
    mockFetch(MODEL);
    const consoleSpy = vi.spyOn(console, 'error');
    render(<ProtectionMap />);
    await screen.findByTestId('pm-grid');
    // Assert no console.error call matches React's unique key warning
    const keyWarnings = consoleSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && /unique "key"/i.test(call[0])
    );
    expect(keyWarnings).toHaveLength(0);
  });
});
