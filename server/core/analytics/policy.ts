// Declarative pipeline policy (spec 001, Group I2 / FR-036). The operator authors
// rules; the model is evaluated against them → policy-drift findings. Pure. Rules
// are limited to what's cleanly evaluable from the DerivedModel (no speculative
// metrics the model doesn't carry — see the review's "no false confidence").
import type { DerivedModel } from '../../pipeline-model/derived';
import { requiredGateChecks } from '../model/legality';

export type PolicyRule =
  | { id: string; kind: 'max-tiers-per-check'; max: number }
  | { id: string; kind: 'no-flaky-required-gate'; maxFlakePct: number }
  | { id: string; kind: 'required-gate-runs-on-pr' }; // shift-left: required gates should also run at PR

export interface PolicyViolation { ruleId: string; kind: PolicyRule['kind']; check: string; detail: string }

const PR_EVENTS = new Set(['pull_request']);

function gatingTiers(model: DerivedModel, check: string): string[] {
  return model.cells.filter((c) => c.check === check && c.intent.gates).map((c) => c.tierId);
}
function runsOnPr(model: DerivedModel, check: string): boolean {
  return model.cells.some((c) => {
    if (c.check !== check || !c.intent.runs) return false;
    const tier = model.tiers.find((t) => t.id === c.tierId);
    return tier ? PR_EVENTS.has(tier.event) : false;
  });
}
function worstFlake(model: DerivedModel, check: string): number {
  return Math.max(0, ...model.cells.filter((c) => c.check === check && c.observed).map((c) => c.observed!.flakeRatePct));
}

export function evaluatePolicies(model: DerivedModel, rules: readonly PolicyRule[], liveRequired?: readonly string[]): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  const required = requiredGateChecks(model, liveRequired);
  for (const rule of rules) {
    if (rule.kind === 'max-tiers-per-check') {
      for (const check of model.checks) {
        const g = gatingTiers(model, check);
        if (g.length > rule.max) out.push({ ruleId: rule.id, kind: rule.kind, check, detail: `gates at ${g.length} tiers (${g.join(', ')}) — policy max ${rule.max}` });
      }
    } else if (rule.kind === 'no-flaky-required-gate') {
      for (const check of required) {
        const f = worstFlake(model, check);
        if (f > rule.maxFlakePct) out.push({ ruleId: rule.id, kind: rule.kind, check, detail: `required gate is ${f.toFixed(1)}% flaky — policy max ${rule.maxFlakePct}%` });
      }
    } else if (rule.kind === 'required-gate-runs-on-pr') {
      for (const check of required) {
        if (!runsOnPr(model, check)) out.push({ ruleId: rule.id, kind: rule.kind, check, detail: `required gate doesn't run at PR time — failures caught late in the queue` });
      }
    }
  }
  return out;
}
