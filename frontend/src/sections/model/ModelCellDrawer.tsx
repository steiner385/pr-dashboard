// Drill-down drawer for the workspace Inspect matrix (Model & Edit consolidation):
// click a check → see its per-tier evidence, then run the SAME what-if simulation
// the Optimize tab uses, anchored to that check, and copy a Claude Code prompt —
// without leaving Inspect. Reuses WorkspaceApi.simulate/prompt (server-validated)
// rather than the legacy ProtectionDrawer's raw-fetch data path.
import { useRef, useState } from 'react';
import type { WorkspaceApi, SimResultDto } from '../../shell/workspaceApi';
import type { DerivedModelLike } from '../optimize/types';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { STATE_GLYPH, displayName, fmtMin, type CellState } from '../../protectionModel';

const REMOVE = '__remove__';

/** Observed real-failure rate (%) — derived (CellLike has realFailures + runs). */
function failRate(o: { runs: number; realFailures: number }): number {
  return o.runs > 0 ? (o.realFailures / o.runs) * 100 : 0;
}

export interface ModelCellDrawerProps {
  check: string;
  model: DerivedModelLike;
  repo: string;
  api: WorkspaceApi;
  onClose: () => void;
  /** focus returns here (the cell/row that opened the drawer) on close */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

export function ModelCellDrawer({ check, model, repo, api, onClose, returnFocusRef }: ModelCellDrawerProps) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, true, { onClose, returnFocusRef });

  const meta = model.checkMeta.find((m) => m.check === check);
  const rows = model.tiers.map((t) => ({ tier: t, cell: model.cells.find((c) => c.check === check && c.tierId === t.id) }));
  const fromTiers = rows.filter((r) => r.cell?.intent.runs).map((r) => r.tier);

  const [from, setFrom] = useState(fromTiers[0]?.id ?? model.tiers[0]?.id ?? '');
  const [to, setTo] = useState<string>(REMOVE);
  const [sim, setSim] = useState<SimResultDto | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<'sim' | 'prompt' | null>(null);

  const runSim = async () => {
    setPending('sim'); setPrompt(null);
    try { setSim(await api.simulate(repo, { check, fromTierId: from, toTierId: to === REMOVE ? null : to })); }
    catch { setSim({ legal: false, reason: 'error', note: 'Simulation failed — try again.', costDeltaMinutes: 0, direction: 'remove', gatesLost: [], gatesGained: [], estimated: true }); }
    finally { setPending(null); }
  };
  const copyPrompt = async () => {
    setPending('prompt');
    try {
      const { prompt: text } = await api.prompt(repo, { goal: 'cost', check, detail: sim?.note ?? '', fromTierId: from, toTierId: to === REMOVE ? null : to });
      setPrompt(text);
      try { await navigator.clipboard?.writeText?.(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable — text is shown to copy manually */ }
    } catch { setPrompt('Couldn’t build the prompt — try again.'); }
    finally { setPending(null); }
  };

  // to-options: any tier other than the from-tier, plus "remove from the from-tier".
  const toOptions = model.tiers.filter((t) => t.id !== from);

  return (
    <>
      <div className="model-drawer-backdrop" data-testid="model-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="model-drawer" data-testid="model-drawer" role="dialog" aria-modal="true"
        aria-label={`Inspect ${displayName(check)}`} ref={ref} tabIndex={-1}>
        <div className="model-drawer-head">
          <strong className="model-drawer-check" title={check}>{displayName(check)}</strong>
          {meta?.isRequiredMergeGate && <span className="model-drawer-gate" title="required merge gate">🔒 required</span>}
          <button type="button" className="model-drawer-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <p className="model-drawer-prov">
          {meta?.provenance?.length ? `defined in ${meta.provenance.map((p) => `${p.file} › ${p.jobId}`).join(', ')}` : 'workflow source unknown'}
        </p>
        {meta?.needs && meta.needs.length > 0 && (
          <p className="model-drawer-needs">depends on: {meta.needs.join(', ')}</p>
        )}

        <table className="model-evidence" data-testid="model-evidence" aria-label="Per-tier evidence">
          <thead><tr><th scope="col">tier</th><th scope="col">state</th><th scope="col">runs</th><th scope="col">fail%</th><th scope="col">min</th></tr></thead>
          <tbody>
            {rows.map(({ tier, cell }) => {
              const o = cell?.observed;
              const state = (cell?.state ?? 'absent') as CellState;
              return (
                <tr key={tier.id} className={cell?.drift ? 'ev-drift' : ''}>
                  <td>{tier.label}</td>
                  <td className={`state-${state}`}>{STATE_GLYPH[state] ?? '·'} {state}{cell?.drift ? ' ⚠' : ''}</td>
                  <td>{o ? o.runs.toLocaleString() : '—'}</td>
                  <td>{o && o.runs ? `${Math.round(failRate(o))}%` : '—'}</td>
                  <td>{o ? fmtMin(o.minutes) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="model-drawer-sim" data-testid="model-sim">
          <div className="model-sim-label">What-if</div>
          <div className="model-sim-controls">
            <label>move from
              <select data-testid="model-sim-from" value={from} onChange={(e) => { setFrom(e.target.value); setSim(null); }}>
                {(fromTiers.length ? fromTiers : model.tiers).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <label>to
              <select data-testid="model-sim-to" value={to} onChange={(e) => { setTo(e.target.value); setSim(null); }}>
                <option value={REMOVE}>— remove —</option>
                {toOptions.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <button type="button" data-testid="model-sim-run" disabled={pending === 'sim'} onClick={runSim}>
              {pending === 'sim' ? 'Simulating…' : 'Simulate'}
            </button>
          </div>
          {sim && (
            <p className={`model-sim-result ${!sim.legal ? 'bad' : sim.costDeltaMinutes < 0 ? 'good' : sim.costDeltaMinutes > 0 ? 'bad' : ''}`}
              data-testid="model-sim-result" role="status" data-legal={sim.legal ? '1' : '0'}>
              {sim.note}{sim.confidence === 'low' ? ' · low confidence' : ''}
            </p>
          )}
        </div>

        <div className="model-drawer-actions">
          <button type="button" className="model-action-primary" data-testid="model-copy-prompt" disabled={pending === 'prompt'} onClick={copyPrompt}>
            {copied ? '✓ Copied' : pending === 'prompt' ? 'Building…' : 'Copy Claude Code prompt'}
          </button>
        </div>
        {prompt && <pre className="model-prompt" data-testid="model-prompt" aria-label="claude code prompt">{prompt}</pre>}
      </aside>
    </>
  );
}
