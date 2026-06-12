import { useState } from 'react';
import type { PrView } from './types';
import { formatDur, formatEta, stageLabel } from './format';
import { MetroTrack } from './MetroTrack';
import { CheckGantt } from './CheckGantt';
import { Waterfall, waterfallSegments } from './Waterfall';
import { subLineTitle } from './definitions';

/** Muted one-line status under the track: percent + active-check for ci,
 *  substate reason for parked, group/position info for queue.
 *  @param queueCulprit lowest-position genuinely-conflicting queue entry (from
 *  RepoQueueView.unmergeableCulprit) — named in the queue-blocked sub line. */
function subLine(pr: PrView, queueCulprit: number | null): string | null {
  const s = pr.stage;
  if (s.stage === 'parked') return stageLabel(s.stage, s.substate);
  if (s.stage === 'queue') {
    // genuinely conflicting with the base — facing ejection, rebase required
    if (s.substate === 'unmergeable') return 'unmergeable — needs rebase before it can merge';
    // cascade victim: a conflicting entry ahead poisons its speculative merge —
    // rebasing would NOT help; it revalidates once the culprit is ejected.
    // (Suffix dropped when the culprit is this PR itself — the presumed-culprit
    // fallback when no snapshot proves DIRTY.)
    if (s.substate === 'queue-blocked') {
      const suffix = queueCulprit != null && queueCulprit !== pr.number
        ? ` (#${queueCulprit})` : '';
      return `queue blocked — conflict ahead${suffix}`;
    }
    const parts: string[] = [];
    if (s.substate === 'group-failed') parts.push('Queue group failed');
    // queue percent always tracks the merge-group build, never head-commit checks —
    // label it so the sub line can't be misread against the PR-checks panel
    if (s.percent != null) parts.push(`group ${s.percent}%`);
    if (pr.queueAheadCount != null && pr.queueAheadCount > 0) parts.push(`behind ${pr.queueAheadCount}`);
    return parts.length ? parts.join(' · ') : null;
  }
  if (s.stage === 'ci') {
    const parts: string[] = [];
    if (s.substate === 'retrying') parts.push('CI retrying');
    if (s.percent != null) parts.push(`${s.percent}%`);
    const running = pr.checks
      .filter((c) => c.isRequired && c.status !== 'COMPLETED' && c.elapsedSeconds != null)
      .sort((a, b) => (b.elapsedSeconds ?? 0) - (a.elapsedSeconds ?? 0))[0];
    if (running) {
      const expected = running.expectedSeconds != null ? ` of ~${formatDur(running.expectedSeconds)}` : '';
      parts.push(`${running.name} running ${formatDur(running.elapsedSeconds!)}${expected}`);
    } else {
      // No required check is IN_PROGRESS — check if any are waiting for a runner
      const runnerWaits = pr.checks.filter(
        (c) => c.isRequired && c.waitKind === 'runner',
      );
      if (runnerWaits.length > 0) {
        // Drop percent from parts (runner-wait replaces the normal ci sub line)
        parts.length = 0;
        const maxExpected = runnerWaits.reduce<number | null>(
          (acc, c) => c.expectedRunnerWaitSeconds != null
            ? Math.max(acc ?? 0, c.expectedRunnerWaitSeconds)
            : acc,
          null,
        );
        const typical = maxExpected != null ? ` · typical ~${formatDur(maxExpected)}` : '';
        return `waiting for runners (${runnerWaits.length} jobs)${typical}`;
      }
    }
    return parts.length ? parts.join(' · ') : null;
  }
  return stageLabel(s.stage, s.substate);
}

