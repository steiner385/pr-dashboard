// Server-side simulation engine (spec 001, FR-011/FR-012). The architect review
// flagged that the original simulateMove is CLIENT-side; this ports it to the
// server and binds it to the shared legality validator (one source of truth) +
// the union required-gate safety set. Pure — (model, change[, liveRequired]) in,
// projection + verdict out.
import type { DerivedModel } from '../../pipeline-model/derived';
import { validateTierChange, requiredGateChecks, type LegalityVerdict } from './legality';

export type MoveDirection = 'demote' | 'promote' | 'remove' | 'none';
/** Sample-size confidence in the projected deltas (roadmap 4.2). 'low' downgrades
 *  an apply to scaffold-only — the deltas are too thinly-observed to act on blindly. */
export type SimConfidence = 'high' | 'medium' | 'low';
export interface TierMove { check: string; fromTierId: string; toTierId: string | null }
export interface SimResult {
  check: string; fromTierId: string; toTierId: string | null;
  costDeltaMinutes: number;
  /** Best-case PR-latency delta (roadmap 4.2): the check's typical duration moved
   *  on/off the PR (pull_request) tier. Negative = a faster PR; an upper bound,
   *  realised only if the check is on the PR critical path. */
  latencyDeltaSeconds: number;
  /** Risk delta (roadmap 4.2): expected real failures that ESCAPE per 100 runs if
   *  this move drops a gate that catches them (positive = riskier). Zero when the
   *  affected check never catches a real failure — i.e. a safe demotion. */
  riskDeltaPer100: number;
  /** Throughput delta (roadmap 4.2): change in merge-queue trains/hour, via the
   *  queue critical-path (max running-check duration). Non-zero only when the move
   *  removes/relocates the queue BOTTLENECK; a non-bottleneck move is honestly ~0. */
  throughputDeltaPerHour: number;
  /** Sample-size confidence band for the deltas above; 'low' ⇒ scaffold-only. */
  confidence: SimConfidence;
  gatesLost: string[];
  gatesGained: string[];
  estimated: boolean;
  direction: MoveDirection;
  legal: boolean;
  reason?: LegalityVerdict['reason'];
  note: string;
}

type Cell = DerivedModel['cells'][number];
function cellFor(m: DerivedModel, check: string, tierId: string): Cell | undefined {
  return m.cells.find((c) => c.check === check && c.tierId === tierId);
}
/** avg minutes/run for a check, pooled across tiers with observed runs */
export function perRunMinutes(m: DerivedModel, check: string): number {
  let mins = 0, runs = 0;
  for (const c of m.cells) if (c.check === check && c.observed && c.observed.runs > 0) { mins += c.observed.minutes; runs += c.observed.runs; }
  return runs ? mins / runs : 0;
}
function tierRunScale(m: DerivedModel, tierId: string): number {
  let n = 0;
  for (const c of m.cells) if (c.tierId === tierId && c.observed) n = Math.max(n, c.observed.runs);
  return n;
}
/** Pooled real-failures-per-run for a check across observed cells (roadmap 4.2 risk). */
function perRunRealFailRate(m: DerivedModel, check: string): number {
  let fails = 0, runs = 0;
  for (const c of m.cells) if (c.check === check && c.observed && c.observed.runs > 0) { fails += c.observed.realFailures; runs += c.observed.runs; }
  return runs ? fails / runs : 0;
}
/** Queue critical path (minutes): the slowest running check at a tier — the bottleneck
 *  that gates how fast a merge train clears. `exclude` removes one check (the move). */
function tierCriticalPathMinutes(m: DerivedModel, tierId: string, exclude?: string): number {
  let max = 0;
  for (const c of m.cells) {
    if (c.tierId !== tierId || !c.intent.runs || c.check === exclude || !c.observed || c.observed.runs <= 0) continue;
    const perRun = c.observed.minutes / c.observed.runs;
    if (perRun > max) max = perRun;
  }
  return max;
}
function directionOf(m: DerivedModel, fromId: string, toId: string | null): MoveDirection {
  if (toId == null) return 'remove';
  const fi = m.tiers.findIndex((t) => t.id === fromId), ti = m.tiers.findIndex((t) => t.id === toId);
  if (fi < 0 || ti < 0 || fi === ti) return 'none';
  return ti > fi ? 'demote' : 'promote';
}

