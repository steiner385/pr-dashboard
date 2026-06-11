import { useCallback, useRef, useState } from 'react';
import { useDashboard } from './useDashboard';
import { PrRow } from './PrRow';
import { StatusStrip, bucketPr, type Bucket } from './StatusStrip';
import { QueueTrain } from './QueueTrain';
import { SettingsPanel } from './SettingsPanel';
import type { PrView } from './types';

// ---- localStorage helpers (private-mode safe) ----

const LS_KEY = 'prdash.collapsed';

function readCollapsedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed as string[]);
  } catch {
    // invalid JSON or storage access denied — return empty set
  }
  return new Set();
}

function writeCollapsedSet(set: Set<string>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...set]));
  } catch {
    // private-mode storage full — silently ignore
  }
}

// ---- active / failed classification for inline summary ----

function isActive(pr: PrView): boolean {
  const { stage } = pr.stage;
  return stage === 'ci' || stage === 'queue' || stage === 'qa-deploy';
}

function isFailed(pr: PrView): boolean {
  const { stage, substate } = pr.stage;
  return (stage === 'parked' && substate === 'ci-failed') ||
    (stage === 'queue' && substate === 'group-failed');
}

export function App() {
  const { state, connected } = useDashboard();
  const [activeFilter, setActiveFilter] = useState<Bucket | null>(null);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => readCollapsedSet());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);
  const handleSettingsClose = useCallback(() => setSettingsOpen(false), []);

  if (!state) return <main className="app"><p className="loading">Loading…</p></main>;

  // Collect all PrViews for the strip bucket counts.
  const allPrs = state.repos.flatMap((r) => r.prs);

  const toggleCollapsed = (repo: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) {
        next.delete(repo);
      } else {
        next.add(repo);
      }
      writeCollapsedSet(next);
      return next;
    });
  };

  return (
    <main className="app">
      <header>
        <h1>PR Pipeline</h1>
        {!connected && (
          <span className="stale disconnected">disconnected — retrying…</span>
        )}
        {state.staleSince && (
          <span className="stale">stale since {new Date(state.staleSince).toLocaleTimeString()}</span>
        )}
        {connected && (
          /* Driven by connection state: SSE suppresses unchanged frames, so a
             frozen "updated" stamp would read as staleness when the stream is
             actually live. The server keepalive re-emits at least every 60s. */
          <span className="generated">live · updated {new Date(state.generatedAt).toLocaleTimeString()}</span>
        )}
        <button
          type="button"
          ref={gearRef}
          className="settings-gear"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(true)}
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </header>
      <SettingsPanel
        open={settingsOpen}
        onClose={handleSettingsClose}
        returnFocusRef={gearRef}
        connected={connected}
      />
      <StatusStrip prs={allPrs} activeFilter={activeFilter} onFilter={setActiveFilter} />
      {state.repos.map((r) => {
        const isCollapsed = collapsedRepos.has(r.repo);
        const visiblePrs = activeFilter
          ? r.prs.filter((pr) => bucketPr(pr) === activeFilter)
          : r.prs;
        const hiddenCount = r.prs.length - visiblePrs.length;

        // Inline summary counts (computed over ALL prs in the repo, regardless of filter)
        const activeCount = r.prs.filter(isActive).length;
        const failedCount = r.prs.filter(isFailed).length;

        return (
          <section key={r.repo}>
            <button
              type="button"
              className="repo-header-btn"
              aria-expanded={!isCollapsed}
              onClick={() => toggleCollapsed(r.repo)}
            >
              <span aria-hidden="true" className="repo-chevron">
                {isCollapsed ? '▸' : '▾'}
              </span>
              {r.repo}
              {!isCollapsed && hiddenCount > 0 && (
                <span className="hidden-count"> ({hiddenCount} hidden)</span>
              )}
              {isCollapsed && (
                <span className="repo-summary">
                  <span className="repo-summary-prs">{r.prs.length} PRs</span>
                  {activeCount > 0 && (
                    <span className="repo-summary-active"> · {activeCount} active</span>
                  )}
                  {failedCount > 0 && (
                    <span className="repo-summary-failed"> · {failedCount} failed</span>
                  )}
                </span>
              )}
            </button>
            {!isCollapsed && (
              <>
                <QueueTrain queue={r.queue} />
                {visiblePrs.length === 0 && hiddenCount === 0 && <p className="empty">no active PRs</p>}
                {visiblePrs.map((pr) => (
                  <PrRow key={pr.number} pr={pr} hasDeploy={r.hasDeploy} accuracy={r.accuracy}
                    queueCulprit={r.queue?.unmergeableCulprit ?? null} />
                ))}
              </>
            )}
          </section>
        );
      })}
    </main>
  );
}