export function PrRow({ pr, hasDeploy, queueCulprit = null, expandable = true }: {
  pr: PrView; hasDeploy: boolean;
  /** Repo-level RepoQueueView.unmergeableCulprit (queue-blocked sub line). */
  queueCulprit?: number | null;
  /** false in kiosk mode (issue #20): row is read-only — no expand-on-click. */
  expandable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const s = pr.stage;
  const parked = s.stage === 'parked';
  const eta = formatEta(s.etaSeconds, s.etaRangeSeconds, s.overdue);
  // multi-train merge ETA (issue #40): waiting queue entries show the p50/p90
  // pair instead of the single-number stage ETA (queueAheadCount stays in the
  // sub line); everything else keeps the existing chip.
  const sim = s.stage === 'queue' ? pr.mergeEtaSim ?? null : null;
  const sub = subLine(pr, queueCulprit);
  return (
    <div id={`pr-${pr.number}`} className={`pr-row ${parked ? `parked ${s.substate ?? ''}` : ''}`}>
      <div className="pr-main" onClick={expandable ? () => setOpen(!open) : undefined}>
        <div className="pr-head">
          <span className="pr-num">#{pr.number}</span>
          <a className="pr-title" href={pr.url} target="_blank" rel="noreferrer"
            onClick={(e) => e.stopPropagation()}>{pr.title}</a>
          {pr.touchesWorkflows && (
            /* workflow-change badge (issue #49): the PR edits .github/workflows/** —
               summary lines (when a derived-graph diff exists) ride the tooltip */
            <span className="ci-change-badge"
              title={pr.workflowImpact?.summary.join('\n')
                ?? 'touches .github/workflows — CI behavior may change'}>
              ⚙ CI change
            </span>
          )}
          {sim ? (
            <span className="eta eta-sim"
              title={`merges in ~${formatDur(sim.p50Secs)} (p50) / ~${formatDur(sim.p90Secs)} (p90${sim.assumesEjects ? ', assumes ≤1 eject' : ''}); ${sim.trainsAhead} train${sim.trainsAhead === 1 ? '' : 's'} ahead`}>
              ~{formatDur(sim.p50Secs)} / ~{formatDur(sim.p90Secs)} p90
            </span>
          ) : (
            eta && <span className={`eta ${s.overdue ? 'overdue' : ''}`}>{eta}</span>
          )}
        </div>
        <MetroTrack stage={s} hasDeploy={hasDeploy} />
        {/* sub-line vocabulary tooltips (issue #66): the definitions of every
            recognized term in the line, from the shared SUBLINE_TERMS map */}
        {sub && <div className="sub" title={subLineTitle(sub)}>{sub}</div>}
      </div>
      {/* workflow-change impact card (issue #49): derived-graph diff summary,
          above the gantt in the expanded panel. */}
      {open && pr.workflowImpact && pr.workflowImpact.summary.length > 0 && (
        <div className="check-sections workflow-impact" data-testid="workflow-impact">
          <div className="panel-label">CI workflow change</div>
          <ul className="workflow-impact-lines">
            {pr.workflowImpact.summary.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      )}
      {/* per-PR waterfall (issue #50): merged PRs carry the spine timeline —
          rendered above any check panels; omitted when no segment has both
          endpoint timestamps (Waterfall itself returns null then, but the
          label must not render either). */}
      {open && pr.timeline && waterfallSegments(pr.timeline).length > 0 && (
        <div className="check-sections waterfall-section">
          <div className="panel-label">where did the time go</div>
          <Waterfall timeline={pr.timeline} />
        </div>
      )}
      {open && pr.groupChecks && pr.groupChecks.length > 0 ? (
        /* Queued PR: the merge-group build (the run driving the stage ETA) gets
           its own labeled section, head-commit PR checks render below it. */
        <div className="check-sections">
          <div className="panel-label">merge group build</div>
          <CheckGantt checks={pr.groupChecks} stage={s.stage} />
          {pr.checks.length > 0 && (
            <>
              <div className="panel-label">PR checks (head commit)</div>
              <CheckGantt checks={pr.checks} stage={s.stage} />
            </>
          )}
        </div>
      ) : (open && pr.checks.length > 0 && (
        <CheckGantt checks={pr.checks} stage={s.stage} />
      ))}
    </div>
  );
}
