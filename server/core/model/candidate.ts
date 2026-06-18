// Project a CandidateModel from a baseline SHA + ordered mutations (spec §3):
// resolve each mutation's file via provenance, apply the pure renderers, re-derive
// from the mutated YAML, then validate over the RE-DERIVED candidate — never the
// mutation list. The required-gate set must stay a superset of baseline.
import type { Mutation } from '../edit/mutation';
import { applyMutation } from '../edit/mutation';
import { requiredGateChecks, gatingRegressed } from './legality';
import type { ModelDeriver, PinnedModel } from './derive';
import type { DerivedModel } from '../../pipeline-model/derived';
import type { GatingResult } from '../../pipeline-model/types';

export interface CandidateValidation { gatingRegressed: boolean; lostGates: string[]; lowConfidence: boolean }
export interface CandidateFile { file: string; diff: string; newText: string }
export interface CandidateResult {
  ok: boolean; reason?: string; baseSha: string;
  files: CandidateFile[];
  validation: CandidateValidation;
  model: DerivedModel | null;
}

/** Required-gate set as a GatingResult so we can reuse gatingRegressed. */
function requiredAsGating(model: DerivedModel): GatingResult {
  return { gatingCallerJobs: [], conditionalCallerJobs: [],
    gates: [...requiredGateChecks(model)].map((checkName) => ({ checkName, events: [] })) };
}

/** Resolve the workflow file a mutation edits (basename, e.g. "ci.yml"), or null. */
function fileForMutation(model: DerivedModel, m: Mutation): string | null {
  if (m.op === 'concurrency') return 'ci.yml';   // workflow-level → the rollup file
  if (m.op === 'pin-action') return null;          // content-search — follow-on
  for (const meta of model.checkMeta ?? []) {
    const anchor = meta.provenance.find((p) => p.jobId === m.jobId);
    if (anchor) return anchor.file;
  }
  return null;
}

/** The mutated checks' confidence (for the low-confidence → scaffold rule). */
function touchesLowConfidence(model: DerivedModel, mutations: Mutation[]): boolean {
  const jobIds = new Set(mutations.map((m) => ('jobId' in m ? m.jobId : '')).filter(Boolean));
  return (model.checkMeta ?? []).some(
    (meta) => meta.confidence === 'low' && meta.provenance.some((p) => jobIds.has(p.jobId)),
  );
}

/**
 * Raw-YAML escape-hatch projection (spec §2.5): re-derive from an operator-edited
 * single file and validate it over the re-derived candidate. The model is the
 * language server — an unparseable edit (or one that drops ci.yml) is refused, and
 * any required-gate loss is flagged. Positive-allowlist: `file` must be a provenance
 * file of the baseline model.
 */
export async function projectRawYaml(
  deriver: ModelDeriver,
  baseline: PinnedModel,
  file: string,
  rawYaml: string,
): Promise<CandidateResult> {
  const base: CandidateResult = { ok: false, baseSha: baseline.sourceSha, files: [], validation: { gatingRegressed: false, lostGates: [], lowConfidence: false }, model: null };
  const allowed = new Set((baseline.model.checkMeta ?? []).flatMap((m) => m.provenance.map((p) => p.file)));
  if (!allowed.has(file)) return { ...base, reason: `"${file}" is not a workflow file of this pipeline` };
  const candidate = await deriver.deriveWithOverrides(baseline.repo, baseline.sourceSha, { [file]: rawYaml });
  if (candidate == null) return { ...base, reason: 'edited YAML did not derive (unparseable, or ci.yml became invalid)' };
  const greg = gatingRegressed(requiredAsGating(baseline.model), requiredAsGating(candidate));
  return {
    ok: true, baseSha: baseline.sourceSha,
    files: [{ file, diff: `(raw edit of ${file})`, newText: rawYaml }],
    validation: { gatingRegressed: greg.regressed, lostGates: greg.lost, lowConfidence: false },
    model: candidate,
  };
}

export async function projectCandidate(
  deriver: ModelDeriver,
  fetchAt: (file: string) => Promise<string | null>,
  baseline: PinnedModel,
  mutations: Mutation[],
): Promise<CandidateResult> {
  const base: CandidateResult = { ok: false, baseSha: baseline.sourceSha, files: [], validation: { gatingRegressed: false, lostGates: [], lowConfidence: false }, model: null };

  // 1. Resolve each mutation to a file (group in order).
  const byFile = new Map<string, Mutation[]>();
  for (const m of mutations) {
    if (m.op === 'pin-action') return { ...base, reason: 'pin-action is not yet supported in candidate projection (follow-on)' };
    const file = fileForMutation(baseline.model, m);
    if (!file) return { ...base, reason: `cannot resolve a workflow file for ${m.op} on "${'jobId' in m ? m.jobId : ''}"` };
    byFile.set(file, [...(byFile.get(file) ?? []), m]);
  }

  // 2. Apply mutations per file (refuse on any renderer refusal); collect overrides + diffs.
  const overrides: Record<string, string> = {};
  const files: CandidateFile[] = [];
  for (const [file, ms] of byFile) {
    let text = await fetchAt(file);
    if (text == null) return { ...base, reason: `workflow ${file} not found at ${baseline.sourceSha.slice(0, 7)}` };
    const diffs: string[] = [];
    for (const m of ms) {
      const edit = applyMutation(text, m);
      if (!edit.ok) return { ...base, reason: edit.reason };
      text = edit.newText; diffs.push(edit.diff);
    }
    overrides[file] = text;
    files.push({ file, diff: diffs.join('\n'), newText: text });
  }

  // 3. Re-derive the candidate from the mutated YAML.
  const candidate = await deriver.deriveWithOverrides(baseline.repo, baseline.sourceSha, overrides);
  if (candidate == null) return { ...base, reason: 'candidate did not derive (ci.yml unparseable after edit)' };

  // 4. Validate over the RE-DERIVED candidate.
  const greg = gatingRegressed(requiredAsGating(baseline.model), requiredAsGating(candidate));
  return {
    ok: true, baseSha: baseline.sourceSha, files,
    validation: { gatingRegressed: greg.regressed, lostGates: greg.lost, lowConfidence: touchesLowConfidence(baseline.model, mutations) },
    model: candidate,
  };
}