/** Simulate a tier move: legality (via the shared validator) + cost/coverage delta. */
export function simulateTierMove(model: DerivedModel, move: TierMove, liveRequired?: readonly string[]): SimResult {
  const verdict = validateTierChange(model, move, liveRequired);
  const from = cellFor(model, move.check, move.fromTierId);
  const direction = directionOf(model, move.fromTierId, move.toTierId);

  const costRemoved = from?.observed?.minutes ?? 0;
  const gatesLost: string[] = [];
  const gatesGained: string[] = [];
  if (from?.intent.gates) gatesLost.push(move.fromTierId);
  let costAdded = 0, estimated = false;
  if (move.toTierId) {
    const to = cellFor(model, move.check, move.toTierId);
    if (to?.observed) costAdded = to.observed.minutes;
    else { costAdded = Math.round(perRunMinutes(model, move.check) * tierRunScale(model, move.toTierId)); estimated = true; }
    if (!to?.intent.gates) gatesGained.push(move.toTierId);
  }
  const costDeltaMinutes = costAdded - costRemoved;

  // Latency (critical-path, roadmap 4.2): the check's typical duration moved on/off
  // the PR tier — an upper bound on how much faster/slower a PR gets.
  const prTierId = model.tiers.find((t) => t.event === 'pull_request')?.id;
  const durSec = Math.round(perRunMinutes(model, move.check) * 60);
  let latencyDeltaSeconds = 0;
  if (prTierId && move.fromTierId === prTierId) latencyDeltaSeconds -= durSec;
  if (prTierId && move.toTierId === prTierId) latencyDeltaSeconds += durSec;

  // Risk (roadmap 4.2): dropping a gate that catches real failures lets them escape;
  // adding a gate catches more. Magnitude = the check's pooled real-fail rate per 100 runs.
  const realRatePer100 = perRunRealFailRate(model, move.check) * 100;
  const riskDeltaPer100 = realRatePer100 * (gatesLost.length ? 1 : 0) - realRatePer100 * (gatesGained.length ? 1 : 0);

  // Throughput (roadmap 4.2): if the move pulls the queue BOTTLENECK off the queue
  // tier, the merge train clears faster (trains/hour rises). A non-bottleneck move
  // leaves the critical path unchanged → honest ~0.
  const queueTierId = model.tiers.find((t) => t.event === 'merge_group')?.id;
  let throughputDeltaPerHour = 0;
  if (queueTierId && move.fromTierId === queueTierId && move.toTierId !== queueTierId) {
    const oldCP = tierCriticalPathMinutes(model, queueTierId);
    const newCP = tierCriticalPathMinutes(model, queueTierId, move.check);
    if (oldCP > 0 && newCP > 0 && newCP < oldCP) throughputDeltaPerHour = 60 / newCP - 60 / oldCP;
  }

  // Confidence band: driven by the thinnest observed sample on the affected cells;
  // an estimated add-side is a guess, so it caps confidence at 'low'.
  const sampleRuns = [from?.observed?.runs, move.toTierId ? cellFor(model, move.check, move.toTierId)?.observed?.runs : undefined]
    .filter((n): n is number => typeof n === 'number' && n > 0);
  const minRuns = sampleRuns.length ? Math.min(...sampleRuns) : 0;
  const confidence: SimConfidence = estimated || minRuns < 10 ? 'low' : minRuns < 50 ? 'medium' : 'high';

  const cost = costDeltaMinutes < 0 ? `saves ${(-costDeltaMinutes).toLocaleString()} min`
    : costDeltaMinutes > 0 ? `adds ${costDeltaMinutes.toLocaleString()} min` : 'no cost change';
  const cov = gatesLost.length ? ` · loses gate at ${gatesLost.join(', ')}`
    : gatesGained.length ? ` · adds gate at ${gatesGained.join(', ')}` : '';
  const lat = latencyDeltaSeconds < 0 ? ` · up to ~${Math.round(-latencyDeltaSeconds / 60)}m faster PR`
    : latencyDeltaSeconds > 0 ? ` · up to ~${Math.round(latencyDeltaSeconds / 60)}m slower PR` : '';
  const risk = riskDeltaPer100 > 0 ? ` · +${riskDeltaPer100.toFixed(0)} risk (real fails/100 escape)`
    : riskDeltaPer100 < 0 ? ` · −${(-riskDeltaPer100).toFixed(0)} risk (real fails/100 caught)` : '';
  const thru = throughputDeltaPerHour >= 1 ? ` · +${throughputDeltaPerHour.toFixed(1)} trains/hr` : '';
  const conf = confidence !== 'high' ? ` · ${confidence} confidence` : '';
  const note = verdict.legal ? `${cost}${estimated ? ' (est.)' : ''}${lat}${thru}${risk}${cov}${conf}` : `not possible — ${verdict.detail ?? verdict.reason}`;

  return { check: move.check, fromTierId: move.fromTierId, toTierId: move.toTierId, costDeltaMinutes, latencyDeltaSeconds, riskDeltaPer100, throughputDeltaPerHour, confidence, gatesLost, gatesGained, estimated, direction, legal: verdict.legal, reason: verdict.reason, note };
}

export interface PlanResult {
  results: SimResult[];
  combinedCostDeltaMinutes: number;
  legal: boolean;
  reason?: string;
}

/**
 * Multi-change planning (spec 001, N2/FR-042). Composite legality is NOT the AND
 * of per-move verdicts: two moves that each leave coverage can JOINTLY strand a
 * required check. We validate each move, then re-check the COMBINED post-plan
 * coverage of every required gate against the merged effect.
 */
export function simulatePlan(model: DerivedModel, moves: readonly TierMove[], liveRequired?: readonly string[]): PlanResult {
  const results = moves.map((m) => simulateTierMove(model, m, liveRequired));
  const combinedCostDeltaMinutes = results.reduce((s, r) => s + r.costDeltaMinutes, 0);

  const firstIllegal = results.find((r) => !r.legal);
  if (firstIllegal) return { results, combinedCostDeltaMinutes, legal: false, reason: `${firstIllegal.check}: ${firstIllegal.reason ?? 'illegal'}` };

  // build the post-plan "runs" set: start from the model, apply every move
  const runs = new Set<string>();
  for (const c of model.cells) if (c.intent.runs) runs.add(`${c.check}@${c.tierId}`);
  for (const m of moves) {
    runs.delete(`${m.check}@${m.fromTierId}`);
    if (m.toTierId) runs.add(`${m.check}@${m.toTierId}`);
  }
  // every required gate must still run somewhere after the WHOLE plan
  const required = requiredGateChecks(model, liveRequired);
  for (const check of required) {
    const stillRuns = [...runs].some((k) => k.startsWith(`${check}@`));
    if (!stillRuns) return { results, combinedCostDeltaMinutes, legal: false, reason: `the combined plan strands required gate "${check}" (runs nowhere after all moves)` };
  }
  return { results, combinedCostDeltaMinutes, legal: true };
}
