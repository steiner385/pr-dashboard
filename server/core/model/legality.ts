// The single source of truth for authoring legality + the merge-gate safety
// invariant (spec 001: FR-012, FR-028, FR-033, FR-035a, SC-006, SC-011).
// Pure functions — shared by the simulator and the edit engine so legality is
// computed one way. No I/O.
//
// The crown-jewel invariant (P1): no authoring change may remove or relocate a
// check that is a REQUIRED merge gate, where "required" binds to the UNION of
// the statically-inferred required set and the live branch-protection ruleset
// (FR-035a) — closing the gap where a statically-missed required check could be
// demoted.
import type { DerivedModel } from '../../pipeline-model/derived';
import type { GatingResult } from '../../pipeline-model/types';

export type LegalityReason = 'required-gate' | 'cycle' | 'orphaned-gate' | 'undeclared-event';
export interface LegalityVerdict { legal: boolean; reason?: LegalityReason; detail?: string }

/**
 * The effective required-merge-gate set: union of the model's static inference
 * (`checkMeta.isRequiredMergeGate`) and the live ruleset's required checks when
 * available (FR-035a). When `liveRequired` is undefined the ruleset was
 * unreadable → static-only (caller should flag low-confidence).
 */
export function requiredGateChecks(model: DerivedModel, liveRequired?: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const m of model.checkMeta ?? []) if (m.isRequiredMergeGate) set.add(m.check);
  for (const c of liveRequired ?? []) set.add(c);
  return set;
}

/** Does `check` still run somewhere after a proposed move/removal? (coverage retained anywhere) */
function runsAfter(model: DerivedModel, check: string, fromTierId: string, toTierId: string | null): boolean {
  for (const cell of model.cells) {
    if (cell.check !== check) continue;
    if (cell.tierId === fromTierId) { if (toTierId == null) continue; else return true; } // moved, not removed
    if (cell.intent.runs) return true; // runs at some other tier already
  }
  return toTierId != null; // a move always lands somewhere
}

/**
 * Validate a tier move / removal against the required-gate safety invariant
 * (FR-012 + FR-035a). Refuses anything that would drop a required gate's
 * coverage. `liveRequired` is the live-ruleset required set (optional).
 */
export function validateTierChange(
  model: DerivedModel,
  change: { check: string; fromTierId: string; toTierId: string | null },
  liveRequired?: readonly string[],
): LegalityVerdict {
  const required = requiredGateChecks(model, liveRequired);
  if (required.has(change.check)) {
    // a required gate may not be removed, and may not be relocated off the tier
    // where it gates the merge (the queue/merge_group tier).
    const fromCell = model.cells.find((c) => c.check === change.check && c.tierId === change.fromTierId);
    const fromIsMergeGate = fromCell?.intent.gates === true
      && (model.tiers.find((t) => t.id === change.fromTierId)?.event === 'merge_group');
    if (change.toTierId == null && fromIsMergeGate) {
      return { legal: false, reason: 'required-gate', detail: `${change.check} is a required merge gate — cannot remove it` };
    }
    if (fromIsMergeGate && change.toTierId != null) {
      return { legal: false, reason: 'required-gate', detail: `${change.check} is a required merge gate — cannot move it off the merge queue` };
    }
    if (!runsAfter(model, change.check, change.fromTierId, change.toTierId)) {
      return { legal: false, reason: 'required-gate', detail: `${change.check} is required but would no longer run anywhere` };
    }
  }
  return { legal: true };
}

/** Validate a gate demotion (FR-029): refuse demoting a required merge gate. */
export function validateGateChange(
  model: DerivedModel,
  change: { check: string; tierId: string; gate: boolean },
  liveRequired?: readonly string[],
): LegalityVerdict {
  if (!change.gate && requiredGateChecks(model, liveRequired).has(change.check)) {
    const tierEvent = model.tiers.find((t) => t.id === change.tierId)?.event;
    if (tierEvent === 'merge_group') {
      return { legal: false, reason: 'required-gate', detail: `${change.check} is a required merge gate — cannot demote it` };
    }
  }
  return { legal: true };
}

/**
 * Cycle detection for a `needs:` dependency graph (FR-028). `needs` maps each
 * jobId to the jobs it depends on. Returns the offending cycle (job ids) or null.
 * DFS with a recursion stack; deterministic order.
 */
export function detectCycle(needs: Map<string, readonly string[]>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const jobs = [...needs.keys()].sort();

  function visit(job: string): string[] | null {
    color.set(job, GRAY);
    stack.push(job);
    for (const dep of needs.get(job) ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        // back-edge → cycle: slice the stack from `dep` to here
        const i = stack.indexOf(dep);
        return [...stack.slice(i), dep];
      }
      if (c === WHITE) { const found = visit(dep); if (found) return found; }
    }
    stack.pop();
    color.set(job, BLACK);
    return null;
  }

  for (const job of jobs) {
    if ((color.get(job) ?? WHITE) === WHITE) {
      const found = visit(job);
      if (found) return found;
    }
  }
  return null;
}

/** Validate a `needs:` edit (FR-028): reject if the resulting graph has a cycle. */
export function validateNeedsChange(
  baseNeeds: Map<string, readonly string[]>,
  change: { jobId: string; addNeeds?: string[]; removeNeeds?: string[] },
): LegalityVerdict {
  const next = new Map<string, readonly string[]>();
  for (const [k, v] of baseNeeds) next.set(k, [...v]);
  const cur = new Set(next.get(change.jobId) ?? []);
  for (const r of change.removeNeeds ?? []) cur.delete(r);
  for (const a of change.addNeeds ?? []) cur.add(a);
  next.set(change.jobId, [...cur]);
  const cycle = detectCycle(next);
  if (cycle) return { legal: false, reason: 'cycle', detail: `would create a needs cycle: ${cycle.join(' → ')}` };
  return { legal: true };
}

/**
 * The candidate-gating safety check (spec §3/§5): the candidate's gating-check
 * set must be a SUPERSET of the baseline's. Any gating check present in the
 * baseline but absent in the candidate is a silent-ungating regression and must
 * block structured apply. Pure; Increment 2 runs it over the re-derived candidate.
 */
export function gatingRegressed(baseline: GatingResult, candidate: GatingResult): { regressed: boolean; lost: string[] } {
  const cand = new Set(candidate.gates.map((g) => g.checkName));
  const lost = [...new Set(baseline.gates.map((g) => g.checkName).filter((n) => !cand.has(n)))].sort((a, b) => a.localeCompare(b));
  return { regressed: lost.length > 0, lost };
}
