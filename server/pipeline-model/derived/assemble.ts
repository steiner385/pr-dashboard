// server/pipeline-model/derived/assemble.ts
//
// Limits (v1): the matrix is driven by STATIC check names — an observed
// (name, event) that matches no CheckNode produces no cell, so a check that
// CI runs but the parser never modeled is invisible here (not flagged as
// drift). Reconciling observed-only checks into 'observed-only' cells is a
// follow-up.
import type { StaticGraph, GatingResult, CheckNode } from '../types';
import { KINDASH_TIERS, type TierDef } from './tiers';
import { observedKey, type ObservedCell } from './observed';
import { cellState, type Cell, type CellIntent } from './cell';
import { deriveDrift, type DriftConfig, DRIFT_DEFAULTS } from './drift';

/** Per-check actionability metadata — what the surface needs to drill in, judge
 *  legality of a move, and generate a correct workflow edit / Claude Code prompt.
 *  (The cell grid carries only booleans; this carries the provenance + triggers
 *  the server already knows but used to drop.) */
export interface CheckMeta {
  check: string;
  /** Distinct GHA event kinds the check's workflow declares (pull_request, merge_group, …). */
  triggers: string[];
  /** Where the check is defined — the file+job an action must edit. */
  provenance: { file: string; jobId: string }[];
  confidence: 'high' | 'low';
  /** True when the check is an unconditional required gate on the merge queue —
   *  moving/removing it would break branch protection (hard safety invariant). */
  isRequiredMergeGate: boolean;
  /** The checks this one depends on (DAG edges, via the caller `needs:` graph).
   *  Optional only so pre-needs fixtures stay valid; the assembler always sets it. */
  needs?: string[];
}

export interface DerivedModel {
  tiers: TierDef[];
  checks: string[];
  cells: Cell[];
  checkMeta: CheckMeta[];
}

export function assembleDerivedModel(
  graph: StaticGraph, gating: GatingResult, observed: Map<string, ObservedCell>,
  tiers: TierDef[] = KINDASH_TIERS,
  cfg: DriftConfig = DRIFT_DEFAULTS,
): DerivedModel {
  // Index static checks by checkName (a name may have multiple CheckNodes only
  // via distinct provenance; they share triggers/confidence per our model).
  const byCheck = new Map<string, CheckNode[]>();
  for (const c of graph.checks) {
    const arr = byCheck.get(c.checkName) ?? [];
    arr.push(c);
    byCheck.set(c.checkName, arr);
  }
  // gating lookup: checkName → set of events it gates at (union across all
  // gating entries for the same checkName, so duplicate names don't drop
  // earlier events).
  const gatesAt = new Map<string, Set<string>>();
  for (const g of gating.gates) {
    const existing = gatesAt.get(g.checkName);
    if (existing) {
      for (const e of g.events) existing.add(e);
    } else {
      gatesAt.set(g.checkName, new Set(g.events));
    }
  }
  const conditionalCallers = new Set(gating.conditionalCallerJobs);
  const gatingCallers = new Set(gating.gatingCallerJobs);

  const checks = [...byCheck.keys()].sort();

  // jobId → the check names it owns (for mapping the caller `needs:` graph to checks)
  const checksByJob = new Map<string, Set<string>>();
  for (const c of graph.checks) {
    const s = checksByJob.get(c.callerJobId) ?? new Set<string>();
    s.add(c.checkName); checksByJob.set(c.callerJobId, s);
  }

  // per-check actionability metadata (triggers / provenance / confidence / gate-safety / needs)
  const checkMeta: CheckMeta[] = checks.map((check) => {
    const nodes = byCheck.get(check)!;
    const triggers = [...new Set(nodes.flatMap((n) => n.triggers.events.map((e) => e.kind)))];
    const provMap = new Map<string, { file: string; jobId: string }>();
    for (const n of nodes) for (const p of n.provenance) provMap.set(`${p.file}#${p.jobId}`, { file: p.file, jobId: p.jobId });
    const confidence = nodes.some((n) => n.confidence === 'low') ? 'low' : 'high';
    const gatesMergeGroup = gatesAt.get(check)?.has('merge_group') ?? false;
    const unconditional = nodes.some((n) => gatingCallers.has(n.callerJobId) && !conditionalCallers.has(n.callerJobId));
    // DAG edges (roadmap 5.1): the checks this check depends on, via the caller `needs:` graph.
    const callerJobs = [...new Set(nodes.map((n) => n.callerJobId))];
    const neededJobs = new Set(callerJobs.flatMap((j) => graph.callerNeeds[j] ?? []));
    const needs = [...new Set([...neededJobs].flatMap((j) => [...(checksByJob.get(j) ?? [])]))].filter((n) => n !== check).sort();
    return { check, triggers, provenance: [...provMap.values()], confidence, isRequiredMergeGate: gatesMergeGroup && unconditional, needs };
  });

  // For checkRunsElsewhere: a check is "active" if it has an observed cell
  // with runs >= cfg.minRuns at ANY tier, so a single stray run does not
  // over-flag configured-but-unobserved drift (direction-1).
  const activeChecks = new Set<string>();
  for (const check of checks) {
    if (tiers.some((t) => (observed.get(observedKey(check, t.event))?.runs ?? 0) >= cfg.minRuns)) {
      activeChecks.add(check);
    }
  }

  const cells: Cell[] = [];
  for (const check of checks) {
    const nodes = byCheck.get(check)!;
    const runsElsewhere = activeChecks.has(check);
    for (const tier of tiers) {
      const node = nodes.find((n) => n.triggers.events.some((e) => e.kind === tier.event));
      const runs = node != null;
      const gates = (gatesAt.get(check)?.has(tier.event)) ?? false;
      const conditional = runs && (node!.confidence === 'low' || conditionalCallers.has(node!.callerJobId));
      const intent: CellIntent = { runs, gates: runs && gates, conditional };
      const obs = observed.get(observedKey(check, tier.event)) ?? null;
      cells.push({
        check, tierId: tier.id, intent, observed: obs,
        drift: deriveDrift(intent, obs, runsElsewhere, cfg),
        state: cellState(intent),
      });
    }
  }
  return { tiers, checks, cells, checkMeta };
}
