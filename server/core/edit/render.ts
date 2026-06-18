// IDE edit-renderers (spec 001, Group G): render a model-level authoring change
// to a concrete workflow YAML edit + a diff fragment. Textual edits preserve
// formatting; they REFUSE anything they can't do safely (job not found, an
// existing `if:` that would need merging) rather than emit a guess — writing
// broken CI is the risk even behind a draft PR (P1/P2).
//
// This is the G2 (check → tier) dimension: restrict a job to a target event by
// setting `if: github.event_name == '<event>'`. It's the only dimension with a
// legacy parity oracle (the demotion path), so it ships first; G1/G3–G6 follow
// behind their own legality + round-trip tests.

export type EditResult =
  | { ok: true; newText: string; addedLine: string; diff: string }
  | { ok: false; reason: string };

interface JobBlock {
  jobLine: number; jobIndent: string; end: number; block: string[];
  /** indent of the job's first body property, or null when the job has no body */
  propIndent: string | null;
}

/** Locate a job's header line and body block by indentation. Pure; null when absent. */
function locateJobBlock(lines: string[], jobId: string): JobBlock | null {
  const esc = jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const jobRe = new RegExp(`^(\\s+)${esc}:\\s*(#.*)?$`);
  let jobLine = -1, jobIndent = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(jobRe);
    if (m) { jobLine = i; jobIndent = m[1]; break; }
  }
  if (jobLine < 0) return null;
  let end = lines.length;
  for (let i = jobLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const ind = lines[i].match(/^(\s*)/)![1].length;
    if (ind <= jobIndent.length) { end = i; break; }
  }
  const block = lines.slice(jobLine + 1, end);
  const firstProp = block.find((l) => l.trim() !== '');
  const propIndent = firstProp ? firstProp.match(/^(\s*)/)![1] : null;
  return { jobLine, jobIndent, end, block, propIndent };
}

/** Restrict `jobId` to run only on `event` (G2), or refuse with a reason. */
export function renderTierAssign(yamlText: string, jobId: string, event: string): EditResult {
  const lines = yamlText.split('\n');
  const loc = locateJobBlock(lines, jobId);
  if (!loc) return { ok: false, reason: `could not locate job "${jobId}" in the workflow` };
  if (loc.propIndent === null) return { ok: false, reason: `job "${jobId}" has no body to edit` };
  const { jobLine, block, propIndent } = loc;

  const hasIf = block.some((l) => {
    const ind = l.match(/^(\s*)/)![1];
    return ind === propIndent && /^if\s*:/.test(l.trim());
  });
  if (hasIf) return { ok: false, reason: `job "${jobId}" already has an \`if:\` — edit it by hand (use the prompt)` };

  const addedLine = `${propIndent}if: \${{ github.event_name == '${event}' }}`;
  const newText = [...lines.slice(0, jobLine + 1), addedLine, ...lines.slice(jobLine + 1)].join('\n');
  const diff = [
    `@@ job ${jobId} — restrict to ${event} @@`,
    ` ${lines[jobLine]}`,
    `+${addedLine}`,
    ...block.slice(0, 2).map((l) => ` ${l}`),
  ].join('\n');
  return { ok: true, newText, addedLine, diff };
}

/**
 * Quarantine a flaky job (K2): add `continue-on-error: true` so its failures stop
 * breaking the build. CALLER MUST refuse this for a required merge gate (FR-038) —
 * this renderer only does the textual edit. Refuses existing continue-on-error /
 * missing job.
 */
export function renderQuarantine(yamlText: string, jobId: string): EditResult {
  const lines = yamlText.split('\n');
  const loc = locateJobBlock(lines, jobId);
  if (!loc) return { ok: false, reason: `could not locate job "${jobId}" in the workflow` };
  if (loc.propIndent === null) return { ok: false, reason: `job "${jobId}" has no body to edit` };
  const { jobLine, block, propIndent } = loc;
  if (block.some((l) => l.match(/^(\s*)/)![1] === propIndent && /^continue-on-error\s*:/.test(l.trim()))) {
    return { ok: false, reason: `job "${jobId}" already sets continue-on-error — edit by hand` };
  }
  const addedLine = `${propIndent}continue-on-error: true  # quarantined (flaky) — remove when fixed`;
  const newText = [...lines.slice(0, jobLine + 1), addedLine, ...lines.slice(jobLine + 1)].join('\n');
  const diff = [`@@ job ${jobId} — quarantine (flaky) @@`, ` ${lines[jobLine]}`, `+${addedLine}`, ...block.slice(0, 2).map((l) => ` ${l}`)].join('\n');
  return { ok: true, newText, addedLine, diff };
}

/** Add `timeout-minutes: <minutes>` to a job (hygiene; additive). Refuses a job
 *  that already sets it, or one with no body / absent. */
