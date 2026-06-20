import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useApiBase } from './embed/ApiBaseContext';
import { simulateMove, legalFromTiers, legalToTargets } from './protectionSimulate';
import { buildClaudePrompt } from './protectionPrompt';
import { useFocusTrap } from './hooks/useFocusTrap';

// ---- DerivedModel mirror (server/pipeline-model/derived) --------------------

interface TierDef { id: string; label: string; event: string }
interface ObservedCell {
  ran: boolean; runs: number; realFailures: number;
  failRatePct: number; flakeRatePct: number; minutes: number;
}
type CellState = 'gate' | 'advisory' | 'conditional' | 'absent';
interface Cell {
  check: string; tierId: string;
  intent: { runs: boolean; gates: boolean; conditional: boolean };
  observed: ObservedCell | null;
  drift: boolean;
  state: CellState;
}
export interface CheckMeta {
  check: string;
  triggers: string[];
  provenance: { file: string; jobId: string }[];
  confidence: 'high' | 'low';
  isRequiredMergeGate: boolean;
}
export interface DerivedModel { tiers: TierDef[]; checks: string[]; cells: Cell[]; checkMeta?: CheckMeta[] }

// gate (mandatory) ▸ conditional (runs-when-touched) ▸ advisory ▸ absent
const STATE_RANK: Record<CellState, number> = { gate: 3, conditional: 2, advisory: 1, absent: 0 };
const ABSENT_META = { role: 'absent' as CellState, drift: false, minutes: 0, gateTiers: [] as string[] };
const STATE_GLYPH: Record<CellState, string> = { gate: '●', conditional: '◐', advisory: '○', absent: '·' };
const STATE_WORD: Record<CellState, string> = { gate: 'gate', conditional: 'conditional', advisory: 'advisory', absent: 'absent' };

// ---- Findings (re-homed recommendations, anchored to checks) -----------------

type Goal = 'drift' | 'cost' | 'quality';
const GOALS: Goal[] = ['drift', 'cost', 'quality']; // urgency order: wrong-now → risk → waste
const GOAL_ICON: Record<Goal, string> = { cost: '💰', quality: '🛡', drift: '⚠' };
const GOAL_LABEL: Record<Goal, string> = { cost: 'Cost', quality: 'Quality', drift: 'Drift' };

export interface Finding { goal: Goal; check: string; detail: string; weight: number }

interface MetricsSlice {
  demotionCandidates?: { repo: string; candidates: { name: string; currentTier: string; suggestedTier: string; minutesInWindow: number }[] }[];
  promotionCandidates?: { repo: string; candidates: { name: string; suggestedTier: string; realFailures: number }[] }[];
}

function buildFindings(repo: string, model: DerivedModel | null, metrics: MetricsSlice | null): Finding[] {
  const out: Finding[] = [];
  for (const cell of model?.cells ?? []) {
    if (cell.drift) out.push({ goal: 'drift', check: cell.check, detail: `${cell.tierId}: configured ≠ observed`, weight: 1 });
  }
  const demo = metrics?.demotionCandidates?.find((d) => d.repo === repo)?.candidates ?? [];
  for (const c of demo) out.push({ goal: 'cost', check: c.name, detail: `${c.currentTier} → ${c.suggestedTier} · ~${c.minutesInWindow.toLocaleString()} min/wk`, weight: c.minutesInWindow });
  const promo = metrics?.promotionCandidates?.find((p) => p.repo === repo)?.candidates ?? [];
  for (const c of promo) out.push({ goal: 'quality', check: c.name, detail: `shift left → ${c.suggestedTier} · ${c.realFailures} real fails caught late`, weight: c.realFailures });
  return out;
}

// ---- helpers ----------------------------------------------------------------

function cellKey(check: string, tierId: string): string { return `${check} ${tierId}`; }
function groupOf(check: string): string { const i = check.indexOf(' / '); return i === -1 ? 'other' : check.slice(0, i); }
function leafOf(check: string): string { const i = check.indexOf(' / '); return i === -1 ? check : check.slice(i + 3); }
/** Display label for a check leaf: drop the raw `(${{ matrix.x }}/N)` template
 *  (the `(i/N)` shard suffix already carries the readable index). */
