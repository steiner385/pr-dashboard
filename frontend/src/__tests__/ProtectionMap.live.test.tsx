// Live integration: renders ProtectionMap against the REAL running dashboard
// (127.0.0.1:4400) with NO fetch mocks — so an /api response-shape drift (e.g.
// /api/repos returning { repos: [...] } not a bare array, which left the Designer
// tab empty) fails here, where the mocked unit tests cannot see it.
// Skips when the dashboard isn't running (CI), so it never blocks the suite.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProtectionMap } from '../ProtectionMap';

const BASE = 'http://127.0.0.1:4400';

async function serverUp(): Promise<boolean> {
  try { return (await fetch(`${BASE}/api/state`)).ok; } catch { return false; }
}

afterEach(() => vi.unstubAllGlobals());

describe('ProtectionMap (live integration vs running dashboard)', () => {
  it('renders the matrix and surfaces from the real API', async () => {
    if (!(await serverUp())) { console.warn('skipped — dashboard not running at 4400'); return; }
    // make the component's relative `/api/...` calls hit the real server
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal('fetch', (u: string | URL | Request, o?: RequestInit) =>
      realFetch(typeof u === 'string' && u.startsWith('/') ? BASE + u : u, o));

    render(<ProtectionMap />);

    // the matrix must actually appear (this is what was blank in the bug)
    await screen.findByTestId('pm-grid', {}, { timeout: 12_000 });
    expect(screen.getAllByTestId(/^pm-cell-/).length).toBeGreaterThan(0);
    // and the peer surfaces
    expect(screen.getByTestId('pm-findings')).toBeInTheDocument();
    expect(screen.getByTestId('pm-sim')).toBeInTheDocument();
    expect(screen.getByTestId('pm-overlay-cost')).toBeInTheDocument();
  }, 20_000);
});
