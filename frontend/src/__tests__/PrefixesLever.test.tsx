import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PrefixesLever } from '../sections/optimize/PrefixesLever';
import type { WorkspaceApi } from '../shell/workspaceApi';

const api = (over: Partial<WorkspaceApi> = {}) => ({
  prefixesDryRun: vi.fn(async () => ({ dryRun: true as const, file: '.pr-dashboard.yml',
    prefixes: ['build', 'static-checks'], newText: 'batchSize: 6\nrequiredCheckPrefixes:\n  - build\n  - static-checks\n', baseSha: 's' })),
  prefixesOpen: vi.fn(async () => ({ opened: true as const, number: 91, url: 'https://x/91', prefixes: ['build', 'static-checks'] })),
  ...over,
} as unknown as WorkspaceApi);

describe('PrefixesLever (roadmap 4.5 — one-click governed prefixes PR)', () => {
  it('previews the suggested prefixes + the .pr-dashboard.yml change', async () => {
    const a = api();
    render(<PrefixesLever repo="o/r" api={a} />);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(await screen.findByLabelText('pr-dashboard.yml preview')).toHaveTextContent(/requiredCheckPrefixes/);
    expect(screen.getByLabelText('pr-dashboard.yml preview')).toHaveTextContent(/batchSize: 6/); // preserved
    expect(screen.getByRole('status')).toHaveTextContent(/build/);
    expect(a.prefixesDryRun).toHaveBeenCalledWith('o/r');
  });

  it('opens a draft PR from the previewed prefixes', async () => {
    const a = api();
    render(<PrefixesLever repo="o/r" api={a} />);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await screen.findByLabelText('pr-dashboard.yml preview');
    fireEvent.click(screen.getByRole('button', { name: /open draft pr/i }));
    await waitFor(() => expect(screen.getByText(/Opened draft PR/)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: '#91' })).toHaveAttribute('href', 'https://x/91');
    expect(a.prefixesOpen).toHaveBeenCalledWith('o/r', ['build', 'static-checks']);
  });

  it('surfaces an error from the dry-run', async () => {
    const a = api({ prefixesDryRun: vi.fn(async () => { throw new Error('no merge_group checks to derive prefixes from'); }) });
    render(<PrefixesLever repo="o/r" api={a} />);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no merge_group checks/);
  });
});
