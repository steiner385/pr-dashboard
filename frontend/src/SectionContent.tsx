import { ForecastBanner } from './shell/ForecastBanner';
import { HealthView } from './sections/health/HealthView';
import { PipelineView } from './sections/pipeline/PipelineView';
import { DiagnoseView } from './sections/diagnose/DiagnoseView';
import { ModelEditView } from './sections/modelEdit/ModelEditView';
import { InsightsView } from './sections/insights/InsightsView';
import { ErrorBoundary } from './ErrorBoundary';
import { useSectionRoute } from './embed/RouterContext';
import { laneToSection, type SectionId } from './shell/sections';
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
  if (!state) {
    return <div className="workspace-loading" role="status">Connecting to the live feed…</div>;
  }

  let section: React.ReactNode;
  switch (active) {
    case 'health':
      section = (
        <>
          <ForecastBanner api={api} repo={focused} />
          <HealthView state={state} connected={connected} onFocusRepo={onFocusRepo}
            onJumpToLane={(laneId) => go(laneToSection(laneId))} />
        </>
      );
      break;
    case 'pipeline': section = <PipelineView state={state} focusedRepo={focused} />; break;
    case 'diagnose': section = <DiagnoseView state={state} focusedRepo={focused} api={api} />; break;
    case 'model-edit': section = <ModelEditView repo={focused} api={api} />; break;
    case 'insights': section = <InsightsView repo={focused} api={api} />; break;
  }

  return <ErrorBoundary key={active}>{section}</ErrorBoundary>;
}
