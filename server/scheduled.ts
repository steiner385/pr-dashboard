import { parse as parseYaml } from 'yaml';
import { FAILING_CONCLUSIONS } from './history';

/** The lane status vocabulary (mirrors frontend types.ts LaneStatus; the server
 *  uses inline literal unions for lane status — see estimator/lane-health.ts). */
type LaneStatus = 'green' | 'amber' | 'red' | 'blind' | 'idle';

/**
 * Scheduled-lane helpers (Delivery spine, Spec 4). Pure functions only — the
 * REST polling + persistence live on the Poller / HistoryStore. The scheduled
 * lane is the one genuinely-new backend data source: it auto-discovers a repo's
 * scheduled (cron) workflows and REST-polls their recent runs, run-level only.
 *
 * DEFERRED (run-level only — see plan): per-job failing-name drill-down
 * (`/runs/{id}/jobs`), cron-parsing / missed-run detection, and job-level rows.
 */

/** One latest scheduled run per workflow, as surfaced to the frontend. */
export interface ScheduledRun {
  workflow: string;
  conclusion: string | null;
  status: string | null;
  createdAt: string | null;
  htmlUrl: string | null;
}

/** A `workflow_runs[]` row from the Actions REST API (only the fields we use). */
export interface ScheduledRunApiRow {
  id?: number | null;
  run_number?: number | null;
  run_attempt?: number | null;
  status?: string | null;
  conclusion?: string | null;
  created_at?: string | null;
  html_url?: string | null;
  event?: string | null;
}
export interface ScheduledRunsApiResponse { workflow_runs?: ScheduledRunApiRow[] | null; }

/**
 * Of the given workflow files, the paths whose YAML `on:` block declares a
 * `schedule:` trigger — i.e. cron-scheduled workflows. Discovery is filtered by
 * the workflow FILE's `on` definition (not by `event=schedule` on runs alone):
 * a manual fire of a scheduled workflow is `workflow_dispatch`, and we still
 * want to track it (spec §9). Returns sorted, de-duplicated paths.
 *
 * Primary path uses the `yaml` parser; if a file is unparseable we fall back to
 * a robust scan that keeps the file only when a `schedule:` key appears within
 * the `on:` block (never elsewhere — an `env.schedule` must not match).
 */
export function parseScheduledWorkflows(files: { path: string; text: string }[]): string[] {
  const out = new Set<string>();
  for (const { path, text } of files) {
    if (definesSchedule(text)) out.add(path);
  }
  return [...out].sort();
}

function definesSchedule(text: string): boolean {
  try {
    const doc = parseYaml(text) as Record<string, unknown> | null;
    // YAML parses the bareword `on` as boolean true (the Norway problem), so the
    // trigger block can land under either the string 'on' or the boolean key.
    const on = (doc?.on ?? (doc as Record<string, unknown>)?.[true as unknown as string]) as unknown;
    if (on == null) return false;
    if (Array.isArray(on)) return on.includes('schedule');
    if (typeof on === 'object') return 'schedule' in (on as Record<string, unknown>);
    if (typeof on === 'string') return on === 'schedule';
    return false;
  } catch {
    return scheduleUnderOnFallback(text);
  }
}

/**
 * Regex fallback for unparseable YAML: true only when a `schedule:` key sits
 * inside the `on:` block. We find the `on:` line, then scan subsequent lines
 * that are MORE indented than it (the block body) for a `schedule:` key,
 * stopping at the first line dedented back to/under `on`'s indent (block end).
 */
function scheduleUnderOnFallback(text: string): boolean {
  const lines = text.split('\n');
  const onIdx = lines.findIndex((l) => /^\s*(['"]?on['"]?|true)\s*:/.test(l));
  if (onIdx < 0) return false;
  const onLine = lines[onIdx];
  // Inline/flow form on the same line, e.g. `on: { schedule: [...] }`.
  if (/\bschedule\b/.test(onLine.slice(onLine.indexOf(':') + 1))) return true;
  const onIndent = (onLine.match(/^\s*/)?.[0].length) ?? 0;
  for (let i = onIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = (line.match(/^[ \t]*/)?.[0].length) ?? 0;
    if (indent <= onIndent) break; // block ended
    if (/^[ \t]*schedule\s*:/.test(line)) return true;
  }
  return false;
}

/** REST path for a scheduled workflow's recent runs (newest first), run-level. */
export function scheduledRunsApiPath(owner: string, name: string, file: string): string {
  return `/repos/${owner}/${name}/actions/workflows/${file}/runs?per_page=8`;
}

/**
 * The scheduled lane's status (spec §9 + plan task 1):
 *  - no scheduled workflows discovered → idle.
 *  - discovered but no runs recorded yet → blind.
 *  - latest run of ANY workflow is failing-class → red.
 *  - every latest run is SUCCESS → green.
 *  - otherwise (in-progress / cancelled / neutral) → amber.
 * `runs` is the newest run PER workflow (latestScheduledRuns output).
 */
export function scheduledLaneStatus(
  runs: ScheduledRun[], opts: { discovered: number },
): { status: LaneStatus; summary: string } {
  if (opts.discovered === 0) return { status: 'idle', summary: 'no scheduled workflows' };
  if (runs.length === 0) {
    return { status: 'blind', summary: `${opts.discovered} scheduled · no runs yet` };
  }
  const isFail = (c: string | null) => c != null && FAILING_CONCLUSIONS.has(c.toUpperCase());
  const isSuccess = (c: string | null) => (c ?? '').toUpperCase() === 'SUCCESS';
  const failing = runs.filter((r) => isFail(r.conclusion)).length;
  const passing = runs.filter((r) => isSuccess(r.conclusion)).length;

  const glyph = (c: string | null) => isFail(c) ? '✗' : isSuccess(c) ? '✓' : '●';
  const split = runs.map((r) => `${shortName(r.workflow)} ${glyph(r.conclusion)}`).join(' · ');

  if (failing > 0) return { status: 'red', summary: split };
  if (passing === runs.length) return { status: 'green', summary: split };
  return { status: 'amber', summary: split };
}

/** Workflow file → display label (strip the `.github/workflows/` dir + extension). */
export function shortName(workflow: string): string {
  return workflow.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
}
