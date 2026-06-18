/**
 * Promotion candidate → one-click DRAFT PR (#150.2, scaffold approach).
 *
 * The complement of demotion-action.ts. The dashboard surfaces checks that fail
 * for real at a LATE tier with no earlier coverage (estimator/promotion-
 * candidates.ts); this opens a DRAFT pull request scaffolding the SHIFT-LEFT —
 * a proposal doc carrying the failure evidence, the resolved workflow file/job,
 * and a SUGGESTED trigger change to also run the check at the earlier tier.
 *
 * Like demotion it deliberately does NOT auto-edit the workflow (a trigger change
 * is a CI edit a human should land), and it shares the GraphQL orchestration via
 * scaffold-pr.ts so the two levers can't drift.
 */
import type { GraphqlClient } from './pr-actions';
import type { PromotionCandidate } from './estimator/promotion-candidates';
import { openScaffoldDraftPr, type ScaffoldProposal, type DraftPrResult } from './scaffold-pr';

export type { DraftPrResult };

/** Where a candidate's gating most likely lives — same heuristic as demotion:
 *  KinDash names checks `<callerJob> / <job name>` and reusable workflows
 *  `_<callerJob>.yml`. The proposal points at it; the human confirms. */
export interface PromotionTarget { callerJob: string | null; workflowFile: string }
export function resolvePromotionTarget(candidate: PromotionCandidate): PromotionTarget {
  const slash = candidate.name.indexOf(' / ');
  if (slash === -1) return { callerJob: null, workflowFile: 'ci.yml' };
  const caller = candidate.name.slice(0, slash).trim();
  return { callerJob: caller, workflowFile: `_${caller}.yml` };
}

/** The suggested trigger change for a promotion, as a reviewable snippet. */
function suggestedChange(candidate: PromotionCandidate): { summary: string; snippet: string } {
  if (candidate.event === 'merge_group') {
    return {
      summary: 'Also run this job on PR pushes so its failures are caught before the queue.',
      snippet:
        '# Add pull_request to the job/workflow trigger (and to the rollup it gates),\n' +
        '# OR broaden an existing affected-slice to include this check on PRs:\n' +
        'on:\n  pull_request:\n  merge_group:',
    };
  }
  // push:main → merge queue
  return {
    summary: 'Add this job to the merge-queue build so it gates pre-merge, not just post-merge.',
    snippet:
      '# Add merge_group to the workflow trigger and include the job in the\n' +
      '# merge-queue rollup so it becomes a pre-merge gate:\n' +
      'on:\n  merge_group:\n  push:\n    branches: [main]',
  };
}

/** kebab slug for branch + filename, stable and filesystem-safe. */
export function promotionSlug(candidate: PromotionCandidate): string {
  return `${candidate.name}-${candidate.event}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function buildPromotionProposal(candidate: PromotionCandidate): ScaffoldProposal {
  const slug = promotionSlug(candidate);
  const target = resolvePromotionTarget(candidate);
  const change = suggestedChange(candidate);
  const title = `chore(ci): promote ${candidate.name} → ${candidate.suggestedTier} (shift-left)`;
  const evidence =
    `- **Check:** \`${candidate.name}\`\n` +
    `- **Trigger:** ${candidate.event} (${candidate.currentTier})\n` +
    `- **Real failures:** ${candidate.realFailures} (non-flaky) in ${candidate.runsInWindow} runs (${candidate.failRatePct}%)\n` +
    `- **Cost:** ~${candidate.minutesInWindow.toLocaleString()} runner-min in window\n` +
    `- **Suggested tier:** ${candidate.suggestedTier}`;
  const fileHint = target.callerJob
    ? `\`.github/workflows/${target.workflowFile}\` (caller job \`${target.callerJob}\` — **confirm**)`
    : `\`.github/workflows/${target.workflowFile}\` (**confirm the owning file/job**)`;
  const path = `docs/ci-tuning/promotion-proposals/${slug}.md`;

  const doc =
    `# Promotion proposal — ${candidate.name}\n\n` +
    `> Auto-scaffolded by the PR dashboard. **Advisory** — this check fails for\n` +
    `> real at a late tier with no earlier coverage, so its failures cost a queue\n` +
    `> eject / a post-merge red instead of a fast PR signal. Shifting it left\n` +
    `> catches them sooner. Review before changing triggers.\n\n` +
    `## Evidence\n${evidence}\n\n` +
    `## Likely location\n${fileHint}\n\n` +
    `## Suggested change\n${change.summary}\n\n\`\`\`yaml\n${change.snippet}\n\`\`\`\n\n` +
    `## Checklist\n` +
    `- [ ] Confirm the owning workflow file + job above\n` +
    `- [ ] Add the earlier trigger (or broaden the affected-slice that should cover it)\n` +
    `- [ ] Confirm CI cost is acceptable for the added runs\n` +
    `- [ ] Remove this proposal doc before merge\n`;

  const body =
    `**Advisory promotion (shift-left) proposal** (auto-scaffolded; draft).\n\n${evidence}\n\n` +
    `### Suggested change\n${change.summary}\n\n\`\`\`yaml\n${change.snippet}\n\`\`\`\n\n` +
    `Likely location: ${fileHint}\n\n` +
    `This PR only adds a proposal doc (\`${path}\`); it makes **no workflow change**. ` +
    `Finish the trigger edit per the checklist, delete the doc, and un-draft.`;

  return { slug, branch: `chore/promote-${slug}`, path, title, doc, body };
}

/** Open the promotion draft proposal PR via the shared scaffold-PR orchestration. */
export async function openPromotionDraftPr(
  client: GraphqlClient, owner: string, repo: string, candidate: PromotionCandidate,
): Promise<DraftPrResult> {
  return openScaffoldDraftPr(client, owner, repo, buildPromotionProposal(candidate));
}
