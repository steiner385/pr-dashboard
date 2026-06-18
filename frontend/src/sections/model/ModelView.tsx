// Model section (spec 001, US3 / FR-008/FR-009): the read view of the protection
// model. Surfaces the merge contract (required gates), the check × tier matrix with
// cell-state glyphs, and drift — so "what gates a merge, and where is it drifting?"
// is answerable at a glance (SC-005). Reads the SHA-pinned model via the same
// /api/workspace client; API injected for tests.
import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceApi, SecurityFindingDto, RulesetDto } from '../../shell/workspaceApi';
import type { DerivedModelLike, CellLike } from '../optimize/types';
import { groupShards } from './groupShards';

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
  const [security, setSecurity] = useState<SecurityFindingDto[] | null>(null);
  const [ruleset, setRuleset] = useState<RulesetDto | null>(null);

  useEffect(() => {
    if (!repo) return;
    setModel(null); setError(null); setSha(null); setSecurity(null); setRuleset(null);
    api.getPipeline(repo).then((r) => { setModel(r.model); setSha(r.sourceSha); }).catch((e: Error) => setError(e.message));
    // security + ruleset are advisory — their failure must not block the model read
    api.security(repo).then((r) => setSecurity(r.findings)).catch(() => setSecurity(null));
    api.ruleset(repo).then(setRuleset).catch(() => setRuleset(null));
  }, [repo, api]);

  const [showGates, setShowGates] = useState(false);
  const [driftOnly, setDriftOnly] = useState(false);
  const [openShards, setOpenShards] = useState<Set<string>>(new Set());
  const required = useMemo(() => (model ? requiredGates(model) : []), [model]);
  const drift = useMemo(() => (model ? driftCells(model) : []), [model]);
  const driftChecks = useMemo(() => new Set(drift.map((c) => c.check)), [drift]);
  const cellAt = (check: string, tier: string) => model!.cells.find((c) => c.check === check && c.tierId === tier);

  if (!repo) return <div className="model-view empty">Select a pipeline to inspect its model.</div>;
  if (error) return <div className="model-view error" role="alert">Couldn’t derive the model: {error}</div>;
  if (!model) return <div className="model-view" role="status">Deriving the pipeline model…</div>;

  const rows = driftOnly ? model.checks.filter((c) => driftChecks.has(c)) : model.checks;

  const cellTds = (check: string) => model.tiers.map((t) => {
    const cell = cellAt(check, t.id);
    const state = cell?.state ?? 'absent';
    return (
      <td key={t.id} className={`cell state-${state}${cell?.drift ? ' drift' : ''}`} title={`${state}${cell?.drift ? ' — drift' : ''}`}>
        {GLYPH[state] ?? '·'}{cell?.drift ? '⚠' : ''}
      </td>
    );
  });
  const checkRow = (check: string, shardMember = false) => (
    <tr key={check} className={shardMember ? 'shard-member' : undefined}>
      <th scope="row">{check}{required.includes(check) && <span title="required merge gate"> 🔒</span>}</th>
      {cellTds(check)}
    </tr>
  );
  const toggleShard = (base: string) => setOpenShards((p) => { const n = new Set(p); n.has(base) ? n.delete(base) : n.add(base); return n; });

  return (
    <div className="model-view">
      <h2>Model — {repo} <span className="model-sha" title="derived from this commit">@{sha?.slice(0, 7)}</span></h2>

      {/* Compact summary bar — counts + toggles, not prose walls (roadmap 2.4) */}
      <div className="model-summary">
        <button type="button" className="model-chip" aria-expanded={showGates} onClick={() => setShowGates((s) => !s)}>
          🔒 {required.length} required gate{required.length === 1 ? '' : 's'}
        </button>
        {drift.length > 0 && (
          <button type="button" className={`model-chip drift${driftOnly ? ' active' : ''}`} aria-pressed={driftOnly} onClick={() => setDriftOnly((d) => !d)}>
            ⚠ {drift.length} cell{drift.length === 1 ? '' : 's'} drifting
          </button>
        )}
        {ruleset && (
          <span className={`model-chip ruleset ${ruleset.readable ? (ruleset.inSync ? 'in-sync' : 'mismatch') : 'unreadable'}`}>
            {!ruleset.readable ? '🔐 ruleset unreadable' : ruleset.inSync ? '✓ ruleset in sync' : '⚠ ruleset mismatch'}
          </span>
        )}
      </div>
      {showGates && (
        <p className="merge-contract" role="status">required gates: {required.length ? required.join(', ') : 'none detected'}</p>
      )}

      <p className="matrix-legend" aria-label="Matrix legend">{GLYPH.gate} gate · {GLYPH.conditional} conditional · {GLYPH.advisory} advisory · {GLYPH.absent} absent · ⚠ drift</p>

      <table className="protection-matrix" aria-label="Protection matrix">
        <thead>
          <tr><th scope="col">Check</th>{model.tiers.map((t) => <th key={t.id} scope="col">{t.label}</th>)}</tr>
        </thead>
        <tbody>
          {groupShards(rows).flatMap((r) => {
            if (r.kind === 'single') return [checkRow(r.check)];
            const expanded = openShards.has(r.base);
            const summary = (
              <tr key={r.base} className="shard-group">
                <th scope="row">
                  <button type="button" className="shard-toggle" aria-expanded={expanded} onClick={() => toggleShard(r.base)}>
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {r.base} <span className="shard-count">({r.members.length} shards)</span>
                  </button>
                </th>
                {cellTds(r.members[0])}
              </tr>
            );
            return expanded ? [summary, ...r.members.map((m) => checkRow(m, true))] : [summary];
          })}
        </tbody>
      </table>

      {/* Details below the matrix — ruleset specifics + security (roadmap 2.4) */}
      {ruleset && ruleset.readable && !ruleset.inSync && (
        <p className="model-ruleset-detail mismatch" role="status">
          ⚠ Ruleset mismatch — {ruleset.missingFromModel.length ? `ruleset requires ${ruleset.missingFromModel.join(', ')} not enforced by config` : ''}
          {ruleset.missingFromModel.length && ruleset.extraInModel.length ? '; ' : ''}
          {ruleset.extraInModel.length ? `config gates ${ruleset.extraInModel.join(', ')} the ruleset doesn’t` : ''}
        </p>
      )}
      {ruleset && !ruleset.readable && (
        <p className="model-ruleset-detail unreadable" role="status">🔐 Ruleset unreadable — grant administration:read to verify required-gate parity</p>
      )}
      {security && security.length > 0 && (
        <section className="model-security" aria-label="Security findings">
          <h3>Security ({security.length})</h3>
          <ul role="list">
            {security.map((f, i) => (
              <li key={i} className={`sec-finding conf-${f.confidence}`} data-kind={f.kind}>
                <span className="sec-kind">{f.kind}</span>
                <span className="sec-conf">[{f.confidence}]</span>{' '}
                <span className="sec-detail">{f.detail}</span>
                {f.jobId && <span className="sec-loc"> — {f.file} · {f.jobId}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
