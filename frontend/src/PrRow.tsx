import { useState, type MouseEvent, type KeyboardEvent } from 'react';
import type { PrView } from './types';
import { formatDur, formatEta, stageLabel } from './format';
import { MetroTrack } from './MetroTrack';
import { CheckGantt } from './CheckGantt';
import { Waterfall, waterfallSegments } from './Waterfall';
import { DEFS, defTitle, subLineTitle } from './definitions';

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
    if (s.substate === 'group-failed') parts.push(stageLabel(s.stage, s.substate)); // canonical label — no drift vs format.ts
    // queue percent always tracks the merge-group build, never head-commit checks —
    // label it so the sub line can't be misread against the PR-checks panel
    if (s.percent != null) parts.push(`group ${s.percent}%`);
    if (pr.queueAheadCount != null && pr.queueAheadCount > 0) parts.push(`behind ${pr.queueAheadCount}`);
    return parts.length ? parts.join(' · ') : null;
  }
  if (s.stage === 'ci') {
    const parts: string[] = [];
    if (s.substate === 'retrying') parts.push(stageLabel(s.stage, s.substate)); // canonical label — no drift vs format.ts
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

/** Check conclusions that count as "already failed" for the ready+auto-merge
 *  gate. NEUTRAL/SKIPPED/SUCCESS are not failures; null = still running. */
const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/**
 * Decide whether the "Ready + auto-merge" button shows for this PR, and whether
 * it's blocked. Per product decision (drafts, disabled-when-blocked):
 *   - show ONLY on draft PRs (stage parked / substate 'draft')
 *   - block (disable) when the PR conflicts with base (mergeStateStatus DIRTY)
 *     or a required check has ALREADY concluded as a failure
 * Arming auto-merge on a still-running draft is safe — GitHub waits for green —
 * so a draft with checks in flight is shown enabled.
 */
export function readyMergeGate(pr: PrView): { show: boolean; blocked: boolean; reason: string } {
  const isDraft = pr.stage.stage === 'parked' && pr.stage.substate === 'draft';
  if (!isDraft) return { show: false, blocked: false, reason: '' };
  if (pr.mergeStateStatus === 'DIRTY') {
    return { show: true, blocked: true, reason: 'conflicts with base — rebase before it can merge' };
  }
  const failing = pr.checks.find(
    (c) => c.isRequired && c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion));
  if (failing) {
    return { show: true, blocked: true, reason: `required check failing (${failing.name}) — fix before arming` };
  }
  return { show: true, blocked: false, reason: '' };
}

export function PrRow({ pr, hasDeploy, queueCulprit = null, expandable = true }: {
  pr: PrView; hasDeploy: boolean;
  /** Repo-level RepoQueueView.unmergeableCulprit (queue-blocked sub line). */
  queueCulprit?: number | null;
  /** false in kiosk mode (issue #20): row is read-only — no expand-on-click. */
  expandable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionResult, setActionResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const gate = readyMergeGate(pr);

  async function onReadyMerge(e: MouseEvent) {
    e.stopPropagation();
    if (busy || gate.blocked) return;
    setBusy(true);
    setActionResult(null);
    try {
      const res = await fetch('/api/pr/ready-merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: pr.repo, number: pr.number }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        setActionResult({ ok: false, msg: String(data.error ?? `HTTP ${res.status}`) });
        return;
      }
      const parts: string[] = [];
      if (data.markedReady) parts.push('marked ready');
      if (data.cleanReadyToMerge) parts.push('mergeable now — merge it directly');
      else if (data.alreadyArmed) parts.push('auto-merge already armed');
      else if (data.autoMergeArmed) parts.push('auto-merge armed');
      setActionResult({ ok: true, msg: parts.join(' · ') || 'done' });
    } catch (err) {
      setActionResult({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

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
      {/* Keyboard-operable expand toggle (UX-H1). role="button" rather than a
          real <button> because the row nests interactive children (title link,
          ready-merge action) which a <button> can't legally contain. */}
      <div className="pr-main"
        {...(expandable ? {
          role: 'button' as const,
          tabIndex: 0,
          'aria-expanded': open,
          'aria-label': `${open ? 'Collapse' : 'Expand'} PR #${pr.number} details`,
          onClick: () => setOpen(!open),
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); }
          },
        } : {})}>
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
        {/* ready+auto-merge action (drafts only; disabled when conflicting or a
            required check has already failed). Own click-guarded row so it never
            toggles the expand panel. */}
        {expandable && gate.show && (
          <div className="pr-actions" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="pr-ready-merge" data-testid="pr-ready-merge"
              disabled={busy || gate.blocked}
              title={gate.blocked ? gate.reason : 'Mark this draft ready for review and arm auto-merge (squash)'}
              onClick={onReadyMerge}>
              {busy ? 'arming…' : 'Ready + auto-merge'}
            </button>
            {gate.blocked && <span className="pr-action-blocked">{gate.reason}</span>}
            {actionResult && (
              <span className={`pr-action-msg ${actionResult.ok ? 'ok' : 'err'}`}
                data-testid="pr-action-msg">
                {/* glyph + text prefix so success/failure isn't conveyed by colour
                    alone (UX-L4) */}
                <span aria-hidden="true">{actionResult.ok ? '✓ ' : '✗ '}</span>
                {actionResult.ok ? '' : 'Error: '}{actionResult.msg}
              </span>
            )}
          </div>
        )}
      </div>
      {/* PR-level CI cost (cost explorer): the current head's runner-minutes
          (running checks count started→now), priced when rates are configured —
          minutes-only otherwise. Hidden entirely when no check has started. */}
      {open && pr.costMinutes != null && (
        <div className="check-sections pr-cost" data-testid="pr-cost"
          title={defTitle(DEFS.prCiCost)}>
          CI cost this run: {formatDur(pr.costMinutes * 60)}
          {pr.costDollars != null
            ? ` (~$${pr.costDollars.toFixed(2)})${pr.costDollarsPartial ? ' (partial)' : ''}`
            : ''}
        </div>
      )}
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
