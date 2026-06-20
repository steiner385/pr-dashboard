// Generates a ready-to-run Claude Code prompt for a finding's action. Pure — it
// turns the finding + the check's provenance + the simulated cost/coverage delta
// into a precise instruction an engineer can paste into their own CC session.
// Drift is investigate-only (the tool can't know if config or the check is wrong).
import type { DerivedModel, CheckMeta } from './protectionModel';
import { simulateMove } from './protectionSimulate';

export type Goal = 'drift' | 'cost' | 'quality';
export interface PromptFinding { goal: Goal; check: string; detail: string; suggestedTierId?: string | null }

function metaOf(model: DerivedModel, check: string): CheckMeta | undefined {
  return model.checkMeta?.find((m) => m.check === check);
}
function where(meta?: CheckMeta): string {
  if (!meta?.provenance?.length) return 'the workflow that defines it';
  return meta.provenance.map((p) => `.github/workflows/${p.file} (job \`${p.jobId}\`)`).join(' and ');
}
function runsAtTierId(model: DerivedModel, check: string): string | undefined {
  // the tier the check most-frequently runs at (first in tier order where it runs)
  return model.tiers.find((t) => model.cells.find((c) => c.check === check && c.tierId === t.id)?.intent.runs)?.id;
}

export function buildClaudePrompt(repo: string, model: DerivedModel, f: PromptFinding): string {
  const meta = metaOf(model, f.check);
  const loc = where(meta);

  if (f.goal === 'drift') {
    return [
      `In ${repo}, investigate and reconcile CI drift on the check "${f.check}".`,
      ``,
      `Symptom: ${f.detail} (its configured tier/gate disagrees with what actually ran over the last 30 days).`,
      `It is defined in ${loc}.`,
      ``,
      `Determine which side is wrong:`,
      `- If the job is effectively dead (its \`if:\`/event no longer matches), remove it.`,
      `- If a trigger regressed (it SHOULD run but doesn't), repair the \`if:\`/\`on:\` guard.`,
      meta?.isRequiredMergeGate ? `- ⚠ This is a REQUIRED merge-queue gate — confirm against branch protection before changing anything.` : `- Confirm the change doesn't alter the required-check set (the \`ci\` rollup).`,
      ``,
      `Do not blindly delete. Propose the smaller of the two fixes and open a PR for review.`,
    ].join('\n');
  }

  const fromTierId = runsAtTierId(model, f.check) ?? 'pr';
  const sim = simulateMove(model, { check: f.check, fromTierId, toTierId: f.suggestedTierId ?? null });

  if (f.goal === 'cost') {
    return [
      `In ${repo}, demote the CI check "${f.check}" to run less often.`,
      ``,
      `Why: ${f.detail}. Over the last 30 days this is wasted runner time.`,
      `Edit ${loc}:`,
      `- Restrict it so it no longer runs on every \`pull_request\` (e.g. add \`if: github.event_name == 'merge_group'\`, or move the job out of the PR job-set).`,
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
    `- Add it to the PR tier (relax the \`if:\` / add \`pull_request\` to \`on:\`) so it runs on PRs.`,
    `- Note this ADDS PR-time cost — confirm the check's failures are real (not flake) before committing.`,
    `- Projected effect: ${sim.note}.`,
    ``,
    `Open a PR titled "ci: shift ${f.check} left to PR".`,
  ].join('\n');
}
