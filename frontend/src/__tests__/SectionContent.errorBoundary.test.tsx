import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouterProvider } from '../embed/RouterContext';
import { ApiBaseProvider } from '../embed/ApiBaseContext';
import { SectionContent } from '../SectionContent';
import { makeWorkspaceApi } from '../shell/workspaceApi';
import type { DashboardState } from '../types';

// Silence React's caught-error console spam during this test suite
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// Mock PipelineView to throw on render — simulates a section view crash
vi.mock('../sections/pipeline/PipelineView', () => ({
  PipelineView: () => { throw new Error('PipelineView exploded'); },
}));

const api = makeWorkspaceApi();

const wrap = (ui: React.ReactNode) =>
  <ApiBaseProvider><RouterProvider mode="hash">{ui}</RouterProvider></ApiBaseProvider>;

// Minimal DashboardState stub — enough to bypass the null guard in SectionContent
const state = { prs: [], repos: [], checks: [], lanes: [] } as unknown as DashboardState;

describe('SectionContent error isolation', () => {
  it('shows the ErrorBoundary fallback when the active section throws, instead of propagating', () => {
    render(wrap(
      <SectionContent
        active="pipeline"
        state={state}
        connected={true}
        api={api}
        focused={null}
        onFocusRepo={() => {}}
      />
    ));

    // The boundary renders an [role="alert"] card with the error message
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/PipelineView exploded/);
    expect(alert).toHaveTextContent(/something broke rendering this tab/);
  });

  it('recovers when switching to a healthy section — key={active} resets the boundary', () => {
    // Render the crashing pipeline section; boundary must show the error fallback.
    const { rerender } = render(wrap(
      <SectionContent
        active="pipeline"
        state={state}
        connected={true}
        api={api}
        focused={null}
        onFocusRepo={() => {}}
      />
    ));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Switch to "health" — key={active} remounts the boundary; HealthView is not
    // mocked and renders cleanly with the stub state.
    rerender(wrap(
      <SectionContent
        active="health"
        state={state}
        connected={true}
        api={api}
        focused={null}
        onFocusRepo={() => {}}
      />
    ));

    // The error fallback must be gone, proving the boundary was reset.
    expect(screen.queryByRole('alert')).toBeNull();
    // And healthy content must be present.
    expect(screen.getByRole('group', { name: /overall ci health/i })).toBeInTheDocument();
  });
});
