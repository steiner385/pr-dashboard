import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { ModelView, requiredGates, driftCells } from '../sections/model/ModelView';
import type { WorkspaceApi } from '../shell/workspaceApi';
import type { DerivedModelLike } from '../sections/optimize/types';

const cell = (check: string, tierId: string, state: string, drift = false): DerivedModelLike['cells'][number] =>
  ({ check, tierId, intent: { runs: state !== 'absent', gates: state === 'gate', conditional: false }, observed: null, state, drift });

const MODEL: DerivedModelLike = {
  tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }],
  checks: ['build', 'lint'],
  cells: [
    cell('build', 'pr', 'advisory'), cell('build', 'queue', 'gate'),
    cell('lint', 'pr', 'advisory'), cell('lint', 'queue', 'absent', true),
  ],
  checkMeta: [
    { check: 'build', isRequiredMergeGate: true, provenance: [{ file: 'ci.yml', jobId: 'build' }] },
    { check: 'lint', isRequiredMergeGate: false, provenance: [{ file: 'ci.yml', jobId: 'lint' }] },
  ],
};

const api = (over: Partial<WorkspaceApi> = {}): WorkspaceApi => ({
  getPipeline: vi.fn(async () => ({ repo: 'o/r', sourceSha: 'deadbeefcafe', model: MODEL })),
  security: vi.fn(async () => ({ repo: 'o/r', sourceSha: 'deadbeefcafe', scannedFiles: 1, findings: [] })),
  ruleset: vi.fn(async () => ({ readable: true, derivedRequired: ['build'], liveRequired: ['build'], missingFromModel: [], extraInModel: [], inSync: true })),
  simulate: vi.fn(), prompt: vi.fn(), draftPrDryRun: vi.fn(), draftPrOpen: vi.fn(), self: vi.fn(), ...over,
} as unknown as WorkspaceApi);

describe('requiredGates / driftCells (pure)', () => {
  it('extracts the required-gate set', () => expect(requiredGates(MODEL)).toEqual(['build']));
  it('finds drifting cells', () => expect(driftCells(MODEL)).toHaveLength(1));
});

