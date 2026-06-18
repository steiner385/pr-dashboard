// Diagnose section (spec 001, US2 / FR-009): drill from a PR to the exact blocking
// check without leaving its context. Lists open PRs (focused-repo first) and, for
// the selected PR, surfaces the blocker + the per-check Gantt (the existing
// CheckGantt, re-delivered under the new IA). Pure blocker helper + thin view.
import { useEffect, useMemo, useState } from 'react';
import type { DashboardState, PrView, CheckView } from '../../types';
import type { WorkspaceApi } from '../../shell/workspaceApi';
import { CheckGantt } from '../../CheckGantt';
import { clusterFailures } from './clustering';
import { queueIncidents } from './incidents';
import { remediationProposals } from './remediation';

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);

/** The check holding a PR up: first failed required check, else first still-running,
 *  else null (nothing blocking). Pure + testable. */
export function blockingCheck(pr: PrView): { check: CheckView; why: 'failed' | 'running'; flaky: boolean } | null {
  // Rank failures so a REAL failure outranks a known-flaky one (roadmap 5.5 / the
  // CI-CD review): a flaky required check shouldn't be named the blocker while a
  // real failure sits below it. Score = real(2) + required(1); flaky is labelled.
  const failed = pr.checks.filter((c) => c.conclusion != null && FAILED.has(c.conclusion));
  if (failed.length) {
    const score = (c: CheckView) => (c.likelyFlake ? 0 : 2) + (c.isRequired ? 1 : 0);
    const best = failed.reduce((a, b) => (score(b) > score(a) ? b : a));
    return { check: best, why: 'failed', flaky: !!best.likelyFlake };
  }
  const running = pr.checks.find((c) => c.isRequired && c.status !== 'completed')
    ?? pr.checks.find((c) => c.status !== 'completed');
  if (running) return { check: running, why: 'running', flaky: false };
  return null;
}

/** All open PRs, focused repo first. */
export function prsForDiagnose(state: DashboardState, focusedRepo?: string | null): PrView[] {
  const flat = state.repos.flatMap((r) => r.prs);
  return focusedRepo ? [...flat].sort((a, b) => (a.repo === focusedRepo ? -1 : b.repo === focusedRepo ? 1 : 0)) : flat;
}

export interface DiagnoseViewProps { state: DashboardState; focusedRepo?: string | null; api?: WorkspaceApi }

export function DiagnoseView({ state, focusedRepo, api }: DiagnoseViewProps) {
  const prs = useMemo(() => prsForDiagnose(state, focusedRepo), [state, focusedRepo]);
  const clusters = useMemo(() => clusterFailures(state, 3), [state]);
  const incidents = useMemo(() => queueIncidents(state), [state]);

  // Already-quarantined checks (roadmap 4.5) — fetched for the focused repo so the
  // remediation composer doesn't re-propose a flake that's already in quarantine.
  const [quarantined, setQuarantined] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!api || !focusedRepo) { setQuarantined(new Set()); return; }
    let cancelled = false;
    api.quarantines(focusedRepo)
      .then((r) => { if (!cancelled) setQuarantined(new Set(r.quarantines.map((q) => q.check))); })
      .catch(() => { if (!cancelled) setQuarantined(new Set()); });
    return () => { cancelled = true; };
  }, [api, focusedRepo]);

  const remediations = useMemo(() => remediationProposals(state, 2, quarantined), [state, quarantined]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const key = (p: PrView) => `${p.repo}#${p.number}`;
  const selected = prs.find((p) => key(p) === selectedKey) ?? prs[0] ?? null;
  const blocker = selected ? blockingCheck(selected) : null;

  return (
    <div className="diagnose-view">
      {remediations.length > 0 && (
        <section className="remediation-proposals" aria-label="Auto-remediation proposals">
          <strong>🛠 Remediation proposals</strong> — flaky required gates blocking merges:
          <ul role="list">
            {remediations.map((p) => (
              <li key={p.check} className="remediation-proposal">
                <p className="remediation-rationale">{p.rationale}</p>
                <p className="remediation-action">→ {p.action} <span className="remediation-where">Apply in Model &amp; Edit → Optimize → quarantine {p.check}.</span></p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {incidents.length > 0 && (
        <section className="queue-incidents" role="status" aria-label="Queue incidents">
          <strong>🚑 Queue stalled</strong> — guided recovery:
          {incidents.map((inc) => (
            <div key={inc.repo} className="queue-incident">
              <span className="incident-repo">{inc.repo}</span>
              <ol>{inc.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </div>
          ))}
        </section>
      )}
      {clusters.length > 0 && (
        <section className="failure-clusters" role="status" aria-label="Failure clusters">
          <strong>⚠ Systemic failures</strong> — likely one incident, not {clusters.reduce((n, c) => n + c.prCount, 0)} separate problems:
          <ul role="list">
            {clusters.map((c) => (
              <li key={c.check} className="failure-cluster">
                <span className="cluster-check">{c.check}</span> failing on <strong>{c.prCount} PRs</strong>
                {c.repos.length > 1 ? ` across ${c.repos.length} repos` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className="diagnose-pr-list" role="list" aria-label="Open pull requests">
        {prs.map((p) => (
          <li key={key(p)} className={selected && key(p) === key(selected) ? 'diagnose-pr active' : 'diagnose-pr'}>
            <button type="button" className="diagnose-pr-btn"
              aria-current={selected && key(p) === key(selected) ? 'true' : undefined}
              aria-label={`${p.repo} #${p.number} ${p.title}`}
              onClick={() => setSelectedKey(key(p))}>
              <span className="diagnose-pr-repo">{p.repo}</span> #{p.number} {p.title}
            </button>
          </li>
        ))}
        {prs.length === 0 && <li className="diagnose-pr empty">No open PRs.</li>}
      </ul>
      {selected && (
        <section className="diagnose-detail" aria-label={`PR #${selected.number} detail`}>
          <p className="diagnose-blocker" role="status">
            {blocker
              ? `Blocked by ${blocker.check.name} (${blocker.why === 'failed' ? (blocker.flaky ? 'failed — likely FLAKE' : 'failed') : 'still running'})`
              : 'Nothing blocking — all checks green.'}
          </p>
          <CheckGantt checks={selected.checks} stage={selected.stage.stage} />
        </section>
      )}
    </div>
  );
}