export function renderTimeout(yamlText: string, jobId: string, minutes: number): EditResult {
  const lines = yamlText.split('\n');
  const loc = locateJobBlock(lines, jobId);
  if (!loc) return { ok: false, reason: `could not locate job "${jobId}" in the workflow` };
  if (loc.propIndent === null) return { ok: false, reason: `job "${jobId}" has no body to edit` };
  const { jobLine, block, propIndent } = loc;
  if (block.some((l) => l.match(/^(\s*)/)![1] === propIndent && /^timeout-minutes\s*:/.test(l.trim()))) {
    return { ok: false, reason: `job "${jobId}" already sets timeout-minutes — edit by hand` };
  }
  const addedLine = `${propIndent}timeout-minutes: ${minutes}`;
  const newText = [...lines.slice(0, jobLine + 1), addedLine, ...lines.slice(jobLine + 1)].join('\n');
  const diff = [`@@ job ${jobId} — timeout ${minutes}m @@`, ` ${lines[jobLine]}`, `+${addedLine}`, ...block.slice(0, 2).map((l) => ` ${l}`)].join('\n');
  return { ok: true, newText, addedLine, diff };
}

/** Change a job's `runs-on:` (runner routing). Refuses a missing job, a job
 *  with no `runs-on:` (e.g. a reusable-workflow `uses:` caller), or a `runs-on:`
 *  that is a matrix/expression (cannot route safely). */
export function renderRunnerRoute(yamlText: string, jobId: string, runsOn: string): EditResult {
  const lines = yamlText.split('\n');
  const loc = locateJobBlock(lines, jobId);
  if (!loc) return { ok: false, reason: `could not locate job "${jobId}" in the workflow` };
  if (loc.propIndent === null) return { ok: false, reason: `job "${jobId}" has no body to edit` };
  const { jobLine, end, propIndent } = loc;
  let runsIdx = -1;
  for (let i = jobLine + 1; i < end; i++) {
    if (lines[i].match(/^(\s*)/)![1] === propIndent && /^runs-on\s*:/.test(lines[i].trim())) { runsIdx = i; break; }
  }
  if (runsIdx < 0) return { ok: false, reason: `job "${jobId}" has no \`runs-on:\` (reusable-workflow caller?) — cannot route` };
  const value = lines[runsIdx].slice(lines[runsIdx].indexOf(':') + 1).trim();
  if (value.includes('${{') || value.startsWith('[')) {
    return { ok: false, reason: `job "${jobId}" runs-on is an expression/matrix — edit by hand` };
  }
  const newLine = `${propIndent}runs-on: ${runsOn}`;
  const newText = [...lines.slice(0, runsIdx), newLine, ...lines.slice(runsIdx + 1)].join('\n');
  const diff = [`@@ job ${jobId} — runs-on → ${runsOn} @@`, `-${lines[runsIdx]}`, `+${newLine}`].join('\n');
  return { ok: true, newText, addedLine: newLine, diff };
}

/** Pin an action `uses: owner/repo@ref` to a resolved 40-hex commit SHA, keeping
 *  the original ref as a trailing comment. Pure — the SHA is supplied by the
 *  caller. Refuses a bad SHA, an already-pinned ref, or a missing `uses:` line. */
export function pinActionSha(yamlText: string, usesRef: string, sha: string): EditResult {
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, reason: `"${sha}" is not a 40-char commit SHA` };
  const at = usesRef.lastIndexOf('@');
  if (at < 0) return { ok: false, reason: `"${usesRef}" is not "owner/repo@ref"` };
  const action = usesRef.slice(0, at), ref = usesRef.slice(at + 1);
  if (/^[0-9a-f]{40}$/.test(ref)) return { ok: false, reason: `"${usesRef}" is already pinned to a SHA` };
  const lines = yamlText.split('\n');
  const escA = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escR = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\s*-?\\s*uses:\\s*)${escA}@${escR}\\s*(#.*)?$`);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) { idx = i; break; } }
  if (idx < 0) return { ok: false, reason: `could not find \`uses: ${usesRef}\`` };
  const prefix = lines[idx].match(re)![1];
  const newLine = `${prefix}${action}@${sha}  # ${ref}`;
  const newText = [...lines.slice(0, idx), newLine, ...lines.slice(idx + 1)].join('\n');
  const diff = [`@@ pin ${action} → ${sha.slice(0, 7)} @@`, `-${lines[idx]}`, `+${newLine}`].join('\n');
  return { ok: true, newText, addedLine: newLine, diff };
}

/** Add a workflow-level `concurrency:` block (group + cancel-in-progress) before
 *  the top-level `jobs:`. NOT low-risk — this changes runtime cancellation of
 *  in-flight runs. Refuses a workflow that already declares concurrency, or text
 *  with no top-level `jobs:`. */
export function addConcurrency(yamlText: string, group: string): EditResult {
  const lines = yamlText.split('\n');
  if (lines.some((l) => /^concurrency\s*:/.test(l))) {
    return { ok: false, reason: `workflow already declares \`concurrency:\` — edit by hand` };
  }
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx < 0) return { ok: false, reason: `could not find top-level \`jobs:\` — not a workflow?` };
  const added = [`concurrency:`, `  group: ${group}`, `  cancel-in-progress: true`];
  const newText = [...lines.slice(0, jobsIdx), ...added, ...lines.slice(jobsIdx)].join('\n');
  const diff = [`@@ add workflow concurrency @@`, ...added.map((l) => `+${l}`), ` ${lines[jobsIdx]}`].join('\n');
  return { ok: true, newText, addedLine: added.join('\n'), diff };
}

