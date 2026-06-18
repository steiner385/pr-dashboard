import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SelfHealthDot } from '../shell/SelfHealthDot';
import type { WorkspaceApi, ToolHealthDto } from '../shell/workspaceApi';

const ok: ToolHealthDto = { ingestionFreshnessSecs: 20, derivationCache: { hits: 9, misses: 1, hitRate: 0.9, size: 2 }, apiRateLimit: { remaining: 4000, limit: 5000 }, status: 'ok', reasons: [] };
const degraded: ToolHealthDto = { ingestionFreshnessSecs: 700, derivationCache: { hits: 0, misses: 5, hitRate: 0, size: 0 }, apiRateLimit: null, status: 'degraded', reasons: ['ingestion is 700s stale (poller may be lagging)'] };

const api = (self: () => Promise<ToolHealthDto>): WorkspaceApi => ({ self: vi.fn(self) } as unknown as WorkspaceApi);

describe('SelfHealthDot (Group O spine indicator)', () => {
  it('shows healthy with cache hit-rate in the title', async () => {
    render(<SelfHealthDot api={api(async () => ok)} pollMs={999_999} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveAttribute('title', expect.stringContaining('Tool healthy')));
    expect(screen.getByRole('status').getAttribute('title')).toMatch(/90% hit/);
  });

  it('shows degraded with the reasons on hover', async () => {
    render(<SelfHealthDot api={api(async () => degraded)} pollMs={999_999} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('⚠ tool'));
    expect(screen.getByRole('status').getAttribute('title')).toMatch(/700s stale/);
  });

  it('renders an unknown marker when /self fails (never throws)', async () => {
    render(<SelfHealthDot api={api(async () => { throw new Error('down'); })} pollMs={999_999} />);
    await waitFor(() => expect(screen.getByTitle(/tool health unknown/i)).toBeInTheDocument());
  });

  it('surfaces the ingestion-freshness age visibly (roadmap 4.3)', async () => {
    render(<SelfHealthDot api={api(async () => ok)} pollMs={999_999} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/20s/));
  });

  it('flags STALE data even when the tool itself reports ok (roadmap 4.3)', async () => {
    const staleButOk: ToolHealthDto = { ...ok, ingestionFreshnessSecs: 300, status: 'ok' };
    render(<SelfHealthDot api={api(async () => staleButOk)} pollMs={999_999} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/stale/i));
    expect(screen.getByRole('status').className).toMatch(/stale/);
  });
});
