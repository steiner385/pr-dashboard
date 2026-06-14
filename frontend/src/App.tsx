import { useCallback, useEffect, useRef, useState } from 'react';
import { useDashboard } from './useDashboard';
import { readKioskConfig } from './kiosk';
import { PrRow } from './PrRow';
import { StatusStrip, bucketPr, type Bucket } from './StatusStrip';
import { QueueTrain } from './QueueTrain';
import { SettingsPanel } from './SettingsPanel';
import { LegendPanel } from './LegendPanel';
import { MetricsView } from './MetricsView';
import { DeliverySpine } from './spine/DeliverySpine';
import { HealthHeader } from './HealthHeader';
import { ErrorBoundary } from './ErrorBoundary';
import { scrollBehavior } from './motion';
import type { PrView } from './types';

type TabId = 'delivery' | 'pipeline' | 'metrics';

// ---- tab ↔ URL hash (#pipeline / #delivery / #metrics) ----
// Each tab is linkable, bookmarkable, and survives a reload; back/forward step
// through tabs via the hashchange listener in App.
const TAB_IDS: readonly TabId[] = ['pipeline', 'delivery', 'metrics'];
const DEFAULT_TAB: TabId = 'pipeline';
function tabFromHash(): TabId | null {
  const h = (typeof window !== 'undefined' ? window.location.hash : '').replace(/^#/, '');
  return (TAB_IDS as readonly string[]).includes(h) ? (h as TabId) : null;
}

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
  const { state, connected, notifySupported, notifyEnabled, toggleNotify } = useDashboard();
  const [activeFilter, setActiveFilter] = useState<Bucket | null>(null);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => readCollapsedSet());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Initial tab comes from the URL hash so a deep link / reload lands on it.
  const [tab, setTab] = useState<TabId>(() => tabFromHash() ?? DEFAULT_TAB);
  // Mount the Delivery spine lazily (first visit) and keep it mounted, like
  // MetricsView — Pipeline is the default tab so the spine isn't built up front.
  // Seed the visited flag when the deep link opens straight onto that tab.
  const [deliveryVisited, setDeliveryVisited] = useState(() => tabFromHash() === 'delivery');
  // Mount MetricsView lazily (first visit) and keep it mounted afterwards, so
  // switching tabs doesn't refetch; the panel divs always exist in the DOM so
  // every aria-controls id resolves.
  const [metricsVisited, setMetricsVisited] = useState(() => tabFromHash() === 'metrics');
  const gearRef = useRef<HTMLButtonElement>(null);
  const handleSettingsClose = useCallback(() => setSettingsOpen(false), []);
  const [legendOpen, setLegendOpen] = useState(false);
  const legendRef = useRef<HTMLButtonElement>(null);
  const handleLegendClose = useCallback(() => setLegendOpen(false), []);

  // ---- kiosk mode (issue #20): read-only wall-display view + auto-cycle ----
  // URL params are read once at mount; a wall display reloads to change them.
  const [{ kiosk, cycleSeconds }] = useState(readKioskConfig);
  const [cycleTick, setCycleTick] = useState(0);
  const repoCount = state?.repos.length ?? 0;

  useEffect(() => {
    if (!kiosk) return;
    const id = window.setInterval(() => {
      if (document.hidden) return; // paused while the tab is not visible
      setCycleTick((t) => t + 1);
    }, cycleSeconds * 1000);
    return () => window.clearInterval(id);
  }, [kiosk, cycleSeconds]);

  // Kiosk pins the Delivery spine (spec §17): the wall display shows the
  // lifecycle rail read-only, with no tab rotation.
  useEffect(() => {
    if (!kiosk || repoCount === 0) return;
    setDeliveryVisited(true);
    setTab('delivery');
  }, [kiosk, cycleTick, repoCount]);

  // Switch tabs and keep the lazy-mount flags in sync (single entry point so the
  // hash listener and the buttons can't drift).
  const selectTab = useCallback((next: TabId) => {
    setTab(next);
    if (next === 'delivery') setDeliveryVisited(true);
    if (next === 'metrics') setMetricsVisited(true);
  }, []);

  // Global health header → detail: open the Delivery tab and bring the lane into
  // view once it's mounted (rAF, after the panel commits this render).
  const jumpToLane = useCallback((laneId: string | null) => {
    selectTab('delivery');
    if (!laneId) return;
    requestAnimationFrame(() => {
      document.getElementById(`spine-lane-${laneId}`)
        ?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'start' });
    });
  }, [selectTab]);

  // Reflect the active tab in the URL hash (history entry per switch, so
  // back/forward steps through tabs). Skip in kiosk — it pins one view and uses
  // query params, not anchors. pushState doesn't fire hashchange, so this never
  // loops with the listener below. The first run is skipped so a bare URL stays
  // the canonical default (no spurious #pipeline / history entry on load); a deep
  // link already matches `tab`, so it writes nothing either.
  const hashWritten = useRef(false);
  useEffect(() => {
    if (kiosk) return;
    if (!hashWritten.current) { hashWritten.current = true; return; }
    if (tabFromHash() !== tab) window.history.pushState(null, '', `#${tab}`);
  }, [tab, kiosk]);

  // Deep links, manual edits, and back/forward all arrive as hashchange.
  useEffect(() => {
    if (kiosk) return;
    const onHash = () => selectTab(tabFromHash() ?? DEFAULT_TAB);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [kiosk, selectTab]);

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
    <main className={kiosk ? 'app kiosk' : 'app'}>
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
        {!kiosk && (
        <>
        <button
          type="button"
          ref={legendRef}
          className="legend-btn"
          aria-label="Legend"
          title="Legend — what every shape, color, and term on the board means"
          aria-haspopup="dialog"
          aria-expanded={legendOpen}
          onClick={() => setLegendOpen(true)}
        >
          <span aria-hidden="true">?</span>
        </button>
        {notifySupported && (
          <button
            type="button"
            className="notify-bell"
            aria-pressed={notifyEnabled}
            aria-label="Browser notifications (this tab)"
            title={notifyEnabled
              ? 'Browser notifications on (this tab only — tab must stay open). Desktop command notifications are toggled in Settings.'
              : 'Enable browser notifications (this tab only — tab must stay open). Desktop command notifications are toggled in Settings.'}
            onClick={toggleNotify}
          >
            <span aria-hidden="true">{notifyEnabled ? '🔔' : '🔕'}</span>
          </button>
        )}
        <button
          type="button"
          ref={gearRef}
          className="settings-gear"
          aria-label="Settings"
          title="Settings — watched repos, tuning, notifications, per-repo config"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(true)}
        >
          <span aria-hidden="true">⚙</span>
        </button>
        </>
        )}
      </header>
      {!kiosk && (
      <>
      <SettingsPanel
        open={settingsOpen}
        onClose={handleSettingsClose}
        returnFocusRef={gearRef}
        connected={connected}
      />
      <LegendPanel
        open={legendOpen}
        onClose={handleLegendClose}
        returnFocusRef={legendRef}
      />
      <ErrorBoundary>
        <HealthHeader state={state} onJumpToLane={jumpToLane} />
      </ErrorBoundary>
      <nav className="tab-bar" role="tablist" aria-label="Dashboard views">
        <button type="button" role="tab" id="tab-pipeline"
          aria-selected={tab === 'pipeline'} aria-controls="tabpanel-pipeline"
          className={tab === 'pipeline' ? 'tab active' : 'tab'}
          onClick={() => selectTab('pipeline')}>
          Pipeline
        </button>
        <button type="button" role="tab" id="tab-delivery"
          aria-selected={tab === 'delivery'} aria-controls="tabpanel-delivery"
          className={tab === 'delivery' ? 'tab active' : 'tab'}
          onClick={() => selectTab('delivery')}>
          Delivery
        </button>
        <button type="button" role="tab" id="tab-metrics"
          aria-selected={tab === 'metrics'} aria-controls="tabpanel-metrics"
          className={tab === 'metrics' ? 'tab active' : 'tab'}
          onClick={() => selectTab('metrics')}>
          Metrics
        </button>
      </nav>
      </>
      )}
      {/* in kiosk the tab bar is gone, so the panels drop the tabpanel role —
          every aria-labelledby/aria-controls must resolve to a real node */}
      <div id="tabpanel-delivery" hidden={tab !== 'delivery'}
        {...(kiosk ? {} : { role: 'tabpanel', 'aria-labelledby': 'tab-delivery' })}>
        <ErrorBoundary>
          {deliveryVisited && <DeliverySpine state={state} kiosk={kiosk} />}
        </ErrorBoundary>
      </div>
      <div id="tabpanel-metrics" hidden={tab !== 'metrics'}
        {...(kiosk ? {} : { role: 'tabpanel', 'aria-labelledby': 'tab-metrics' })}>
        {/* one boundary instance per tab: a render crash in one panel must
            not white-screen the other */}
        <ErrorBoundary>
          {metricsVisited && <MetricsView />}
        </ErrorBoundary>
      </div>
      <div id="tabpanel-pipeline" hidden={tab !== 'pipeline'}
        {...(kiosk ? {} : { role: 'tabpanel', 'aria-labelledby': 'tab-pipeline' })}>
      <ErrorBoundary>
      <StatusStrip prs={allPrs} activeFilter={activeFilter} onFilter={setActiveFilter}
        interactive={!kiosk} />
      {state.repos.map((r, i) => {
        // kiosk ignores persisted collapse — a wall display must show rows
        const isCollapsed = !kiosk && collapsedRepos.has(r.repo);
        const visiblePrs = activeFilter
          ? r.prs.filter((pr) => bucketPr(pr) === activeFilter)
          : r.prs;
        const hiddenCount = r.prs.length - visiblePrs.length;

        // Inline summary counts (computed over ALL prs in the repo, regardless of filter)
        const activeCount = r.prs.filter(isActive).length;
        const failedCount = r.prs.filter(isFailed).length;

        return (
          <section key={r.repo} id={`repo-section-${i}`}>
            {kiosk ? (
              <h2>{r.repo}</h2>
            ) : (
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
            )}
            {!isCollapsed && (
              <>
                <QueueTrain queue={r.queue} />
                {visiblePrs.length === 0 && hiddenCount === 0 && <p className="empty">no active PRs</p>}
                {visiblePrs.map((pr) => (
                  <PrRow key={pr.number} pr={pr} hasDeploy={r.hasDeploy}
                    queueCulprit={r.queue?.unmergeableCulprit ?? null}
                    expandable={!kiosk} />
                ))}
              </>
            )}
          </section>
        );
      })}
      </ErrorBoundary>
      </div>
    </main>
  );
}
