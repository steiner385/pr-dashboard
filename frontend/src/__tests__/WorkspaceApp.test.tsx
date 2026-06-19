import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DashboardState } from '../types';
import { ApiBaseProvider } from '../embed/ApiBaseContext';
import { RouterProvider } from '../embed/RouterContext';

// Mock the live-data hook so the composition is deterministic.
const mockHook = vi.fn();
vi.mock('../useDashboard', () => ({ useDashboard: () => mockHook() }));

// Stub the heavy ported panels so we test the WIRING, not their internals.
vi.mock('../MetricsView', () => ({ MetricsView: () => <div data-testid="metrics-view">METRICS</div> }));
vi.mock('../SettingsPanel', () => ({ SettingsPanel: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Settings">SETTINGS</div> : null) }));
vi.mock('../LegendPanel', () => ({ LegendPanel: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Legend">LEGEND</div> : null) }));

import { WorkspaceApp } from '../shell/WorkspaceApp';

const STATE = {
  generatedAt: '2026-06-17T00:00:00Z', staleSince: null,
  repos: [
    { repo: 'cairnea/KinDash', hasDeploy: false, prs: [{ number: 1 }, { number: 2 }], queue: null, laneHealth: { main: 'green' } },
    { repo: 'cairnea/infra', hasDeploy: false, prs: [], queue: null, laneHealth: { main: 'red' } },
  ],
} as unknown as DashboardState;

const renderApp = () => render(
  <ApiBaseProvider><RouterProvider mode="hash"><WorkspaceApp /></RouterProvider></ApiBaseProvider>,
);

describe('WorkspaceApp (Increment 1 MVP composition)', () => {
  beforeEach(() => { location.hash = ''; mockHook.mockReset(); });

  it('renders the shell + spine + Health fleet over live state', () => {
    mockHook.mockReturnValue({ state: STATE, connected: true });
    renderApp();
    expect(screen.getByText('CI/CD Workspace')).toBeInTheDocument();
    expect(screen.getByText('● live')).toBeInTheDocument();
    // Health is the default section; the down repo sorts first in the fleet
    const rows = screen.getByLabelText('Pipeline fleet').querySelectorAll('.fleet-row');
    expect(rows[0]).toHaveTextContent('cairnea/infra');
  });

  it('shows the connecting state before the first live frame (state null)', () => {
    mockHook.mockReturnValue({ state: null, connected: false });
    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent(/connecting/i);
    expect(screen.getByText('○ reconnecting')).toBeInTheDocument();
  });

  it('every section is built — no legacy bridge link, and Insights replaces Tune/Metrics (WS3a)', () => {
    mockHook.mockReturnValue({ state: STATE, connected: true });
    renderApp();
    expect(screen.queryByRole('link', { name: /open classic dashboard/i })).not.toBeInTheDocument();
    // the consolidated nav: Insights present, the retired tabs gone
    expect(screen.getByText('Insights')).toBeInTheDocument();
    expect(screen.queryByText('Tune & Investigate')).not.toBeInTheDocument();
    expect(screen.queryByText('Metrics')).not.toBeInTheDocument();
  });

  it('offers the legacy back-door link (workspace is the default now)', () => {
    mockHook.mockReturnValue({ state: STATE, connected: true });
    renderApp();
    const link = screen.getByRole('link', { name: /classic/i });
    expect(link).toHaveAttribute('href', '?legacy=1');
  });

  it('surfaces the Insights section (Metrics + Tune folded together — WS3a)', async () => {
    mockHook.mockReturnValue({ state: STATE, connected: true });
    renderApp();
    fireEvent.click(screen.getByText('Insights'));
    expect(await screen.findByTestId('metrics-view')).toBeInTheDocument();
    // the Tune panels are folded in too
    expect(screen.getByLabelText('Budgets')).toBeInTheDocument();
  });

  it('the gear opens Settings and the ? opens the Legend', () => {
    mockHook.mockReturnValue({ state: STATE, connected: true });
    renderApp();
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    expect(screen.getByRole('dialog', { name: 'Legend' })).toBeInTheDocument();
  });

  it('opens the command palette via ⌘K and via the header trigger (WS5.3)', () => {
    mockHook.mockReturnValue({ state: STATE, connected: true });
    renderApp();
    expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog', { name: /command palette/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', metaKey: true }); // toggles closed
    expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /command palette/i }));
    expect(screen.getByRole('dialog', { name: /command palette/i })).toBeInTheDocument();
  });

  it('shows the notifications bell when supported and toggles it', () => {
    const toggleNotify = vi.fn();
    mockHook.mockReturnValue({ state: STATE, connected: true, notifySupported: true, notifyEnabled: false, toggleNotify });
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Browser notifications/i }));
    expect(toggleNotify).toHaveBeenCalledTimes(1);
  });
});
