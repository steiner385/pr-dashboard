// Tune & Investigate section (spec 001, US5). Budgets/quota gauges (J3), policy
// violations (I2), closed-loop outcomes (H), and the changelog + action audit (L).
// Each panel loads independently and is advisory (FR-022) — and now each renders an
// explicit loading / empty / error state so an empty-but-healthy pipeline never shows
// a void (roadmap 1.1). API injected.
import { useEffect, useState, type ReactNode } from 'react';
import type { WorkspaceApi, BudgetsDto, PolicyDto, OutcomesDto, ChangelogDto } from '../../shell/workspaceApi';
import { stripCheckTemplate } from '../../protectionModel';

type Loadable<T> = { status: 'loading' } | { status: 'error' } | { status: 'ok'; data: T };

/** Load a value into a Loadable, mapping a rejection to the error state. */
function useLoadable<T>(load: (() => Promise<T>) | null, deps: unknown[]): Loadable<T> {
  const [v, setV] = useState<Loadable<T>>({ status: 'loading' });
  useEffect(() => {
    if (!load) { setV({ status: 'loading' }); return; }
    let cancelled = false;
    setV({ status: 'loading' });
    load().then((data) => { if (!cancelled) setV({ status: 'ok', data }); })
      .catch(() => { if (!cancelled) setV({ status: 'error' }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return v;
}

/** A panel that always renders its labelled region, with loading / error / empty /
 *  content states — never a silent void. `isEmpty` decides the empty state. */
function Panel<T>({ label, title, value, isEmpty, empty, children }: {
  label: string; title: string; value: Loadable<T>;
  isEmpty: (d: T) => boolean; empty: string; children: (d: T) => ReactNode;
}) {
  return (
    <section className="tune-panel" aria-label={label}>
      <h3>{title}</h3>
      {value.status === 'loading' && <p className="tune-loading" role="status">Loading…</p>}
      {value.status === 'error' && <p className="tune-error" role="status">Couldn’t load — the provider may be offline.</p>}
      {value.status === 'ok' && (isEmpty(value.data)
        ? <p className="tune-empty">{empty}</p>
        : children(value.data))}
    </section>
  );
}

export function TuneView({ repo, api }: { repo: string | null; api: WorkspaceApi }) {
  const budgets = useLoadable<BudgetsDto>(() => api.budgets(), [api]);
  const policy = useLoadable<PolicyDto>(repo ? () => api.policy(repo) : null, [repo, api]);
  const outcomes = useLoadable<OutcomesDto>(repo ? () => api.outcomes(repo) : null, [repo, api]);
  const log = useLoadable<ChangelogDto>(repo ? () => api.changelog(repo) : null, [repo, api]);

  return (
    <div className="tune-view">
      {/* #184: section heading + tab label are owned by InsightsView's two-tab
          layout now; the stale "Tune & Investigate" h2 is removed. */}
      <Panel label="Budgets" title="Budgets" value={budgets}
        isEmpty={(d) => d.gauges.length === 0} empty="No budget breaches in this window ✓">
        {(d) => (
          <ul role="list">
            {d.gauges.map((g) => (
              <li key={g.kind} className={`budget-gauge state-${g.state}`}>
                <span className="budget-kind">{g.kind}</span>
                <span className="budget-value">{g.current}{g.unit ? ` ${g.unit}` : ''} / {g.threshold} ({Math.round(g.fractionUsed * 100)}%)</span>
                <span className="budget-state" aria-hidden="true">{g.state === 'breach' ? '⛔' : g.state === 'warn' ? '⚠' : '✓'}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {!repo ? (
        <p className="tune-hint">Select a pipeline to see its policy, outcomes, and changelog.</p>
      ) : (
        <>
          <Panel label="Policy" title="Policy" value={policy}
            isEmpty={(d) => d.violations.length === 0} empty="No policy violations ✓">
            {(d) => <ul role="list">{d.violations.map((v, i) => <li key={i}><strong>{stripCheckTemplate(v.check)}</strong>: {v.detail}</li>)}</ul>}
          </Panel>

          <Panel label="Outcomes" title="Applied-change outcomes" value={outcomes}
            isEmpty={(d) => d.outcomes.length === 0} empty="No applied-change outcomes yet — apply a change to start the closed loop.">
            {(d) => (
              <>
                <p className="outcomes-accuracy">{Math.round(d.accuracy.meanCostAccuracy * 100)}% mean accuracy{d.accuracy.recommenderUsable ? '' : ' (advisory)'}</p>
                <ul role="list">
                  {d.outcomes.map((o) => (
                    <li key={o.prNumber} className={`outcome conf-${o.confidence}`}>
                      #{o.prNumber} {stripCheckTemplate(o.check)}: {Math.round(o.costAccuracy * 100)}% accurate {o.directionCorrect ? '✓' : '✗ wrong direction'} <em>[{o.confidence}]</em>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>

          <Panel label="Changelog and audit" title="Changelog & audit" value={log}
            isEmpty={(d) => d.changelog.length === 0 && d.audit.length === 0} empty="No config changes or tool actions recorded in this window.">
            {(d) => (
              <ul role="list">
                {d.changelog.map((c, i) => <li key={`c${i}`} className="changelog-entry">{c.at.slice(0, 10)} · {c.summary} <em>({c.actor})</em></li>)}
                {d.audit.map((a, i) => <li key={`a${i}`} className="audit-entry">{a.at.slice(0, 10)} · tool {a.action} {a.target ?? ''} {a.result ? `→ ${a.result}` : ''}</li>)}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
