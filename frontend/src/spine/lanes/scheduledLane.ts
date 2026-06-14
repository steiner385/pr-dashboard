import type { DashboardState, LaneStatus } from '../../types';

/** Failing-class conclusions (mirror of server history.ts FAILING_CONCLUSIONS).
 *  REST conclusions are lowercase; compared case-insensitively. CANCELLED is
 *  deliberately NOT here — a cancelled scheduled run never reds the lane. */
const FAILING = new Set(['failure', 'timed_out', 'startup_failure']);

type SchedRun = NonNullable<DashboardState['repos'][number]['scheduled']>['runs'][number];

const isFail = (c: string | null) => c != null && FAILING.has(c.toLowerCase());
const isSuccess = (c: string | null) => (c ?? '').toLowerCase() === 'success';

/** Workflow file → short label (`nightly.yml` → `nightly`). */
function shortName(workflow: string): string {
  return workflow.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
}

/**
 * Scheduled-lane derivation (Spec 4): the health of every repo's cron-scheduled
 * workflows (nightly/weekly/audit-*), aggregated across repos. gating:true — a
 * failed nightly is a real red worth surfacing.
 *
 *  - No repo has scheduled workflows → idle (rendered not-wired → out of rollup).
 *  - Workflows discovered but no runs recorded → blind.
 *  - Latest run of ANY workflow is failing-class → red.
 *  - Every latest run is SUCCESS → green.
 *  - Otherwise (in-progress / cancelled / neutral) → amber.
 */
export function scheduledLane(repos: DashboardState['repos']): { status: LaneStatus; summary: string } {
  const snaps = repos.map((r) => r.scheduled).filter(Boolean) as
    NonNullable<DashboardState['repos'][number]['scheduled']>[];
  const discovered = snaps.reduce((n, s) => n + s.discovered, 0);
  if (discovered === 0) return { status: 'idle', summary: 'no scheduled workflows' };

  const runs: SchedRun[] = snaps.flatMap((s) => s.runs);
  if (runs.length === 0) return { status: 'blind', summary: `${discovered} scheduled · no runs yet` };

  const failing = runs.filter((r) => isFail(r.conclusion)).length;
  const passing = runs.filter((r) => isSuccess(r.conclusion)).length;
  const glyph = (c: string | null) => isFail(c) ? '✗' : isSuccess(c) ? '✓' : '●';

  // Few workflows → a per-workflow glyph list; many → a count summary.
  const summary = runs.length <= 4
    ? runs.map((r) => `${shortName(r.workflow)} ${glyph(r.conclusion)}`).join(' · ')
    : [passing > 0 ? `${passing} ✓` : null,
       failing > 0 ? `${failing} ✗` : null,
       runs.length - passing - failing > 0 ? `${runs.length - passing - failing} ●` : null]
        .filter(Boolean).join(' · ');

  if (failing > 0) return { status: 'red', summary };
  if (passing === runs.length) return { status: 'green', summary };
  return { status: 'amber', summary };
}
