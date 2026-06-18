// The unified-workspace entry composition (spec 001, Increment 1 MVP): wires the
// shell + the spine (pipeline switcher + liveness) + the Health section over the
// live DashboardState. Sections not yet rebuilt (Diagnose/Model/Optimize/Tune)
// deep-link into the legacy tabs via the bridge — strangler-fig, so nothing is
// lost mid-rebuild. This is mounted behind the workspace flag; the classic App
// stays the default until parity.
import { useMemo, useRef, useState } from 'react';
import './workspace.css';
import { useDashboard } from '../useDashboard';
import { WorkspaceShell } from './WorkspaceShell';
import { PipelineSwitcher, useFocusedPipeline } from './PipelineSwitcher';
import { HealthView } from '../sections/health/HealthView';
import { DiagnoseView } from '../sections/diagnose/DiagnoseView';
import { PipelineView } from '../sections/pipeline/PipelineView';
import { InsightsView } from '../sections/insights/InsightsView';
import { SettingsPanel } from '../SettingsPanel';
import { LegendPanel } from '../LegendPanel';
import { ModelEditView } from '../sections/modelEdit/ModelEditView';
import { makeWorkspaceApi } from './workspaceApi';
import { SelfHealthDot } from './SelfHealthDot';
import { CommandPalette } from './CommandPalette';
import { ForecastBanner } from './ForecastBanner';
import { laneToSection, hashForSection, type SectionId } from './sections';

// workspace section → legacy tab hash (where its capability lives until rebuilt)
const LEGACY_TAB: Record<SectionId, string> = {
  health: '#delivery', pipeline: '#pipeline', diagnose: '#pipeline', 'model-edit': '#designer', insights: '#metrics',
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
  const { state, connected, notifySupported, notifyEnabled, toggleNotify } = useDashboard();
  const repos = useMemo(() => (state ? state.repos.map((r) => r.repo) : []), [state]);
  const [focused, focus] = useFocusedPipeline(repos);
  const api = useMemo(() => makeWorkspaceApi(), []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);
  const legendRef = useRef<HTMLButtonElement>(null);

  const header = (
    <div className="workspace-spine">
      <span className="workspace-brand">CI/CD Workspace</span>
      <PipelineSwitcher repos={repos} focused={focused} onFocus={focus} />
      <span className={connected ? 'liveness live' : 'liveness down'} title={connected ? 'live' : 'reconnecting'}>
        {connected ? '● live' : '○ reconnecting'}
      </span>
      <SelfHealthDot api={api} />
      <button type="button" ref={legendRef} className="legend-btn" aria-label="Legend"
        title="Legend — what every shape, color, and term on the board means"
        aria-haspopup="dialog" aria-expanded={legendOpen} onClick={() => setLegendOpen(true)}>
        <span aria-hidden="true">?</span>
      </button>
      {notifySupported && (
        <button type="button" className="notify-bell" aria-pressed={notifyEnabled}
          aria-label="Browser notifications (this tab)"
          title={notifyEnabled
            ? 'Browser notifications on (this tab only — tab must stay open). Desktop notifications are toggled in Settings.'
            : 'Enable browser notifications (this tab only — tab must stay open). Desktop notifications are toggled in Settings.'}
          onClick={toggleNotify}>
          <span aria-hidden="true">{notifyEnabled ? '🔔' : '🔕'}</span>
        </button>
      )}
      <button type="button" ref={gearRef} className="settings-gear" aria-label="Settings"
        title="Settings — watched repos, tuning, notifications, per-repo config"
        aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>
        <span aria-hidden="true">⚙</span>
      </button>
    </div>
  );

  const modals = (
    <>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} returnFocusRef={gearRef} connected={connected} />
      <LegendPanel open={legendOpen} onClose={() => setLegendOpen(false)} returnFocusRef={legendRef} />
      <CommandPalette repos={repos} onFocusRepo={focus} />
    </>
  );

  if (!state) {
    return (
      <>
        <WorkspaceShell
          header={header}
          content={{ health: <div className="workspace-loading" role="status">Connecting to the live feed…</div> }}
          legacyBridge={(id) => <LegacyBridge id={id} />}
        />
        {modals}
      </>
    );
  }

  return (
    <>
      <WorkspaceShell
        header={header}
        content={{
          health: <><ForecastBanner api={api} repo={focused} /><HealthView state={state} connected={connected} onFocusRepo={focus} onJumpToLane={(laneId) => { location.hash = hashForSection(laneToSection(laneId)); }} /></>,
          pipeline: <PipelineView state={state} focusedRepo={focused} />,
          diagnose: <DiagnoseView state={state} focusedRepo={focused} />,
          'model-edit': <ModelEditView repo={focused} api={api} />,
          insights: <InsightsView repo={focused} api={api} />,
        }}
        legacyBridge={(id) => <LegacyBridge id={id} />}
      />
      {modals}
    </>
  );
}
