// Pure model logic for the Protection Map (#183 decomposition): the DerivedModel
// mirror types, the findings/goal vocabulary, and the stateless cell/format
// helpers. Extracted verbatim from ProtectionMap.tsx so the component file holds
// only React (state, effects, render) and so these pure functions are unit-testable
// in isolation. protectionSimulate.ts / protectionPrompt.ts consume the types from
// here — this module is the single source of truth for the protection-map shape.

// ---- DerivedModel mirror (server/pipeline-model/derived) --------------------

export interface TierDef { id: string; label: string; event: string }
export interface ObservedCell {
  ran: boolean; runs: number; realFailures: number;
  failRatePct: number; flakeRatePct: number; minutes: number;
}
export type CellState = 'gate' | 'advisory' | 'conditional' | 'absent';
export interface Cell {
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
export const STATE_RANK: Record<CellState, number> = { gate: 3, conditional: 2, advisory: 1, absent: 0 };
export const ABSENT_META = { role: 'absent' as CellState, drift: false, minutes: 0, gateTiers: [] as string[] };
export const STATE_GLYPH: Record<CellState, string> = { gate: '●', conditional: '◐', advisory: '○', absent: '·' };
export const STATE_WORD: Record<CellState, string> = { gate: 'gate', conditional: 'conditional', advisory: 'advisory', absent: 'absent' };

// ---- Findings (re-homed recommendations, anchored to checks) -----------------

export type Goal = 'drift' | 'cost' | 'quality';
export const GOALS: Goal[] = ['drift', 'cost', 'quality']; // urgency order: wrong-now → risk → waste
export const GOAL_ICON: Record<Goal, string> = { cost: '💰', quality: '🛡', drift: '⚠' };
export const GOAL_LABEL: Record<Goal, string> = { cost: 'Cost', quality: 'Quality', drift: 'Drift' };

export interface Finding { goal: Goal; check: string; detail: string; weight: number }

export interface MetricsSlice {
  demotionCandidates?: { repo: string; candidates: { name: string; currentTier: string; suggestedTier: string; minutesInWindow: number }[] }[];
  promotionCandidates?: { repo: string; candidates: { name: string; suggestedTier: string; realFailures: number }[] }[];
}

export function buildFindings(repo: string, model: DerivedModel | null, metrics: MetricsSlice | null): Finding[] {
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

export function cellKey(check: string, tierId: string): string { return `${check} ${tierId}`; }
export function groupOf(check: string): string { const i = check.indexOf(' / '); return i === -1 ? 'other' : check.slice(0, i); }
export function leafOf(check: string): string { const i = check.indexOf(' / '); return i === -1 ? check : check.slice(i + 3); }
/** Drop the raw `(${{ matrix.x }}/N)` GitHub-expression template from a check name
 *  (the `(i/N)` shard suffix already carries the readable index). Keeps the rest of
 *  the name — including the `group / ` prefix — so it's the right cleanup for the
 *  full-name matrix; use {@link displayName} where the compact leaf is wanted. */
export function stripCheckTemplate(check: string): string {
  // any parenthesised group that CONTAINS a `${{ … }}` expression — covers both
  // "(${{ matrix.shard }}/8)" and "(API ${{ inputs.api-level }})" where prose
  // precedes the expression inside the parens.
  return check.replace(/\([^()]*\$\{\{[^}]*\}\}[^()]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
}
/** Compact display label for a check: the leaf (no workflow-group prefix) with the
 *  raw matrix template stripped. */
export function displayName(check: string): string {
  return stripCheckTemplate(leafOf(check));
}
export function fmtMin(m: number): string { return m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)}h` : `${m}m`; }

export type Overlay = 'none' | 'cost' | 'quality';
export const OVERLAYS: { id: Overlay; label: string }[] = [
  { id: 'none', label: 'States' }, { id: 'cost', label: 'Cost' }, { id: 'quality', label: 'Quality' },
];
export function cellHeat(c: Cell | undefined, overlay: Overlay, max: { minutes: number; fail: number }): string | undefined {
  if (overlay === 'none' || !c?.observed) return undefined;
  if (overlay === 'cost') {
    const pct = max.minutes ? Math.round((c.observed.minutes / max.minutes) * 80) : 0;
    return `color-mix(in srgb, var(--amber) ${pct}%, transparent)`;
  }
  const pct = max.fail ? Math.round((c.observed.failRatePct / max.fail) * 80) : 0;
  return `color-mix(in srgb, var(--fail) ${pct}%, transparent)`;
}
export function cellTitle(c: Cell): string {
  const parts = [`${c.check} — ${c.tierId}: ${STATE_WORD[c.state]}`];
  if (c.observed) {
    parts.push(`${c.observed.runs} runs · ${c.observed.minutes.toLocaleString()} min`);
    if (c.observed.realFailures > 0) parts.push(`${c.observed.realFailures} real fails (${c.observed.failRatePct}%)`);
    if (c.observed.flakeRatePct > 0) parts.push(`flake ${c.observed.flakeRatePct}%`);
  }
  if (c.drift) parts.push('⚠ drift: configured/observed disagree');
  return parts.join(' · ');
}
