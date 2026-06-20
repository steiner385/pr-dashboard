// Simulation engine for the CI/CD Designer (spec Increment 2): given the derived
// protection model and a proposed "move check X from tier A to tier B" change,
// project the cost (runtime) and coverage (gate) delta, AND decide whether the
// move is even legal. Pure + client-side so what-ifs are instant.
//
// Legality (both personas' hard rules) is enforced HERE so the simulator, the
// constrained dropdowns, and any prompt/PR generator share one source of truth:
//   • you can only move a check OUT of a tier it actually runs at;
//   • you can only move it INTO a tier whose GHA event its workflow declares;
//   • you can NEVER move/remove a required merge-queue gate (breaks branch
//     protection) — the non-negotiable safety invariant.
import type { DerivedModel, CheckMeta } from './protectionModel';

type Cell = DerivedModel['cells'][number];
interface TierDef { id: string; label: string; event: string }

export type MoveDirection = 'demote' | 'promote' | 'remove' | 'none';
export interface MoveRequest { check: string; fromTierId: string; toTierId: string | null }
export interface SimResult {
  check: string; fromTierId: string; toTierId: string | null;
  costDeltaMinutes: number;
  gatesLost: string[];
  gatesGained: string[];
  estimated: boolean;
  direction: MoveDirection;
  legal: boolean;
  reason?: string;     // why illegal (shown to the user); undefined when legal
  note: string;
}

function cellFor(model: DerivedModel, check: string, tierId: string): Cell | undefined {
  return model.cells.find((c) => c.check === check && c.tierId === tierId);
}
function metaOf(model: DerivedModel, check: string): CheckMeta | undefined {
  return model.checkMeta?.find((m) => m.check === check);
}
function eventOf(model: DerivedModel, tierId: string): string | undefined {
  return model.tiers.find((t) => t.id === tierId)?.event;
}

export function perRunMinutes(model: DerivedModel, check: string): number {
  let mins = 0, runs = 0;
  for (const c of model.cells) if (c.check === check && c.observed && c.observed.runs > 0) { mins += c.observed.minutes; runs += c.observed.runs; }
  return runs ? mins / runs : 0;
}
export function tierRunScale(model: DerivedModel, tierId: string): number {
  let m = 0;
  for (const c of model.cells) if (c.tierId === tierId && c.observed) m = Math.max(m, c.observed.runs);
  return m;
}

/** Tiers a check actually runs at — the only legal `from` options. */
export function legalFromTiers(model: DerivedModel, check: string): TierDef[] {
  return model.tiers.filter((t) => cellFor(model, check, t.id)?.intent.runs);
}

/** Legal `to` targets for a move out of `fromTierId` (incl. a `null` = remove
 *  entry). Empty when the check is a required queue gate sitting on the queue —
 *  it cannot be moved or removed without breaking branch protection. */
export function legalToTargets(model: DerivedModel, check: string, fromTierId: string): { tierId: string | null; label: string }[] {
  const meta = metaOf(model, check);
  const fromEvent = eventOf(model, fromTierId);
  if (meta?.isRequiredMergeGate && fromEvent === 'merge_group') return [];
  const out: { tierId: string | null; label: string }[] = [];
  for (const t of model.tiers) {
    if (t.id === fromTierId) continue;
    if (meta && !meta.triggers.includes(t.event)) continue; // only events the workflow declares
    out.push({ tierId: t.id, label: t.label });
  }
  out.push({ tierId: null, label: '— remove —' });
  return out;
}

function directionOf(model: DerivedModel, fromTierId: string, toTierId: string | null): MoveDirection {
  if (toTierId == null) return 'remove';
  const fi = model.tiers.findIndex((t) => t.id === fromTierId);
  const ti = model.tiers.findIndex((t) => t.id === toTierId);
  if (fi < 0 || ti < 0 || fi === ti) return 'none';
  return ti > fi ? 'demote' : 'promote'; // later/less-frequent tier = demote; earlier = shift-left
}

export function simulateMove(model: DerivedModel, req: MoveRequest): SimResult {
  const meta = metaOf(model, req.check);
  const from = cellFor(model, req.check, req.fromTierId);
  const fromEvent = eventOf(model, req.fromTierId);
  const direction = directionOf(model, req.fromTierId, req.toTierId);

  // ── legality ──────────────────────────────────────────────────────────────
  let legal = true; let reason: string | undefined;
  if (!from || !from.intent.runs) {
    legal = false; reason = `does not run at ${req.fromTierId}`;
  } else if (meta?.isRequiredMergeGate && fromEvent === 'merge_group') {
    legal = false; reason = 'required merge-queue gate — moving it would break branch protection';
  } else if (req.toTierId != null) {
    const toEvent = eventOf(model, req.toTierId);
    if (toEvent && meta && !meta.triggers.includes(toEvent)) {
      legal = false; reason = `the workflow has no ${toEvent} trigger`;
    }
  }

  // ── projection (computed regardless, for display) ───────────────────────────
  const costRemoved = from?.observed?.minutes ?? 0;
  const gatesLost: string[] = [];
  const gatesGained: string[] = [];
  if (from?.intent.gates) gatesLost.push(req.fromTierId);
  let costAdded = 0;
  let estimated = false;
  if (req.toTierId) {
    const to = cellFor(model, req.check, req.toTierId);
    if (to?.observed) costAdded = to.observed.minutes;
    else { costAdded = Math.round(perRunMinutes(model, req.check) * tierRunScale(model, req.toTierId)); estimated = true; }
    if (!to?.intent.gates) gatesGained.push(req.toTierId);
  }
  const costDeltaMinutes = costAdded - costRemoved;

  const cost = costDeltaMinutes < 0 ? `saves ${(-costDeltaMinutes).toLocaleString()} min`
    : costDeltaMinutes > 0 ? `adds ${costDeltaMinutes.toLocaleString()} min` : 'no cost change';
  const cov = gatesLost.length ? ` · loses gate at ${gatesLost.join(', ')}`
    : gatesGained.length ? ` · adds gate at ${gatesGained.join(', ')}` : '';
  const note = legal ? `${cost}${estimated ? ' (est.)' : ''}${cov}` : `not possible — ${reason}`;

  return { check: req.check, fromTierId: req.fromTierId, toTierId: req.toTierId, costDeltaMinutes, gatesLost, gatesGained, estimated, direction, legal, reason, note };
}
