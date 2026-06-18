/**
 * Demotion candidate → one-click DRAFT PR (Phase 2, scaffold approach).
 *
 * The dashboard surfaces almost-always-green checks as demotion candidates
 * (estimator/demotion-candidates.ts). This opens a DRAFT pull request on the
 * target repo that scaffolds the demotion: it commits a proposal doc carrying
 * the evidence, the resolved workflow file + job, and a SUGGESTED `if:` guard —
 * a starting point a human reviews and turns into the real trigger change. It
 * deliberately does NOT auto-edit the workflow's gating: demoting a check is a
 * high-blast-radius CI edit, so the tool scaffolds and a human lands it.
 *
 * Runs through the same per-owner GraphQL client the poller/pr-actions use; the
 * App needs `contents: write` (already granted for the ready-merge flip).
 */

import type { GraphqlClient } from './pr-actions';
import type { DemotionCandidate } from './estimator/demotion-candidates';
import { openScaffoldDraftPr, type DraftPrResult } from './scaffold-pr';

/** Where a candidate's gating most likely lives, derived from its check name.
 *  KinDash names a reusable workflow `_<callerJob>.yml` and its checks
 *  `<callerJob> / <job name>`. We surface the heuristic file + the caller so the
 *  proposal can point at it; the human confirms (the doc says so). */
export interface DemotionTarget {
  /** ci.yml caller job (the part before ' / '), or null when the name has none. */
  callerJob: string | null;
  /** Best-guess workflow file under .github/workflows/ owning the job. */
  workflowFile: string;
}

export function resolveDemotionTarget(candidate: DemotionCandidate): DemotionTarget {
  const slash = candidate.name.indexOf(' / ');
  if (slash === -1) return { callerJob: null, workflowFile: 'ci.yml' };
  const caller = candidate.name.slice(0, slash).trim();
  // KinDash reusable-workflow convention: caller `integration-tests` → file
  // `_integration-tests.yml`. A bare caller with no underscore variant still
  // resolves to the heuristic; the proposal tells the reviewer to confirm.
  return { callerJob: caller, workflowFile: `_${caller}.yml` };
}

/** The suggested trigger change for a demotion, as a reviewable snippet. */
function suggestedChange(candidate: DemotionCandidate): { summary: string; snippet: string } {
  if (candidate.event === 'pull_request') {
    return {
      summary: `Stop running this job on PR pushes (keep it on the merge queue + main).`,
      snippet:
        `# Add to the job in ${'`'}.github/workflows/<file>${'`'} so it skips on PR events:\n` +
        `    if: \${{ github.event_name != 'pull_request' }}`,
    };
  }
  // push / merge_group → nightly
  return {
    summary: `Move this job to a nightly schedule (drop it from the per-build path).`,
    snippet:
      `# Remove the job from the per-build workflow and add it to the nightly\n` +
      `# workflow (e.g. _full-ci.yml) under:\n` +
      `on:\n  schedule:\n    - cron: '0 7 * * *'   # nightly`,
  };
}

/** kebab slug for branch + filename, stable and filesystem-safe. */
export function demotionSlug(candidate: DemotionCandidate): string {
  const raw = `${candidate.name}-${candidate.event}`;
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export interface DemotionProposal {
  slug: string;
  branch: string;
  path: string;
  title: string;
  /** Markdown committed to `path`. */
  doc: string;
  /** PR body. */
  body: string;
}

export function buildDemotionProposal(candidate: DemotionCandidate): DemotionProposal {
  const slug = demotionSlug(candidate);
  const target = resolveDemotionTarget(candidate);
  const change = suggestedChange(candidate);
  const title = `chore(ci): demote ${candidate.name} → ${candidate.suggestedTier} (advisory)`;
  const evidence =
    `- **Check:** \`${candidate.name}\`\n` +
    `- **Trigger:** ${candidate.event} (${candidate.currentTier})\n` +
    `- **Success rate:** ${candidate.successRatePct}% over ${candidate.runsInWindow} runs\n` +
    `- **Cost:** ~${candidate.minutesInWindow.toLocaleString()} runner-min in window\n` +
    `- **Suggested tier:** ${candidate.suggestedTier}`;
  const fileHint = target.callerJob
    ? `\`.github/workflows/${target.workflowFile}\` (caller job \`${target.callerJob}\` — **confirm**)`
    : `\`.github/workflows/${target.workflowFile}\` (**confirm the owning file/job**)`;

  const doc =
    `# Demotion proposal — ${candidate.name}\n\n` +
    `> Auto-scaffolded by the PR dashboard. **Advisory** — this check is almost\n` +
    `> always green and expensive; consider running it less often. A green check\n` +
    `> can still guard against rare regressions, so review before demoting.\n\n` +
    `## Evidence\n${evidence}\n\n` +
    `## Likely location\n${fileHint}\n\n` +
    `## Suggested change\n${change.summary}\n\n\`\`\`yaml\n${change.snippet}\n\`\`\`\n\n` +
    `## Checklist\n` +
    `- [ ] Confirm the owning workflow file + job above\n` +
    `- [ ] Apply the trigger change (or your preferred lower-frequency gating)\n` +
    `- [ ] Confirm the required-check name still resolves (branch protection / merge queue)\n` +
    `- [ ] Remove this proposal doc before merge\n`;

  const body =
    `**Advisory demotion proposal** (auto-scaffolded; draft).\n\n${evidence}\n\n` +
    `### Suggested change\n${change.summary}\n\n\`\`\`yaml\n${change.snippet}\n\`\`\`\n\n` +
    `Likely location: ${fileHint}\n\n` +
    `This PR only adds a proposal doc (\`${`docs/ci-tuning/demotion-proposals/${slug}.md`}\`); it makes **no workflow change**. ` +
    `Finish the gating edit per the checklist, delete the doc, and un-draft.`;

  return {
    slug,
    branch: `chore/demote-${slug}`,
    path: `docs/ci-tuning/demotion-proposals/${slug}.md`,
    title,
    doc,
    body,
  };
}

// ---- GraphQL orchestration (shared with the promotion lever) ----------------
// Re-export the result type so existing importers (api.ts) are unchanged; the
// branch/commit/PR mutations live once in scaffold-pr.ts.
export type { DraftPrResult };

/**
 * Open the demotion draft proposal PR via the shared scaffold-PR orchestration.
 * Throws on the first failed mutation (the API layer maps it to an HTTP error).
 */
export async function openDemotionDraftPr(
  client: GraphqlClient, owner: string, repo: string, candidate: DemotionCandidate,
): Promise<DraftPrResult> {
  return openScaffoldDraftPr(client, owner, repo, buildDemotionProposal(candidate));
}
