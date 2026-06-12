import { Fragment } from 'react';
import type { CheckView } from './types';
import { formatDur, formatSince } from './format';

type RowKind = 'done' | 'running' | 'overdue' | 'failed' | 'queued' | 'skipped';

/** Bar scale for the panel: the longest check (elapsed, expected, or its p90
 *  upper bound) defines 100% — so the p10–p90 band never overflows a bar. */
export function ganttScale(checks: CheckView[]): number {
  const max = checks.reduce(
    (acc, c) => Math.max(acc, c.elapsedSeconds ?? 0, c.expectedSeconds ?? 0, c.expectedHighSeconds ?? 0), 0);
  return max > 0 ? max : 60;
}

function rowKind(c: CheckView): RowKind {
  if (c.status !== 'COMPLETED') {
    if (c.elapsedSeconds == null) return 'queued';
    return c.expectedSeconds != null && c.elapsedSeconds > c.expectedSeconds ? 'overdue' : 'running';
  }
  if (c.conclusion === 'SUCCESS') return 'done';
  if (c.conclusion === 'SKIPPED') return 'skipped';
  return 'failed';
}

/** Flake-radar annotation for a failing check (issue #37). */
function flakeText(c: CheckView): string {
  return ` · ⚐ flakes ${Math.round(c.flakeRatePct ?? 0)}% — likely flake, consider re-run`;
}

/** Hover text for the duration-regression ↑ badge (issue #41). */
function regressTitle(c: CheckView): string {
  const r = c.regression;
  if (!r) return 'duration regression';
  return `duration regression: p50 ${formatDur(r.priorP50Secs)} → ${formatDur(r.recentP50Secs)}`
    + ` since ${formatSince(r.sinceApprox)}`;
}

function timeText(c: CheckView, kind: RowKind): string {
  const elapsed = c.elapsedSeconds != null ? formatDur(c.elapsedSeconds) : '';
  switch (kind) {
    case 'done': return elapsed ? `${elapsed} ✓` : '✓';
    case 'failed': {
      const base = elapsed ? `${elapsed} ✗` : '✗';
      return c.likelyFlake ? base + flakeText(c) : base;
    }
    case 'skipped': return '–';
    case 'queued': {
      if (c.waitKind === 'blocked') {
        // graph nodes for reusable workflows carry a ' /' suffix — cosmetic-trim it
        return `⊘ blocked on ${(c.blockedOn ?? '?').replace(/ \/$/, '')}`;
      }
      if (c.waitKind === 'runner') {
        if (c.waitingSeconds == null) return '⧗ waiting for runner';
        const dur = formatDur(c.waitingSeconds);
        const typical = c.expectedRunnerWaitSeconds != null
          ? ` (typical ~${formatDur(c.expectedRunnerWaitSeconds)})` : '';
        return `⧗ waiting for runner · ${dur}${typical}`;
      }
      return '—';
    }
    case 'overdue': return `${elapsed} ⚠ overdue`;
    case 'running':
      return c.expectedSeconds != null ? `${elapsed} / ~${formatDur(c.expectedSeconds)}` : elapsed;
  }
}

