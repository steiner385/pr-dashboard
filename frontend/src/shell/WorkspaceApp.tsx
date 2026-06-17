// The unified-workspace entry composition (spec 001, Increment 1 MVP): wires the
// shell + the spine (pipeline switcher + liveness) + the Health section over the
// live DashboardState. Sections not yet rebuilt (Diagnose/Model/Optimize/Tune)
// deep-link into the legacy tabs via the bridge — strangler-fig, so nothing is
// lost mid-rebuild. This is mounted behind the workspace flag; the classic App
// stays the default until parity.
import { useMemo } from 'react';
import { useDashboard } from '../useDashboard';
import { WorkspaceShell } from './WorkspaceShell';
import { PipelineSwitcher, useFocusedPipeline } from './PipelineSwitcher';
import { HealthView } from '../sections/health/HealthView';
import { DiagnoseView } from '../sections/diagnose/DiagnoseView';
import { OptimizeView } from '../sections/optimize/OptimizeView';
import { ModelView } from '../sections/model/ModelView';
import { makeWorkspaceApi } from './workspaceApi';
import type { SectionId } from './sections';

// workspace section → legacy tab hash (where its capability lives until rebuilt)
const LEGACY_TAB: Record<SectionId, string> = {
  health: '#delivery', diagnose: '#pipeline', model: '#designer', optimize: '#designer', tune: '#metrics',
};

function LegacyBridge({ id }: { id: SectionId }) {
  return (
    <div className="legacy-bridge" role="region" aria-label={`${id} (classic)`}>
      <p>This section isn’t rebuilt yet. Its capability still lives in the classic dashboard.</p>
      <a className="legacy-bridge-link" href={`/${LEGACY_TAB[id]}`} target="_blank" rel="noreferrer">
        Open classic dashboard ↗
      </a>
    </div>
  );
}

export function WorkspaceApp() {
  const { state, connected } = useDashboard();
  const repos = useMemo(() => (state ? state.repos.map((r) => r.repo) : []), [state]);
  const [focused, focus] = useFocusedPipeline(repos);
  const api = useMemo(() => makeWorkspaceApi(), []);

  const header = (
    <div className="workspace-spine">
      <span className="workspace-brand">CI/CD Workspace</span>
      <PipelineSwitcher repos={repos} focused={focused} onFocus={focus} />
      <span className={connected ? 'liveness live' : 'liveness down'} title={connected ? 'live' : 'reconnecting'}>
        {connected ? '● live' : '○ reconnecting'}
      </span>
    </div>
  );

  if (!state) {
    return (
      <WorkspaceShell
        header={header}
        content={{ health: <div className="workspace-loading" role="status">Connecting to the live feed…</div> }}
        legacyBridge={(id) => <LegacyBridge id={id} />}
      />
    );
  }

  return (
    <WorkspaceShell
      header={header}
      content={{
        health: <HealthView state={state} connected={connected} onFocusRepo={focus} />,
        diagnose: <DiagnoseView state={state} focusedRepo={focused} />,
        model: <ModelView repo={focused} api={api} />,
        optimize: <OptimizeView repo={focused} api={api} />,
      }}
      legacyBridge={(id) => <LegacyBridge id={id} />}
    />
  );
}
