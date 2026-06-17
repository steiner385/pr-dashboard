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

/** Restrict `jobId` to run only on `event` (G2), or refuse with a reason. */
export function renderTierAssign(yamlText: string, jobId: string, event: string): EditResult {
  const lines = yamlText.split('\n');
  const esc = jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const jobRe = new RegExp(`^(\\s+)${esc}:\\s*(#.*)?$`);

  let jobLine = -1, jobIndent = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(jobRe);
    if (m) { jobLine = i; jobIndent = m[1]; break; }
  }
  if (jobLine < 0) return { ok: false, reason: `could not locate job "${jobId}" in the workflow` };

  let end = lines.length;
  for (let i = jobLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const ind = lines[i].match(/^(\s*)/)![1].length;
    if (ind <= jobIndent.length) { end = i; break; }
  }
  const block = lines.slice(jobLine + 1, end);
  const firstProp = block.find((l) => l.trim() !== '');
  if (!firstProp) return { ok: false, reason: `job "${jobId}" has no body to edit` };
  const propIndent = firstProp.match(/^(\s*)/)![1];

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