function GanttRow({ c, scale }: { c: CheckView; scale: number }) {
  const kind = rowKind(c);
  const fillPct = kind === 'queued'
    ? 15
    : Math.min(100, ((c.elapsedSeconds ?? 0) / scale) * 100);

  // For runner-wait queued rows, determine extra CSS class
  const isRunnerWait = kind === 'queued' && c.waitKind === 'runner';
  const isAmber = isRunnerWait
    && c.waitingSeconds != null
    && c.expectedRunnerWaitSeconds != null
    && c.waitingSeconds > 2 * c.expectedRunnerWaitSeconds;
  const extraClass = isRunnerWait ? (isAmber ? ' g-runner-wait g-runner-wait-amber' : ' g-runner-wait') : '';
  const advisoryClass = c.isRequired ? '' : ' g-advisory';

  // p10–p90 expected-duration band: only when both bounds are known
  const hasBand = c.expectedLowSeconds != null && c.expectedHighSeconds != null;
  const barTitle = hasBand && c.expectedSeconds != null
    ? `expected ~${formatDur(c.expectedSeconds)} (p10 ${formatDur(c.expectedLowSeconds!)} – p90 ${formatDur(c.expectedHighSeconds!)})`
    : undefined;

  // full name always hoverable (names truncate); advisory keeps its annotation
  const nameTitle = c.isRequired ? c.name : `${c.name} — advisory, does not gate merging`;

  return (
    <li className={`g-row g-${kind}${extraClass}${advisoryClass}`}>
      <span className="g-name" title={nameTitle}>
        {c.url
          ? <a href={c.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{c.name}</a>
          : <span>{c.name}</span>}
        {c.regressed && (
          <span className="g-regress" role="img" aria-label="duration regression"
            title={regressTitle(c)}>↑</span>
        )}
      </span>
      <span className="g-bar" title={barTitle}>
        {hasBand && (() => {
          const lowPct = Math.min(100, (c.expectedLowSeconds! / scale) * 100);
          const highPct = Math.min(100, (c.expectedHighSeconds! / scale) * 100);
          return <span className="band" style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }} />;
        })()}
        <i style={{ width: `${fillPct}%` }} />
        {c.expectedSeconds != null && (() => {
          const pct = Math.min(100, (c.expectedSeconds / scale) * 100);
          return <span className="exp" style={{ left: pct >= 100 ? 'calc(100% - 2px)' : `${pct}%` }} />;
        })()}
      </span>
      <span className="g-t">{timeText(c, kind)}</span>
    </li>
  );
}

interface WorkflowGroup { name: string | null; checks: CheckView[] }

/**
 * Group checks by workflowName, preserving first-seen order within a rank:
 * workflows that carry required checks first (the rollup workflow — required
 * status is workflow-scoped server-side), then foreign workflows (inherently
 * advisory), with the null-workflow group last ('other checks': old data
 * without workflow identity).
 */
export function groupByWorkflow(checks: CheckView[]): WorkflowGroup[] {
  const order: (string | null)[] = [];
  const byName = new Map<string | null, CheckView[]>();
  for (const c of checks) {
    if (!byName.has(c.workflowName)) { byName.set(c.workflowName, []); order.push(c.workflowName); }
    byName.get(c.workflowName)!.push(c);
  }
  const rank = (g: WorkflowGroup) =>
    (g.checks.some((c) => c.isRequired) ? 0 : 2) + (g.name === null ? 1 : 0);
  return order.map((name) => ({ name, checks: byName.get(name)! }))
    .sort((a, b) => rank(a) - rank(b)); // stable: first-seen order within a rank
}

/** Expanded-panel check list as horizontal Gantt bars. Advisory checks render
 *  italic and muted (via the `.g-advisory` class on their row) to distinguish
 *  them from required checks without a section divider.
 *
 *  When checks span multiple workflows, rows group under a muted header per
 *  workflow (null last as 'other checks'); the required→advisory ordering is
 *  kept within the leading (rollup) workflow and foreign workflows render after
 *  the rollup workflow's rows. One shared time scale spans the whole panel.
 *  A single-workflow panel renders exactly as before (no headers). */
export function CheckGantt({ checks, stage }: {
  checks: CheckView[]; stage: string;
}) {
  const scale = ganttScale(checks);
  const groups = groupByWorkflow(checks);
  const grouped = groups.length > 1;
  return (
    <ul className="checks gantt">
      {groups.map((g, gi) => {
        const required = g.checks.filter((c) => c.isRequired);
        const advisory = g.checks.filter((c) => !c.isRequired);
        return (
          <Fragment key={`wf-${gi}`}>
            {grouped && <li className="divider g-workflow">{g.name ?? 'other checks'}</li>}
            {required.map((c, i) => <GanttRow key={`${c.name}-${i}`} c={c} scale={scale} />)}
            {advisory.map((c, i) => <GanttRow key={`${c.name}-${i}`} c={c} scale={scale} />)}
          </Fragment>
        );
      })}
    </ul>
  );
}
