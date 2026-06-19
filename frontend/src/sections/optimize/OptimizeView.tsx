// Optimize section / IDE entry (spec 001, US4): the "act" surface that drives the
// already-built server loop (/api/workspace/*). For the focused pipeline it loads
// the model, lets the user simulate a tier change, and — when legal — preview a
// draft-PR diff or copy a Claude Code prompt. The server enforces every safety
// invariant (required-gate union, SHA-pin, draft-only); this UI surfaces the
// verdict. API is injected (testable without a network).
import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceApi, SimResultDto } from '../../shell/workspaceApi';
import type { DerivedModelLike } from './types';
import { PrefixesLever } from './PrefixesLever';
import { demotionFindings } from './findings';

/** first tier id where the check runs (its "home" tier to move from) */
function homeTier(model: DerivedModelLike, check: string): string | null {
  for (const t of model.tiers) {
    const cell = model.cells.find((c) => c.check === check && c.tierId === t.id);
    if (cell?.intent.runs) return t.id;
  }
  return null;
}

export interface OptimizeViewProps { repo: string | null; api: WorkspaceApi }

export function OptimizeView({ repo, api }: OptimizeViewProps) {
  const [model, setModel] = useState<DerivedModelLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sim, setSim] = useState<SimResultDto | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  // Per-action pending state (#168): key → true while that specific action is in-flight.
  // Keys: 'simulate:<check>', 'quarantine:<check>', 'preview', 'copyPrompt', 'simulatePlan'
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [quarantine, setQuarantine] = useState<{ check: string; diff?: string; error?: string } | null>(null);
  const [planChecks, setPlanChecks] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<{ combinedCostDeltaMinutes: number; legal: boolean; reason?: string } | null>(null);
  const [rulesetReadable, setRulesetReadable] = useState(true);
  const [calibration, setCalibration] = useState<{ count: number; meanCostAccuracy: number; recommenderUsable: boolean } | null>(null);

  useEffect(() => {
    if (!repo) return;
    setModel(null); setError(null); setSelected(null); setSim(null); setDiff(null); setPrompt(null); setRulesetReadable(true); setCalibration(null);
    api.getPipeline(repo).then((r) => setModel(r.model)).catch((e: Error) => setError(e.message));
    // trust caveat (roadmap 4.6): a verdict computed without the live branch-protection
    // ruleset is static-only — say so, never imply ruleset-verified safety.
    api.ruleset(repo).then((rs) => setRulesetReadable(rs.readable)).catch(() => setRulesetReadable(false));
    // closed-loop calibration (roadmap 5.4): how accurate past predictions proved.
    api.outcomes(repo).then((o) => setCalibration(o.accuracy)).catch(() => setCalibration(null));
  }, [repo, api]);

  const from = useMemo(() => (model && selected ? homeTier(model, selected) : null), [model, selected]);
  const findings = useMemo(() => (model ? demotionFindings(model).slice(0, 8) : []), [model]);

  function startPending(key: string) { setPending((p) => ({ ...p, [key]: true })); }
  function clearPending(key: string) { setPending((p) => { const n = { ...p }; delete n[key]; return n; }); }

  async function simulate(check: string) {
    setSelected(check); setSim(null); setDiff(null); setPrompt(null);
    const tier = model ? homeTier(model, check) : null;
    if (!repo || !tier) return;
    const key = `simulate:${check}`;
    startPending(key);
    try { setSim(await api.simulate(repo, { check, fromTierId: tier, toTierId: null })); }
    catch (e) { setError((e as Error).message); }
    finally { clearPending(key); }
  }
  async function preview() {
    if (!repo || !selected || !from || !model) return;
    const job = model.checkMeta.find((m) => m.check === selected)?.provenance[0]?.jobId ?? selected;
    startPending('preview');
    try { setDiff((await api.draftPrDryRun(repo, { kind: 'tier', check: selected, jobId: job, fromTierId: from, targetEvent: 'merge_group' })).diff); }
    catch (e) { setError((e as Error).message); }
    finally { clearPending('preview'); }
  }

  // "Author one" path (FR-013/016): hand the demote to Claude Code as a prompt.
  // The server sources provenance + the simulated delta; we display the text
  // (always copy-able) and best-effort write it to the clipboard.
  async function copyPrompt() {
    if (!repo || !selected || !from) return;
    startPending('copyPrompt');
    try {
      const { prompt: text } = await api.prompt(repo, { goal: 'cost', check: selected, detail: sim?.note ?? '', fromTierId: from, toTierId: null });
      setPrompt(text);
      try { await navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable — text is still shown to copy manually */ }
    } catch (e) { setError((e as Error).message); }
    finally { clearPending('copyPrompt'); }
  }

  async function doQuarantine(check: string) {
    if (!repo || !model) return;
    const job = model.checkMeta.find((m) => m.check === check)?.provenance[0]?.jobId ?? check;
    const key = `quarantine:${check}`;
    setQuarantine({ check }); startPending(key);
    try { setQuarantine({ check, diff: (await api.quarantineDryRun(repo, check, job)).diff }); }
    catch (e) { setQuarantine({ check, error: (e as Error).message }); } // server refuses a required gate (FR-038)
    finally { clearPending(key); }
  }

  function togglePlan(check: string) {
    setPlan(null);
    setPlanChecks((prev) => { const next = new Set(prev); next.has(check) ? next.delete(check) : next.add(check); return next; });
  }
  async function simulatePlan() {
    if (!repo || !model || planChecks.size === 0) return;
    const moves = [...planChecks].map((check) => ({ check, fromTierId: homeTier(model, check) ?? 'pr', toTierId: null }));
    startPending('simulatePlan');
    try { setPlan(await api.plan(repo, moves)); }
    catch (e) { setError((e as Error).message); }
    finally { clearPending('simulatePlan'); }
  }

  if (!repo) return <div className="optimize-view empty">Select a pipeline to optimize.</div>;
  if (error) return <div className="optimize-view error" role="alert">Couldn’t load the model: {error}</div>;
  if (!model) return <div className="optimize-view" role="status">Deriving the pipeline model…</div>;

  return (
    <div className="optimize-view">
      <h2>Optimize — {repo}</h2>
      {!rulesetReadable && (
        <p className="optimize-caveat" role="status">⚠ Verdicts are <strong>static-only</strong> — the live branch-protection ruleset is unreadable (grant <code>administration:read</code>). Safety is checked against the inferred gate set, not the enforced one.</p>
      )}
      {calibration && calibration.count > 0 && (
        <p className="optimize-calibration" role="status">
          🎯 Predictions are <strong>{Math.round(calibration.meanCostAccuracy * 100)}% accurate</strong> over {calibration.count} landed change{calibration.count === 1 ? '' : 's'}
          {calibration.recommenderUsable ? '' : ' — advisory until proven'}.
        </p>
      )}

      <PrefixesLever repo={repo} api={api} />

      {findings.length > 0 && (
        <section className="optimize-findings" aria-label="Findings">
          <h3>Findings — top demotion candidates</h3>
          <ul role="list">
            {findings.map((f) => (
              <li key={f.check} className="optimize-finding">
                <span className="finding-impact" aria-hidden="true">💰</span>
                <span className="finding-check">{f.check}</span>
                <span className="finding-why">{f.minutes.toLocaleString()} min/window · never failed — demote candidate</span>
                <button type="button" disabled={!!pending[`simulate:${f.check}`]} onClick={() => simulate(f.check)}>Simulate</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="optimize-checks" role="list">
        {model.checks.map((c) => (
          <li key={c} className={c === selected ? 'optimize-check active' : 'optimize-check'}>
            <label className="plan-toggle">
              <input type="checkbox" checked={planChecks.has(c)} onChange={() => togglePlan(c)} aria-label={`Add ${c} to plan`} />
            </label>
            <span className="optimize-check-name">{c}</span>
            <button type="button" disabled={!!pending[`simulate:${c}`]} onClick={() => simulate(c)}>Simulate demote</button>
            <button type="button" className="quarantine-btn" disabled={!!pending[`quarantine:${c}`]} onClick={() => doQuarantine(c)}>Quarantine (flaky)</button>
          </li>
        ))}
      </ul>
      {planChecks.size > 0 && (
        <section className="optimize-plan" aria-label="Multi-change plan">
          <button type="button" disabled={!!pending['simulatePlan']} onClick={simulatePlan}>Simulate plan ({planChecks.size} change{planChecks.size === 1 ? '' : 's'})</button>
          {plan && (
            <p className={plan.legal ? 'plan-note legal' : 'plan-note illegal'} role="status">
              {plan.legal
                ? `Plan is safe — combined ${plan.combinedCostDeltaMinutes < 0 ? `saves ${(-plan.combinedCostDeltaMinutes).toLocaleString()}` : `adds ${plan.combinedCostDeltaMinutes.toLocaleString()}`} min`
                : `Plan blocked — ${plan.reason}`}
            </p>
          )}
        </section>
      )}
      {quarantine && (
        <section className="optimize-quarantine" aria-label={`Quarantine ${quarantine.check}`}>
          {quarantine.error
            ? <p className="quarantine-blocked" role="status">Can’t quarantine {quarantine.check}: {quarantine.error}</p>
            : quarantine.diff
              ? <><p role="status">Quarantine {quarantine.check} (adds continue-on-error):</p><pre className="quarantine-diff" aria-label="quarantine diff">{quarantine.diff}</pre></>
              : <p role="status">Preparing quarantine for {quarantine.check}…</p>}
        </section>
      )}
      {selected && sim && (
        <section className="optimize-sim" aria-label={`Simulation for ${selected}`}>
          <p className={sim.legal ? 'sim-note legal' : 'sim-note illegal'} role="status">{sim.note}</p>
          {sim.legal && sim.confidence === 'low' && (
            <p className="sim-low-confidence" role="status">⚠ Low-confidence projection (thin/estimated data) — this would generate a review scaffold, not a structured apply.</p>
          )}
          {sim.legal
            ? <div className="optimize-actions">
                <button type="button" disabled={!!pending['preview']} onClick={preview}>Preview draft PR</button>
                <button type="button" disabled={!!pending['copyPrompt']} onClick={copyPrompt}>Copy Claude Code prompt</button>
              </div>
            : <p className="sim-blocked">This change is blocked: {sim.reason}.</p>}
          {diff && <pre className="optimize-diff" aria-label="draft PR diff">{diff}</pre>}
          {prompt && <pre className="optimize-prompt" aria-label="claude code prompt">{prompt}</pre>}
        </section>
      )}
    </div>
  );
}
