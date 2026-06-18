import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BuildView } from '../sections/build/BuildView';
import type { WorkspaceApi, CandidateDto } from '../shell/workspaceApi';
import type { DerivedModelLike } from '../sections/optimize/types';

const MODEL: DerivedModelLike = {
  tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }],
  checks: ['e2e', 'build'],
  cells: [
    { check: 'e2e', tierId: 'pr', intent: { runs: true, gates: false, conditional: false }, observed: null, state: 'advisory' },
    { check: 'build', tierId: 'queue', intent: { runs: true, gates: true, conditional: false }, observed: null, state: 'gate' },
  ],
  checkMeta: [
    { check: 'e2e', isRequiredMergeGate: false, provenance: [{ file: 'ci.yml', jobId: 'e2e' }] },
    { check: 'build', isRequiredMergeGate: true, provenance: [{ file: 'ci.yml', jobId: 'build' }] },
  ],
};

const clean: CandidateDto = { ok: true, baseSha: 'sha', files: [{ file: 'ci.yml', diff: '@@ job e2e — timeout 15m @@\n+    timeout-minutes: 15' }], validation: { gatingRegressed: false, lostGates: [], lowConfidence: false }, model: null };
const regressed: CandidateDto = { ok: true, baseSha: 'sha', files: [{ file: 'ci.yml', diff: '@@ remove job build @@' }], validation: { gatingRegressed: true, lostGates: ['build'], lowConfidence: false }, model: null };

function api(candidate = vi.fn(async () => clean), candidateApply = vi.fn(async () => ({ ok: true as const, number: 9, url: 'https://example/pr/9' }))): WorkspaceApi {
  return {
    getPipeline: vi.fn(async () => ({ repo: 'o/r', sourceSha: 'sha', model: MODEL })),
    candidate,
    candidateApply,
  } as unknown as WorkspaceApi;
}

describe('BuildView (Increment 3 — the no-code loop)', () => {
  it('loads the model and lists checks with structured op buttons', async () => {
    render(<BuildView repo="o/r" api={api()} />);
    expect((await screen.findAllByText('e2e')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Add timeout').length).toBeGreaterThan(0);
  });

  it('applying a timeout composes a mutation, projects a candidate, and shows the generated diff', async () => {
    const cand = vi.fn(async () => clean);
    render(<BuildView repo="o/r" api={api(cand)} />);
    fireEvent.click((await screen.findAllByText('Add timeout'))[0]); // e2e
    expect(await screen.findByLabelText('generated diff')).toHaveTextContent('timeout-minutes: 15');
    expect(cand).toHaveBeenCalledWith('o/r', [{ op: 'timeout', jobId: 'e2e', minutes: 15 }], 'sha');
    expect(screen.getByTestId('candidate-verdict')).toHaveTextContent(/safe/i);
  });

  it('a gating-regressed candidate is shown blocked with the lost gates and no draft-PR exit', async () => {
    render(<BuildView repo="o/r" api={api(vi.fn(async () => regressed))} />);
    fireEvent.click((await screen.findAllByText('Remove'))[1]); // build (required)
    expect(await screen.findByTestId('candidate-verdict')).toHaveTextContent(/blocked/i);
    expect(screen.getByTestId('candidate-verdict')).toHaveTextContent('build');
    expect(screen.queryByText('Open draft PR')).not.toBeInTheDocument();
  });

  it('a safe candidate offers a real Open draft PR button that applies and shows the PR link', async () => {
    const apply = vi.fn(async () => ({ ok: true as const, number: 9, url: 'https://example/pr/9' }));
    render(<BuildView repo="o/r" api={api(vi.fn(async () => clean), apply)} />);
    fireEvent.click((await screen.findAllByText('Add timeout'))[0]);
    fireEvent.click(await screen.findByText('Open draft PR'));
    expect(apply).toHaveBeenCalledWith('o/r', [{ op: 'timeout', jobId: 'e2e', minutes: 15 }], 'sha');
    expect(await screen.findByRole('link', { name: /#9/ })).toHaveAttribute('href', 'https://example/pr/9');
  });

  it('selecting a canvas node opens the inspector, whose op composes a mutation and projects', async () => {
    const cand = vi.fn(async () => clean);
    render(<BuildView repo="o/r" api={api(cand)} />);
    fireEvent.click(await screen.findByTestId('node-pr-e2e')); // select via the canvas
    const inspector = await screen.findByLabelText('Edit e2e');
    fireEvent.click(within(inspector).getByRole('button', { name: /add timeout/i }));
    expect(cand).toHaveBeenCalledWith('o/r', [{ op: 'timeout', jobId: 'e2e', minutes: 15 }], 'sha');
  });

  it('removing the only pending mutation clears the candidate', async () => {
    render(<BuildView repo="o/r" api={api()} />);
    fireEvent.click((await screen.findAllByText('Add timeout'))[0]);
    await screen.findByLabelText('generated diff');
    fireEvent.click(screen.getByLabelText('remove pending change 1'));
    expect(screen.queryByLabelText('generated diff')).not.toBeInTheDocument();
  });
});
