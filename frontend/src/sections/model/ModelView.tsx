// Model section (spec 001, US3 / FR-008/FR-009): the read view of the protection
// model. Surfaces the merge contract (required gates), the check × tier matrix with
// cell-state glyphs, and drift — so "what gates a merge, and where is it drifting?"
// is answerable at a glance (SC-005). Reads the SHA-pinned model via the same
// /api/workspace client; API injected for tests.
import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceApi } from '../../shell/workspaceApi';
import type { DerivedModelLike, CellLike } from '../optimize/types';

const GLYPH: Record<string, string> = { gate: '🔒', conditional: '◐', advisory: '•', absent: '·' };

export function requiredGates(model: DerivedModelLike): string[] {
  return model.checkMeta.filter((m) => m.isRequiredMergeGate).map((m) => m.check);
}
export function driftCells(model: DerivedModelLike): CellLike[] {
  return model.cells.filter((c) => c.drift);
}

export interface ModelViewProps { repo: string | null; api: WorkspaceApi }

export function ModelView({ repo, api }: ModelViewProps) {
  const [model, setModel] = useState<DerivedModelLike | null>(null);
  const [sha, setSha] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    setModel(null); setError(null); setSha(null);
    api.getPipeline(repo).then((r) => { setModel(r.model); setSha(r.sourceSha); }).catch((e: Error) => setError(e.message));
  }, [repo, api]);

  const required = useMemo(() => (model ? requiredGates(model) : []), [model]);
  const drift = useMemo(() => (model ? driftCells(model) : []), [model]);
  const cellAt = (check: string, tier: string) => model!.cells.find((c) => c.check === check && c.tierId === tier);

  if (!repo) return <div className="model-view empty">Select a pipeline to inspect its model.</div>;
  if (error) return <div className="model-view error" role="alert">Couldn’t derive the model: {error}</div>;
  if (!model) return <div className="model-view" role="status">Deriving the pipeline model…</div>;

  return (
    <div className="model-view">
      <h2>Model — {repo} <span className="model-sha" title="derived from this commit">@{sha?.slice(0, 7)}</span></h2>
      <p className="merge-contract" role="status">
        <strong>Merge contract:</strong>{' '}
        {required.length ? `${required.length} required gate${required.length === 1 ? '' : 's'} — ${required.join(', ')}` : 'no required gates detected'}
      </p>
      {drift.length > 0 && (
        <p className="model-drift" role="status">⚠ {drift.length} cell{drift.length === 1 ? '' : 's'} drifting (config ≠ observed)</p>
      )}
      <table className="protection-matrix" aria-label="Protection matrix">
        <thead>
          <tr><th scope="col">Check</th>{model.tiers.map((t) => <th key={t.id} scope="col">{t.label}</th>)}</tr>
        </thead>
        <tbody>
          {model.checks.map((check) => (
            <tr key={check}>
              <th scope="row">{check}{required.includes(check) && <span title="required merge gate"> 🔒</span>}</th>
              {model.tiers.map((t) => {
                const cell = cellAt(check, t.id);
                const state = cell?.state ?? 'absent';
                return (
                  <td key={t.id} className={`cell state-${state}${cell?.drift ? ' drift' : ''}`} title={`${state}${cell?.drift ? ' — drift' : ''}`}>
                    {GLYPH[state] ?? '·'}{cell?.drift ? '⚠' : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
