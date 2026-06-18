// Model & Edit section (roadmap WS3b) — one surface for the protection model in
// three modes, replacing the overlapping Model / Optimize / Build sections (all three
// read the same derived model and the same /api/workspace loop). Inspect = the
// read matrix; Optimize = findings → simulate → draft PR; Edit = the visual no-code
// editor. A mode tablist composes the three existing, already-tested surfaces.
import { useState } from 'react';
import type { WorkspaceApi } from '../../shell/workspaceApi';
import { ModelView } from '../model/ModelView';
import { OptimizeView } from '../optimize/OptimizeView';
import { BuildView } from '../build/BuildView';

type Mode = 'inspect' | 'optimize' | 'edit';
const MODES: { id: Mode; label: string; blurb: string }[] = [
  { id: 'inspect', label: 'Inspect', blurb: 'what gates a merge, and where it drifts' },
  { id: 'optimize', label: 'Optimize', blurb: 'findings → simulate → draft PR' },
  { id: 'edit', label: 'Edit', blurb: 'shape the pipeline visually' },
];

export function ModelEditView({ repo, api }: { repo: string | null; api: WorkspaceApi }) {
  const [mode, setMode] = useState<Mode>('inspect');

  if (!repo) return <div className="model-edit-view empty">Select a pipeline to inspect and shape its model.</div>;

  return (
    <div className="model-edit-view">
      <div className="model-edit-modes" role="tablist" aria-label="Model & Edit mode">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="tab" id={`me-tab-${m.id}`}
            aria-selected={mode === m.id} aria-controls={`me-panel-${m.id}`} title={m.blurb}
            className={`model-edit-tab${mode === m.id ? ' active' : ''}`} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div id={`me-panel-${mode}`} role="tabpanel" aria-labelledby={`me-tab-${mode}`}>
        {mode === 'inspect' && <ModelView repo={repo} api={api} />}
        {mode === 'optimize' && <OptimizeView repo={repo} api={api} />}
        {mode === 'edit' && <BuildView repo={repo} api={api} />}
      </div>
    </div>
  );
}