// A whole-expression simple event guard (mirrors pipeline-model/narrow-events SIMPLE).
const SIMPLE_EVENT_GUARD = /^\s*(?:\$\{\{)?\s*github\.event_name\s*(?:==|!=)\s*'[a-z_]+'\s*(?:\}\})?\s*$/;

/** Shift a check left (inverse of G2): remove a job's *simple* event-guard `if:`
 *  so it runs on all the workflow's events (incl. pull_request). Refuse-not-merge:
 *  any `if:` beyond a single `github.event_name` comparison is refused (→ scaffold),
 *  never textually merged. Refuses a missing job or a job with no `if:`. */
export function renderShiftLeft(yamlText: string, jobId: string): EditResult {
  const lines = yamlText.split('\n');
  const loc = locateJobBlock(lines, jobId);
  if (!loc) return { ok: false, reason: `could not locate job "${jobId}" in the workflow` };
  if (loc.propIndent === null) return { ok: false, reason: `job "${jobId}" has no body to edit` };
  const { jobLine, end, propIndent } = loc;
  let ifIdx = -1;
  for (let i = jobLine + 1; i < end; i++) {
    if (lines[i].match(/^(\s*)/)![1] === propIndent && /^if\s*:/.test(lines[i].trim())) { ifIdx = i; break; }
  }
  if (ifIdx < 0) return { ok: false, reason: `job "${jobId}" has no \`if:\` event guard to relax — already shifts left` };
  const ifVal = lines[ifIdx].slice(lines[ifIdx].indexOf(':') + 1).trim();
  if (!SIMPLE_EVENT_GUARD.test(ifVal)) {
    return { ok: false, reason: `job "${jobId}" \`if:\` is not a simple event guard — edit by hand (use the prompt)` };
  }
  const newText = [...lines.slice(0, ifIdx), ...lines.slice(ifIdx + 1)].join('\n');
  const diff = [`@@ job ${jobId} — shift left (remove event guard) @@`, `-${lines[ifIdx]}`, ...lines.slice(jobLine, jobLine + 1).map((l) => ` ${l}`)].join('\n');
  return { ok: true, newText, addedLine: '', diff };
}

const unquote = (s: string) => s.replace(/^['"]|['"]$/g, '');

/** Strip every reference to `jobId` from `needs:` clauses (inline-array, scalar,
 *  and block-list forms). Pure helper for renderRemoveCheck. */
function stripNeedsRef(lines: string[], jobId: string): string[] {
  const out: string[] = [];
  let needsIndent: number | null = null; // indent of the `needs:` header while inside a block list
  for (const line of lines) {
    const indent = line.match(/^(\s*)/)![1].length;
    if (needsIndent !== null) {
      const item = line.match(/^\s*-\s*(\S+)\s*(#.*)?$/);
      if (item && indent > needsIndent) {
        if (unquote(item[1]) === jobId) continue; // drop this needs list item
        out.push(line); continue;
      }
      needsIndent = null; // block ended
    }
    const inlineArr = line.match(/^(\s*needs\s*:\s*)\[(.*)\]\s*(#.*)?$/);
    if (inlineArr) {
      const items = inlineArr[2].split(',').map((s) => unquote(s.trim())).filter((s) => s && s !== jobId);
      out.push(`${inlineArr[1]}[${items.join(', ')}]`);
      continue;
    }
    const scalar = line.match(/^(\s*)needs\s*:\s*(\S+)\s*(#.*)?$/);
    if (scalar && unquote(scalar[2]) === jobId) continue; // drop `needs: jobId`
    const header = line.match(/^(\s*)needs\s*:\s*(#.*)?$/);
    if (header) { needsIndent = header[1].length; out.push(line); continue; }
    out.push(line);
  }
  return out;
}

/** Remove a dead job's block and strip it from every `needs:` reference. The
 *  CALLER (validator) must refuse this for a required gate / where removal would
 *  orphan a gate — this renderer only does the textual edit. Refuses a missing job. */
export function renderRemoveCheck(yamlText: string, jobId: string): EditResult {
  const lines = yamlText.split('\n');
  const loc = locateJobBlock(lines, jobId);
  if (!loc) return { ok: false, reason: `could not locate job "${jobId}" in the workflow` };
  const { jobLine, end } = loc;
  const removedSlice = lines.slice(jobLine, end);
  const withoutJob = [...lines.slice(0, jobLine), ...lines.slice(end)];
  const cleaned = stripNeedsRef(withoutJob, jobId);
  const newText = cleaned.join('\n');
  const diff = [`@@ remove job ${jobId} @@`, ...removedSlice.slice(0, 3).map((l) => `-${l}`)].join('\n');
  return { ok: true, newText, addedLine: '', diff };
}
