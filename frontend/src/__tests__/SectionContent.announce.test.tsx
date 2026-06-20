import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouterProvider } from '../embed/RouterContext';
import { ApiBaseProvider } from '../embed/ApiBaseContext';
import { SectionContent } from '../SectionContent';
import { makeWorkspaceApi } from '../shell/workspaceApi';
import type { DashboardState } from '../types';
import type { SectionId } from '../shell/sections';

// Section views may render noisy errors with the minimal stub state — we only
// assert the announcer here, so silence the caught-error console spam.
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

const api = makeWorkspaceApi();
const state = { prs: [], repos: [], checks: [], lanes: [] } as unknown as DashboardState;

const view = (active: SectionId) =>
  <ApiBaseProvider><RouterProvider mode="hash">
    <SectionContent active={active} state={state} connected={true} api={api}
      focused={null} onFocusRepo={() => {}} />
  </RouterProvider></ApiBaseProvider>;

describe('SectionContent — screen-reader section-nav announcement (#195)', () => {
  it('has a polite live region that is empty on initial mount (page load is not a navigation)', () => {
    render(view('health'));
    const live = screen.getByTestId('section-announcer');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent(''); // no announcement on first render
  });

  it('announces the incoming section label when the active section changes', () => {
    const { rerender } = render(view('health'));
    rerender(view('insights'));
    expect(screen.getByTestId('section-announcer')).toHaveTextContent('Insights section');
    rerender(view('pipeline'));
    expect(screen.getByTestId('section-announcer')).toHaveTextContent('Pipeline section');
  });

  it('does not re-announce when the active section is unchanged', () => {
    const { rerender } = render(view('diagnose'));
    rerender(view('diagnose'));
    expect(screen.getByTestId('section-announcer')).toHaveTextContent(''); // still the initial (no change)
  });
});
