// Increment 3b — the governed multi-file APPLY exit for the Build no-code loop.
// Projects the composed candidate, REFUSES anything unsafe (gating regression,
// low parse-confidence, renderer refusal), then optimistic-concurrency checks HEAD
// and opens a single multi-file DRAFT PR (never a direct apply). The multi-file
// opener is injected so this is unit-testable without GitHub. Mirrors the single-
// file draft-PR discipline (FR-026): never open against an unseen base.
import type { ModelDeriver, PinnedModel } from '../model/derive';
import { projectCandidate } from '../model/candidate';
import type { Mutation } from '../edit/mutation';

export interface MultiFileDraftInput { repo: string; baseSha: string; files: { filePath: string; newText: string }[]; title: string; body: string }
export type OpenMultiFile = (input: MultiFileDraftInput) => Promise<{ number: number; url: string }>;

export type ApplyResult =
  | { ok: true; number: number; url: string }
  | { ok: false; stale: true; headSha: string }                 // HEAD drifted — re-derive
  | { ok: false; stale: false; reason: string };

export async function applyCandidate(
  deriver: ModelDeriver,
  fetchAt: (file: string) => Promise<string | null>,
  openMultiFile: OpenMultiFile,
  baseline: PinnedModel,
  mutations: Mutation[],
): Promise<ApplyResult> {
  const cand = await projectCandidate(deriver, fetchAt, baseline, mutations);
  if (!cand.ok) return { ok: false, stale: false, reason: cand.reason ?? 'cannot apply' };
  if (cand.validation.gatingRegressed) return { ok: false, stale: false, reason: `would drop required gate(s): ${cand.validation.lostGates.join(', ')}` };
  if (cand.validation.lowConfidence) return { ok: false, stale: false, reason: 'low parse-confidence — scaffold only, structured apply blocked' };
  if (cand.files.length === 0) return { ok: false, stale: false, reason: 'no file changes to apply' };

  // optimistic concurrency: HEAD must still be the base we derived/validated against
  const pin = await deriver.checkPin(baseline.repo, baseline.sourceSha);
  if (!pin.current) return { ok: false, stale: true, headSha: pin.headSha };

  try {
    const { number, url } = await openMultiFile({
      repo: baseline.repo, baseSha: baseline.sourceSha,
      files: cand.files.map((f) => ({ filePath: `.github/workflows/${f.file}`, newText: f.newText })),
      title: `ci: pipeline changes (${cand.files.length} file${cand.files.length === 1 ? '' : 's'})`,
      body: `Composed pipeline changes — generated as a **draft** for review, not applied.\n\n` +
        cand.files.map((f) => `\`\`\`diff\n${f.diff}\n\`\`\``).join('\n\n'),
    });
    return { ok: true, number, url };
  } catch (e) {
    return { ok: false, stale: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
