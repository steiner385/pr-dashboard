import { useCallback, useEffect, useRef, useState } from 'react';
import { ForecastBanner } from './shell/ForecastBanner';
import { HealthView } from './sections/health/HealthView';
import { PipelineView } from './sections/pipeline/PipelineView';
import { DiagnoseView } from './sections/diagnose/DiagnoseView';
import { ModelEditView } from './sections/modelEdit/ModelEditView';
import { InsightsView } from './sections/insights/InsightsView';
import { ErrorBoundary } from './ErrorBoundary';
import { useSectionRoute } from './embed/RouterContext';
import { SECTIONS, laneToSection, type SectionId } from './shell/sections';
import type { WorkspaceApi } from './shell/workspaceApi';
import type { DashboardState } from './types';

export interface SectionContentProps {
  active: SectionId;
  state: DashboardState | null;
  connected: boolean;
  api: WorkspaceApi;
  focused: string | null;
  onFocusRepo: (repo: string) => void;
}

/** Render the active section view. No landmark (the host/standalone shell owns <main>). */
export function SectionContent({ active, state, connected, api, focused, onFocusRepo }: SectionContentProps) {
  const { go } = useSectionRoute();
  // Stable callback — same `go` reference → same onJumpToLane identity → HealthView
  // and HealthHeader don't re-render just because SectionContent re-renders.
  const onJumpToLane = useCallback(
    (laneId: string | null) => go(laneToSection(laneId)),
    [go],
  );

  let body: React.ReactNode;
  if (!state) {
    body = <div className="workspace-loading" role="status">Connecting to the live feed…</div>;
  } else {
    let section: React.ReactNode;
    switch (active) {
      case 'health':
        section = (
          <>
            <ForecastBanner api={api} repo={focused} />
            <HealthView state={state} connected={connected} onFocusRepo={onFocusRepo}
              onJumpToLane={onJumpToLane} />
          </>
        );
        break;
      case 'pipeline': section = <PipelineView state={state} focusedRepo={focused} />; break;
      case 'diagnose': section = <DiagnoseView state={state} focusedRepo={focused} api={api} />; break;
      case 'model-edit': section = <ModelEditView repo={focused} api={api} />; break;
      case 'insights': section = <InsightsView repo={focused} api={api} />; break;
    }
    body = <ErrorBoundary key={active}>{section}</ErrorBoundary>;
  }

  // The announcer lives OUTSIDE the key={active} boundary so it stays mounted
  // across section changes (a live region only announces if present beforehand).
  return (
    <>
      <SectionAnnouncer active={active} />
      {body}
    </>
  );
}

/**
 * a11y (#195): announce intentional section navigation to screen readers via a
 * scoped polite live region. The broad `<main aria-live>` was removed (#171) to
 * stop the SSE announcement flood; this announces ONLY the incoming section name
 * on a route change, skipping the initial section (page load is not a navigation).
 */
function SectionAnnouncer({ active }: { active: SectionId }) {
  const [message, setMessage] = useState('');
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const label = SECTIONS.find((s) => s.id === active)?.label ?? active;
    setMessage(`${label} section`);
  }, [active]);
  return (
    <div data-testid="section-announcer" className="sr-only" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
