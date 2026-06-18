// Pipeline section — the original PR pipeline view, ported into the unified
// workspace IA. Reuses the existing PrRow / QueueTrain / StatusStrip verbatim so
// the rich per-PR rows (stage, queue, checks, ready+auto-merge actions) and the
// status filter are identical to the classic dashboard; only the framing (focused
// repo first, no kiosk branch) is workspace-native. Data is the live Tier-1 state.
import { useState } from 'react';
import type { DashboardState, PrView } from '../../types';
import { PrRow } from '../../PrRow';
import { QueueTrain } from '../../QueueTrain';
import { StatusStrip, bucketPr, isActivePr, isFailedPr, type Bucket } from '../../StatusStrip';
import { splitCohort, deployBreakdown } from './ordering';
import { nextToMerge } from './queueFront';

/** Compact ETA like "~5m" / "~1h"; null when unknown. */
function eta(secs: number | null): string | null {
  if (secs == null) return null;
  return secs < 90 ? `~${Math.round(secs)}s` : secs < 5400 ? `~${Math.round(secs / 60)}m` : `~${Math.round(secs / 3600)}h`;
}


export function PipelineView({ state, focusedRepo }: { state: DashboardState | null; focusedRepo: string | null }) {
  const [activeFilter, setActiveFilter] = useState<Bucket | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openCohorts, setOpenCohorts] = useState<Set<string>>(new Set());

  if (!state) return <div className="pipeline-view" role="status">Loading pipeline…</div>;

  // focused repo first (stable otherwise) — the workspace's "current pipeline" lead
  const repos = [...state.repos].sort((a, b) => (a.repo === focusedRepo ? -1 : b.repo === focusedRepo ? 1 : 0));
  const allPrs = repos.flatMap((r) => r.prs);
  const toggle = (repo: string) => setCollapsed((p) => { const n = new Set(p); n.has(repo) ? n.delete(repo) : n.add(repo); return n; });
  const toggleCohort = (repo: string) => setOpenCohorts((p) => { const n = new Set(p); n.has(repo) ? n.delete(repo) : n.add(repo); return n; });
  const row = (pr: typeof allPrs[number], r: typeof repos[number]) => (
    <PrRow key={pr.number} pr={pr} hasDeploy={r.hasDeploy} queueCulprit={r.queue?.unmergeableCulprit ?? null} expandable />
  );

  return (
    <div className="pipeline-view">
      <StatusStrip prs={allPrs} activeFilter={activeFilter} onFilter={setActiveFilter} />
      {repos.map((r) => {
        const isCollapsed = collapsed.has(r.repo);
        const visiblePrs = activeFilter ? r.prs.filter((pr) => bucketPr(pr) === activeFilter) : r.prs;
        const hiddenCount = r.prs.length - visiblePrs.length;
        const activeCount = r.prs.filter(isActivePr).length;
        const failedCount = r.prs.filter(isFailedPr).length;
        return (
          <section key={r.repo}>
            <h2 className="repo-header">
              <button type="button" className="repo-header-btn" aria-expanded={!isCollapsed} onClick={() => toggle(r.repo)}>
                <span aria-hidden="true" className="repo-chevron">{isCollapsed ? '▸' : '▾'}</span>
                {r.repo}
                {!isCollapsed && hiddenCount > 0 && <span className="hidden-count"> ({hiddenCount} hidden)</span>}
                {isCollapsed && (
                  <span className="repo-summary">
                    <span className="repo-summary-prs">{r.prs.length} PRs</span>
                    {activeCount > 0 && <span className="repo-summary-active"> · {activeCount} active</span>}
                    {failedCount > 0 && <span className="repo-summary-failed"> · {failedCount} failed</span>}
                  </span>
                )}
              </button>
            </h2>
            {!isCollapsed && (() => {
              const { lead, cohort } = splitCohort(visiblePrs);
              const cohortOpen = openCohorts.has(r.repo);
              return (
                <>
                  <QueueTrain queue={r.queue} />
                  {r.deploy && (r.deploy.awaitingQa > 0 || r.deploy.awaitingProd > 0) && (
                    <p className="deploy-backlog" role="status" aria-label="Deploy backlog">
                      📦 Deploy backlog:{' '}
                      {[
                        r.deploy.awaitingQa > 0 ? `${r.deploy.awaitingQa} awaiting QA` : null,
                        r.deploy.awaitingProd > 0 ? `${r.deploy.awaitingProd} awaiting prod` : null,
                      ].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {(() => {
                    const next = nextToMerge(r.queue);
                    if (!next) return null;
                    const prs = next.prNumbers.map((n) => `#${n}`).join(', ');
                    const e = eta(next.etaSeconds);
                    return (
                      <p className="next-to-merge" role="status">
                        ⏭ Merges next: <strong>{prs}</strong>{' '}
                        {next.building ? `building${next.percent != null ? ` ${next.percent}%` : ''}` : 'front of queue'}
                        {e ? ` · ${e}` : ''}
                      </p>
                    );
                  })()}
                  {visiblePrs.length === 0 && hiddenCount === 0 && <p className="empty">no active PRs</p>}
                  {lead.map((pr) => row(pr, r))}
                  {cohort.length > 0 && (() => {
                    // Disjoint deploy stages — never lump awaiting-QA into "awaiting prod".
                    const { awaitingQa, awaitingProd } = deployBreakdown(cohort);
                    const parts = [
                      awaitingQa > 0 ? `${awaitingQa} awaiting QA` : null,
                      awaitingProd > 0 ? `${awaitingProd} awaiting prod` : null,
                    ].filter(Boolean);
                    const label = parts.length ? parts.join(' · ') : 'deploying';
                    return (
                      <div className="pipeline-cohort">
                        <button type="button" className="cohort-toggle" aria-expanded={cohortOpen} onClick={() => toggleCohort(r.repo)}>
                          <span aria-hidden="true">{cohortOpen ? '▾' : '▸'}</span> {cohort.length} merged · {label}
                        </button>
                        {cohortOpen && cohort.map((pr) => row(pr, r))}
                      </div>
                    );
                  })()}
                  {r.deploy?.chain && (r.deploy.chain.inFlight || r.deploy.chain.supersededCount > 0) && (
                    <p className="deploy-chain" role="status" aria-label="Deploy chain">
                      {r.deploy.chain.inFlight && (
                        <>⤴ Deploying <strong>#{r.deploy.chain.inFlight.prNumber}</strong> — at {r.deploy.chain.inFlight.stage}, flowing to prod</>
                      )}
                      {r.deploy.chain.supersededCount > 0 && (
                        <span className="deploy-superseded">
                          {r.deploy.chain.inFlight ? ' · ' : ''}
                          {r.deploy.chain.supersededCount} superseded (rolled into a newer deploy)
                        </span>
                      )}
                    </p>
                  )}
                </>
              );
            })()}
          </section>
        );
      })}
    </div>
  );
}
