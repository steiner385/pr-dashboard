// Branch-protection ruleset reconciliation (spec 001, Group I1 / FR-035, SC-014).
// Compares the STATICALLY-derived required-gate set against the repo's LIVE
// branch-protection ruleset and reports mismatches. Pure — the live read (which
// needs the `administration:read` App scope) is injected; when it's unreadable we
// report `readable:false` and surface "grant administration:read", NEVER a false
// "no mismatch" (SC-014: 0 silent mismatches).
import type { DerivedModel } from '../../pipeline-model/derived';

export interface RulesetReconciliation {
  readable: boolean;
  derivedRequired: string[];
  liveRequired: string[];
  /** required by the live ruleset but NOT inferred from config — the dangerous gap
   *  (the model would let you demote a check the ruleset actually requires). */
  missingFromModel: string[];
  /** inferred as a gate but NOT in the live ruleset — config gates more than the
   *  ruleset enforces (usually benign, worth surfacing). */
  extraInModel: string[];
  inSync: boolean;
}

/** The statically-inferred required-merge-gate set (checkMeta). */
export function derivedRequiredGates(model: DerivedModel): string[] {
  return (model.checkMeta ?? []).filter((m) => m.isRequiredMergeGate).map((m) => m.check).sort();
}

/**
 * Reconcile. `live` is the live-ruleset required check names, or null when the
 * ruleset is unreadable (scope missing / API error) — which yields readable:false,
 * not a clean verdict.
 */
export function reconcileRuleset(model: DerivedModel, live: readonly string[] | null): RulesetReconciliation {
  const derived = derivedRequiredGates(model);
  if (live == null) {
    return { readable: false, derivedRequired: derived, liveRequired: [], missingFromModel: [], extraInModel: [], inSync: false };
  }
  const liveSet = new Set(live);
  const derivedSet = new Set(derived);
  const missingFromModel = [...liveSet].filter((c) => !derivedSet.has(c)).sort();
  const extraInModel = derived.filter((c) => !liveSet.has(c));
  return {
    readable: true,
    derivedRequired: derived,
    liveRequired: [...liveSet].sort(),
    missingFromModel,
    extraInModel,
    inSync: missingFromModel.length === 0 && extraInModel.length === 0,
  };
}