function displayName(check: string): string {
  return leafOf(check).replace(/\(\$\{\{[^}]*\}\}[^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
}
function fmtMin(m: number): string { return m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)}h` : `${m}m`; }

type Overlay = 'none' | 'cost' | 'quality';
const OVERLAYS: { id: Overlay; label: string }[] = [
  { id: 'none', label: 'States' }, { id: 'cost', label: 'Cost' }, { id: 'quality', label: 'Quality' },
];
function cellHeat(c: Cell | undefined, overlay: Overlay, max: { minutes: number; fail: number }): string | undefined {
  if (overlay === 'none' || !c?.observed) return undefined;
  if (overlay === 'cost') {
    const pct = max.minutes ? Math.round((c.observed.minutes / max.minutes) * 80) : 0;
    return `color-mix(in srgb, var(--amber) ${pct}%, transparent)`;
  }
  const pct = max.fail ? Math.round((c.observed.failRatePct / max.fail) * 80) : 0;
  return `color-mix(in srgb, var(--fail) ${pct}%, transparent)`;
}
function cellTitle(c: Cell): string {
  const parts = [`${c.check} — ${c.tierId}: ${STATE_WORD[c.state]}`];
  if (c.observed) {
    parts.push(`${c.observed.runs} runs · ${c.observed.minutes.toLocaleString()} min`);
    if (c.observed.realFailures > 0) parts.push(`${c.observed.realFailures} real fails (${c.observed.failRatePct}%)`);
    if (c.observed.flakeRatePct > 0) parts.push(`flake ${c.observed.flakeRatePct}%`);
  }
  if (c.drift) parts.push('⚠ drift: configured/observed disagree');
  return parts.join(' · ');
}

// ---- component --------------------------------------------------------------

export function ProtectionMap() {
  const { apiUrl } = useApiBase();
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [model, setModel] = useState<DerivedModel | null>(null);
  const [metrics, setMetrics] = useState<MetricsSlice | null>(null);
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [sim, setSim] = useState<{ check: string; from: string; to: string } | null>(null);
  const [drilled, setDrilled] = useState<{ check: string; goal: Goal; detail: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedGoals, setExpandedGoals] = useState<Set<Goal>>(new Set());
  const [showAbsent, setShowAbsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- a11y: drawer focus management (mirrors LegendPanel/SettingsPanel pattern) ----
  const drawerRef = useRef<HTMLElement>(null);
  /** Ref to the button that last opened the drawer — focus returns here on close. */
  const drawerTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/repos'))
      .then((r) => r.json() as Promise<{ repos: { repo: string; excluded: boolean }[] }>)
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : data?.repos ?? [];
        const names = list.filter((x) => !x.excluded).map((x) => x.repo);
        setRepos(names);
        setRepo((prev) => prev ?? names.find((n) => n.startsWith('cairnea/')) ?? names[0] ?? null);
      })
      .catch(() => { if (!cancelled) setRepos([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    setLoading(true); setError(null);
    fetch(apiUrl(`/protection-map?repo=${encodeURIComponent(repo)}`))
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return r.json() as Promise<DerivedModel>;
      })
      .then((m) => { if (!cancelled) setModel(m); })
      .catch((e) => { if (!cancelled) { setModel(null); setError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repo]);

  // default-collapse groups with no gates and no drift (pure advisory/absent noise);
  // re-seeded whenever the model changes (repo switch). User toggles adjust from there.
  useEffect(() => {
    if (!model) return;
    const problem = new Set<string>();
    for (const c of model.cells) if (c.state === 'gate' || c.drift) problem.add(groupOf(c.check));
    const clean = [...new Set(model.checks.map(groupOf))].filter((g) => !problem.has(g));
    setCollapsed(new Set(clean));
  }, [model]);

  // DEFERRED until the model has loaded: /api/metrics is a heavy synchronous SQLite
  // pass that blocks the Node event loop and would starve /api/protection-map.
  useEffect(() => {
    if (!model || metrics) return;
    let cancelled = false;
    fetch(apiUrl('/metrics?window=30d'))
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (!cancelled) setMetrics(m); })
      .catch(() => { if (!cancelled) setMetrics(null); });
    return () => { cancelled = true; };
  }, [model, metrics]);

  // Esc to close the drawer + focus management + focus trap (via shared hook).
  useFocusTrap(drawerRef, !!drilled, {
    onClose: () => setDrilled(null),
    returnFocusRef: drawerTriggerRef,
  });

  const findings = useMemo(() => buildFindings(repo ?? '', model, metrics), [repo, model, metrics]);
  const byCell = useMemo(() => {
    const m = new Map<string, Cell>();
    for (const c of model?.cells ?? []) m.set(cellKey(c.check, c.tierId), c);
    return m;
  }, [model]);
  const summary = useMemo(() => {
    const s = { gate: 0, conditional: 0, advisory: 0, absent: 0, drift: 0 };
    for (const c of model?.cells ?? []) { s[c.state]++; if (c.drift) s.drift++; }
    return s;
  }, [model]);
  const maxima = useMemo(() => {
    let minutes = 0, fail = 0;
    for (const c of model?.cells ?? []) if (c.observed) { minutes = Math.max(minutes, c.observed.minutes); fail = Math.max(fail, c.observed.failRatePct); }
    return { minutes, fail };
  }, [model]);

  // per-check rollup: dominant role, drift, cost, the tiers it hard-gates at
  const checkMeta = useMemo(() => {
    const m = new Map<string, { role: CellState; drift: boolean; minutes: number; gateTiers: string[] }>();
    for (const check of model?.checks ?? []) {
      let role: CellState = 'absent', drift = false, minutes = 0; const gateTiers: string[] = [];
      for (const t of model!.tiers) {
        const c = byCell.get(cellKey(check, t.id));
        if (!c) continue;
        if (STATE_RANK[c.state] > STATE_RANK[role]) role = c.state;
        if (c.drift) drift = true;
        if (c.observed) minutes += c.observed.minutes;
        if (c.state === 'gate') gateTiers.push(t.id);
      }
      m.set(check, { role, drift, minutes, gateTiers });
    }
    return m;
  }, [model, byCell]);

  // group rows by owning workflow; sort checks problem-first, groups problem-first.
  // Also precomputes per-(group,tier) best CellState for the group header mini-cells
  // so the render loop doesn't re-run the nested byCell lookup on every reconciliation.
  const grouped = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const check of model?.checks ?? []) {
      const g = groupOf(check);
      const arr = groups.get(g) ?? []; arr.push(check); groups.set(g, arr);
    }
    const getMeta = (c: string) => checkMeta.get(c) ?? ABSENT_META;
    const rank = (c: string) => { const m = getMeta(c); return (m.drift ? 100 : 0) + STATE_RANK[m.role] * 10; };
    const tiers = model?.tiers ?? [];
    return [...groups.entries()].map(([name, checks]) => {
      checks.sort((a, b) => rank(b) - rank(a) || (getMeta(b).minutes - getMeta(a).minutes) || leafOf(a).localeCompare(leafOf(b)));
      const drift = checks.some((c) => getMeta(c).drift);
      const gates = checks.filter((c) => getMeta(c).role === 'gate').length;
      const visible = checks.filter((c) => showAbsent || getMeta(c).role !== 'absent');
      // Precompute the best CellState per tier for this group's header row mini-cells.
      const tierBest = new Map<string, CellState>();
      for (const t of tiers) {
        let best: CellState = 'absent';
        for (const c of checks) {
          // byCell is from the outer useMemo and is stable when model is stable
          const cell = byCell.get(cellKey(c, t.id));
          if (cell && STATE_RANK[cell.state] > STATE_RANK[best]) best = cell.state;
        }
        tierBest.set(t.id, best);
      }
      return { name, checks, visible, drift, gates, hiddenAbsent: checks.length - visible.length, tierBest };
    }).sort((a, b) => Number(b.drift) - Number(a.drift) || b.gates - a.gates || a.name.localeCompare(b.name));
  }, [model, checkMeta, showAbsent, byCell]);

  // per-tier rollup (cost + gate count) for the column headers
  const tierStats = useMemo(() => {
    const m = new Map<string, { minutes: number; gates: number }>();
    for (const t of model?.tiers ?? []) {
      let minutes = 0, gates = 0;
      for (const c of model!.cells) if (c.tierId === t.id) { if (c.observed) minutes += c.observed.minutes; if (c.state === 'gate') gates++; }
      m.set(t.id, { minutes, gates });
    }
    return m;
  }, [model]);

  // the merge contract: checks that hard-gate at the queue (merge_group) tier
  const queueTierId = model?.tiers.find((t) => t.event === 'merge_group')?.id;
  const mergeBlockers = useMemo(
    () => (queueTierId ? (model?.checks ?? []).filter((c) => byCell.get(cellKey(c, queueTierId))?.state === 'gate') : []),
    [model, byCell, queueTierId]);
  const redundantGates = useMemo(
    () => (model?.checks ?? []).filter((c) => (checkMeta.get(c)?.gateTiers.length ?? 0) >= 2).length,
    [model, checkMeta]);
  const reclaimable = useMemo(() => {
    const demo = metrics?.demotionCandidates?.find((d) => d.repo === (repo ?? ''))?.candidates ?? [];
    return demo.reduce((s, c) => s + (c.minutesInWindow || 0), 0);
  }, [metrics, repo]);

  const findingsByGoal = useMemo(() => {
    const m: Record<Goal, Finding[]> = { drift: [], cost: [], quality: [] };
    for (const f of findings) m[f.goal].push(f);
    for (const g of GOALS) m[g].sort((a, b) => b.weight - a.weight);
    return m;
  }, [findings]);

  const verdict = summary.drift > 0
    ? { cls: 'warn', text: `${summary.drift} drift` }
    : mergeBlockers.length === 0
      ? { cls: 'bad', text: 'no merge gate' }
      : { cls: 'ok', text: 'protected' };

  const toggleGroup = (n: string) => setCollapsed((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const toggleGoal = (g: Goal) => setExpandedGoals((s) => { const x = new Set(s); if (x.has(g)) x.delete(g); else x.add(g); return x; });
  // open the drill-down drawer for a check, seeding the simulator with the
  // recommended (legal) move so the user lands on the suggested action.
  // `trigger` is the element that opened the drawer — focus returns to it on close.
  const openDrill = (check: string, goal: Goal, detail: string, trigger?: HTMLElement | null) => {
    if (!model) return;
    if (trigger) drawerTriggerRef.current = trigger;
    const fromOpts = legalFromTiers(model, check);
    const from = fromOpts[0]?.id ?? model.tiers[0]?.id ?? '';
    const toOpts = legalToTargets(model, check, from);
    const to = toOpts.find((o) => o.tierId !== null)?.tierId ?? '__remove__';
    setSim({ check, from, to });
    setDrilled({ check, goal, detail });
  };

  return (
    <div className="protection-map">
      {loading && <p className="loading" data-testid="pm-loading">Deriving the protection map…</p>}
      {error && <p className="pm-error" data-testid="pm-error">Couldn’t derive the map: {error}</p>}

      {model && (
        <>
          {/* ── HEALTH STRIP: the answer, first ─────────────────────────── */}
          <div className="pm-health" data-testid="pm-summary">
            <div className="pm-health-id">
              <span className={`pm-verdict pm-verdict-${verdict.cls}`}>{verdict.text}</span>
              {repos.length > 1 ? (
                <select className="pm-repo" aria-label="Pipeline repository" value={repo ?? ''} onChange={(e) => setRepo(e.target.value)}>
                  {repos.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              ) : <span className="pm-repo-name">{repo}</span>}
            </div>
            <div className="pm-stats">
              <span className="pm-stat"><b>{summary.gate}</b><i>gates</i></span>
              <span className="pm-stat pm-stat-warn"><b>{summary.drift}</b><i>drift</i></span>
              <span className="pm-stat"><b>{findings.length}</b><i>actions</i></span>
              {reclaimable > 0 && <span className="pm-stat"><b>~{fmtMin(reclaimable)}</b><i>/wk reclaimable</i></span>}
              {redundantGates > 0 && <span className="pm-stat"><b>{redundantGates}</b><i>multi-tier gates</i></span>}
            </div>
            <div className="pm-overlay-toggle" role="group" aria-label="Matrix overlay">
              {OVERLAYS.map((o) => (
                <button key={o.id} type="button" className={overlay === o.id ? 'pm-ov active' : 'pm-ov'}
                  aria-pressed={overlay === o.id} data-testid={`pm-overlay-${o.id}`} onClick={() => setOverlay(o.id)}>{o.label}</button>
              ))}
            </div>
          </div>

          {/* the merge contract, stated plainly */}
          <p className="pm-contract" data-testid="pm-contract">
            <b>Blocks merge ({mergeBlockers.length}):</b>{' '}
            {mergeBlockers.length ? mergeBlockers.map(leafOf).slice(0, 8).join(' · ') : 'nothing gates the merge queue'}
            {mergeBlockers.length > 8 && ` · +${mergeBlockers.length - 8} more`}
          </p>

          <div className="pm-body">
            {/* ── ACTIONS rail ──────────────────────────────────────────── */}
            <aside className="pm-findings" data-testid="pm-findings" aria-label="Actions">
              <h3>Actions <span className="pm-findings-count">{findings.length}</span></h3>
              {findings.length === 0 && <p className="pm-findings-empty">No actions — the pipeline reads clean.</p>}
              {GOALS.map((goal) => {
                const items = findingsByGoal[goal];
                if (!items.length) return null;
                const open = expandedGoals.has(goal);
                const shown = open ? items : items.slice(0, 3);
                const total = goal === 'cost' ? items.reduce((s, f) => s + f.weight, 0) : 0;
                return (
                  <div key={goal} className={`pm-fgroup pm-fgroup-${goal}`} data-goal={goal}>
                    <div className="pm-fgroup-head">
                      <span>{GOAL_ICON[goal]} {GOAL_LABEL[goal]}</span>
                      <span className="pm-fgroup-meta">{items.length}{total ? ` · ~${fmtMin(total)}/wk` : ''}</span>
                    </div>
                    <ul>
                      {shown.map((f, i) => (
                        <li key={`${f.check}-${i}`} className="pm-finding" data-goal={goal}>
                          <button type="button" className="pm-finding-btn"
                            onClick={(e) => openDrill(f.check, goal, f.detail, e.currentTarget)}
                            aria-label={`Details for ${displayName(f.check)}`}>
                            <span className="pm-finding-check" title={f.check}>{displayName(f.check)}</span>
                            <span className="pm-finding-detail">{f.detail}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {items.length > 3 && (
                      <button type="button" className="pm-show-more" onClick={() => toggleGoal(goal)}>
                        {open ? 'show less' : `show all ${items.length}`}
                      </button>
                    )}
                  </div>
                );
              })}
            </aside>

            {/* ── MATRIX (reference) ────────────────────────────────────── */}
            <div className="pm-grid-wrap">
              <table className="pm-grid" data-testid="pm-grid" aria-label="Protection check matrix">
                <thead>
                  <tr>
                    <th scope="col" className="pm-check-h">
                      check
                      <label className="pm-show-absent">
                        <input type="checkbox" checked={showAbsent} onChange={(e) => setShowAbsent(e.target.checked)} /> absent
                      </label>
                    </th>
                    {model.tiers.map((t) => {
                      const st = tierStats.get(t.id)!;
                      return (
                        <th scope="col" key={t.id} className="pm-tier-h" title={`trigger: ${t.event}`}>
                          {t.label}<i>{st.gates}g · {fmtMin(st.minutes)}</i>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g) => {
                    const open = !collapsed.has(g.name);
                    return (
                      <Fragment key={g.name}>
                        <tr key={`h-${g.name}`} className="pm-group-row" onClick={() => toggleGroup(g.name)}>
                          <th scope="rowgroup" className="pm-group-name">
                            <button
                              type="button"
                              className="pm-group-btn"
                              aria-expanded={open}
                              aria-label={`Toggle group ${g.name}`}
                              onClick={(e) => { e.stopPropagation(); toggleGroup(g.name); }}
                            >
                              <span className="pm-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                              {' '}{g.name}
                              <span className="pm-group-meta">{g.checks.length}{g.gates ? ` · ${g.gates}g` : ''}{g.drift ? ' · ⚠' : ''}</span>
                            </button>
                          </th>
                          {model.tiers.map((t) => {
                            const best = g.tierBest.get(t.id) ?? 'absent';
                            return <td key={t.id} className={`pm-mini pm-${best}`}>{STATE_GLYPH[best]}</td>;
                          })}
                        </tr>
                        {open && g.visible.map((check) => (
                          <tr key={check} data-testid={`pm-row-${check}`} className="pm-check-row">
                            <td className="pm-check" title={check}>{displayName(check)}</td>
                            {model.tiers.map((t) => {
                              const c = byCell.get(cellKey(check, t.id));
                              const state = c?.state ?? 'absent';
                              const heat = cellHeat(c, overlay, maxima);
                              return (
                                <td key={t.id}
                                  className={`pm-cell pm-${state}${c?.drift ? ' pm-has-drift' : ''}${overlay !== 'none' ? ' pm-overlaid' : ''}`}
                                  data-testid={`pm-cell-${check}-${t.id}`} data-state={state} data-drift={c?.drift ? '1' : '0'}
                                  style={heat ? { background: heat } : undefined} title={c ? cellTitle(c) : undefined}>
                                  <span className="pm-glyph">{STATE_GLYPH[state]}</span>{c?.drift && <span className="pm-drift-badge">⚠</span>}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                        {open && g.hiddenAbsent > 0 && (
                          <tr key={`a-${g.name}`} className="pm-absent-note"><td colSpan={model.tiers.length + 1}>+{g.hiddenAbsent} absent-only checks hidden</td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <p className="pm-legend">
                <b className="pm-gate">● gate</b> blocks merge · <b className="pm-cond">◐ conditional</b> runs-when-touched ·
                <b className="pm-adv"> ○ advisory</b> non-blocking · <span className="pm-absent">· absent</span> ·
                <b className="pm-drift"> ⚠ drift</b> config ≠ observed
              </p>
            </div>
          </div>

          {/* ── Drill-down drawer: evidence + constrained simulator + action ── */}
          {drilled && (() => {
            const dcheck = drilled.check;
            const meta = model.checkMeta?.find((m) => m.check === dcheck);
            const s = sim && sim.check === dcheck ? sim : { check: dcheck, from: legalFromTiers(model, dcheck)[0]?.id ?? model.tiers[0]?.id ?? '', to: '__remove__' };
            const fromOpts = legalFromTiers(model, dcheck);
            const toOpts = legalToTargets(model, dcheck, s.from);
            const res = simulateMove(model, { check: dcheck, fromTierId: s.from, toTierId: s.to === '__remove__' ? null : s.to });
            const setFrom = (from: string) => {
              const next = legalToTargets(model, dcheck, from);
              const keep = next.some((o) => (o.tierId ?? '__remove__') === s.to);
              setSim({ check: dcheck, from, to: keep ? s.to : (next.find((o) => o.tierId !== null)?.tierId ?? '__remove__') });
            };
            const onCopy = () => {
              const text = buildClaudePrompt(repo ?? '', model, { goal: drilled.goal, check: dcheck, detail: drilled.detail, suggestedTierId: s.to === '__remove__' ? null : s.to });
              void navigator.clipboard?.writeText?.(text);
              setCopied(true); window.setTimeout(() => setCopied(false), 1500);
            };
            return (
              <>
              {/* #182: pm-drawer previously had no backdrop (unlike settings-overlay);
                  add one so click-outside dismisses + content behind is dimmed. */}
              <div className="pm-drawer-backdrop" data-testid="pm-drawer-backdrop"
                onClick={() => setDrilled(null)} aria-hidden="true" />
              <aside
                className="pm-drawer"
                data-testid="pm-drawer"
                role="dialog"
                aria-modal="true"
                aria-label={`Action for ${displayName(dcheck)}`}
                ref={drawerRef}
                tabIndex={-1}
              >
                <div className="pm-drawer-head">
                  <span className={`pm-drawer-goal pm-fgroup-${drilled.goal}`}>{GOAL_ICON[drilled.goal]} {GOAL_LABEL[drilled.goal]}</span>
                  <strong className="pm-drawer-check" title={dcheck}>{displayName(dcheck)}</strong>
                  <button type="button" className="pm-drawer-x" aria-label="Close" onClick={() => setDrilled(null)}>✕</button>
                </div>
                <p className="pm-drawer-prov">
                  {meta?.provenance?.length ? `defined in ${meta.provenance.map((p) => `${p.file} › ${p.jobId}`).join(', ')}` : 'workflow source unknown'}
                  {meta?.isRequiredMergeGate && <span className="pm-drawer-gate"> · required merge gate</span>}
                  {meta?.confidence === 'low' && <span className="pm-drawer-low"> · low parse confidence</span>}
                </p>
                <p className="pm-drawer-why">{drilled.detail}</p>

                <table className="pm-evidence" data-testid="pm-evidence" aria-label="Per-tier evidence">
                  <thead><tr><th scope="col">tier</th><th scope="col">state</th><th scope="col">runs</th><th scope="col">fail%</th><th scope="col">min</th></tr></thead>
                  <tbody>
                    {model.tiers.map((t) => {
                      const c = byCell.get(cellKey(dcheck, t.id));
                      const o = c?.observed;
                      const st = c?.state ?? 'absent';
                      return (
                        <tr key={t.id} className={c?.drift ? 'pm-ev-drift' : ''}>
                          <td>{t.label}</td>
                          <td className={`pm-${st}`}>{STATE_GLYPH[st]} {STATE_WORD[st]}{c?.drift ? ' ⚠' : ''}</td>
                          <td>{o ? o.runs.toLocaleString() : '—'}</td>
                          <td>{o && o.runs ? `${o.failRatePct}%` : '—'}</td>
                          <td>{o ? fmtMin(o.minutes) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="pm-drawer-sim" data-testid="pm-sim">
                  <div className="pm-sim-label">What-if</div>
                  <div className="pm-sim-controls">
                    <label>move from
                      <select data-testid="pm-sim-from" value={s.from} onChange={(e) => setFrom(e.target.value)}>
                        {fromOpts.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                    </label>
                    <label>to
                      <select data-testid="pm-sim-to" value={s.to} onChange={(e) => setSim({ check: dcheck, from: s.from, to: e.target.value })} disabled={toOpts.length === 0}>
                        {toOpts.length === 0 && <option value="">— no legal move —</option>}
                        {toOpts.map((o) => <option key={o.tierId ?? '__remove__'} value={o.tierId ?? '__remove__'}>{o.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <p className={`pm-sim-result ${!res.legal ? 'bad' : res.costDeltaMinutes < 0 ? 'good' : res.costDeltaMinutes > 0 ? 'bad' : ''}`}
                    data-testid="pm-sim-result" data-cost-delta={res.costDeltaMinutes} data-legal={res.legal ? '1' : '0'}>{res.note}</p>
                </div>

                <div className="pm-drawer-actions">
                  <button type="button" className="pm-action-primary" data-testid="pm-copy-prompt" onClick={onCopy}>
                    {copied ? '✓ Copied' : 'Copy Claude Code prompt'}
                  </button>
                </div>
              </aside>
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
