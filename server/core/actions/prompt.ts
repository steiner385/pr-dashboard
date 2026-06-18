// Server-side Claude Code prompt generator (spec 001, FR-013/FR-016). Ports the
// client-only buildClaudePrompt to the server, sourcing provenance (file+job)
// from the DerivedModel's checkMeta + the simulated delta. Drift is
// investigate-only (no canned PR). Pure.
import type { DerivedModel } from '../../pipeline-model/derived';
import { simulateTierMove } from '../model/simulate';

export type Goal = 'drift' | 'cost' | 'quality';
export interface PromptInput { goal: Goal; check: string; detail: string; fromTierId?: string; toTierId?: string | null }

function provenance(model: DerivedModel, check: string): string {
  const m = model.checkMeta?.find((x) => x.check === check);
  if (!m?.provenance?.length) return 'the workflow that defines it';
  return m.provenance.map((p) => `.github/workflows/${p.file} (job \`${p.jobId}\`)`).join(' and ');
}
function isRequiredGate(model: DerivedModel, check: string): boolean {
  return model.checkMeta?.find((x) => x.check === check)?.isRequiredMergeGate ?? false;
}
function firstRunTier(model: DerivedModel, check: string): string | undefined {
  return model.tiers.find((t) => model.cells.find((c) => c.check === check && c.tierId === t.id)?.intent.runs)?.id;
}

export function buildPrompt(repo: string, model: DerivedModel, f: PromptInput): string {
  const loc = provenance(model, f.check);

  if (f.goal === 'drift') {
    return [
      `In ${repo}, investigate and reconcile CI drift on the check "${f.check}".`,
      ``,
      `Symptom: ${f.detail} (its configured tier/gate disagrees with the last 30 days of runs).`,
      `It is defined in ${loc}.`,
      ``,
      `Determine which side is wrong:`,
      `- If the job is effectively dead (its \`if:\`/event no longer matches), remove it.`,
      `- If a trigger regressed (it SHOULD run but doesn't), repair the \`if:\`/\`on:\` guard.`,
      isRequiredGate(model, f.check)
        ? `- ⚠ This is a REQUIRED merge gate — confirm against branch protection before changing anything.`
        : `- Confirm the change doesn't alter the required-check set (the \`ci\` rollup).`,
      ``,
      `Do not blindly delete. Propose the smaller fix and open a PR for review.`,
    ].join('\n');
  }

  const from = f.fromTierId ?? firstRunTier(model, f.check) ?? 'pr';
  const sim = simulateTierMove(model, { check: f.check, fromTierId: from, toTierId: f.toTierId ?? null });

  if (f.goal === 'cost') {
    return [
      `In ${repo}, demote the CI check "${f.check}" to run less often.`,
      ``,
      `Why: ${f.detail}. Over the last 30 days this is wasted runner time.`,
      `Edit ${loc}:`,
      `- Restrict it so it no longer runs on every \`pull_request\` (e.g. add \`if: github.event_name == 'merge_group'\`).`,
      `- Do NOT remove any merge-queue gate; the \`ci\` rollup must still pass on PRs.`,
      `- Projected effect: ${sim.note}.`,
      ``,
      `Open a PR titled "ci: demote ${f.check} (reduce redundant runs)".`,
    ].join('\n');
  }

  // quality / shift-left
  return [
    `In ${repo}, shift the CI check "${f.check}" left so failures are caught earlier.`,
    ``,
    `Why: ${f.detail}. Catching these at PR time avoids late merge-queue failures.`,
    `Edit ${loc}:`,
    `- Add it to the PR tier (relax the \`if:\` / add \`pull_request\` to \`on:\`).`,
    `- Note this ADDS PR-time cost — confirm the failures are real (not flake) first.`,
    `- Projected effect: ${sim.note}.`,
    ``,
    `Open a PR titled "ci: shift ${f.check} left to PR".`,
  ].join('\n');
}
