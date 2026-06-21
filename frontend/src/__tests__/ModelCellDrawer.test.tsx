import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ModelCellDrawer } from '../sections/model/ModelCellDrawer';
import type { WorkspaceApi } from '../shell/workspaceApi';
import type { DerivedModelLike } from '../sections/optimize/types';

const MODEL: DerivedModelLike = {
  tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }],
  checks: ['e2e'],
  cells: [
    { check: 'e2e', tierId: 'pr', intent: { runs: true, gates: false, conditional: false }, observed: { runs: 100, minutes: 500, realFailures: 5, flakeRatePct: 0 }, state: 'advisory' },
    { check: 'e2e', tierId: 'queue', intent: { runs: true, gates: true, conditional: false }, observed: { runs: 80, minutes: 400, realFailures: 0, flakeRatePct: 0 }, state: 'gate' },
  ],
  checkMeta: [{ check: 'e2e', isRequiredMergeGate: true, provenance: [{ file: 'ci.yml', jobId: 'e2e' }], needs: ['build'] }],
};

const api = (over: Partial<WorkspaceApi> = {}): WorkspaceApi => ({
  simulate: vi.fn(async () => ({ legal: true, note: 'saves 400 min', costDeltaMinutes: -400, direction: 'remove', gatesLost: [], gatesGained: [], estimated: false })),
  prompt: vi.fn(async () => ({ prompt: 'In o/r, demote the check "e2e"…' })),
  ...over,
} as unknown as WorkspaceApi);

describe('ModelCellDrawer (Inspect drill-down)', () => {
  it('renders per-tier evidence (runs · fail% · minutes) + the required-gate badge', () => {
    render(<ModelCellDrawer check="e2e" model={MODEL} repo="o/r" api={api()} onClose={vi.fn()} />);
    const ev = screen.getByTestId('model-evidence');
    expect(within(ev).getByText('PR')).toBeInTheDocument();
    expect(within(ev).getByText('100')).toBeInTheDocument();     // runs on PR
    expect(within(ev).getByText('5%')).toBeInTheDocument();      // 5/100 fail rate
    expect(screen.getByText(/required/)).toBeInTheDocument();    // gate badge
    expect(screen.getByText(/depends on: build/)).toBeInTheDocument();
  });

  it('runs the what-if simulation through WorkspaceApi.simulate and shows the verdict', async () => {
    const a = api();
    render(<ModelCellDrawer check="e2e" model={MODEL} repo="o/r" api={a} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('model-sim-run'));
    expect(await screen.findByTestId('model-sim-result')).toHaveTextContent('saves 400 min');
    expect(a.simulate).toHaveBeenCalledWith('o/r', expect.objectContaining({ check: 'e2e', toTierId: null }));
  });

  it('surfaces an illegal move (required gate) without crashing', async () => {
    const a = api({ simulate: vi.fn(async () => ({ legal: false, reason: 'required-gate', note: 'not possible — required merge gate', costDeltaMinutes: 0, direction: 'remove', gatesLost: [], gatesGained: [], estimated: false })) });
    render(<ModelCellDrawer check="e2e" model={MODEL} repo="o/r" api={a} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('model-sim-run'));
    const res = await screen.findByTestId('model-sim-result');
    expect(res).toHaveTextContent(/required merge gate/);
    expect(res).toHaveAttribute('data-legal', '0');
  });

  it('copies a Claude Code prompt via WorkspaceApi.prompt', async () => {
    const a = api();
    render(<ModelCellDrawer check="e2e" model={MODEL} repo="o/r" api={a} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('model-copy-prompt'));
    expect(await screen.findByTestId('model-prompt')).toHaveTextContent('demote the check');
    expect(a.prompt).toHaveBeenCalledWith('o/r', expect.objectContaining({ check: 'e2e' }));
  });

  it('closes via the ✕ button', () => {
    const onClose = vi.fn();
    render(<ModelCellDrawer check="e2e" model={MODEL} repo="o/r" api={api()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