describe('ModelView (US3)', () => {
  it('leads with a compact summary (gate count + pinned sha); the full gate list is behind a disclosure', async () => {
    render(<ModelView repo="o/r" api={api()} />);
    expect(await screen.findByRole('button', { name: /1 required gate/ })).toBeInTheDocument();
    expect(screen.getByText(/@deadbee/)).toBeInTheDocument();
    // the comma list is NOT shown up front (no prose wall)
    expect(screen.queryByText(/required gates:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /1 required gate/ }));
    expect(screen.getByText(/required gates:/)).toHaveTextContent('build');
  });

  it('renders the matrix with a legend and flags drift', async () => {
    render(<ModelView repo="o/r" api={api()} />);
    expect(await screen.findByLabelText('Protection matrix')).toBeInTheDocument();
    expect(screen.getByText(/1 cell drifting/)).toBeInTheDocument();
    expect(screen.getByLabelText('Matrix legend')).toBeInTheDocument();
  });

  it('the drift count filters the matrix to only the drifting checks', async () => {
    render(<ModelView repo="o/r" api={api()} />);
    await screen.findByLabelText('Protection matrix');
    // before: both checks present as row headers
    expect(screen.getByRole('rowheader', { name: /build/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /1 cell drifting/ }));
    // after: only the drifting check (lint) remains
    expect(screen.queryByRole('rowheader', { name: /^build/ })).not.toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /lint/ })).toBeInTheDocument();
  });

  it('renders the security panel (Group M) with finding + confidence', async () => {
    const withFindings = api({ security: vi.fn(async () => ({ repo: 'o/r', sourceSha: 's', scannedFiles: 1,
      findings: [{ file: 'ci.yml', kind: 'pull_request_target', detail: 'runs on fork PRs', confidence: 'high' as const }] })) });
    render(<ModelView repo="o/r" api={withFindings} />);
    const panel = await screen.findByLabelText('Security findings');
    expect(within(panel).getByText('pull_request_target')).toBeInTheDocument();
    expect(within(panel).getByText('[high]')).toBeInTheDocument();
  });

  it('shows the source file for workflow-level findings that have no jobId (so they are not all identical)', async () => {
    const withFindings = api({ security: vi.fn(async () => ({ repo: 'o/r', sourceSha: 's', scannedFiles: 2,
      findings: [
        { file: '_android-build.yml', kind: 'broad-permissions', detail: 'workflow-level write permission(s)', confidence: 'medium' as const },
        { file: '_android-smoke.yml', kind: 'broad-permissions', detail: 'workflow-level write permission(s)', confidence: 'medium' as const },
      ] })) });
    render(<ModelView repo="o/r" api={withFindings} />);
    const panel = await screen.findByLabelText('Security findings');
    // both same kind/detail — the file is what distinguishes them
    expect(within(panel).getByText(/_android-build\.yml/)).toBeInTheDocument();
    expect(within(panel).getByText(/_android-smoke\.yml/)).toBeInTheDocument();
  });

  it('shows a ruleset mismatch (the dangerous gap — ruleset requires a check config misses)', async () => {
    const mismatch = api({ ruleset: vi.fn(async () => ({ readable: true, derivedRequired: ['build'], liveRequired: ['build', 'security-scan'], missingFromModel: ['security-scan'], extraInModel: [], inSync: false })) });
    render(<ModelView repo="o/r" api={mismatch} />);
    expect(await screen.findByText(/Ruleset mismatch/)).toHaveTextContent(/requires security-scan, not enforced by config/);
  });

  it('collapses a sharded fan-out in the ruleset-mismatch list (×N, not eight lines)', async () => {
    const mismatch = api({ ruleset: vi.fn(async () => ({
      readable: true, derivedRequired: [], liveRequired: [], missingFromModel: [],
      extraInModel: ['lint', ...Array.from({ length: 8 }, (_, i) => `static / test: unit (${i + 1}/8)`)],
      inSync: false,
    })) });
    render(<ModelView repo="o/r" api={mismatch} />);
    const line = await screen.findByText(/Ruleset mismatch/);
    expect(line).toHaveTextContent('static / test: unit (×8)');     // the 8 shards folded into one
    expect(line).not.toHaveTextContent('(1/8)');                    // individual shards gone
    expect(line).toHaveTextContent('lint');                         // non-shard names untouched
  });

  it('shows "grant administration:read" when the ruleset is unreadable (no false in-sync)', async () => {
    const unreadable = api({ ruleset: vi.fn(async () => ({ readable: false, derivedRequired: ['build'], liveRequired: [], missingFromModel: [], extraInModel: [], inSync: false })) });
    render(<ModelView repo="o/r" api={unreadable} />);
    expect(await screen.findByText(/grant administration:read/)).toBeInTheDocument();
  });

  it('still renders the model when the security audit fails (advisory, non-blocking)', async () => {
    const secFails = api({ security: vi.fn(async () => { throw new Error('administration:read missing'); }) });
    render(<ModelView repo="o/r" api={secFails} />);
    expect(await screen.findByLabelText('Protection matrix')).toBeInTheDocument(); // model still renders
  });

  it('collapses sharded checks into one expandable matrix row (roadmap 2.3)', async () => {
    const sharded: DerivedModelLike = {
      ...MODEL,
      checks: ['build', 'static / test: unit (shard 1/3)', 'static / test: unit (shard 2/3)', 'static / test: unit (shard 3/3)'],
      cells: [cell('build', 'queue', 'gate'),
        cell('static / test: unit (shard 1/3)', 'queue', 'gate'),
        cell('static / test: unit (shard 2/3)', 'queue', 'gate'),
        cell('static / test: unit (shard 3/3)', 'queue', 'gate')],
      checkMeta: MODEL.checkMeta,
    };
    render(<ModelView repo="o/r" api={api({ getPipeline: vi.fn(async () => ({ repo: 'o/r', sourceSha: 's', model: sharded })) })} />);
    await screen.findByLabelText('Protection matrix');
    // the 3 shards collapse into one "(3 shards)" toggle; individual shards hidden
    const toggle = screen.getByRole('button', { name: /static \/ test: unit.*3 shards/ });
    expect(screen.queryByRole('rowheader', { name: /shard 1\/3/ })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('rowheader', { name: /shard 1\/3/ })).toBeInTheDocument();
  });

  it('surfaces a derivation error', async () => {
    render(<ModelView repo="o/r" api={api({ getPipeline: vi.fn(async () => { throw new Error('no derivable model'); }) })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no derivable model');
  });

  it('clicking a check name opens the drill-down drawer for that check', async () => {
    render(<ModelView repo="o/r" api={api()} />);
    await screen.findByLabelText('Protection matrix');
    expect(screen.queryByTestId('model-drawer')).toBeNull();
    fireEvent.click(screen.getByTestId('drill-build'));
    const drawer = screen.getByTestId('model-drawer');
    expect(drawer).toHaveAttribute('role', 'dialog');
    expect(drawer).toHaveAttribute('aria-label', expect.stringContaining('build'));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('model-drawer')).toBeNull();
  });
});

