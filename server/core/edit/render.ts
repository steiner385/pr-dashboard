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
