import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RawYamlHatch } from '../sections/build/RawYamlHatch';
import type { WorkspaceApi, CandidateDto } from '../shell/workspaceApi';

const regressed: CandidateDto = { ok: true, baseSha: 's', files: [], validation: { gatingRegressed: true, lostGates: ['e2e'], lowConfidence: false }, model: null };

function api(candidateRaw = vi.fn(async () => regressed)): WorkspaceApi {
  return { candidateRaw } as unknown as WorkspaceApi;
}

describe('RawYamlHatch (advanced escape hatch)', () => {
  it('is collapsed by default behind an Advanced disclosure', () => {
    render(<RawYamlHatch repo="o/r" file="ci.yml" baseSha="s" api={api()} />);
    expect(screen.queryByLabelText(/raw yaml/i)).not.toBeInTheDocument();
    expect(screen.getByText(/advanced/i)).toBeInTheDocument();
  });

  it('once expanded, validating an edit calls candidateRaw and shows the gating verdict', async () => {
    const raw = vi.fn(async () => regressed);
    render(<RawYamlHatch repo="o/r" file="ci.yml" baseSha="s" api={api(raw)} />);
    fireEvent.click(screen.getByText(/advanced/i));
    fireEvent.change(screen.getByLabelText(/raw yaml/i), { target: { value: 'jobs: {}' } });
    fireEvent.click(screen.getByRole('button', { name: /validate/i }));
    await waitFor(() => expect(raw).toHaveBeenCalledWith('o/r', 'ci.yml', 'jobs: {}', 's'));
    expect(await screen.findByTestId('hatch-verdict')).toHaveTextContent(/blocked/i);
  });
});
