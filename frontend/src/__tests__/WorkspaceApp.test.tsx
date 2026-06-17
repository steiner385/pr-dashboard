import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DashboardState } from '../types';

// Mock the live-data hook so the composition is deterministic.
const mockHook = vi.fn();
vi.mock('../useDashboard', () => ({ useDashboard: () => mockHook() }));

import { WorkspaceApp } from '../shell/WorkspaceApp';

const STATE = {
  generatedAt: '2026-06-17T00:00:00Z', staleSince: null,
  repos: [
    { repo: 'cairnea/KinDash', hasDeploy: false, prs: [{ number: 1 }, { number: 2 }], queue: null, laneHealth: { main: 'green' } },
    { repo: 'cairnea/infra', hasDeploy: false, prs: [], queue: null, laneHealth: { main: 'red' } },
  ],
} as unknown as DashboardState;

describe('WorkspaceApp (Increment 1 MVP composition)', () => {
  beforeEach(() => { location.hash = ''; mockHook.mockReset(); });

  it('renders the shell + spine + Health fleet over live state', () => {
    mockHook.mockReturnValue({ state: STATE, connected: true });
    render(<WorkspaceApp />);
    expect(screen.getByText('CI/CD Workspace')).toBeInTheDocument();
    expect(screen.getByText('● live')).toBeInTheDocument();
    // Health is the default section; the down repo sorts first in the fleet
    const rows = screen.getByLabelText('Pipeline fleet').querySelectorAll('.fleet-row');
    expect(rows[0]).toHaveTextContent('cairnea/infra');
  });

  it('shows the connecting state before the first live frame (state null)', () => {
    mockHook.mockReturnValue({ state: null, connected: false });
    render(<WorkspaceApp />);
    expect(screen.getByRole('status')).toHaveTextContent(/connecting/i);
    expect(screen.getByText('○ reconnecting')).toBeInTheDocument();
  });

  it('an unbuilt section falls back to the legacy bridge with a classic-dashboard link', () => {
    mockHook.mockReturnValue({ state: STATE, connected: true });
    render(<WorkspaceApp />);
    fireEvent.click(screen.getByText('Tune & Investigate'));
    const link = screen.getByRole('link', { name: /open classic dashboard/i });
    expect(link).toHaveAttribute('href', '/#metrics'); // tune → metrics tab (still bridged)
  });
});