describe('ModelView — Cost/Quality heat overlays', () => {
  // a cell carrying observed cost (minutes) + failures, so the overlay has data to shade
  const observed = (minutes: number, runs: number, realFailures: number) =>
    ({ runs, minutes, realFailures, flakeRatePct: 0 });
  const OBSERVED_MODEL: DerivedModelLike = {
    tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }],
    checks: ['cheap', 'pricey'],
    cells: [
      { check: 'cheap', tierId: 'pr', intent: { runs: true, gates: false, conditional: false }, observed: observed(10, 100, 0), state: 'advisory' },
      { check: 'pricey', tierId: 'pr', intent: { runs: true, gates: true, conditional: false }, observed: observed(500, 100, 40), state: 'gate' },
    ],
    checkMeta: [
      { check: 'cheap', isRequiredMergeGate: false, provenance: [{ file: 'ci.yml', jobId: 'cheap' }] },
      { check: 'pricey', isRequiredMergeGate: true, provenance: [{ file: 'ci.yml', jobId: 'pricey' }] },
    ],
  };
  const obsApi = api({ getPipeline: vi.fn(async () => ({ repo: 'o/r', sourceSha: 's', model: OBSERVED_MODEL })) });

  const cellFor = (check: string) =>
    screen.getByRole('rowheader', { name: new RegExp(check) }).closest('tr')!.querySelector('td.cell') as HTMLElement;

  it('defaults to States (no heat) and exposes Cost + Quality toggles', async () => {
    render(<ModelView repo="o/r" api={obsApi} />);
    await screen.findByLabelText('Protection matrix');
    expect(screen.getByTestId('overlay-none')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('overlay-cost')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-quality')).toBeInTheDocument();
    expect(cellFor('pricey')).not.toHaveClass('heat');
  });

  it('Cost overlay shades the priciest cell hottest (and tooltips the minutes)', async () => {
    render(<ModelView repo="o/r" api={obsApi} />);
    await screen.findByLabelText('Protection matrix');
    fireEvent.click(screen.getByTestId('overlay-cost'));
    const pricey = cellFor('pricey');
    expect(pricey).toHaveClass('heat');
    expect(pricey.style.background).toMatch(/color-mix/);
    expect(pricey).toHaveAttribute('title', expect.stringContaining('100 runs'));
    // the max-minutes cell shades at the top of the scale (80%); the cheap one far less
    expect(pricey.style.background).toContain('80%');
  });

  it('Quality overlay shades by real-failure rate', async () => {
    render(<ModelView repo="o/r" api={obsApi} />);
    await screen.findByLabelText('Protection matrix');
    fireEvent.click(screen.getByTestId('overlay-quality'));
    const pricey = cellFor('pricey'); // 40/100 = 40% fail → the only failing cell, hottest
    expect(pricey).toHaveClass('heat');
    expect(pricey.style.background).toContain('var(--fail)');
  });
});
