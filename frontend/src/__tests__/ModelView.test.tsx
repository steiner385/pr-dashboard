import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
  simulate: vi.fn(), prompt: vi.fn(), draftPrDryRun: vi.fn(), draftPrOpen: vi.fn(), ...over,
} as unknown as WorkspaceApi);

describe('requiredGates / driftCells (pure)', () => {
  it('extracts the required-gate set', () => expect(requiredGates(MODEL)).toEqual(['build']));
  it('finds drifting cells', () => expect(driftCells(MODEL)).toHaveLength(1));
});

describe('ModelView (US3)', () => {
  it('shows the merge contract + the pinned sha', async () => {
    render(<ModelView repo="o/r" api={api()} />);
    expect(await screen.findByText(/Merge contract:/)).toBeInTheDocument();
    expect(screen.getByText(/1 required gate — build/)).toBeInTheDocument();
    expect(screen.getByText(/@deadbee/)).toBeInTheDocument();
  });

  it('renders the matrix and flags drift', async () => {
    render(<ModelView repo="o/r" api={api()} />);
    expect(await screen.findByLabelText('Protection matrix')).toBeInTheDocument();
    expect(screen.getByText(/1 cell drifting/)).toBeInTheDocument();
  });

  it('surfaces a derivation error', async () => {
    render(<ModelView repo="o/r" api={api({ getPipeline: vi.fn(async () => { throw new Error('no derivable model'); }) })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no derivable model');
  });
});
