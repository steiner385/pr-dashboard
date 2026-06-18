// The IDE "Act" climax (spec 001, FR-026/FR-033, P1/P2): turn a model edit into a
// review-gated draft PR, safely. Two phases:
//   1. prepare — derive @HEAD (pins a SHA), re-validate legality on the FRESH
//      model, render the YAML edit. Refuses illegal/required-gate edits.
//   2. open — optimistic concurrency: re-check the pinned SHA against live HEAD;
//      if drifted, ABORT and signal re-derive (never open against an unseen base);
//      else create a branch + commit + DRAFT PR via the injected client.
// Network (PR creation) is injected so the whole flow is unit-testable; no direct
// apply ever (draft only).
import type { ModelDeriver } from '../model/derive';
import { validateTierChange, requiredGateChecks } from '../model/legality';
import { renderTierAssign, renderQuarantine } from '../edit/render';

/** A G2 tier-assign authoring intent. (Other dimensions add their own variants.) */
export interface TierAssignIntent { kind: 'tier'; check: string; jobId: string; fromTierId: string; targetEvent: string }

export interface PreparedEdit {
  repo: string; baseSha: string; filePath: string; jobId: string;
  newText: string; diff: string;
}
export type PrepareResult = { ok: true; prepared: PreparedEdit } | { ok: false; reason: string };

/** The GitHub write surface — injected, so tests use a fake and prod wires the real client. */
export interface PrClient {
  fetchWorkflowAtSha: (repo: string, name: string, sha: string) => Promise<string | null>;
  openDraftPr: (input: { repo: string; baseSha: string; filePath: string; newText: string; title: string; body: string }) => Promise<{ number: number; url: string }>;
  /** Read any repo file (root-relative path) at a SHA — for the requiredCheckPrefixes
   *  lever's `.pr-dashboard.yml` read-merge (roadmap 4.5). Null when absent. */
  fetchFileAtSha?: (repo: string, path: string, sha: string) => Promise<string | null>;
}

/** Phase 1: derive @HEAD, validate on the fresh model, render the edit. */
export async function prepareDraftEdit(
  deriver: ModelDeriver, client: PrClient, repo: string, intent: TierAssignIntent, liveRequired?: readonly string[],
): Promise<PrepareResult> {
  const pinned = await deriver.deriveAtHead(repo);
  if (!pinned) return { ok: false, reason: 'no derivable model at HEAD' };

  // re-validate on the FRESHLY derived model (FR-033) — never trust a stale verdict
  const verdict = validateTierChange(pinned.model, { check: intent.check, fromTierId: intent.fromTierId, toTierId: intent.targetEvent === 'merge_group' ? 'queue' : intent.targetEvent }, liveRequired);
  if (!verdict.legal) return { ok: false, reason: verdict.detail ?? verdict.reason ?? 'illegal change' };

  const meta = pinned.model.checkMeta?.find((m) => m.check === intent.check);
  const file = meta?.provenance?.[0]?.file;
  if (!file) return { ok: false, reason: `cannot locate the workflow file for "${intent.check}"` };

  const yaml = await client.fetchWorkflowAtSha(repo, file, pinned.sourceSha);
  if (yaml == null) return { ok: false, reason: `workflow ${file} not found at ${pinned.sourceSha.slice(0, 7)}` };

  const edit = renderTierAssign(yaml, intent.jobId, intent.targetEvent);
  if (!edit.ok) return { ok: false, reason: edit.reason };

  return { ok: true, prepared: { repo, baseSha: pinned.sourceSha, filePath: `.github/workflows/${file}`, jobId: intent.jobId, newText: edit.newText, diff: edit.diff } };
}

/**
 * Phase 1 for a flake-quarantine (K2/FR-038): derive @HEAD, REFUSE if the check is
 * a required merge gate (union static+ruleset), then render the continue-on-error
 * edit. Quarantining a required gate would silently drop merge protection — never
 * allowed, even via this path.
 */
export async function prepareQuarantineEdit(
  deriver: ModelDeriver, client: PrClient, repo: string, intent: { check: string; jobId: string }, liveRequired?: readonly string[],
): Promise<PrepareResult> {
  const pinned = await deriver.deriveAtHead(repo);
  if (!pinned) return { ok: false, reason: 'no derivable model at HEAD' };
  if (requiredGateChecks(pinned.model, liveRequired).has(intent.check)) {
    return { ok: false, reason: `"${intent.check}" is a required merge gate — cannot quarantine it (would drop merge protection)` };
  }
  const meta = pinned.model.checkMeta?.find((m) => m.check === intent.check);
  const file = meta?.provenance?.[0]?.file;
  if (!file) return { ok: false, reason: `cannot locate the workflow file for "${intent.check}"` };
  const yaml = await client.fetchWorkflowAtSha(repo, file, pinned.sourceSha);
  if (yaml == null) return { ok: false, reason: `workflow ${file} not found at ${pinned.sourceSha.slice(0, 7)}` };
  const edit = renderQuarantine(yaml, intent.jobId);
  if (!edit.ok) return { ok: false, reason: edit.reason };
  return { ok: true, prepared: { repo, baseSha: pinned.sourceSha, filePath: `.github/workflows/${file}`, jobId: intent.jobId, newText: edit.newText, diff: edit.diff } };
}

export type OpenResult =
  | { opened: true; number: number; url: string }
  | { opened: false; stale: true; headSha: string }   // HEAD drifted — caller must re-derive (FR-026)
  | { opened: false; stale: false; reason: string };

/** Phase 2: optimistic-concurrency check, then open the DRAFT PR (or abort on drift). */
export async function openDraftPr(
  deriver: ModelDeriver, client: PrClient, prepared: PreparedEdit, check: string,
): Promise<OpenResult> {
  const pin = await deriver.checkPin(prepared.repo, prepared.baseSha);
  if (!pin.current) return { opened: false, stale: true, headSha: pin.headSha }; // FR-026: never open against an unseen base
  try {
    const { number, url } = await client.openDraftPr({
      repo: prepared.repo, baseSha: prepared.baseSha, filePath: prepared.filePath, newText: prepared.newText,
      title: `ci: adjust ${check} tier`,
      body: `Adjusts the protection tier of \`${check}\`.\n\n\`\`\`diff\n${prepared.diff}\n\`\`\`\n\n_Generated as a **draft** for review — not applied._`,
    });
    return { opened: true, number, url };
  } catch (e) {
    return { opened: false, stale: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
