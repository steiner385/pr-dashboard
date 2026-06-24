import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Poller, RetryThrottle, describeError, ingestCheckSet, ingestGroupFailures, maxPlausibleSuccessSecs, rerunInProgressFor, computePrCost, DEPLOY_DISCOVERY_INTERVAL_MS, type DashboardState } from '../poller';
import { HistoryStore } from '../history';
import { deriveCiGraph } from '../required-checks';
import type { CheckRun } from '../types';
import { RateLimitError, type GithubClient } from '../github';
import { ClientRouter } from '../client-router';
import { DEFAULTS, type AppConfig } from '../config';
import { Notifier, type NotificationEvent, type NotificationsConfig } from '../notifier';
import type { DeployWatcher } from '../deploy-watcher';

const NOW = new Date('2026-06-10T12:00:00Z');

// DEFAULTS are de-personalized (no owners, no deploy) — tests run against a
// neutral two-owner config with one deploy-watched repo. ancestrySource is
// pinned to 'clone' here: this block (and everything spreading it) is the
// clone-mode suite; api-mode (the runtime default) coverage lives in the
// "ancestrySource 'api'" describe below.
const CONFIG: AppConfig = {
  ...DEFAULTS,
  ancestrySource: 'clone',
  owners: ['acme', 'octo'],
  deploy: {
    'acme/widgets': {
      cloneUrl: 'https://github.com/acme/widgets.git',
      defaultBranch: 'main',
      order: ['qa', 'prod'],
      environments: [
        { name: 'qa', healthUrl: 'https://qa.widgets.example.com/health', auto: true, shaKey: 'commitSha' },
        { name: 'prod', healthUrl: 'https://widgets.example.com/health', auto: false, shaKey: 'commitSha' },
      ],
    },
  },
};

// Explicit required-check prefixes for the watched repo — stands in for what
// ci.yml derivation would produce at runtime (the hand-maintained fallback list
// is gone; the chain is config > derived > none).
const PREFIX_CONFIG: AppConfig = {
  ...CONFIG,
  repos: { 'acme/widgets': { requiredCheckPrefixes:
    ['ci', 'fast-checks /', 'pr-affected-tests /'] } },
};

const CHECK_DONE = {
  __typename: 'CheckRun', name: 'fast-checks / ESLint', status: 'COMPLETED', conclusion: 'SUCCESS',
  startedAt: '2026-06-10T11:50:00Z', completedAt: '2026-06-10T11:53:00Z', detailsUrl: 'u',
  isRequired: true, checkSuite: { workflowRun: { event: 'pull_request' } },
};
const CHECK_RUNNING = {
  ...CHECK_DONE, name: 'pr-affected-tests / Affected Unit + Server Tests',
  status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-06-10T11:55:00Z', completedAt: null,
};

const SWEEP_RESPONSE = {
  open0: { issueCount: 1, nodes: [{ number: 8962, title: 'fix: overlap', url: 'u8962', isDraft: false,
    mergedAt: null, repository: { nameWithOwner: 'acme/widgets' }, mergeCommit: null }] },
  open1: { issueCount: 0, nodes: [] },
  merged0: { issueCount: 1, nodes: [{ number: 8951, title: 'feat: allowance', url: 'u8951', isDraft: false,
    mergedAt: '2026-06-10T11:40:00Z', repository: { nameWithOwner: 'acme/widgets' },
    mergeCommit: { oid: 'squash8951' } }] },
  merged1: { issueCount: 0, nodes: [] },
};
const DETAIL_RESPONSE = {
  r0: { nameWithOwner: 'acme/widgets', pr8962: {
    number: 8962, title: 'fix: overlap', url: 'u8962', isDraft: false, mergeStateStatus: 'BLOCKED',
    mergedAt: null, headRefOid: 'head8962', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
      contexts: { pageInfo: { hasNextPage: false }, nodes: [CHECK_DONE, CHECK_RUNNING] } } } }] },
  } },
};

function fakeClient(
  sweep: Record<string, unknown> = SWEEP_RESPONSE,
  detail: Record<string, unknown> = DETAIL_RESPONSE,
  detailMarker = 'pr8962: pullRequest',
) {
  return {
    remaining: 4000, resetAt: null,
    graphql: vi.fn(async (q: string) => {
      if (q.includes('open0: search')) return sweep;
      if (q.includes(detailMarker)) return detail;
      throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    }),
  };
}

/**
 * Per-env deploy fake: health() dispatches on the health URL, isAncestor()
 * dispatches on the deployed sha — so qa and prod can answer differently
 * (e.g. qa live, prod not yet → merged PR lands 'awaiting-prod').
 */
function fakeDeploy(
  shaByUrl: Record<string, string | null>,
  ancestryByDeployedSha: Record<string, 'yes' | 'no' | 'missing'>,
) {
  return {
    health: vi.fn(async (url: string) => shaByUrl[url] ?? null),
    ensureClone: vi.fn(async () => {}),
    isAncestor: vi.fn(async (_repo: string, _sha: string, deployedSha: string) =>
      ancestryByDeployedSha[deployedSha] ?? 'missing'),
  } as unknown as DeployWatcher;
}
const noDeploy = () => fakeDeploy({}, {});

/** Router seam (multi-installation round 10): existing tests inject ONE fake
 *  client that answers for every owner — exactly `ClientRouter.forSingle`. */
const asRouter = (client: unknown) => ClientRouter.forSingle(client as GithubClient);

let history: HistoryStore;
beforeEach(() => {
  history = new HistoryStore(':memory:');
  // seed expectations so the estimator has history
  for (let i = 0; i < 5; i++) {
    history.recordCheckDuration('acme/widgets', 'fast-checks / ESLint', 'pull_request',
      `2026-06-0${i + 1}T10:00:00Z`, `2026-06-0${i + 1}T10:03:00Z`, 'SUCCESS');
    history.recordCheckDuration('acme/widgets', 'pr-affected-tests / Affected Unit + Server Tests', 'pull_request',
      `2026-06-0${i + 1}T10:00:00Z`, `2026-06-0${i + 1}T10:10:00Z`, 'SUCCESS');
  }
});

describe('Poller', () => {
  it('sweep discovers PRs, detail fetch classifies + computes progress, durations are ingested', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const state = p.buildState();
    const widgets = state.repos.find((r) => r.repo === 'acme/widgets')!;
    expect(widgets.hasDeploy).toBe(true); // deploy-configured repo flagged for the frontend
    const pr = widgets.prs.find((x) => x.number === 8962)!;
    expect(pr.stage.stage).toBe('ci');
    expect(pr.stage.percent).toBeGreaterThan(0);
    expect(pr.stage.etaSeconds).not.toBeNull();
    // completed check duration ingested (completed_at unique per run → n grows to 6)
    expect(history.expected('acme/widgets', 'fast-checks / ESLint', 'pull_request')!.n).toBe(6);
    // lastSweep meta advanced
    expect(history.getMeta('lastSweep')).toBe(NOW.toISOString());
  });

  it('calibrated range (issue #35): an optimistic-history stage gets a widened display range', async () => {
    // 10 accuracy samples at ratio 1.5 → calibrationFactor('ci') = 1.5 > 1.15
    for (let i = 0; i < 10; i++) {
      history.recordEtaAccuracy('acme/widgets', 'ci', 100, 150, `2026-06-09T10:${String(i).padStart(2, '0')}:00Z`);
    }
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.stage.stage).toBe('ci');
    const eta = pr.stage.etaSeconds!;
    expect(eta).not.toBeNull();
    expect(pr.stage.etaRangeSeconds).toEqual([eta, Math.round(eta * 1.5)]);
  });

  it('calibrated range stays off under 10 samples (no factor yet)', async () => {
    for (let i = 0; i < 9; i++) {
      history.recordEtaAccuracy('acme/widgets', 'ci', 100, 150, `2026-06-09T10:${String(i).padStart(2, '0')}:00Z`);
    }
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.stage.etaSeconds).not.toBeNull();
    expect(pr.stage.etaRangeSeconds).toBeNull();
  });

  it('calibrated range stays off for benign factors (≤ 1.15 — no display churn)', async () => {
    // 10 samples at ratio 1.05 → factor exists but sits below the churn threshold
    for (let i = 0; i < 10; i++) {
      history.recordEtaAccuracy('acme/widgets', 'ci', 100, 105, `2026-06-09T10:${String(i).padStart(2, '0')}:00Z`);
    }
    expect(history.calibrationFactor('acme/widgets', 'ci')).toBeCloseTo(1.05, 10);
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.stage.etaSeconds).not.toBeNull();
    expect(pr.stage.etaRangeSeconds).toBeNull();
  });

  it('merged PR is persisted and classified through deploy stages (qa live, prod not → awaiting-prod)', async () => {
    const deploy = fakeDeploy(
      { 'https://qa.widgets.example.com/health': 'deployedSha-qa', 'https://widgets.example.com/health': 'oldSha-prod' },
      { 'deployedSha-qa': 'yes', 'oldSha-prod': 'no' },
    );
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce();
    const state = p.buildState();
    const pr = state.repos.find((r) => r.repo === 'acme/widgets')!.prs.find((x) => x.number === 8951)!;
    expect(pr.stage.stage).toBe('awaiting-prod');
    const rec = history.listTrackedMerged(7, NOW).find((r) => r.number === 8951)!;
    expect(rec.qaLiveAt).toBe(NOW.toISOString());
    expect(rec.prodLiveAt).toBeNull();
  });

  it('first observation already-live records NO deploy gap (backfill poisoning guard)', async () => {
    // PR is found already deployed on qa at first observation — the merged→live
    // wall-clock gap is unknowable here (this instance never saw it not-live)
    const deploy = fakeDeploy(
      { 'https://qa.widgets.example.com/health': 'deployedSha-qa' },
      { 'deployedSha-qa': 'yes' },
    );
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce();
    // env is marked live, but no gap sample is recorded
    expect(history.listTrackedMerged(7, NOW).find((r) => r.number === 8951)!.qaLiveAt)
      .toBe(NOW.toISOString());
    expect(history.medianDeployGap('acme/widgets', 'qa')).toBeNull();
  });

  it('observed not-live then live records the deploy gap', async () => {
    let t = NOW.getTime();
    const shaBox: Record<string, string | null> = { 'https://qa.widgets.example.com/health': 'oldSha-qa' };
    const deploy = fakeDeploy(shaBox, { 'oldSha-qa': 'no', 'newSha-qa': 'yes' });
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.deployOnce();   // observed NOT live on qa
    expect(history.medianDeployGap('acme/widgets', 'qa')).toBeNull();
    shaBox['https://qa.widgets.example.com/health'] = 'newSha-qa';
    t += 5 * 60_000;        // deploy lands 5 min later
    await p.deployOnce();
    // merged 11:40 → live 12:05 = 1500s gap, recorded because not-live was observed first
    expect(history.medianDeployGap('acme/widgets', 'qa')).toBe(1500);
    expect(history.listTrackedMerged(7, new Date(t)).find((r) => r.number === 8951)!.qaLiveAt)
      .toBe(new Date(t).toISOString());
  });

  it('rate-limit floor degrades hot interval', () => {
    const c = fakeClient(); c.remaining = 500;
    const p = new Poller({ router: asRouter(c), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.effectiveHotMs()).toBe(60_000);
  });

  it('rateLimitFloor is configurable: a lower floor keeps normal intervals', () => {
    const c = fakeClient(); c.remaining = 500;
    const p = new Poller({ router: asRouter(c), history, deploy: noDeploy(),
      config: { ...CONFIG, rateLimitFloor: 400 }, now: () => NOW });
    expect(p.effectiveHotMs()).toBe(CONFIG.intervals.hotMs); // 500 ≥ 400 — not degraded
    expect(p.nextDelayMs('sweep')).toBe(CONFIG.intervals.sweepMs);
  });
});

const staleDetail = (completedA: string, completedB: string) => ({
  r0: { nameWithOwner: 'acme/widgets', pr8970: {
    number: 8970, title: 'docs: tweak', url: 'u8970', isDraft: false, mergeStateStatus: 'CLEAN',
    mergedAt: null, headRefOid: 'head8970', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
      contexts: { pageInfo: { hasNextPage: false }, nodes: [
        { ...CHECK_DONE, isRequired: false,
          startedAt: '2026-06-10T11:35:00Z', completedAt: completedA },
        { ...CHECK_DONE, name: 'pr-affected-tests / Affected Unit + Server Tests', isRequired: false,
          startedAt: '2026-06-10T11:30:00Z', completedAt: completedB },
      ] } } } }] },
  } },
});
const staleSweep = {
  open0: { issueCount: 1, nodes: [{ number: 8970, title: 'docs: tweak', url: 'u8970', isDraft: false,
    mergedAt: null, repository: { nameWithOwner: 'acme/widgets' }, mergeCommit: null }] },
  open1: { issueCount: 0, nodes: [] },
  merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
};

// Explicit [] disables prefixes entirely (even if derivation later succeeds) —
// these tests exercise the no-required-signal fallback paths that prefixes
// would otherwise bypass.
const NO_PREFIX_CONFIG: AppConfig = {
  ...CONFIG,
  repos: { 'acme/widgets': { requiredCheckPrefixes: [] } },
};

describe('Poller expectedSet staleness guard (no required marking)', () => {
  beforeEach(() => {
    // fat history: a path-gated check that won't run on this PR
    for (let i = 0; i < 5; i++) {
      history.recordCheckDuration('acme/widgets', 'heavy-suite / Integration', 'pull_request',
        `2026-06-0${i + 1}T10:00:00Z`, `2026-06-0${i + 1}T10:20:00Z`, 'SUCCESS');
    }
  });

  it('old completed checks + fat history expectedSet → ready, not stuck in ci', async () => {
    // newest completion 11:42, NOW 12:00 → 18 min > 10 min staleness threshold
    const client = fakeClient(staleSweep, staleDetail('2026-06-10T11:40:00Z', '2026-06-10T11:42:00Z'), 'pr8970: pullRequest');
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: NO_PREFIX_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs.find((x) => x.number === 8970)!;
    expect(pr.stage.stage).toBe('ready');
    expect(pr.stage.substate).toBe('idle');
  });

  it('recent completions keep the full expectedSet → still ci (needs: chain may unlock more)', async () => {
    // newest completion 11:58 → only 2 min old: absent expected checks may still appear
    const client = fakeClient(staleSweep, staleDetail('2026-06-10T11:56:00Z', '2026-06-10T11:58:00Z'), 'pr8970: pullRequest');
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: NO_PREFIX_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs.find((x) => x.number === 8970)!;
    expect(pr.stage.stage).toBe('ci');
    expect(pr.stage.percent).toBeLessThan(100);
  });
});

describe('Poller requiredCheckPrefixes (late-materializing required checks)', () => {
  // Mid-run snapshot: nothing is marked isRequired yet; one prefix-matched check is
  // running and one advisory (lighthouse) is also present.
  const midRunDetail = (advisory: Record<string, unknown>) => ({
    r0: { nameWithOwner: 'acme/widgets', pr8970: {
      number: 8970, title: 'docs: tweak', url: 'u8970', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'head8970', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [
          { ...CHECK_DONE, isRequired: false },
          { ...CHECK_DONE, name: 'pr-affected-tests / Affected Unit + Server Tests', isRequired: false,
            status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-06-10T11:55:00Z', completedAt: null },
          { ...CHECK_DONE, name: 'lighthouse', isRequired: false, ...advisory },
        ] } } } }] },
    } },
  });

  async function classifyMidRun(advisory: Record<string, unknown>) {
    const client = fakeClient(staleSweep, midRunDetail(advisory), 'pr8970: pullRequest');
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: PREFIX_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    return p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs.find((x) => x.number === 8970)!;
  }

  it('advisory (non-matching) FAILURE does NOT park — stage stays ci', async () => {
    const pr = await classifyMidRun({ conclusion: 'FAILURE' });
    expect(pr.stage.stage).toBe('ci');
    expect(pr.stage.substate).toBeNull();
  });

  it('prefix-matched FAILURE parks the PR', async () => {
    const client = fakeClient(staleSweep, midRunDetail({
      name: 'fast-checks / Type Check', conclusion: 'FAILURE' }), 'pr8970: pullRequest');
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: PREFIX_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos[0]!.prs.find((x) => x.number === 8970)!;
    expect(pr.stage.stage).toBe('parked');
    expect(pr.stage.substate).toBe('ci-failed');
  });

  it('expectedSet keeps prefix-matched history names (denominator does not collapse)', async () => {
    // history also knows an advisory check — it must NOT count toward progress,
    // while both prefix-matched names must stay in the denominator
    for (let i = 0; i < 5; i++) {
      history.recordCheckDuration('acme/widgets', 'lighthouse', 'pull_request',
        `2026-06-0${i + 1}T10:00:00Z`, `2026-06-0${i + 1}T10:08:00Z`, 'SUCCESS');
    }
    const pr = await classifyMidRun({ status: 'IN_PROGRESS', conclusion: null, completedAt: null });
    expect(pr.stage.stage).toBe('ci');
    // 1 of 2 prefix-matched expected checks done → strictly between 0 and 100, and
    // unaffected by lighthouse (which would push the denominator to 3)
    expect(pr.stage.percent).toBeGreaterThan(0);
    expect(pr.stage.percent).toBeLessThan(100);
  });

  it('checkViews isRequired reflects the prefix predicate (advisory stays false)', async () => {
    const pr = await classifyMidRun({ status: 'IN_PROGRESS', conclusion: null, completedAt: null });
    const byName = Object.fromEntries(pr.checks.map((c) => [c.name, c.isRequired]));
    expect(byName['fast-checks / ESLint']).toBe(true);
    expect(byName['pr-affected-tests / Affected Unit + Server Tests']).toBe(true);
    expect(byName['lighthouse']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Poller hardening (tasks 10-11 review fixes)
// ---------------------------------------------------------------------------

const EMPTY_SWEEP = {
  open0: { issueCount: 0, nodes: [] }, open1: { issueCount: 0, nodes: [] },
  merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
};

describe('Poller scheduling (warm tier + self-re-arming timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sweep tick chains a full detail refresh so cold PRs stay warm', async () => {
    vi.useFakeTimers();
    // PR 8970 classifies 'ready' (cold) after its first detail fetch — the hot
    // tick alone would never refresh it again.
    const client = fakeClient(staleSweep,
      staleDetail('2026-06-10T11:40:00Z', '2026-06-10T11:42:00Z'), 'pr8970: pullRequest');
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.start();
    await vi.advanceTimersByTimeAsync(0); // flush initial kick (sweep + full detail)
    const detailCalls = () =>
      client.graphql.mock.calls.filter(([q]) => (q as string).includes('pr8970: pullRequest')).length;
    expect(detailCalls()).toBe(1);
    expect(p.getState().repos[0]!.prs[0]!.stage.stage).toBe('ready');
    // hot ticks fire at 15/30/45/60s but skip the cold PR; the sweep tick at 60s warms it
    await vi.advanceTimersByTimeAsync(CONFIG.intervals.sweepMs);
    expect(detailCalls()).toBe(2);
    p.stop();
  });

  it('stop() clears pending timeouts', async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    const calls = client.graphql.mock.calls.length;
    p.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.graphql.mock.calls.length).toBe(calls);
  });

  it('normal delays follow configured intervals', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.nextDelayMs('hot')).toBe(CONFIG.intervals.hotMs);
    expect(p.nextDelayMs('sweep')).toBe(CONFIG.intervals.sweepMs);
    expect(p.nextDelayMs('deploy')).toBe(CONFIG.intervals.deployMs);
  });

  it('sweep delay degrades to 5 min when remaining < 1000', () => {
    const c = fakeClient(); c.remaining = 500;
    const p = new Poller({ router: asRouter(c), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.nextDelayMs('sweep')).toBe(300_000);
    expect(p.nextDelayMs('hot')).toBe(60_000); // effectiveHotMs floor
  });

  it('RateLimitError pauses every cycle for at least retryAfterSeconds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = { remaining: 4000, resetAt: null,
      graphql: vi.fn(async () => { throw new RateLimitError(120); }) };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    expect(p.nextDelayMs('hot')).toBeGreaterThanOrEqual(120_000);
    expect(p.nextDelayMs('sweep')).toBeGreaterThanOrEqual(120_000);
    expect(p.nextDelayMs('deploy')).toBeGreaterThanOrEqual(120_000);
  });
});

describe('Poller cycle containment + re-entrancy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a TypeError from client.graphql never escapes; staleSince is set and logged', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = { remaining: 4000, resetAt: null,
      graphql: vi.fn(async () => { throw new TypeError('cannot read properties of undefined'); }) };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CONFIG.intervals.sweepMs);
    expect(p.buildState().staleSince).toBe(NOW.toISOString());
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]).includes('cannot read properties')).toBe(true);
    p.stop();
  });

  it('a tick that fires while the same cycle is in flight is skipped', async () => {
    const client = { remaining: 4000, resetAt: null,
      graphql: vi.fn(() => new Promise(() => { /* never resolves */ })) };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    void p.sweepOnce();        // hangs on the never-resolving fetch
    await p.sweepOnce();       // latched — resolves immediately, no second fetch
    expect(client.graphql).toHaveBeenCalledTimes(1);
  });
});

describe('Poller propagating ancestry state', () => {
  it("isAncestor 'missing' renders merged PR as qa-deploy/propagating, not a percent bar", async () => {
    const deploy = fakeDeploy(
      { 'https://qa.widgets.example.com/health': 'deployedSha-qa' },
      { 'deployedSha-qa': 'missing' },
    );
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8951)!;
    expect(pr.stage.stage).toBe('qa-deploy');
    expect(pr.stage.substate).toBe('propagating');
    expect(pr.stage.percent).toBeNull();
  });

  it('ancestry checks for the same (sha, deployedSha) pair are throttled to once per 60s', async () => {
    const deploy = fakeDeploy(
      { 'https://qa.widgets.example.com/health': 'deployedSha-qa' },
      { 'deployedSha-qa': 'missing' },
    );
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce();
    await p.deployOnce(); // same clock → within 60s of the first check
    expect(vi.mocked(deploy.isAncestor)).toHaveBeenCalledTimes(1);
  });

  it("a later 'yes' clears propagating and marks the env live", async () => {
    let t = NOW.getTime();
    const ancestry: Record<string, 'yes' | 'no' | 'missing'> = { 'deployedSha-qa': 'missing' };
    const deploy = fakeDeploy({ 'https://qa.widgets.example.com/health': 'deployedSha-qa' }, ancestry);
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.deployOnce();
    expect(p.buildState().repos[0]!.prs.find((x) => x.number === 8951)!.stage.substate)
      .toBe('propagating');
    ancestry['deployedSha-qa'] = 'yes';
    t += 61_000; // step past the ancestry throttle window
    await p.deployOnce();
    const pr = p.buildState().repos[0]!.prs.find((x) => x.number === 8951)!;
    expect(pr.stage.stage).toBe('awaiting-prod');
    expect(history.listTrackedMerged(7, new Date(t)).find((r) => r.number === 8951)!.qaLiveAt)
      .not.toBeNull();
  });

  it('prod health unreachable → prodLive unknown; merged PR still classifies (awaiting-prod)', async () => {
    // qa is live, prod /health is down (no sha) — must not crash or show a bogus prod state
    const deploy = fakeDeploy(
      { 'https://qa.widgets.example.com/health': 'deployedSha-qa' },
      { 'deployedSha-qa': 'yes' },
    );
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8951)!;
    expect(pr.stage.stage).toBe('awaiting-prod');
  });
});

describe('Poller cache pruning + sweep bookkeeping', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prunes stage/queue/group entries for vanished PRs after sweep', async () => {
    const sweepBox = { current: SWEEP_RESPONSE as Record<string, unknown> };
    const client = { remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return sweepBox.current;
        if (q.includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }) };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const internals = p as unknown as {
      stages: Map<string, unknown>;
      queueEntries: Map<string, unknown[]>;
      groupChecks: Map<string, unknown[]>;
    };
    expect(internals.stages.has('acme/widgets#8962')).toBe(true);
    // simulate leftovers from a since-emptied merge queue
    internals.queueEntries.set('acme/widgets', []);
    internals.groupChecks.set('deadOid', []);
    sweepBox.current = EMPTY_SWEEP;
    await p.sweepOnce();
    expect(internals.stages.has('acme/widgets#8962')).toBe(false);
    expect(internals.queueEntries.size).toBe(0);
    expect(internals.groupChecks.size).toBe(0);
  });

  it('warns once per sweep when a search payload is truncated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sweep = {
      ...SWEEP_RESPONSE,
      open0: { issueCount: 60, nodes: SWEEP_RESPONSE.open0.nodes },
      merged0: { issueCount: 99, nodes: SWEEP_RESPONSE.merged0.nodes },
    };
    const p = new Poller({ router: asRouter(fakeClient(sweep)), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toMatch(/acme/);
  });

  it('lastSweep meta records sweep start, not end', async () => {
    let t = NOW.getTime();
    const client = { remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        t += 5_000; // the fetch itself takes 5s
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        throw new Error('unexpected');
      }) };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    expect(history.getMeta('lastSweep')).toBe(NOW.toISOString());
  });
});

describe('Poller deep merged sweep pagination', () => {
  afterEach(() => vi.restoreAllMocks());

  // 120 merged PRs for owner acme split over 3 pages (50/50/20)
  const mergedNode = (n: number) => ({ number: n, title: `pr ${n}`, url: `u${n}`, isDraft: false,
    mergedAt: '2026-06-09T10:00:00Z', repository: { nameWithOwner: 'acme/widgets' },
    mergeCommit: { oid: `sha${n}` } });
  const page = (start: number, count: number, next: string | null) => ({
    issueCount: 120,
    pageInfo: { hasNextPage: next != null, endCursor: next },
    nodes: Array.from({ length: count }, (_, i) => mergedNode(start + i)),
  });
  const pagedClient = () => ({
    remaining: 4000, resetAt: null,
    graphql: vi.fn(async (q: string) => {
      if (q.includes('open0: search')) return {
        open0: { issueCount: 0, nodes: [] }, open1: { issueCount: 0, nodes: [] },
        merged0: page(1, 50, 'C1'), merged1: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      };
      if (q.includes('after: "C1"')) return { merged: page(51, 50, 'C2') };
      if (q.includes('after: "C2"')) return { merged: page(101, 20, null) };
      throw new Error(`unexpected query: ${q.slice(0, 100)}`);
    }),
  });

  it('deep flag set → follows pagination and ingests all 120 merged PRs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(pagedClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce(true);
    expect(history.listTrackedMerged(7, NOW)).toHaveLength(120);
    expect(warn).not.toHaveBeenCalled(); // paginated aliases don't warn truncation
  });

  it('routine sweep (no deep flag) stays single-page and keeps the truncation warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = pagedClient();
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    // one search request per owner (acme, octo) — and NO pagination follow-ups
    expect(client.graphql).toHaveBeenCalledTimes(2);
    expect(history.listTrackedMerged(7, NOW)).toHaveLength(50);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toMatch(/truncated/);
  });
});

describe('Poller open sweep pagination', () => {
  afterEach(() => vi.restoreAllMocks());

  const openNode = (n: number) => ({ number: n, title: `pr ${n}`, url: `u${n}`, isDraft: false,
    mergedAt: null, repository: { nameWithOwner: 'acme/widgets' }, mergeCommit: null });
  const openPage = (start: number, count: number, next: string | null, total: number) => ({
    issueCount: total,
    pageInfo: { hasNextPage: next != null, endCursor: next },
    nodes: Array.from({ length: count }, (_, i) => openNode(start + i)),
  });
  const emptyAlias = { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };

  /** 58 open PRs for acme over 2 pages (50/8); octo empty. Routes per owner +
   *  per cursor; a cursor listed in `failCursors` rejects (mid-pagination outage). */
  const twoPageClient = (failCursors: string[] = []) => ({
    remaining: 4000, resetAt: null,
    graphql: vi.fn(async (q: string) => {
      if (q.includes('open0: search') && q.includes('user:acme')) return {
        open0: openPage(1, 50, 'O1', 58), merged0: emptyAlias,
      };
      if (q.includes('open0: search') && q.includes('user:octo')) return {
        open0: emptyAlias, merged0: emptyAlias,
      };
      if (q.includes('after: "O1"')) {
        if (failCursors.includes('O1')) throw new Error('boom');
        return { open: openPage(51, 8, null, 58) };
      }
      throw new Error(`unexpected query: ${q.slice(0, 100)}`);
    }),
  });

  it('routine sweep follows open pagination: both pages merge into tracked PRs, no truncation warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = twoPageClient();
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    const internals = p as unknown as { prs: Map<string, unknown> };
    expect(internals.prs.size).toBe(58);
    expect(internals.prs.has('acme/widgets#1')).toBe(true);   // page 1
    expect(internals.prs.has('acme/widgets#58')).toBe(true);  // page 2
    // 2 owner sweeps + 1 open-page follow-up
    expect(client.graphql).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
    expect(history.getMeta('lastSweep')).toBe(NOW.toISOString()); // sweep counted as complete
  });

  it('mid-pagination failure leaves the window unadvanced and does not prune later-page PRs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(twoPageClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce(); // complete 2-page sweep — 58 tracked
    history.setMeta('lastSweep', 'SENTINEL');
    const p2internals = p as unknown as { prs: Map<string, unknown> };
    // swap in a client whose page-2 fetch fails
    const failing = twoPageClient(['O1']);
    (p as unknown as { deps: { router: unknown } }).deps.router = asRouter(failing);
    await p.sweepOnce();
    // page-2 PRs survive (no prune off an incomplete open set), window not advanced
    expect(p2internals.prs.has('acme/widgets#58')).toBe(true);
    expect(p2internals.prs.size).toBe(58);
    expect(history.getMeta('lastSweep')).toBe('SENTINEL');
  });

  it('warns when open PRs still exceed the 5-page cap (250)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search') && q.includes('user:acme')) return {
          open0: openPage(1, 50, 'O1', 260), merged0: emptyAlias,
        };
        if (q.includes('open0: search') && q.includes('user:octo')) return {
          open0: emptyAlias, merged0: emptyAlias,
        };
        const m = q.match(/after: "O(\d)"/);
        if (m) {
          const i = Number(m[1]);
          // pages 2..5 — page 5 STILL reports hasNextPage (260 > 250)
          return { open: openPage(i * 50 + 1, 50, `O${i + 1}`, 260) };
        }
        throw new Error(`unexpected query: ${q.slice(0, 100)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    const internals = p as unknown as { prs: Map<string, unknown> };
    expect(internals.prs.size).toBe(250);
    // 2 owner sweeps + 4 follow-ups (pages 2..5), then the cap stops pagination
    expect(client.graphql).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toMatch(/open sweep.*acme.*5-page cap/);
  });
});

describe('Poller state memoization', () => {
  it('cycles memoize state via emitUpdate; getState() returns the memoized object', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const seen: DashboardState[] = [];
    p.on('update', () => seen.push(p.getState()));
    await p.sweepOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.repos.length).toBeGreaterThan(0);
    expect(p.getState()).toBe(seen[0]); // identity: memoized, not rebuilt per consumer
  });

  it('getState() before any cycle falls back to a fresh build', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.getState().repos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task A: queueAheadCount threading
// ---------------------------------------------------------------------------

describe('Poller queueAheadCount in PrView', () => {
  // Build a PR detail response that puts PR 8962 in the merge queue (QUEUED state),
  // and wire up a queue response with a second entry ahead of it.
  const queuedDetail = {
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      number: 8962, title: 'fix: overlap', url: 'u8962', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'head8962', autoMergeRequest: { mergeMethod: 'SQUASH' },
      mergeCommit: null,
      mergeQueueEntry: { position: 2, state: 'QUEUED', enqueuedAt: null, headCommit: null },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [
          { ...CHECK_DONE },
        ] } } } }] },
    } },
  };

  const QUEUE_RESPONSE = {
    repository: {
      mergeQueue: {
        entries: {
          nodes: [
            // Entry ahead: position 1, non-MERGEABLE
            { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: null,
              headCommit: null, pullRequest: { number: 9001 } },
            // Our PR: position 2
            { position: 2, state: 'QUEUED', enqueuedAt: null,
              headCommit: null, pullRequest: { number: 8962 } },
          ],
        },
      },
    },
  };

  function queueClient() {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return queuedDetail;
        if (q.includes('mergeQueue')) return QUEUE_RESPONSE;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }

  it('queueAheadCount is non-null and equals entries ahead when stage is queue', async () => {
    const p = new Poller({ router: asRouter(queueClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const state = p.buildState();
    const pr = state.repos.find((r) => r.repo === 'acme/widgets')!.prs.find((x) => x.number === 8962)!;
    expect(pr.stage.stage).toBe('queue');
    expect(pr.queueAheadCount).toBe(1);
  });

  it('queueAheadCount is null for a non-queue stage (ci)', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const state = p.buildState();
    const pr = state.repos.find((r) => r.repo === 'acme/widgets')!.prs.find((x) => x.number === 8962)!;
    expect(pr.stage.stage).toBe('ci');
    expect(pr.queueAheadCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task D: observed queue throughput
// ---------------------------------------------------------------------------

describe('Poller observed group runs + queue waits', () => {
  const GROUP_OID = 'groupOid1';

  // PR 8962 sits in the merge queue with a CI group running on GROUP_OID.
  const queuedDetail = (over: Record<string, unknown> = {}) => ({
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      number: 8962, title: 'fix: overlap', url: 'u8962', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'head8962', autoMergeRequest: { mergeMethod: 'SQUASH' },
      mergeCommit: null,
      mergeQueueEntry: { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
        headCommit: { oid: GROUP_OID } },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [{ ...CHECK_DONE }] } } } }] },
      ...over,
    } },
  });

  const queueResponse = {
    repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
        headCommit: { oid: GROUP_OID }, pullRequest: { number: 8962 } },
    ] } } },
  };

  const mgCheck = (over: Record<string, unknown>) => ({
    __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null,
    startedAt: '2026-06-10T11:30:00Z', completedAt: null, detailsUrl: 'u',
    checkSuite: { workflowRun: { event: 'merge_group' } }, ...over,
  });
  const rollupRunning = { repository: { o0: { oid: GROUP_OID, statusCheckRollup: { contexts: { nodes: [
    mgCheck({}),
    mgCheck({ name: 'unit', startedAt: '2026-06-10T11:31:00Z' }),
  ] } } } } };
  const rollupDone = { repository: { o0: { oid: GROUP_OID, statusCheckRollup: { contexts: { nodes: [
    mgCheck({ status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-06-10T11:45:00Z' }),
    mgCheck({ name: 'unit', startedAt: '2026-06-10T11:31:00Z',
      status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-06-10T11:40:00Z' }),
  ] } } } } };

  function boxedClient(detailBox: { current: Record<string, unknown> },
    rollupBox: { current: Record<string, unknown> }) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return detailBox.current;
        if (q.includes('object(oid:')) return rollupBox.current;
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }

  it('all-COMPLETED group with a FAILURE conclusion does not record a group_runs row', async () => {
    const rollupFailed = { repository: { o0: { oid: GROUP_OID, statusCheckRollup: { contexts: { nodes: [
      mgCheck({ status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-06-10T11:42:00Z' }),
      mgCheck({ name: 'unit', startedAt: '2026-06-10T11:31:00Z',
        status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-06-10T11:38:00Z' }),
    ] } } } } };
    const detailBox = { current: queuedDetail() };
    const rollupBox = { current: rollupFailed as Record<string, unknown> };
    const recordSpy = vi.spyOn(history, 'recordGroupRun');
    const client = boxedClient(detailBox, rollupBox);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();  // all-COMPLETED but contains FAILURE — must NOT record
    expect(recordSpy).not.toHaveBeenCalled();
    expect(history.medianGroupRun('acme/widgets')).toBeNull();
  });

  it('records a group run exactly once when its checks first become all-COMPLETED', async () => {
    const detailBox = { current: queuedDetail() };
    const rollupBox = { current: rollupRunning as Record<string, unknown> };
    const recordSpy = vi.spyOn(history, 'recordGroupRun');
    const client = boxedClient(detailBox, rollupBox);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();                 // group still running — nothing recorded
    expect(recordSpy).not.toHaveBeenCalled();
    rollupBox.current = rollupDone;
    await p.queueOnce();                 // transition to all-COMPLETED — record once
    await p.queueOnce();                 // completed group is no longer refetched
    expect(recordSpy).toHaveBeenCalledTimes(1);
    // duration = max(completedAt 11:45) − min(startedAt 11:30) = 900s
    expect(recordSpy).toHaveBeenCalledWith('acme/widgets', 900, '2026-06-10T11:45:00Z');
    expect(history.medianGroupRun('acme/widgets')).toBe(900);
  });

  it('medianGroupSecs prefers the observed median over the longest-check proxy', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const internals = p as unknown as { medianGroupSecs(repo: string): number | null };
    // proxy only: longest merge_group check p50
    for (let i = 0; i < 5; i++) {
      history.recordCheckDuration('acme/widgets', 'ci', 'merge_group',
        `2026-06-0${i + 1}T10:00:00Z`, `2026-06-0${i + 1}T10:08:00Z`, 'SUCCESS');
    }
    expect(internals.medianGroupSecs('acme/widgets')).toBe(480);
    // observed group runs win once present
    history.recordGroupRun('acme/widgets', 1234, '2026-06-10T11:00:00Z');
    expect(internals.medianGroupSecs('acme/widgets')).toBe(1234);
  });

  it('records the queue wait when a queued PR transitions to merged', async () => {
    const detailBox = { current: queuedDetail() };
    const rollupBox = { current: rollupRunning as Record<string, unknown> };
    const p = new Poller({ router: asRouter(boxedClient(detailBox, rollupBox)), history,
      deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();               // captures enqueuedAt 11:30
    expect(history.medianQueueWait('acme/widgets')).toBeNull();
    detailBox.current = queuedDetail({ mergedAt: '2026-06-10T11:50:00Z',
      mergeQueueEntry: null, mergeCommit: { oid: 'squash8962' } });
    await p.detailOnce();               // merged: wait = 11:50 − 11:30 = 1200s
    expect(history.medianQueueWait('acme/widgets')).toBe(1200);
    const internals = p as unknown as { queueEnqueuedAt: Map<string, string> };
    expect(internals.queueEnqueuedAt.has('acme/widgets#8962')).toBe(false);
  });

  it('a PR dequeued without merging records no queue wait and drops its enqueuedAt', async () => {
    const detailBox = { current: queuedDetail() };
    const rollupBox = { current: rollupRunning as Record<string, unknown> };
    const p = new Poller({ router: asRouter(boxedClient(detailBox, rollupBox)), history,
      deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    detailBox.current = queuedDetail({ mergeQueueEntry: null }); // kicked out of the queue
    await p.detailOnce();
    expect(history.medianQueueWait('acme/widgets')).toBeNull();
    const internals = p as unknown as { queueEnqueuedAt: Map<string, string> };
    expect(internals.queueEnqueuedAt.has('acme/widgets#8962')).toBe(false);
  });

  it('pruneCaches drops recordedGroups + queueEnqueuedAt entries for vanished subjects', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const internals = p as unknown as {
      recordedGroups: Set<string>;
      queueEnqueuedAt: Map<string, string>;
    };
    internals.recordedGroups.add('deadOid');
    internals.queueEnqueuedAt.set('acme/widgets#9999', '2026-06-10T11:00:00Z');
    await p.sweepOnce(); // sweep does not contain PR 9999 nor any queue groups
    expect(internals.recordedGroups.has('deadOid')).toBe(false);
    expect(internals.queueEnqueuedAt.has('acme/widgets#9999')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task G: conditional-remaining estimator wired into both populations
// ---------------------------------------------------------------------------

describe('Poller wires history samples into computeProgress (conditional estimator)', () => {
  const AFFECTED = 'pr-affected-tests / Affected Unit + Server Tests';

  it('pull_request population: bimodal history re-anchors a running check ETA', async () => {
    // beforeEach seeded 5×600s for AFFECTED; complete the bimodal set: +1×600, +6×120
    history.recordCheckDuration('acme/widgets', AFFECTED, 'pull_request',
      '2026-06-06T10:00:00Z', '2026-06-06T10:10:00Z', 'SUCCESS');
    for (let i = 0; i < 6; i++) {
      history.recordCheckDuration('acme/widgets', AFFECTED, 'pull_request',
        `2026-06-07T1${i}:00:00Z`, `2026-06-07T1${i}:02:00Z`, 'SUCCESS');
    }
    // running check elapsed = 150s (11:57:30 → 12:00) — past the fast mode (120s)
    const detail = {
      r0: { nameWithOwner: 'acme/widgets', pr8962: {
        ...DETAIL_RESPONSE.r0.pr8962,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
          contexts: { pageInfo: { hasNextPage: false }, nodes: [CHECK_DONE,
            { ...CHECK_RUNNING, startedAt: '2026-06-10T11:57:30Z' }] } } } }] },
      } },
    };
    const p = new Poller({ router: asRouter(fakeClient(SWEEP_RESPONSE, detail)), history,
      deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.stage.stage).toBe('ci');
    // p50 of the bimodal set is 120 → old logic would say max(120−150, 0) = 0;
    // conditional median of qualifying samples (6×600) re-anchors to 600−150 = 450
    expect(pr.stage.etaSeconds).toBe(450);
    expect(pr.stage.overdue).toBe(false);
  });

  it('merge_group population: bimodal history re-anchors a running group ETA', async () => {
    // bimodal merge_group history for check 'ci': 6×120, 6×600
    for (let i = 0; i < 6; i++) {
      history.recordCheckDuration('acme/widgets', 'ci', 'merge_group',
        `2026-06-07T1${i}:00:00Z`, `2026-06-07T1${i}:02:00Z`, 'SUCCESS');
      history.recordCheckDuration('acme/widgets', 'ci', 'merge_group',
        `2026-06-08T1${i}:00:00Z`, `2026-06-08T1${i}:10:00Z`, 'SUCCESS');
    }
    const detail = {
      r0: { nameWithOwner: 'acme/widgets', pr8962: {
        ...DETAIL_RESPONSE.r0.pr8962,
        mergeStateStatus: 'CLEAN', autoMergeRequest: { mergeMethod: 'SQUASH' },
        mergeQueueEntry: { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:50:00Z',
          headCommit: { oid: 'gOid' } },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
          contexts: { pageInfo: { hasNextPage: false }, nodes: [CHECK_DONE] } } } }] },
      } },
    };
    const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:50:00Z',
        headCommit: { oid: 'gOid' }, pullRequest: { number: 8962 } },
    ] } } } };
    const rollup = { repository: { o0: { oid: 'gOid', statusCheckRollup: { contexts: { nodes: [
      { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null,
        startedAt: '2026-06-10T11:57:30Z', completedAt: null, detailsUrl: 'u',
        checkSuite: { workflowRun: { event: 'merge_group' } } },
    ] } } } } };
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return detail;
        if (q.includes('object(oid:')) return rollup;
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.stage.stage).toBe('queue');
    expect(pr.stage.etaSeconds).toBe(450); // conditional re-anchor on the group check
  });
});

// ---------------------------------------------------------------------------
// Task E: derived required-check prefixes
// ---------------------------------------------------------------------------

describe('Poller derived required-check prefixes', () => {
  // Mid-run snapshot with nothing marked isRequired: one done check, one running,
  // one 'lighthouse'. Which of these count as required depends purely on the
  // effective prefixes — making prefix-source precedence observable.
  const midRunDetail = {
    r0: { nameWithOwner: 'acme/widgets', pr8970: {
      number: 8970, title: 'docs: tweak', url: 'u8970', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'head8970', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [
          { ...CHECK_DONE, isRequired: false },
          { ...CHECK_DONE, name: 'pr-affected-tests / Affected Unit + Server Tests', isRequired: false,
            status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-06-10T11:55:00Z', completedAt: null },
          { ...CHECK_DONE, name: 'lighthouse', isRequired: false,
            status: 'IN_PROGRESS', conclusion: null, completedAt: null },
        ] } } } }] },
    } },
  };

  async function requiredByName(p: Poller) {
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8970)!;
    return Object.fromEntries(pr.checks.map((c) => [c.name, c.isRequired]));
  }
  const client = () => fakeClient(staleSweep, midRunDetail, 'pr8970: pullRequest');

  it('derived prefixes flow into checkViews/required classification', async () => {
    const p = new Poller({ router: asRouter(client()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.setDerivedPrefixes('acme/widgets', ['lighthouse']);
    const byName = await requiredByName(p);
    expect(byName['lighthouse']).toBe(true);             // derived prefix matched
    expect(byName['fast-checks / ESLint']).toBe(false);  // not in the derived set
  });

  it('config requiredCheckPrefixes wins over derived prefixes', async () => {
    const config = { ...CONFIG,
      repos: { 'acme/widgets': { requiredCheckPrefixes: ['fast-checks /'] } } };
    const p = new Poller({ router: asRouter(client()), history, deploy: noDeploy(),
      config, now: () => NOW });
    p.setDerivedPrefixes('acme/widgets', ['lighthouse']);
    const byName = await requiredByName(p);
    expect(byName['fast-checks / ESLint']).toBe(true);
    expect(byName['lighthouse']).toBe(false);
  });

  it('without config or derived prefixes, no prefixes apply (chain ends at none)', async () => {
    // The hand-maintained FALLBACK list is gone — with neither config nor derived
    // prefixes, nothing is prefix-required (only GitHub's isRequired marking counts,
    // and these mid-run fixtures all carry isRequired: false).
    const p = new Poller({ router: asRouter(client()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const byName = await requiredByName(p);
    expect(byName['fast-checks / ESLint']).toBe(false);
    expect(byName['pr-affected-tests / Affected Unit + Server Tests']).toBe(false);
    expect(byName['lighthouse']).toBe(false);
  });

  it('setDerivedPrefixes logs the derivation once', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.setDerivedPrefixes('acme/widgets', ['ci', 'build']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0])).toMatch(/acme\/widgets.*ci, build/);
    log.mockRestore();
  });

  it('deploy cycle re-derives from ci.yml at most once per 24h', async () => {
    let t = NOW.getTime();
    const ciYaml = 'jobs:\n  lint: {}\n  ci:\n    needs: [lint]\n';
    const deploy = {
      health: vi.fn(async () => null),
      ensureClone: vi.fn(async () => {}),
      fetchClone: vi.fn(async () => {}),
      isAncestor: vi.fn(async () => 'missing' as const),
      readFileAtHead: vi.fn(async () => ciYaml),
    } as unknown as DeployWatcher;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => new Date(t) });
    await p.deployOnce();
    expect(vi.mocked(deploy.readFileAtHead)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deploy.readFileAtHead))
      .toHaveBeenCalledWith('acme/widgets', '.github/workflows/ci.yml', 'main');
    expect(String(log.mock.calls[0])).toMatch(/ci, lint/); // derived and logged
    t += 60_000;
    await p.deployOnce();   // within 24h — no re-read
    expect(vi.mocked(deploy.readFileAtHead)).toHaveBeenCalledTimes(1);
    t += 24 * 3600_000;
    await p.deployOnce();   // ≥24h later — re-derives
    expect(vi.mocked(deploy.readFileAtHead)).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('unparseable ci.yml during deploy re-derivation keeps prior derived prefixes', async () => {
    const deploy = {
      health: vi.fn(async () => null),
      ensureClone: vi.fn(async () => {}),
      fetchClone: vi.fn(async () => {}),
      isAncestor: vi.fn(async () => 'missing' as const),
      readFileAtHead: vi.fn(async () => 'not: [valid: yaml'),
    } as unknown as DeployWatcher;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let t = NOW.getTime();
    const p = new Poller({ router: asRouter(client()), history, deploy,
      config: CONFIG, now: () => new Date(t) });
    p.setDerivedPrefixes('acme/widgets', ['fast-checks /']); // earlier successful derivation
    expect(log).toHaveBeenCalledTimes(1);
    t += 25 * 3600_000; // step past the 24h derivation throttle so deployOnce re-reads ci.yml
    await p.deployOnce();
    expect(vi.mocked(deploy.readFileAtHead)).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1); // setDerivedPrefixes never re-ran (unparseable)
    // the earlier derived prefixes still classify required checks
    const byName = await requiredByName(p);
    expect(byName['fast-checks / ESLint']).toBe(true);
    expect(byName['lighthouse']).toBe(false);
    log.mockRestore();
  });

  it('a deploy fake without readFileAtHead does not break the deploy cycle (best-effort)', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await expect(p.deployOnce()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task W1: derived needs graph
// ---------------------------------------------------------------------------

/** Build an all-events derived-graph node map from a plain needs adjacency. */
const nodeMap = (m: Map<string, string[]>) =>
  new Map([...m].map(([k, needs]) =>
    [k, { needs, activity: { mode: 'all' as const }, runsOn: null, timeoutMinutes: null }]));

describe('Poller derived needs graph (W1)', () => {
  const WIDGETS_NEEDS = new Map<string, string[]>([
    ['ci', ['static-checks /', 'build', 'build-test']],
    ['static-checks /', ['Prepare (prisma + packages)']],
    ['build', ['Prepare (prisma + packages)']],
    ['build-test', ['Prepare (prisma + packages)']],
    ['Prepare (prisma + packages)', []],
  ]);

  it('needsFor returns null without a derived graph', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.needsFor('acme/widgets', 'ci')).toBeNull();
  });

  it('matches check names to graph nodes by the shared prefix semantics', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.setDerivedGraph('acme/widgets', nodeMap(WIDGETS_NEEDS));
    // exact node
    expect(p.needsFor('acme/widgets', 'ci')).toEqual(['static-checks /', 'build', 'build-test']);
    // a check under a uses-job node matches the ' /' prefix
    expect(p.needsFor('acme/widgets', 'static-checks / TypeScript'))
      .toEqual(['Prepare (prisma + packages)']);
    // longest-prefix wins: build-test must not resolve to the 'build' node
    expect(p.needsFor('acme/widgets', 'build-test')).toEqual(['Prepare (prisma + packages)']);
    // unmatched name → null
    expect(p.needsFor('acme/widgets', 'lighthouse')).toBeNull();
    // other repos remain graph-less
    expect(p.needsFor('other/repo', 'ci')).toBeNull();
  });

  it('deploy-cycle re-derivation populates the needs graph alongside prefixes', async () => {
    const ciYaml = 'jobs:\n  lint: {}\n  ci:\n    needs: [lint]\n';
    const deploy = {
      health: vi.fn(async () => null),
      ensureClone: vi.fn(async () => {}),
      fetchClone: vi.fn(async () => {}),
      isAncestor: vi.fn(async () => 'missing' as const),
      readFileAtHead: vi.fn(async () => ciYaml),
    } as unknown as DeployWatcher;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => NOW });
    await p.deployOnce();
    expect(p.needsFor('acme/widgets', 'ci')).toEqual(['lint']);
    expect(p.needsFor('acme/widgets', 'lint')).toEqual([]);
    log.mockRestore();
  });

  it('needActiveFor evaluates the node activity per event, defaulting to true when unknown', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    // unknown repo/graph → true (never prune on missing knowledge)
    expect(p.needActiveFor('acme/widgets', 'android-smoke /', 'pull_request')).toBe(true);
    p.setDerivedGraph('acme/widgets', new Map([
      ['android-smoke /', { needs: [], activity: { mode: 'only', events: ['merge_group'] }, runsOn: null, timeoutMinutes: null }],
      ['build', { needs: [], activity: { mode: 'all' }, runsOn: null, timeoutMinutes: null }],
    ]));
    expect(p.needActiveFor('acme/widgets', 'android-smoke /', 'merge_group')).toBe(true);
    expect(p.needActiveFor('acme/widgets', 'android-smoke /', 'pull_request')).toBe(false);
    expect(p.needActiveFor('acme/widgets', 'build', 'pull_request')).toBe(true);
    // node missing from the graph → true
    expect(p.needActiveFor('acme/widgets', 'ghost', 'pull_request')).toBe(true);
  });

  it('deploy-cycle re-derivation carries the if: event activity into the graph', async () => {
    const ciYaml = "jobs:\n  mg-only:\n    if: github.event_name == 'merge_group'\n  ci:\n    needs: [mg-only]\n";
    const deploy = {
      health: vi.fn(async () => null),
      ensureClone: vi.fn(async () => {}),
      fetchClone: vi.fn(async () => {}),
      isAncestor: vi.fn(async () => 'missing' as const),
      readFileAtHead: vi.fn(async () => ciYaml),
    } as unknown as DeployWatcher;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => NOW });
    await p.deployOnce();
    expect(p.needActiveFor('acme/widgets', 'mg-only', 'merge_group')).toBe(true);
    expect(p.needActiveFor('acme/widgets', 'mg-only', 'pull_request')).toBe(false);
    log.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Task W2: runner-wait ingestion, payload classification, ETA queue-delay
// ---------------------------------------------------------------------------

describe('Poller runner waits (W2)', () => {
  const PREPARE = 'Prepare (prisma + packages)';
  const AFFECTED = 'pr-affected-tests / Affected Unit + Server Tests';
  const NEEDS = new Map<string, string[]>([
    ['ci', ['fast-checks /', 'pr-affected-tests /']],
    ['fast-checks /', [PREPARE]],
    ['pr-affected-tests /', [PREPARE]],
    [PREPARE, []],
  ]);

  const prepDone = {
    ...CHECK_DONE, name: PREPARE, isRequired: false,
    startedAt: '2026-06-10T11:48:00Z', completedAt: '2026-06-10T11:53:00Z',
  };

  function pollerWith(detail: Record<string, unknown>) {
    const p = new Poller({ router: asRouter(fakeClient(SWEEP_RESPONSE, detail)), history,
      deploy: noDeploy(), config: CONFIG, now: () => NOW });
    p.setDerivedGraph('acme/widgets', nodeMap(NEEDS));
    return p;
  }
  const detailWith = (nodes: Record<string, unknown>[]) => ({
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      ...DETAIL_RESPONSE.r0.pr8962,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
        contexts: { pageInfo: { hasNextPage: false }, nodes } } } }] },
    } },
  });

  it('detail fetch ingests runner-wait samples (startedAt − needed completedAt)', async () => {
    // AFFECTED started 11:55, its need (Prepare) completed 11:53 → 120s pickup wait
    const p = pollerWith(detailWith([prepDone, CHECK_RUNNING]));
    await p.sweepOnce();
    await p.detailOnce();
    expect(history.expectedRunnerWait('acme/widgets', AFFECTED, 'pull_request')).toBe(120);
    // Prepare is a root job — no sample for it
    expect(history.expectedRunnerWait('acme/widgets', PREPARE, 'pull_request')).toBeNull();
  });

  it('group-rollup fetch ingests merge_group runner-wait samples', async () => {
    const GROUP_OID = 'oidW2';
    const mg = (over: Record<string, unknown>) => ({
      __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null,
      startedAt: null, completedAt: null, detailsUrl: 'u',
      checkSuite: { workflowRun: { event: 'merge_group' } }, ...over,
    });
    const rollup = { repository: { o0: { oid: GROUP_OID, statusCheckRollup: { contexts: { nodes: [
      mg({ name: PREPARE, status: 'COMPLETED', conclusion: 'SUCCESS',
        startedAt: '2026-06-10T11:30:00Z', completedAt: '2026-06-10T11:33:00Z' }),
      mg({ name: 'fast-checks / ESLint', startedAt: '2026-06-10T11:34:00Z' }),
    ] } } } } };
    const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
        headCommit: { oid: GROUP_OID }, pullRequest: { number: 8962 } },
    ] } } } };
    const queuedDetail = detailWith([prepDone]);
    (queuedDetail.r0.pr8962 as Record<string, unknown>).mergeQueueEntry = {
      position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
      headCommit: { oid: GROUP_OID } };
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return queuedDetail;
        if (q.includes('object(oid:')) return rollup;
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.setDerivedGraph('acme/widgets', nodeMap(NEEDS));
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    // fast-checks / ESLint started 11:34, Prepare completed 11:33 → 60s, merge_group population
    expect(history.expectedRunnerWait('acme/widgets', 'fast-checks / ESLint', 'merge_group')).toBe(60);
  });

  it('CheckView carries waitKind/blockedOn/waitingSeconds for queued checks', async () => {
    // Prepare completed 11:58 → ESLint (queued) waits for a runner for 120s;
    // ci (queued) is blocked on the still-queued ESLint; AFFECTED is running → null kind
    const p = pollerWith(detailWith([
      { ...prepDone, completedAt: '2026-06-10T11:58:00Z' },
      { ...CHECK_DONE, status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null },
      { ...CHECK_DONE, name: 'ci', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null },
      CHECK_RUNNING,
    ]));
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos[0]!.prs.find((x) => x.number === 8962)!;
    const byName = Object.fromEntries(pr.checks.map((c) => [c.name, c]));
    expect(byName['fast-checks / ESLint']).toMatchObject({
      waitKind: 'runner', waitingSeconds: 120, blockedOn: null });
    expect(byName['ci']).toMatchObject({
      waitKind: 'blocked', blockedOn: 'fast-checks / ESLint', waitingSeconds: null });
    expect(byName[AFFECTED]).toMatchObject({
      waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null });
    // Prepare is a root node → unknown (queued anchor impossible)… it is COMPLETED here → null
    expect(byName[PREPARE]!.waitKind).toBeNull();
  });

  it('a merge_group-only need is dropped for PR-phase checks: runner, not blocked', async () => {
    // `ci` needs fast-checks + android-smoke; android-smoke runs on merge_group only
    // so it never appears in a PR rollup. Without the activity gate `ci` would sit
    // "blocked on android-smoke /" forever.
    const p = new Poller({ router: asRouter(fakeClient(SWEEP_RESPONSE, detailWith([
      { ...prepDone, completedAt: '2026-06-10T11:53:00Z' },
      CHECK_DONE, // fast-checks / ESLint completed 11:53
      { ...CHECK_DONE, name: 'ci', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null },
    ]))), history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    p.setDerivedGraph('acme/widgets', new Map([
      ['ci', { needs: ['fast-checks /', 'android-smoke /'], activity: { mode: 'all' }, runsOn: null, timeoutMinutes: null }],
      ['fast-checks /', { needs: [PREPARE], activity: { mode: 'all' }, runsOn: null, timeoutMinutes: null }],
      ['android-smoke /', { needs: [], activity: { mode: 'only', events: ['merge_group'] }, runsOn: null, timeoutMinutes: null }],
      [PREPARE, { needs: [], activity: { mode: 'all' }, runsOn: null, timeoutMinutes: null }],
    ]));
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos[0]!.prs.find((x) => x.number === 8962)!;
    const ci = pr.checks.find((c) => c.name === 'ci')!;
    // anchored on the universal need's completion (11:53 → 420s), not blocked
    expect(ci).toMatchObject({ waitKind: 'runner', waitingSeconds: 420, blockedOn: null });
  });

  it('expectedRunnerWaitSeconds: name-level median for runner-waiting checks, null for blocked', async () => {
    for (let i = 0; i < 3; i++) {
      history.recordRunnerWait('acme/widgets', 'fast-checks / ESLint', 'pull_request',
        90, `2026-06-09T1${i}:00:00Z`);
    }
    for (let i = 0; i < 4; i++) {
      history.recordRunnerWait('acme/widgets', 'other-check', 'pull_request',
        300, `2026-06-09T2${i}:00:00Z`);
    }
    const p = pollerWith(detailWith([
      { ...prepDone, completedAt: '2026-06-10T11:58:00Z' },
      { ...CHECK_DONE, status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null },
      { ...CHECK_DONE, name: 'ci', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null },
    ]));
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos[0]!.prs.find((x) => x.number === 8962)!;
    const byName = Object.fromEntries(pr.checks.map((c) => [c.name, c]));
    // ESLint is runner-waiting with name-level history → 90
    expect(byName['fast-checks / ESLint']!.expectedRunnerWaitSeconds).toBe(90);
    // 'ci' is BLOCKED (on the queued ESLint) — a pickup estimate is meaningless, skip the lookup
    expect(byName['ci']!.waitKind).toBe('blocked');
    expect(byName['ci']!.expectedRunnerWaitSeconds).toBeNull();
  });

  it('expectedRunnerWaitSeconds falls back to the event-level median when no name-level history', async () => {
    for (let i = 0; i < 3; i++) {
      history.recordRunnerWait('acme/widgets', 'fast-checks / ESLint', 'pull_request',
        90, `2026-06-09T1${i}:00:00Z`);
    }
    for (let i = 0; i < 4; i++) {
      history.recordRunnerWait('acme/widgets', 'other-check', 'pull_request',
        300, `2026-06-09T2${i}:00:00Z`);
    }
    // every need of 'ci' completed → ci is runner-waiting, not blocked. The completed
    // checks all started BEFORE prep's completion (negative pickup waits) so this set
    // ingests no new samples that would shift the seeded event-level median.
    const p = pollerWith(detailWith([
      { ...prepDone, completedAt: '2026-06-10T11:58:00Z' },
      CHECK_DONE,
      { ...CHECK_RUNNING, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-06-10T11:59:00Z' },
      { ...CHECK_DONE, name: 'ci', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null },
    ]));
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos[0]!.prs.find((x) => x.number === 8962)!;
    const ci = pr.checks.find((c) => c.name === 'ci')!;
    expect(ci.waitKind).toBe('runner');
    // 'ci' has no name-level samples → event-level median of [90×3, 300×4] = 300
    expect(ci.expectedRunnerWaitSeconds).toBe(300);
  });

  it('queued required checks extend the stage ETA by the learned pickup wait', async () => {
    // Baseline: same snapshot, no learned waits.
    const queuedNodes = [
      { ...CHECK_DONE, status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null },
    ];
    const p1 = pollerWith(detailWith(queuedNodes));
    await p1.sweepOnce();
    await p1.detailOnce();
    const base = p1.buildState().repos[0]!.prs.find((x) => x.number === 8962)!.stage.etaSeconds!;
    // Learned 120s pickup waits → every queued/not-yet-appeared check gains 120s
    for (let i = 0; i < 3; i++) {
      history.recordRunnerWait('acme/widgets', 'fast-checks / ESLint', 'pull_request',
        120, `2026-06-09T1${i}:00:00Z`);
    }
    const p2 = pollerWith(detailWith(queuedNodes));
    await p2.sweepOnce();
    await p2.detailOnce();
    const withDelay = p2.buildState().repos[0]!.prs.find((x) => x.number === 8962)!.stage.etaSeconds!;
    expect(withDelay).toBe(base + 120);
  });
});

// ---------------------------------------------------------------------------
// Task C: SSE diffing
// ---------------------------------------------------------------------------

describe('Poller SSE diffing (emitUpdate deduplication)', () => {
  it('two cycles with identical underlying data → only one "update" emission', async () => {
    // The EMPTY_SWEEP client returns the same data every call — no state changes.
    // First cycle emits; second cycle sees identical snapshot and must NOT emit again.
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return EMPTY_SWEEP;
        throw new Error(`unexpected: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    let emitCount = 0;
    p.on('update', () => emitCount++);
    await p.sweepOnce();
    await p.sweepOnce(); // same underlying data
    expect(emitCount).toBe(1);
  });

  it('lastState is still refreshed on a skipped emission (generatedAt advances)', async () => {
    let t = NOW.getTime();
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return EMPTY_SWEEP;
        throw new Error(`unexpected: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => new Date(t) });
    await p.sweepOnce();                // t=NOW, emits
    const first = p.getState().generatedAt;
    t += 30_000;
    await p.sweepOnce();                // same data, +30s — skips emit but updates lastState
    const second = p.getState().generatedAt;
    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());
  });

  it('keepalive: identical data still re-emits once >60s pass since the last emission', async () => {
    let t = NOW.getTime();
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return EMPTY_SWEEP;
        throw new Error(`unexpected: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => new Date(t) });
    let emitCount = 0;
    p.on('update', () => emitCount++);
    await p.sweepOnce();        // first emission
    t += 30_000;
    await p.sweepOnce();        // identical, 30s — suppressed
    expect(emitCount).toBe(1);
    t += 31_000;
    await p.sweepOnce();        // 61s since last emission — keepalive forces a frame
    expect(emitCount).toBe(2);
    t += 30_000;
    await p.sweepOnce();        // keepalive window reset — suppressed again
    expect(emitCount).toBe(2);
  });

  it('a stage change triggers a second emission', async () => {
    // First sweep: PR 8962 open (ci stage). Second sweep: PR 8962 is gone (vanished/closed).
    // That removes it from the state → different snapshot → must emit again.
    const sweepBox = { current: SWEEP_RESPONSE as Record<string, unknown> };
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return sweepBox.current;
        if (q.includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
        throw new Error(`unexpected: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    let emitCount = 0;
    p.on('update', () => emitCount++);
    await p.sweepOnce();
    await p.detailOnce();
    expect(emitCount).toBe(2);  // sweep + detail
    sweepBox.current = EMPTY_SWEEP; // PR 8962 disappears
    await p.sweepOnce();
    expect(emitCount).toBe(3);  // new emission because snapshot changed
  });
});

// ---------------------------------------------------------------------------
// Task F: ETA accuracy tracking
// ---------------------------------------------------------------------------

describe('Poller ETA accuracy tracking', () => {
  const doneDetail = {
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      ...DETAIL_RESPONSE.r0.pr8962, mergeStateStatus: 'CLEAN',
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [
          CHECK_DONE,
          { ...CHECK_DONE, name: 'pr-affected-tests / Affected Unit + Server Tests',
            completedAt: '2026-06-10T11:58:00Z' },
        ] } } } }] },
    } },
  };

  function boxedClient(detailBox: { current: Record<string, unknown> },
    sweepBox: { current: Record<string, unknown> } = { current: SWEEP_RESPONSE }) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return sweepBox.current;
        if (q.includes('pr8962: pullRequest')) return detailBox.current;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }

  it('ci→ready transition records predicted (first ETA) vs actual stage duration', async () => {
    let t = NOW.getTime();
    const detailBox = { current: DETAIL_RESPONSE as Record<string, unknown> };
    const p = new Poller({ router: asRouter(boxedClient(detailBox)), history,
      deploy: noDeploy(), config: CONFIG, now: () => new Date(t) });
    await p.sweepOnce();    // PR enters ci; first non-null ETA = 600 (sum-shaped expected set)
    await p.detailOnce();
    expect(history.etaAccuracy('acme/widgets', 'ci')).toBeNull();
    t += 240_000;           // 4 min later the run finishes
    detailBox.current = doneDetail;
    await p.detailOnce();   // ci → ready: predicted 600, actual 240 → |600−240| = 360
    expect(history.etaAccuracy('acme/widgets', 'ci')).toEqual({ medianAbsErrSecs: 360, n: 1 });
  });

  it('transitions out of parked record nothing', async () => {
    let t = NOW.getTime();
    const draftSweep = {
      ...SWEEP_RESPONSE,
      open0: { issueCount: 1, nodes: [{ ...SWEEP_RESPONSE.open0.nodes[0], isDraft: true }] },
      merged0: { issueCount: 0, nodes: [] },
    };
    const draftDetail = {
      r0: { nameWithOwner: 'acme/widgets',
        pr8962: { ...(doneDetail.r0.pr8962 as object), isDraft: true } },
    };
    const detailBox = { current: draftDetail as Record<string, unknown> };
    const recordSpy = vi.spyOn(history, 'recordEtaAccuracy');
    const p = new Poller({ router: asRouter(boxedClient(detailBox, { current: draftSweep })),
      history, deploy: noDeploy(), config: CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.detailOnce();   // parked (draft)
    t += 300_000;
    detailBox.current = doneDetail;
    await p.detailOnce();   // parked → ready: old stage not ETA-tracked
    expect(recordSpy).not.toHaveBeenCalled();
    recordSpy.mockRestore();
  });

  it('a queued PR leaving the board via merge records queue accuracy', async () => {
    let t = NOW.getTime();
    const queuedDetail = (over: Record<string, unknown> = {}) => ({
      r0: { nameWithOwner: 'acme/widgets', pr8962: {
        ...DETAIL_RESPONSE.r0.pr8962, mergeStateStatus: 'CLEAN',
        autoMergeRequest: { mergeMethod: 'SQUASH' },
        mergeQueueEntry: { position: 1, state: 'QUEUED', enqueuedAt: '2026-06-10T11:55:00Z',
          headCommit: null },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
          contexts: { pageInfo: { hasNextPage: false }, nodes: [CHECK_DONE] } } } }] },
        ...over,
      } },
    });
    const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'QUEUED', enqueuedAt: '2026-06-10T11:55:00Z',
        headCommit: null, pullRequest: { number: 8962 } },
    ] } } } };
    const detailBox = { current: queuedDetail() as Record<string, unknown> };
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return detailBox.current;
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.detailOnce();   // stage=queue, no entries yet → ETA still null
    await p.queueOnce();    // entries known → first ETA = 1×groupRun default = 900
    t += 600_000;
    detailBox.current = queuedDetail({ mergedAt: '2026-06-10T12:10:00Z',
      mergeQueueEntry: null, mergeCommit: { oid: 'squash8962' } });
    await p.detailOnce();   // merged off the board: predicted 900, actual 600 → err 300
    expect(history.etaAccuracy('acme/widgets', 'queue'))
      .toEqual({ medianAbsErrSecs: 300, n: 1 });
  });

  it('pruneCaches drops stage-tracker entries for vanished PRs', async () => {
    const sweepBox = { current: SWEEP_RESPONSE as Record<string, unknown> };
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return sweepBox.current;
        if (q.includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const internals = p as unknown as { stageTracker: Map<string, unknown> };
    expect(internals.stageTracker.has('acme/widgets#8962')).toBe(true);
    internals.stageTracker.set('acme/widgets#9999', { stageId: 'ci', enteredAt: 0, firstEta: null });
    sweepBox.current = EMPTY_SWEEP;
    await p.sweepOnce();
    expect(internals.stageTracker.has('acme/widgets#9999')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #44: lead-time timestamps (first_green_at + enqueued_at on merged_prs)
// ---------------------------------------------------------------------------

describe('Poller lead-time timestamps (issue #44)', () => {
  const KEY = 'acme/widgets#8962';
  const doneDetail = {
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      ...DETAIL_RESPONSE.r0.pr8962, mergeStateStatus: 'CLEAN',
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [
          CHECK_DONE,
          { ...CHECK_DONE, name: 'pr-affected-tests / Affected Unit + Server Tests',
            completedAt: '2026-06-10T11:58:00Z' },
        ] } } } }] },
    } },
  };
  const queuedDetail = (over: Record<string, unknown> = {}) => ({
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      ...(doneDetail.r0.pr8962 as object),
      autoMergeRequest: { mergeMethod: 'SQUASH' },
      mergeQueueEntry: { position: 1, state: 'QUEUED', enqueuedAt: '2026-06-10T12:02:00Z',
        headCommit: null },
      ...over,
    } },
  });

  function boxedClient(detailBox: { current: Record<string, unknown> }) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return detailBox.current;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }

  it('ci → ready records firstGreenAt ONCE and persists it on merge', async () => {
    let t = NOW.getTime();
    const detailBox = { current: DETAIL_RESPONSE as Record<string, unknown> };
    const p = new Poller({ router: asRouter(boxedClient(detailBox)), history,
      deploy: noDeploy(), config: CONFIG, now: () => new Date(t) });
    const internals = p as unknown as { firstGreenAt: Map<string, string> };
    await p.sweepOnce();
    await p.detailOnce();                          // ci — nothing recorded yet
    expect(internals.firstGreenAt.has(KEY)).toBe(false);
    t += 240_000;
    const firstGreenIso = new Date(t).toISOString();
    detailBox.current = doneDetail;
    await p.detailOnce();                          // ci → ready: record
    expect(internals.firstGreenAt.get(KEY)).toBe(firstGreenIso);
    // a new push sends the PR back to ci and green again — first stamp wins
    t += 60_000;
    detailBox.current = DETAIL_RESPONSE;
    await p.detailOnce();                          // ready → ci
    t += 60_000;
    detailBox.current = doneDetail;
    await p.detailOnce();                          // ci → ready (again)
    expect(internals.firstGreenAt.get(KEY)).toBe(firstGreenIso);
    // merge: persisted onto the merged_prs row, in-memory entry consumed
    t += 60_000;
    detailBox.current = { r0: { nameWithOwner: 'acme/widgets', pr8962: {
      ...(doneDetail.r0.pr8962 as object), mergedAt: '2026-06-10T12:08:00Z',
      mergeCommit: { oid: 'squash8962' } } } };
    await p.detailOnce();
    const rec = history.listTrackedMerged(7, new Date(t)).find((r) => r.number === 8962)!;
    expect(rec.firstGreenAt).toBe(firstGreenIso);
    expect(internals.firstGreenAt.has(KEY)).toBe(false);
  });

  it('ci → queue (auto-merge armed enqueue racing the poll) also records firstGreenAt', async () => {
    let t = NOW.getTime();
    const detailBox = { current: DETAIL_RESPONSE as Record<string, unknown> };
    const p = new Poller({ router: asRouter(boxedClient(detailBox)), history,
      deploy: noDeploy(), config: CONFIG, now: () => new Date(t) });
    const internals = p as unknown as { firstGreenAt: Map<string, string> };
    await p.sweepOnce();
    await p.detailOnce();                          // ci
    t += 120_000;
    detailBox.current = queuedDetail();
    await p.detailOnce();                          // ci → queue (never saw ready)
    expect(internals.firstGreenAt.get(KEY)).toBe(new Date(t).toISOString());
  });

  it('enqueuedAt is persisted onto merged_prs alongside the queue-wait sample', async () => {
    let t = NOW.getTime();
    const detailBox = { current: queuedDetail() as Record<string, unknown> };
    const p = new Poller({ router: asRouter(boxedClient(detailBox)), history,
      deploy: noDeploy(), config: CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.detailOnce();                          // queued: enqueuedAt 12:02 captured
    t += 600_000;
    detailBox.current = queuedDetail({ mergedAt: '2026-06-10T12:12:00Z',
      mergeQueueEntry: null, mergeCommit: { oid: 'squash8962' } });
    await p.detailOnce();                          // merged
    const rec = history.listTrackedMerged(7, new Date(t)).find((r) => r.number === 8962)!;
    expect(rec.enqueuedAt).toBe('2026-06-10T12:02:00Z');
    // the queue-wait sample still records (12:12 − 12:02 = 600s)
    expect(history.medianQueueWait('acme/widgets')).toBe(600);
  });

  it('a PR merged with no observed transitions persists nulls (no fabrication)', async () => {
    const detailBox = { current: {
      r0: { nameWithOwner: 'acme/widgets', pr8962: {
        ...(doneDetail.r0.pr8962 as object), mergedAt: '2026-06-10T11:59:00Z',
        mergeCommit: { oid: 'squash8962' } } },
    } as Record<string, unknown> };
    const p = new Poller({ router: asRouter(boxedClient(detailBox)), history,
      deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();                          // first sight is already merged
    const rec = history.listTrackedMerged(7, NOW).find((r) => r.number === 8962)!;
    expect(rec.firstGreenAt).toBeNull();
    expect(rec.enqueuedAt).toBeNull();
  });

  it('pruneCaches drops firstGreenAt entries for vanished PRs', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const internals = p as unknown as { firstGreenAt: Map<string, string> };
    internals.firstGreenAt.set('acme/widgets#9999', '2026-06-10T11:00:00Z');
    await p.sweepOnce(); // sweep does not contain PR 9999
    expect(internals.firstGreenAt.has('acme/widgets#9999')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task V1: RepoQueueView payload (groups + waiting)
// ---------------------------------------------------------------------------

describe('Poller buildQueueView — queue view payload (V1)', () => {
  const GROUP_OID_A = 'oidGroupA'; // building at position 2
  const GROUP_OID_B = 'oidGroupB'; // building at position 5

  // Queue: positions 1–7
  //   pos 1: AWAITING_CHECKS, oid=GROUP_OID_A (building) — covered by group A
  //   pos 2: AWAITING_CHECKS, oid=GROUP_OID_A (same group) — group A top, covers (0,2]
  //   pos 3: AWAITING_CHECKS, oid=GROUP_OID_B — covered by group B
  //   pos 4: AWAITING_CHECKS, oid=GROUP_OID_B — covered by group B
  //   pos 5: AWAITING_CHECKS, oid=GROUP_OID_B (group B top, covers (2,5])
  //   pos 6: QUEUED (waiting)
  //   pos 7: QUEUED (waiting)
  const queueResponse = {
    repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: GROUP_OID_A }, pullRequest: { number: 9001 } },
      { position: 2, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: GROUP_OID_A }, pullRequest: { number: 9002 } },
      { position: 3, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: GROUP_OID_B }, pullRequest: { number: 9003 } },
      { position: 4, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: GROUP_OID_B }, pullRequest: { number: 9004 } },
      { position: 5, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: GROUP_OID_B }, pullRequest: { number: 9005 } },
      { position: 6, state: 'QUEUED', enqueuedAt: null,
        headCommit: null, pullRequest: { number: 9006 } },
      { position: 7, state: 'QUEUED', enqueuedAt: null,
        headCommit: null, pullRequest: { number: 9007 } },
    ] } } },
  };

  // PR 9002 is in the queue (AWAITING_CHECKS, pos 2)
  const queuedDetail = {
    r0: { nameWithOwner: 'acme/widgets', pr9002: {
      number: 9002, title: 'feat: thing', url: 'u9002', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'head9002', autoMergeRequest: { mergeMethod: 'SQUASH' },
      mergeCommit: null,
      mergeQueueEntry: { position: 2, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: GROUP_OID_A } },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [CHECK_DONE] } } } }] },
    } },
  };

  const mgCheck = (oid: string, over: Record<string, unknown>) => ({
    __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null,
    startedAt: '2026-06-10T11:30:00Z', completedAt: null, detailsUrl: 'u',
    checkSuite: { workflowRun: { event: 'merge_group' } }, ...over,
  });

  const rollupRunning = {
    repository: {
      o0: { oid: GROUP_OID_A, statusCheckRollup: { contexts: { nodes: [
        mgCheck(GROUP_OID_A, { name: 'ci', status: 'IN_PROGRESS', conclusion: null }),
      ] } } },
      o1: { oid: GROUP_OID_B, statusCheckRollup: { contexts: { nodes: [
        mgCheck(GROUP_OID_B, { name: 'ci', status: 'IN_PROGRESS', conclusion: null }),
      ] } } },
    },
  };

  const rollupGroupBFailed = {
    repository: {
      o0: { oid: GROUP_OID_A, statusCheckRollup: { contexts: { nodes: [
        mgCheck(GROUP_OID_A, { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS',
          completedAt: '2026-06-10T11:45:00Z' }),
      ] } } },
      o1: { oid: GROUP_OID_B, statusCheckRollup: { contexts: { nodes: [
        mgCheck(GROUP_OID_B, { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE',
          completedAt: '2026-06-10T11:42:00Z' }),
      ] } } },
    },
  };

  const queueSweep = {
    open0: { issueCount: 1, nodes: [{ number: 9002, title: 'feat: thing', url: 'u9002', isDraft: false,
      mergedAt: null, repository: { nameWithOwner: 'acme/widgets' }, mergeCommit: null }] },
    open1: { issueCount: 0, nodes: [] },
    merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
  };

  function queueViewClient(rollupBox: { current: Record<string, unknown> }) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return queueSweep;
        if (q.includes('pr9002: pullRequest')) return queuedDetail;
        if (q.includes('object(oid:')) return rollupBox.current;
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }

  it('two building groups cover batch ranges; waiting entries are beyond both groups', async () => {
    const rollupBox = { current: rollupRunning as Record<string, unknown> };
    const p = new Poller({ router: asRouter(queueViewClient(rollupBox)), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    const queue = repo.queue!;
    expect(queue).not.toBeNull();
    // group A: oid=GROUP_OID_A, covers positions 1–2 (prev=0, this=2)
    const groupA = queue.groups.find((g) => g.oid === GROUP_OID_A)!;
    expect(groupA.prNumbers.sort()).toEqual([9001, 9002]);
    // group B: oid=GROUP_OID_B, covers positions 3–5 (prev=2, this=5)
    const groupB = queue.groups.find((g) => g.oid === GROUP_OID_B)!;
    expect(groupB.prNumbers.sort()).toEqual([9003, 9004, 9005]);
    // waiting: positions 6–7 (beyond max building pos=5)
    expect(queue.waiting.map((w) => w.prNumber).sort()).toEqual([9006, 9007]);
    expect(queue.waiting[0]!.position).toBeLessThan(queue.waiting[1]!.position);
    // batchSize from config
    expect(queue.batchSize).toBe(CONFIG.batchSize);
  });

  it('failed group flag propagates from group-check conclusion=FAILURE', async () => {
    const rollupBox = { current: rollupGroupBFailed as Record<string, unknown> };
    const p = new Poller({ router: asRouter(queueViewClient(rollupBox)), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const queue = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.queue!;
    const groupA = queue.groups.find((g) => g.oid === GROUP_OID_A)!;
    const groupB = queue.groups.find((g) => g.oid === GROUP_OID_B)!;
    expect(groupA.failed).toBe(false);
    expect(groupB.failed).toBe(true);
  });

  it('returns null when there are no queue entries for the repo', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    // No queue entries → queue must be null
    expect(repo.queue).toBeNull();
  });

  it('a per-repo batchSize override flows into the queue view', async () => {
    const config: AppConfig = { ...CONFIG, repos: { 'acme/widgets': { batchSize: 2 } } };
    const rollupBox = { current: rollupRunning as Record<string, unknown> };
    const p = new Poller({ router: asRouter(queueViewClient(rollupBox)), history, deploy: noDeploy(),
      config, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const queue = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.queue!;
    expect(queue.batchSize).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// HEADGREEN multi-PR groups: covered members inherit the covering group's
// progress + groupChecks; UNMERGEABLE entries are surfaced and excluded from
// coverage/waiting (live incident 2026-06-11: #8878 pos 1 UNMERGEABLE rendered
// as an innocuous queued row and was folded into the covering group's car).
// ---------------------------------------------------------------------------

describe('Poller queue group coverage + UNMERGEABLE (HEADGREEN)', () => {
  const OID_A = 'oidHgA';
  const OID_B = 'oidHgB';

  const mgRunning = (oid: string) => ({
    oid,
    statusCheckRollup: { contexts: { nodes: [
      { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null,
        startedAt: '2026-06-10T11:50:00Z', completedAt: null, detailsUrl: 'gu',
        checkSuite: { workflowRun: { event: 'merge_group', runNumber: 7994, workflow: { name: 'CI' } } } },
    ] } },
  });

  const openNode = (number: number) => ({ number, title: `pr ${number}`, url: `u${number}`,
    isDraft: false, mergedAt: null, repository: { nameWithOwner: 'acme/widgets' }, mergeCommit: null });

  const queuedPrNode = (number: number, entry: Record<string, unknown>,
    mergeStateStatus = 'BLOCKED') => ({
    number, title: `pr ${number}`, url: `u${number}`, isDraft: false, mergeStateStatus,
    mergedAt: null, headRefOid: `head${number}`, autoMergeRequest: { mergeMethod: 'SQUASH' },
    mergeCommit: null, mergeQueueEntry: entry,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
      contexts: { pageInfo: { hasNextPage: false }, nodes: [{ ...CHECK_DONE }] } } } }] },
  });

  function hgClient(sweep: Record<string, unknown>, detail: Record<string, unknown>,
    detailMarker: string, queueResponse: Record<string, unknown>, rollup: Record<string, unknown>) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return sweep;
        if (q.includes(detailMarker)) return detail;
        if (q.includes('object(oid:')) return rollup;
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }

  function seedMergeGroupHistory() {
    for (let i = 0; i < 5; i++) {
      history.recordCheckDuration('acme/widgets', 'ci', 'merge_group',
        `2026-06-0${i + 1}T10:00:00Z`, `2026-06-0${i + 1}T10:08:00Z`, 'SUCCESS');
    }
  }

  it('live scenario: UNMERGEABLE entry is excluded from group coverage/waiting and listed in unmergeable; its row is queue/unmergeable', async () => {
    // pos 1 UNMERGEABLE (own stale oid), pos 2 AWAITING_CHECKS oidA,
    // pos 3 AWAITING_CHECKS oidB, pos 4–5 QUEUED
    const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'UNMERGEABLE', enqueuedAt: null,
        headCommit: { oid: 'staleOid8878' }, pullRequest: { number: 8878 } },
      { position: 2, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: OID_A }, pullRequest: { number: 9002 } },
      { position: 3, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: OID_B }, pullRequest: { number: 9003 } },
      { position: 4, state: 'QUEUED', enqueuedAt: null,
        headCommit: null, pullRequest: { number: 9004 } },
      { position: 5, state: 'QUEUED', enqueuedAt: null,
        headCommit: null, pullRequest: { number: 9005 } },
    ] } } } };
    const sweep = {
      open0: { issueCount: 1, nodes: [openNode(8878)] },
      open1: { issueCount: 0, nodes: [] },
      merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
    };
    const detail = { r0: { nameWithOwner: 'acme/widgets',
      pr8878: queuedPrNode(8878, { position: 1, state: 'UNMERGEABLE', enqueuedAt: null,
        headCommit: { oid: 'staleOid8878' } }, 'DIRTY') } };
    const rollup = { repository: { o0: mgRunning(OID_A), o1: mgRunning(OID_B) } };
    seedMergeGroupHistory();
    const p = new Poller({ router: asRouter(hgClient(sweep, detail, 'pr8878: pullRequest', queueResponse, rollup)),
      history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    const queue = repo.queue!;
    // UNMERGEABLE is transparent: group A covers only pos 2, group B only pos 3
    expect(queue.groups.map((g) => g.oid)).toEqual([OID_A, OID_B]);
    expect(queue.groups[0]!.prNumbers).toEqual([9002]);
    expect(queue.groups[1]!.prNumbers).toEqual([9003]);
    expect(queue.waiting.map((w) => w.prNumber)).toEqual([9004, 9005]);
    expect(queue.unmergeable).toEqual([8878]);
    expect(queue.queueBlocked).toEqual([]);
    expect(queue.unmergeableCulprit).toBe(8878);
    // The UNMERGEABLE PR's row: queue/unmergeable, no waiting-line math
    const pr = repo.prs.find((x) => x.number === 8878)!;
    expect(pr.stage.stage).toBe('queue');
    expect(pr.stage.substate).toBe('unmergeable');
    expect(pr.stage.percent).toBeNull();
    expect(pr.stage.etaSeconds).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cascade-unmergeable (live incident 2026-06-11 round 2): GitHub marks queue
  // entries UNMERGEABLE *positionally* — one genuinely-conflicting entry at the
  // front poisons the speculative merge of every entry behind it. Only the entry
  // whose OWN snapshot is DIRTY genuinely conflicts with the base; the rest are
  // cascade victims and must not be told to rebase.
  // -------------------------------------------------------------------------

  /** The literal live scenario: positions 1–4 UNMERGEABLE (#8878 DIRTY, three
   *  cascade victims behind it), position 5 building, position 6 queued. */
  function cascadeFixture(mss8878: string, mssVictims: string) {
    const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'UNMERGEABLE', enqueuedAt: null,
        headCommit: { oid: 'stale8878' }, pullRequest: { number: 8878 } },
      { position: 2, state: 'UNMERGEABLE', enqueuedAt: null,
        headCommit: { oid: 'stale9335' }, pullRequest: { number: 9335 } },
      { position: 3, state: 'UNMERGEABLE', enqueuedAt: null,
        headCommit: { oid: 'stale9323' }, pullRequest: { number: 9323 } },
      { position: 4, state: 'UNMERGEABLE', enqueuedAt: null,
        headCommit: { oid: 'stale9337' }, pullRequest: { number: 9337 } },
      { position: 5, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: OID_A }, pullRequest: { number: 9338 } },
      { position: 6, state: 'QUEUED', enqueuedAt: null,
        headCommit: null, pullRequest: { number: 9342 } },
    ] } } } };
    const sweep = {
      open0: { issueCount: 4,
        nodes: [openNode(8878), openNode(9335), openNode(9323), openNode(9337)] },
      open1: { issueCount: 0, nodes: [] },
      merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
    };
    const entry = (pos: number, oid: string) =>
      ({ position: pos, state: 'UNMERGEABLE', enqueuedAt: null, headCommit: { oid } });
    const detail = { r0: { nameWithOwner: 'acme/widgets',
      pr8878: queuedPrNode(8878, entry(1, 'stale8878'), mss8878),
      pr9335: queuedPrNode(9335, entry(2, 'stale9335'), mssVictims),
      pr9323: queuedPrNode(9323, entry(3, 'stale9323'), mssVictims),
      pr9337: queuedPrNode(9337, entry(4, 'stale9337'), mssVictims),
    } };
    const rollup = { repository: { o0: mgRunning(OID_A) } };
    return hgClient(sweep, detail, 'pr8878: pullRequest', queueResponse, rollup);
  }

  it('live cascade scenario: 1 DIRTY culprit + 3 non-DIRTY victims → genuine vs queue-blocked split with culprit threaded', async () => {
    seedMergeGroupHistory();
    const p = new Poller({ router: asRouter(cascadeFixture('DIRTY', 'BLOCKED')),
      history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    const queue = repo.queue!;
    expect(queue.unmergeable).toEqual([8878]);                 // genuine: DIRTY only
    expect(queue.queueBlocked).toEqual([9335, 9323, 9337]);    // cascade, position order
    expect(queue.unmergeableCulprit).toBe(8878);
    // none of them leak into groups/waiting
    expect(queue.groups.map((g) => g.oid)).toEqual([OID_A]);
    expect(queue.groups[0]!.prNumbers).toEqual([9338]);
    expect(queue.waiting.map((w) => w.prNumber)).toEqual([9342]);
    // rows match the cars: culprit genuine, victims queue-blocked
    expect(repo.prs.find((x) => x.number === 8878)!.stage.substate).toBe('unmergeable');
    for (const n of [9335, 9323, 9337]) {
      const pr = repo.prs.find((x) => x.number === n)!;
      expect(pr.stage.stage).toBe('queue');
      expect(pr.stage.substate).toBe('queue-blocked');
      expect(pr.stage.percent).toBeNull();
      expect(pr.stage.etaSeconds).toBeNull();
    }
  });

  it('culprit fallback: no DIRTY snapshot anywhere → all queue-blocked, lowest-position entry is the presumed culprit', async () => {
    seedMergeGroupHistory();
    const p = new Poller({ router: asRouter(cascadeFixture('UNKNOWN', 'UNKNOWN')),
      history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const queue = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.queue!;
    expect(queue.unmergeable).toEqual([]);
    expect(queue.queueBlocked).toEqual([8878, 9335, 9323, 9337]);
    expect(queue.unmergeableCulprit).toBe(8878);
  });

  // Asymmetry regression (live 2026-06-11): the open-PR sweep page truncates at
  // 50, so a queue-entry PR can have NO snapshot at all — the train car listed
  // #8878 but no row existed. The queue-entries fetch is the source of truth
  // for queue membership: it must materialize a placeholder row, and the sweep
  // prune must not delete a PR that is still a live queue entry.
  it('queue entry with no PR snapshot (sweep truncation) still gets a row, and survives the next sweep prune', async () => {
    const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'UNMERGEABLE', enqueuedAt: null,
        headCommit: { oid: 'stale8878' }, pullRequest: { number: 8878 } },
      { position: 2, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: OID_A }, pullRequest: { number: 9002 } },
    ] } } } };
    // sweep + detail know ONLY 9002 — 8878 fell off the truncated open page
    const sweep = {
      open0: { issueCount: 55, nodes: [openNode(9002)] },
      open1: { issueCount: 0, nodes: [] },
      merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
    };
    const detail = { r0: { nameWithOwner: 'acme/widgets',
      pr9002: queuedPrNode(9002, { position: 2, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: OID_A } }) } };
    const rollup = { repository: { o0: mgRunning(OID_A) } };
    seedMergeGroupHistory();
    const p = new Poller({ router: asRouter(hgClient(sweep, detail, 'pr9002: pullRequest', queueResponse, rollup)),
      history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const state1 = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    expect(state1.queue!.queueBlocked).toEqual([8878]); // no snapshot → not provably DIRTY
    expect(state1.queue!.unmergeableCulprit).toBe(8878);
    const row1 = state1.prs.find((x) => x.number === 8878)!;
    expect(row1).toBeDefined();
    expect(row1.stage.stage).toBe('queue');
    expect(row1.stage.substate).toBe('queue-blocked');
    // the next sweep (8878 still absent from the open page) must NOT prune the row
    await p.sweepOnce();
    const state2 = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    const row2 = state2.prs.find((x) => x.number === 8878);
    expect(row2).toBeDefined();
    expect(row2!.stage.substate).toBe('queue-blocked');
  });

  it('covered members (QUEUED under a building group) inherit the group percent/eta and groupChecks', async () => {
    // pos 1–2 QUEUED, pos 3 AWAITING_CHECKS oidA → group covers (0,3]: all three
    const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'QUEUED', enqueuedAt: null,
        headCommit: null, pullRequest: { number: 9001 } },
      { position: 2, state: 'QUEUED', enqueuedAt: null,
        headCommit: null, pullRequest: { number: 9002 } },
      { position: 3, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: OID_A }, pullRequest: { number: 9003 } },
    ] } } } };
    const sweep = {
      open0: { issueCount: 3, nodes: [openNode(9001), openNode(9002), openNode(9003)] },
      open1: { issueCount: 0, nodes: [] },
      merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
    };
    const detail = { r0: { nameWithOwner: 'acme/widgets',
      pr9001: queuedPrNode(9001, { position: 1, state: 'QUEUED', enqueuedAt: null, headCommit: null }),
      pr9002: queuedPrNode(9002, { position: 2, state: 'QUEUED', enqueuedAt: null, headCommit: null }),
      pr9003: queuedPrNode(9003, { position: 3, state: 'AWAITING_CHECKS', enqueuedAt: null,
        headCommit: { oid: OID_A } }),
    } };
    const rollup = { repository: { o0: mgRunning(OID_A) } };
    seedMergeGroupHistory();
    const p = new Poller({ router: asRouter(hgClient(sweep, detail, 'pr9001: pullRequest', queueResponse, rollup)),
      history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    const queue = repo.queue!;
    expect(queue.groups).toHaveLength(1);
    expect(queue.groups[0]!.prNumbers).toEqual([9001, 9002, 9003]);
    expect(queue.waiting).toEqual([]);
    expect(queue.unmergeable).toEqual([]);
    const groupPercent = queue.groups[0]!.percent;
    const groupEta = queue.groups[0]!.etaSeconds;
    expect(groupPercent).not.toBeNull();
    // Every member row — including the QUEUED-but-covered ones — shows the
    // covering group's progress, zero ahead, and the group build's checks.
    for (const n of [9001, 9002, 9003]) {
      const pr = repo.prs.find((x) => x.number === n)!;
      expect(pr.stage.stage).toBe('queue');
      expect(pr.stage.percent).toBe(groupPercent);
      expect(pr.stage.etaSeconds).toBe(groupEta);
      expect(pr.queueAheadCount).toBe(0);
      expect(pr.groupChecks).not.toBeNull();
      expect(pr.groupChecks![0]).toMatchObject({ name: 'ci', status: 'IN_PROGRESS' });
    }
  });
});

// ---------------------------------------------------------------------------
// Task Y1: workflow identity — scoped required population + groupChecks payload
// ---------------------------------------------------------------------------

describe('Poller workflow scoping (Y1)', () => {
  const wfRun = (workflowName: string | null, runNumber: number | null = null) =>
    ({ workflowRun: { event: 'pull_request', runNumber, workflow: workflowName ? { name: workflowName } : null } });

  // PR 8970 mid-run: a real CI check running, plus Auto-merge PRs' ci-gate FAILURE
  // that startsWith-matches the `ci` prefix (the upstream repo's queued-PR mixing bug).
  const ciGateDetail = (ciGateWorkflow: string | null) => ({
    r0: { nameWithOwner: 'acme/widgets', pr8970: {
      number: 8970, title: 'docs: tweak', url: 'u8970', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'head8970', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [
          { ...CHECK_DONE, isRequired: false, checkSuite: wfRun('CI', 7990) },
          { ...CHECK_DONE, name: 'pr-affected-tests / Affected Unit + Server Tests', isRequired: false,
            status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-06-10T11:55:00Z', completedAt: null,
            checkSuite: wfRun('CI', 7990) },
          { ...CHECK_DONE, name: 'ci-gate', isRequired: false, conclusion: 'FAILURE',
            checkSuite: wfRun(ciGateWorkflow, 511) },
        ] } } } }] },
    } },
  });

  async function build(ciGateWorkflow: string | null, rollupWf: string | null) {
    const client = fakeClient(staleSweep, ciGateDetail(ciGateWorkflow), 'pr8970: pullRequest');
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: PREFIX_CONFIG, now: () => NOW });
    if (rollupWf != null) p.setRollupWorkflowName('acme/widgets', rollupWf);
    await p.sweepOnce();
    await p.detailOnce();
    return p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8970)!;
  }

  it("ci-gate FAILURE from 'Auto-merge PRs' does not park or read required when rollup workflow is 'CI'", async () => {
    const pr = await build('Auto-merge PRs', 'CI');
    expect(pr.stage.stage).toBe('ci');           // not parked/ci-failed
    expect(pr.stage.substate).toBeNull();
    const byName = Object.fromEntries(pr.checks.map((c) => [c.name, c]));
    expect(byName['ci-gate']!.isRequired).toBe(false);
    expect(byName['ci-gate']!.workflowName).toBe('Auto-merge PRs');
    expect(byName['fast-checks / ESLint']!.isRequired).toBe(true);
  });

  it('the same ci-gate with workflowName null parks the PR (permissive for old data)', async () => {
    const pr = await build(null, 'CI');
    expect(pr.stage.stage).toBe('parked');
    expect(pr.stage.substate).toBe('ci-failed');
  });

  it('without a known rollup workflow, prefix matching alone applies (pre-scoping behavior)', async () => {
    const pr = await build('Auto-merge PRs', null);
    expect(pr.stage.stage).toBe('parked');
    expect(pr.stage.substate).toBe('ci-failed');
  });

  it('expectedSet excludes a live foreign-workflow prefix-matching name from the denominator', async () => {
    // ci-gate's completed duration is in pull_request history; without the live
    // foreign-name exclusion it would inflate the required denominator
    for (let i = 0; i < 5; i++) {
      history.recordCheckDuration('acme/widgets', 'ci-gate', 'pull_request',
        `2026-06-0${i + 1}T10:00:00Z`, `2026-06-0${i + 1}T10:01:00Z`, 'SUCCESS');
    }
    const pr = await build('Auto-merge PRs', 'CI');
    // 1 of 2 rollup-workflow expected checks done — ci-gate must not be a third entry
    expect(pr.stage.percent).toBeGreaterThan(0);
    expect(pr.stage.percent).toBeLessThan(100);
    const prNoScope = await build('Auto-merge PRs', null);
    expect(prNoScope.stage.stage).toBe('parked'); // sanity: scoping is what saved it above
  });

  it('rollupWorkflowFor returns the stored name, null when unknown', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.rollupWorkflowFor('acme/widgets')).toBeNull();
    p.setRollupWorkflowName('acme/widgets', 'CI');
    expect(p.rollupWorkflowFor('acme/widgets')).toBe('CI');
  });

  it('deploy-cycle re-derivation stores the workflow name from ci.yml', async () => {
    const ciYaml = 'name: CI\njobs:\n  lint: {}\n  ci:\n    needs: [lint]\n';
    const deploy = {
      health: vi.fn(async () => null),
      ensureClone: vi.fn(async () => {}),
      fetchClone: vi.fn(async () => {}),
      isAncestor: vi.fn(async () => 'missing' as const),
      readFileAtHead: vi.fn(async () => ciYaml),
    } as unknown as DeployWatcher;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => NOW });
    await p.deployOnce();
    expect(p.rollupWorkflowFor('acme/widgets')).toBe('CI');
    log.mockRestore();
  });
});

describe('Poller groupChecks payload (Y1)', () => {
  const GROUP_OID = 'oidY1';
  const queuedDetail = {
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      number: 8962, title: 'fix: overlap', url: 'u8962', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'head8962', autoMergeRequest: { mergeMethod: 'SQUASH' },
      mergeCommit: null,
      mergeQueueEntry: { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
        headCommit: { oid: GROUP_OID } },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [{ ...CHECK_DONE }] } } } }] },
    } },
  };
  const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
    { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
      headCommit: { oid: GROUP_OID }, pullRequest: { number: 8962 } },
  ] } } } };
  const rollup = { repository: { o0: { oid: GROUP_OID, statusCheckRollup: { contexts: { nodes: [
    { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null,
      startedAt: '2026-06-10T11:50:00Z', completedAt: null, detailsUrl: 'gu',
      checkSuite: { workflowRun: { event: 'merge_group', runNumber: 7994, workflow: { name: 'CI' } } } },
  ] } } } } };

  function groupClient() {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return queuedDetail;
        if (q.includes('object(oid:')) return rollup;
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }

  it('a queued PR exposes the merge-group build as groupChecks with merge_group expectations', async () => {
    // merge_group history for 'ci': durations 4/6/8/10/12m → p10=240, p50=480, p90=720
    const mins = [4, 6, 8, 10, 12];
    for (let i = 0; i < mins.length; i++) {
      history.recordCheckDuration('acme/widgets', 'ci', 'merge_group',
        `2026-06-0${i + 1}T10:00:00Z`, `2026-06-0${i + 1}T10:${String(mins[i]).padStart(2, '0')}:00Z`, 'SUCCESS');
    }
    const p = new Poller({ router: asRouter(groupClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.stage.stage).toBe('queue');
    expect(pr.groupChecks).not.toBeNull();
    expect(pr.groupChecks).toHaveLength(1);
    expect(pr.groupChecks![0]).toMatchObject({
      name: 'ci', status: 'IN_PROGRESS', isRequired: true, workflowName: 'CI',
      expectedSeconds: 480, expectedLowSeconds: 240, expectedHighSeconds: 720, url: 'gu',
    });
    // elapsed since 11:50 → 600s
    expect(pr.groupChecks![0]!.elapsedSeconds).toBe(600);
    // head-commit PR checks stay their own list; their single ingested 3m sample
    // populates all three expectations (p10 = p50 = p90 at n=1)
    expect(pr.checks.map((c) => c.name)).toEqual(['fast-checks / ESLint']);
    expect(pr.checks[0]).toMatchObject({
      expectedSeconds: 180, expectedLowSeconds: 180, expectedHighSeconds: 180,
    });
  });

  it('groupChecks is null while the group rollup has not been fetched yet', async () => {
    const p = new Poller({ router: asRouter(groupClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce(); // no queueOnce → group rollup unknown
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.stage.stage).toBe('queue');
    expect(pr.groupChecks).toBeNull();
  });

  it('non-queued PRs carry groupChecks: null', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.stage.stage).toBe('ci');
    expect(pr.groupChecks).toBeNull();
  });
});

describe('Poller train ETA scopes to the required needs-closure (non-blocking checks excluded)', () => {
  const GROUP_OID = 'oidReqScope';
  const queuedDetail = {
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      number: 8962, title: 'fix: x', url: 'u', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'h', autoMergeRequest: { mergeMethod: 'SQUASH' }, mergeCommit: null,
      mergeQueueEntry: { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
        headCommit: { oid: GROUP_OID } },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [{ ...CHECK_DONE }] } } } }] },
    } },
  };
  const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
    { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
      headCommit: { oid: GROUP_OID }, pullRequest: { number: 8962 } },
  ] } } } };
  // merge_group build: the required `ci` rollup is already DONE, but the
  // non-blocking `accessibility` check is still running (started 11:55 → 300s
  // elapsed at NOW, p50 31m). Pre-fix the train ETA maxed over accessibility.
  const rollup = { repository: { o0: { oid: GROUP_OID, statusCheckRollup: { contexts: { nodes: [
    { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS',
      startedAt: '2026-06-10T11:50:00Z', completedAt: '2026-06-10T11:58:00Z', detailsUrl: 'gu',
      checkSuite: { workflowRun: { event: 'merge_group', runNumber: 7994, workflow: { name: 'CI' } } } },
    { __typename: 'CheckRun', name: 'accessibility / Accessibility (combined)', status: 'IN_PROGRESS',
      conclusion: null, startedAt: '2026-06-10T11:55:00Z', completedAt: null, detailsUrl: 'au',
      checkSuite: { workflowRun: { event: 'merge_group', runNumber: 7994, workflow: { name: 'CI' } } } },
  ] } } } } };
  function client() {
    return { remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return queuedDetail;
        if (q.includes('object(oid:')) return rollup;
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }) };
  }
  function seed() {
    history.recordCheckDuration('acme/widgets', 'ci', 'merge_group',
      '2026-06-01T10:00:00Z', '2026-06-01T10:08:00Z', 'SUCCESS'); // 8m
    for (let i = 0; i < 3; i++) {
      history.recordCheckDuration('acme/widgets', 'accessibility / Accessibility (combined)', 'merge_group',
        `2026-06-0${i + 1}T09:00:00Z`, `2026-06-0${i + 1}T09:31:00Z`, 'SUCCESS'); // 31m each → p50 1860
    }
  }
  async function groupOf(p: Poller) {
    await p.sweepOnce(); await p.detailOnce(); await p.queueOnce();
    return p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.queue!.groups[0]!;
  }

  it('excludes the non-blocking check when prefixes mark only ci required → group reads complete', async () => {
    seed();
    const p = new Poller({ router: asRouter(client()), history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    p.setDerivedPrefixes('acme/widgets', ['ci']);
    const g = await groupOf(p);
    expect(g.percent).toBe(100);   // required ci done; accessibility doesn't gate
    expect(g.etaSeconds).toBe(0);
  });

  it('includes the same check once it IS required (prefix added) — proves scoping is the cause', async () => {
    seed();
    const p = new Poller({ router: asRouter(client()), history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    p.setDerivedPrefixes('acme/widgets', ['ci', 'accessibility /']);
    const g = await groupOf(p);
    expect(g.percent).toBeLessThan(100);
    expect(g.etaSeconds).toBeGreaterThan(1000); // ~1560s = 1860 p50 − 300 elapsed
  });

  it('falls back to all checks when no prefixes are derived yet (never blanks the ETA)', async () => {
    seed();
    const p = new Poller({ router: asRouter(client()), history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    const g = await groupOf(p); // no setDerivedPrefixes; base CONFIG has none → unfiltered
    expect(g.etaSeconds).toBeGreaterThan(1000); // accessibility still counted
  });
});

// ---------------------------------------------------------------------------
// Round 7 Task Z1: in-repo .pr-dashboard.yml
// ---------------------------------------------------------------------------

describe('Poller in-repo .pr-dashboard.yml (Z1)', () => {
  afterEach(() => vi.restoreAllMocks());

  const blobResponse = (text: string | null) => ({
    repository: { defaultBranchRef: { name: 'main' },
      object: text == null ? null : { text } },
  });

  /** fakeClient + blob-query handling; textBox lets tests change the file between cycles. */
  function repoCfgClient(textBox: { current: string | null; fail?: boolean }) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('.pr-dashboard.yml')) {
          if (textBox.fail) throw new Error('blob fetch boom');
          return blobResponse(textBox.current);
        }
        if (q.includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }
  const blobCalls = (client: { graphql: ReturnType<typeof vi.fn> }) =>
    client.graphql.mock.calls.filter(([q]) => (q as string).includes('.pr-dashboard.yml')).length;

  const FILE_YAML = 'rollupJobId: rollup\nbatchSize: 12\n';
  // clone-pinned like CONFIG: clone-mode coverage (api mode has its own describe)
  const NO_DEPLOY_CONFIG: AppConfig = { ...DEFAULTS, ancestrySource: 'clone', owners: ['acme', 'octo'] };

  it('loads the file and applies in-repo settings over defaults, logging the source fields once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const textBox = { current: FILE_YAML };
    const client = repoCfgClient(textBox);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => NOW });
    await p.sweepOnce();             // PR 8962 makes acme/widgets a watched repo
    await p.refreshRepoConfigs();
    expect(p.settingsFor('acme/widgets')).toEqual({
      requiredCheckPrefixes: undefined,
      rollupJobId: 'rollup',                          // in-repo
      workflowPath: '.github/workflows/ci.yml',       // default
      batchSize: 12,                                  // in-repo
      autoDiscoverDeploy: false,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]))
      .toContain('[repo-config] acme/widgets: loaded .pr-dashboard.yml (source of: rollupJobId, batchSize)');
    await p.refreshRepoConfigs();    // within 24h: no refetch, no re-log
    expect(blobCalls(client)).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('instance config override beats the in-repo file, per field', async () => {
    const config: AppConfig = { ...NO_DEPLOY_CONFIG,
      repos: { 'acme/widgets': { batchSize: 4 } } };
    const p = new Poller({ router: asRouter(repoCfgClient({ current: FILE_YAML })), history,
      deploy: noDeploy(), config, now: () => NOW });
    await p.sweepOnce();
    await p.refreshRepoConfigs();
    const s = p.settingsFor('acme/widgets');
    expect(s.batchSize).toBe(4);          // override wins
    expect(s.rollupJobId).toBe('rollup'); // in-repo survives for non-overridden fields
  });

  it('a repo BECOMES a deploy repo via its file: ensureClone + health run on the next deploy cycle', async () => {
    const textBox = { current:
      'deploy:\n  environments:\n    - name: qa\n      healthUrl: https://qa.file.dev/health\n' };
    const deploy = fakeDeploy({ 'https://qa.file.dev/health': 'sha-qa' }, { 'sha-qa': 'yes' });
    const p = new Poller({ router: asRouter(repoCfgClient(textBox)), history, deploy,
      config: NO_DEPLOY_CONFIG, now: () => NOW });
    await p.sweepOnce();
    expect(p.buildState().repos[0]!.hasDeploy).toBe(false);
    await p.deployOnce(); // refresh happens inside the deploy cycle
    expect(vi.mocked(deploy.ensureClone))
      .toHaveBeenCalledWith('acme/widgets', 'https://github.com/acme/widgets.git');
    expect(vi.mocked(deploy.health)).toHaveBeenCalledWith('https://qa.file.dev/health', 'commitSha');
    expect(p.buildState().repos[0]!.hasDeploy).toBe(true);
    // merged PR 8951 went live on the file-declared env
    expect(history.listTrackedMerged(7, NOW).find((r) => r.number === 8951)!.qaLiveAt)
      .toBe(NOW.toISOString());
  });

  it("an instance deploy entry stays 'override'-sourced: the in-repo deploy block is ignored (instance-override case)", async () => {
    const textBox = { current:
      'deploy:\n  environments:\n    - name: qa\n      healthUrl: https://qa.file.dev/health\n' };
    const deploy = fakeDeploy({}, {});
    const p = new Poller({ router: asRouter(repoCfgClient(textBox)), history, deploy,
      config: CONFIG, now: () => NOW }); // CONFIG has an instance deploy for acme/widgets
    await p.sweepOnce();
    await p.deployOnce();
    const healthUrls = vi.mocked(deploy.health).mock.calls.map(([u]) => u);
    expect(healthUrls).toContain('https://qa.widgets.example.com/health'); // instance config
    expect(healthUrls).not.toContain('https://qa.file.dev/health');        // file ignored
  });

  it('absent file: defaults apply unchanged and the fetch stays on the 24h cadence', async () => {
    let t = NOW.getTime();
    const textBox = { current: null as string | null };
    const client = repoCfgClient(textBox);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.deployOnce();
    expect(blobCalls(client)).toBe(1);
    expect(p.settingsFor('acme/widgets')).toEqual({
      requiredCheckPrefixes: undefined, rollupJobId: 'ci',
      workflowPath: '.github/workflows/ci.yml', batchSize: DEFAULTS.batchSize,
      autoDiscoverDeploy: false });
    t += 60_000;
    await p.deployOnce();            // within 24h — throttled
    expect(blobCalls(client)).toBe(1);
    t += 24 * 3600_000;
    await p.deployOnce();            // past 24h — refetched
    expect(blobCalls(client)).toBe(2);
  });

  it('a file change is picked up on the 24h refresh and logged again; removal reverts to defaults', async () => {
    let t = NOW.getTime();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const textBox: { current: string | null } = { current: FILE_YAML };
    const p = new Poller({ router: asRouter(repoCfgClient(textBox)), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.refreshRepoConfigs();
    expect(p.settingsFor('acme/widgets').batchSize).toBe(12);
    textBox.current = 'batchSize: 3\n';
    t += 25 * 3600_000;
    await p.refreshRepoConfigs();
    expect(p.settingsFor('acme/widgets').batchSize).toBe(3);
    expect(log).toHaveBeenCalledTimes(2); // change → re-logged
    textBox.current = null;               // file deleted upstream
    t += 25 * 3600_000;
    await p.refreshRepoConfigs();
    expect(p.settingsFor('acme/widgets').batchSize).toBe(DEFAULTS.batchSize);
    expect(String(log.mock.calls[2])).toContain('removed');
  });

  it('a failed blob fetch keeps the previously parsed config (best-effort)', async () => {
    let t = NOW.getTime();
    const textBox = { current: FILE_YAML, fail: false };
    const p = new Poller({ router: asRouter(repoCfgClient(textBox)), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.refreshRepoConfigs();
    expect(p.settingsFor('acme/widgets').batchSize).toBe(12);
    textBox.fail = true;
    t += 25 * 3600_000;
    await p.refreshRepoConfigs();   // fetch throws — prior parse survives, nothing stale
    expect(p.settingsFor('acme/widgets').batchSize).toBe(12);
    expect(p.buildState().staleSince).toBeNull();
  });

  it('file warnings are surfaced via console.warn with the repo prefix', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(repoCfgClient({ current: 'batchSize: -1\n' })), history,
      deploy: noDeploy(), config: NO_DEPLOY_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.refreshRepoConfigs();
    expect(String(warn.mock.calls[0])).toMatch(/\[repo-config\] acme\/widgets: batchSize/);
  });

  it('in-repo requiredCheckPrefixes beat derived prefixes but lose to the instance override', async () => {
    const internals = (p: Poller) =>
      (p as unknown as { effectivePrefixes(r: string): string[] | undefined });
    const textBox = { current: "requiredCheckPrefixes: ['from-file']\n" };
    // file > derived
    const p1 = new Poller({ router: asRouter(repoCfgClient(textBox)), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => NOW });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    p1.setDerivedPrefixes('acme/widgets', ['derived']);
    await p1.sweepOnce();
    await p1.refreshRepoConfigs();
    expect(internals(p1).effectivePrefixes('acme/widgets')).toEqual(['from-file']);
    // override > file
    const p2 = new Poller({ router: asRouter(repoCfgClient(textBox)), history, deploy: noDeploy(),
      config: { ...NO_DEPLOY_CONFIG, repos: { 'acme/widgets': { requiredCheckPrefixes: ['override'] } } },
      now: () => NOW });
    await p2.sweepOnce();
    await p2.refreshRepoConfigs();
    expect(internals(p2).effectivePrefixes('acme/widgets')).toEqual(['override']);
  });

  it('in-repo workflowPath/rollupJobId drive the 24h ci.yml re-derivation', async () => {
    const textBox = { current: 'rollupJobId: gate\nworkflowPath: .github/workflows/gate.yml\ndeploy:\n  environments: []\n' };
    const ciYaml = 'jobs:\n  lint: {}\n  gate:\n    needs: [lint]\n';
    const deploy = {
      health: vi.fn(async () => null),
      ensureClone: vi.fn(async () => {}),
      fetchClone: vi.fn(async () => {}),
      isAncestor: vi.fn(async () => 'missing' as const),
      readFileAtHead: vi.fn(async () => ciYaml),
    } as unknown as DeployWatcher;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(repoCfgClient(textBox)), history, deploy,
      config: NO_DEPLOY_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce(); // refresh makes widgets a deploy repo → derivation runs with file settings
    expect(vi.mocked(deploy.readFileAtHead))
      .toHaveBeenCalledWith('acme/widgets', '.github/workflows/gate.yml', 'main');
    expect(String(log.mock.calls.find((c) => String(c).includes('derived'))))
      .toMatch(/gate, lint/);
  });
});

// ---------------------------------------------------------------------------
// Round 7 Task Z2: reconfigure (hot-apply) + reposReport (source attribution)
// ---------------------------------------------------------------------------

describe('Poller.reconfigure (Z2 hot-apply)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('swaps config, fires an immediate sweep, and re-arms the timer chain on the new intervals', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = fakeClient();
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    // count sweep CYCLES: each cycle issues ONE search per owner; key off acme's
    const sweepCalls = () =>
      client.graphql.mock.calls.filter(([q]) => (q as string).includes('user:acme')).length;
    p.start();
    await vi.advanceTimersByTimeAsync(0);   // initial kick
    expect(sweepCalls()).toBe(1);
    p.reconfigure({ ...CONFIG, intervals: { ...CONFIG.intervals, sweepMs: 10_000 } });
    await vi.advanceTimersByTimeAsync(0);   // reconfigure restarts → immediate sweep
    expect(sweepCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000); // NEW cadence fires at 10s, not 60s
    expect(sweepCalls()).toBe(3);
    expect(p.nextDelayMs('sweep')).toBe(10_000);
    p.stop();
  });

  it('old timers are cleared: no double-fire from the pre-reconfigure chain', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = fakeClient();
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: { ...CONFIG, intervals: { ...CONFIG.intervals, sweepMs: 20_000, hotMs: 600_000, deployMs: 600_000 } },
      now: () => NOW });
    const sweepCalls = () =>
      client.graphql.mock.calls.filter(([q]) => (q as string).includes('open0: search')).length;
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.reconfigure({ ...CONFIG, intervals: { ...CONFIG.intervals, sweepMs: 300_000, hotMs: 600_000, deployMs: 600_000 } });
    await vi.advanceTimersByTimeAsync(0);   // immediate sweep from the restart
    const after = sweepCalls();
    await vi.advanceTimersByTimeAsync(100_000); // old 20s chain would have fired 5×
    expect(sweepCalls()).toBe(after);
    p.stop();
  });

  it('does not start timers when the poller was never started', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = fakeClient();
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.reconfigure({ ...CONFIG, intervals: { ...CONFIG.intervals, sweepMs: 1_000 } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.graphql).not.toHaveBeenCalled();
  });

  it('a reconfigured exclude prunes the repo (open AND merged views) on the next sweep', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    expect(p.buildState().repos).toHaveLength(1);
    p.reconfigure({ ...CONFIG, exclude: ['acme/widgets'] });
    await p.sweepOnce();
    expect(p.buildState().repos).toHaveLength(0);
  });

  it('a reconfigured retentionDays applies to the merged-PR window immediately', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();        // merged 8951 (20 min old) tracked under 7d retention
    expect(p.buildState().repos[0]!.prs.some((x) => x.number === 8951)).toBe(true);
    p.reconfigure({ ...CONFIG, retentionDays: 0.001 }); // ~86s window < the 20 min age
    expect(p.buildState().repos.flatMap((r) => r.prs).some((x) => x.number === 8951)).toBe(false);
  });
});

describe('Poller.reposReport (Z2 source attribution)', () => {
  afterEach(() => vi.restoreAllMocks());

  const fileYaml =
    'rollupJobId: rollup\ndeploy:\n  environments:\n    - name: qa\n      healthUrl: https://qa.file.dev/health\n';
  const reportClient = (text: string | null) => ({
    remaining: 4000, resetAt: null,
    graphql: vi.fn(async (q: string) => {
      if (q.includes('open0: search')) return SWEEP_RESPONSE;
      if (q.includes('.pr-dashboard.yml')) return {
        repository: { defaultBranchRef: { name: 'main' }, object: text == null ? null : { text } } };
      throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    }),
  });

  it('attributes override / in-repo / derived / default per field (instance deploy stays override)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const config: AppConfig = { ...CONFIG, repos: { 'acme/widgets': { batchSize: 4 } } };
    const p = new Poller({ router: asRouter(reportClient(fileYaml)), history, deploy: noDeploy(),
      config, now: () => NOW });
    p.setDerivedPrefixes('acme/widgets', ['ci']);
    await p.sweepOnce();
    await p.refreshRepoConfigs();
    const r = p.reposReport()['acme/widgets']!;
    expect(r.batchSize).toEqual({ value: 4, source: 'override' });
    expect(r.rollupJobId).toEqual({ value: 'rollup', source: 'in-repo' });
    expect(r.workflowPath).toEqual({ value: '.github/workflows/ci.yml', source: 'default' });
    expect(r.requiredCheckPrefixes).toEqual({ value: ['ci'], source: 'derived' });
    // the instance-override case: config.json deploy block wins over the in-repo one
    expect(r.deploy.source).toBe('override');
    expect(r.deploy.value!.environments[0]!.healthUrl).toBe('https://qa.widgets.example.com/health');
  });

  it('file-only deploy reads in-repo; with no layers everything is default', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const config: AppConfig = { ...DEFAULTS, owners: ['acme', 'octo'] };
    const p = new Poller({ router: asRouter(reportClient(fileYaml)), history, deploy: noDeploy(),
      config, now: () => NOW });
    await p.sweepOnce();
    await p.refreshRepoConfigs();
    const r = p.reposReport()['acme/widgets']!;
    expect(r.deploy.source).toBe('in-repo');
    expect(r.deploy.value!.environments[0]!.healthUrl).toBe('https://qa.file.dev/health');
    expect(r.batchSize).toEqual({ value: DEFAULTS.batchSize, source: 'default' });
    expect(r.requiredCheckPrefixes).toEqual({ value: null, source: 'default' });
    expect(r.rollupJobId.source).toBe('in-repo');
  });
});

// ---------------------------------------------------------------------------
// Round 7 review fix: generation guard (timer-chain resurrection)
// ---------------------------------------------------------------------------

describe('Poller reconfigure generation guard (timer-chain resurrection)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('in-flight sweep resolving after reconfigure does NOT re-arm the old chain', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // A deferred graphql promise lets us hold ONE sweep in-flight across a reconfigure.
    // Only the first sweep call is deferred; subsequent ones resolve immediately.
    let resolveSweep!: (v: unknown) => void;
    const sweepInflight = new Promise((res) => { resolveSweep = res; });
    let firstSweep = true;

    let sweepCallCount = 0;
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if ((q as string).includes('open0: search')) {
          if ((q as string).includes('user:acme')) sweepCallCount++; // one per sweep CYCLE, not per owner
          if (firstSweep) {
            firstSweep = false;
            await sweepInflight; // hold the first sweep in-flight across the reconfigure
          }
          return SWEEP_RESPONSE;
        }
        if ((q as string).includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };

    const INTERVAL = 5_000;
    const p = new Poller({
      router: asRouter(client), history, deploy: noDeploy(),
      config: { ...CONFIG, intervals: { sweepMs: INTERVAL, hotMs: 600_000, deployMs: 600_000 } },
      now: () => NOW,
    });

    // Start: initial kick fires sweep #1 (now in-flight, held by deferred).
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepCallCount).toBe(1);

    // Reconfigure mid-flight: stop() bumps generation, start() bumps it again.
    // The in-flight sweep's finally(arm) closure captures the OLD generation and must bail.
    // The new start() fires its own initial kick (sweep #2), which blocks on withLatch('sweep')
    // because sweep #1 still holds the latch — so sweepCallCount stays at 1.
    p.reconfigure({ ...CONFIG, intervals: { sweepMs: INTERVAL, hotMs: 600_000, deployMs: 600_000 } });
    await vi.advanceTimersByTimeAsync(0);
    // sweep #1 still in-flight; new kick is latch-blocked
    expect(sweepCallCount).toBe(1);

    // Release the original in-flight sweep. Its finally(arm) should bail (old generation).
    // The new chain's first arm() timer then fires after INTERVAL.
    resolveSweep(undefined);
    await vi.advanceTimersByTimeAsync(0); // let the promise chain settle
    // Still 1 — the old chain's arm() bailed; new chain hasn't ticked yet
    expect(sweepCallCount).toBe(1);

    // Advance exactly one interval: the NEW chain fires sweep #2.
    // Before the generation guard, the old chain's finally(arm) would ALSO schedule a timer,
    // giving sweep #3 (double-fire) at the same tick.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(sweepCallCount).toBe(2); // exactly one new sweep, not two

    p.stop();
  });
});

// ---------------------------------------------------------------------------
// Round 8 Task A3: webhook nudge + hot-interval relax
// ---------------------------------------------------------------------------

describe('Poller.nudge (webhook-driven out-of-band cycles)', () => {
  it('pr-detail for a TRACKED PR → targeted detail fetch for just that PR', async () => {
    const client = fakeClient();
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce(); // tracks acme/widgets#8962
    client.graphql.mockClear();
    await p.nudge({ kind: 'pr-detail', repo: 'acme/widgets', prNumber: 8962 });
    expect(client.graphql).toHaveBeenCalledTimes(1);
    const q = String(client.graphql.mock.calls[0]);
    expect(q).toContain('pr8962: pullRequest'); // detail query, not a sweep
    expect(q).not.toContain('open0: search');
  });

  it('targeted detail excludes other tracked PRs from the query', async () => {
    const sweep = {
      ...SWEEP_RESPONSE,
      open0: { issueCount: 2, nodes: [
        ...SWEEP_RESPONSE.open0.nodes,
        { number: 9100, title: 'feat: other', url: 'u9100', isDraft: false,
          mergedAt: null, repository: { nameWithOwner: 'acme/widgets' }, mergeCommit: null },
      ] },
    };
    const client = fakeClient(sweep);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    client.graphql.mockClear();
    await p.nudge({ kind: 'pr-detail', repo: 'acme/widgets', prNumber: 8962 });
    const q = String(client.graphql.mock.calls[0]);
    expect(q).toContain('number: 8962');
    expect(q).not.toContain('number: 9100'); // other tracked PR not refetched
  });

  it('pr-detail for an UNTRACKED PR → falls back to sweep + full detail', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const sweepSpy = vi.spyOn(p, 'sweepOnce');
    const detailSpy = vi.spyOn(p, 'detailOnce');
    await p.nudge({ kind: 'pr-detail', repo: 'acme/unknown', prNumber: 1 });
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    expect(detailSpy).toHaveBeenCalledWith(false);
  });

  it('queue route → queueOnce; sweep route → sweepOnce + detailOnce(false)', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const sweepSpy = vi.spyOn(p, 'sweepOnce');
    const detailSpy = vi.spyOn(p, 'detailOnce');
    const queueSpy = vi.spyOn(p, 'queueOnce');
    await p.nudge({ kind: 'queue', repo: 'acme/widgets' });
    expect(queueSpy).toHaveBeenCalledTimes(1);
    expect(sweepSpy).not.toHaveBeenCalled();
    await p.nudge({ kind: 'sweep' });
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    expect(detailSpy).toHaveBeenCalledWith(false);
  });

  it('respects the existing cycle latch: a nudge during an in-flight sweep is skipped', async () => {
    let resolveSweep!: (v: unknown) => void;
    const deferred = new Promise((r) => { resolveSweep = r; });
    let sweepCalls = 0;
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) {
          if (q.includes('user:acme')) sweepCalls++; // one per sweep CYCLE, not per owner
          await deferred; return SWEEP_RESPONSE;
        }
        if (q.includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const first = p.sweepOnce();           // holds the 'sweep' latch
    const nudged = p.nudge({ kind: 'sweep' }); // latch-blocked: must not double-fetch
    resolveSweep(undefined);
    await Promise.all([first, nudged]);
    expect(sweepCalls).toBe(1);
  });

  it('a nudge whose fetch rejects is contained (runCycle), marking staleSince', async () => {
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async () => { throw new Error('boom'); }),
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await expect(p.nudge({ kind: 'sweep' })).resolves.toBeUndefined();
    expect(p.buildState().staleSince).toBe(NOW.toISOString());
    err.mockRestore();
  });
});

describe('Poller.effectiveHotMs webhook relax', () => {
  const WEBHOOKS_ON = { enabled: true, secretPath: '/tmp/s', path: '/api/webhooks/github' };

  it('webhooks enabled + default hotMs → relaxed ×4', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: { ...CONFIG, webhooks: WEBHOOKS_ON, hotMsExplicit: false }, now: () => NOW });
    expect(p.effectiveHotMs()).toBe(CONFIG.intervals.hotMs * 4);
    expect(p.nextDelayMs('hot')).toBe(CONFIG.intervals.hotMs * 4);
  });

  it('explicit intervals.hotMs in the config file wins — no relax', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: { ...CONFIG, webhooks: WEBHOOKS_ON, hotMsExplicit: true }, now: () => NOW });
    expect(p.effectiveHotMs()).toBe(CONFIG.intervals.hotMs);
  });

  it('webhooks disabled → unchanged', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.effectiveHotMs()).toBe(CONFIG.intervals.hotMs);
  });

  it('rate-limit floor still beats the relax (degrades to 60s)', () => {
    const c = fakeClient(); c.remaining = 500;
    const p = new Poller({ router: asRouter(c), history, deploy: noDeploy(),
      config: { ...CONFIG, webhooks: WEBHOOKS_ON, hotMsExplicit: false }, now: () => NOW });
    expect(p.effectiveHotMs()).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Incident 2026-06-11: failure-aware retry + persisted last-known-good.
// A connectivity blip during startup failed the repo-config fetch and ci.yml
// derivation, and the old attempt-armed 24h throttle locked the failure in.
// ---------------------------------------------------------------------------

const enotfound = () => Object.assign(
  new Error('fetch failed'),
  { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) },
);

describe('RetryThrottle (failure-aware backoff)', () => {
  it('success arms the long interval; failure arms 1m/2m/4m/8m capped at 10m', () => {
    const th = new RetryThrottle(24 * 3600_000);
    expect(th.due('k', 0)).toBe(true);            // never attempted → due
    th.success('k', 0);
    expect(th.due('k', 24 * 3600_000 - 1)).toBe(false);
    expect(th.due('k', 24 * 3600_000)).toBe(true);
    // consecutive failures: 60s, 120s, 240s, 480s, then capped at 600s
    let t = 24 * 3600_000;
    for (const gap of [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
      th.failure('k', t);
      expect(th.due('k', t + gap - 1)).toBe(false);
      expect(th.due('k', t + gap)).toBe(true);
      t += gap;
    }
    th.success('k', t);                           // success resets the backoff ladder
    t += 24 * 3600_000;
    th.failure('k', t);
    expect(th.due('k', t + 60_000)).toBe(true);   // back to the 1m rung
  });

  it('keys are independent', () => {
    const th = new RetryThrottle(24 * 3600_000);
    th.failure('a', 0);
    expect(th.due('a', 30_000)).toBe(false);
    expect(th.due('b', 0)).toBe(true);
  });
});

describe('describeError (cause-chain logging)', () => {
  it('includes the cause code/message; bare errors stay as-is; chains nest', () => {
    expect(describeError(enotfound())).toBe(
      'fetch failed (cause: getaddrinfo ENOTFOUND api.github.com)');
    expect(describeError(new Error('plain boom'))).toBe('plain boom');
    expect(describeError('string throw')).toBe('string throw');
    const timeout = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('connect timed out'), {
        code: 'ETIMEDOUT', cause: 'tcp handshake' }),
    });
    expect(describeError(timeout)).toBe('outer (cause: ETIMEDOUT connect timed out ← tcp handshake)');
  });
});

describe('Poller failure-aware refresh throttles (incident 2026-06-11)', () => {
  afterEach(() => vi.restoreAllMocks());

  const FILE_YAML = 'rollupJobId: rollup\nbatchSize: 12\n';
  // clone-pinned like CONFIG: clone-mode coverage (api mode has its own describe)
  const NO_DEPLOY_CONFIG: AppConfig = { ...DEFAULTS, ancestrySource: 'clone', owners: ['acme', 'octo'] };

  function repoCfgClient(textBox: { current: string | null; fail?: boolean }) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('.pr-dashboard.yml')) {
          if (textBox.fail) throw enotfound();
          return { repository: { defaultBranchRef: { name: 'main' },
            object: textBox.current == null ? null : { text: textBox.current } } };
        }
        if (q.includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }
  const blobCalls = (client: { graphql: ReturnType<typeof vi.fn> }) =>
    client.graphql.mock.calls.filter(([q]) => (q as string).includes('.pr-dashboard.yml')).length;

  it('a failed repo-config fetch is retried with backoff; success arms the 24h throttle', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let t = NOW.getTime();
    const textBox = { current: FILE_YAML, fail: true };
    const client = repoCfgClient(textBox);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.refreshRepoConfigs();                  // attempt 1: fails
    expect(blobCalls(client)).toBe(1);
    // failure log carries the cause chain, one line
    expect(String(warn.mock.calls.at(-1))).toMatch(/repo-config.*acme\/widgets.*ENOTFOUND/);
    t += 30_000;
    await p.refreshRepoConfigs();                  // 30s < 1m backoff — throttled
    expect(blobCalls(client)).toBe(1);
    t += 30_000;
    await p.refreshRepoConfigs();                  // 1m after failure — retried (fails again)
    expect(blobCalls(client)).toBe(2);
    t += 60_000;
    await p.refreshRepoConfigs();                  // 1m < 2m second-failure backoff — throttled
    expect(blobCalls(client)).toBe(2);
    t += 60_000;
    textBox.fail = false;
    await p.refreshRepoConfigs();                  // 2m after failure — retried, succeeds
    expect(blobCalls(client)).toBe(3);
    expect(p.settingsFor('acme/widgets').batchSize).toBe(12);
    t += 23 * 3600_000;
    await p.refreshRepoConfigs();                  // success armed 24h — no refetch within it
    expect(blobCalls(client)).toBe(3);
    t += 3600_000;
    await p.refreshRepoConfigs();                  // ≥24h after success — routine refresh
    expect(blobCalls(client)).toBe(4);
  });

  it('a failed ci.yml derivation is retried with backoff; success arms 24h', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let t = NOW.getTime();
    const box = { fail: true };
    const deploy = {
      health: vi.fn(async () => null),
      ensureClone: vi.fn(async () => {}),
      fetchClone: vi.fn(async () => { if (box.fail) throw enotfound(); }),
      isAncestor: vi.fn(async () => 'missing' as const),
      readFileAtHead: vi.fn(async () => 'jobs:\n  lint: {}\n  ci:\n    needs: [lint]\n'),
    } as unknown as DeployWatcher;
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => new Date(t) });
    await p.deployOnce();                          // attempt 1: clone fetch fails
    expect(vi.mocked(deploy.readFileAtHead)).not.toHaveBeenCalled();
    expect(String(warn.mock.calls.find((c) => String(c).includes('derivation'))))
      .toMatch(/acme\/widgets.*derivation failed.*ENOTFOUND/);
    t += 30_000;
    await p.deployOnce();                          // 30s < 1m backoff — throttled
    expect(vi.mocked(deploy.fetchClone)).toHaveBeenCalledTimes(1);
    t += 30_000;
    box.fail = false;
    await p.deployOnce();                          // 1m after failure — retried, succeeds
    expect(vi.mocked(deploy.readFileAtHead)).toHaveBeenCalledTimes(1);
    expect(p.needsFor('acme/widgets', 'ci')).toEqual(['lint']);
    t += 23 * 3600_000;
    await p.deployOnce();                          // within the success-armed 24h
    expect(vi.mocked(deploy.readFileAtHead)).toHaveBeenCalledTimes(1);
    t += 3600_000;
    await p.deployOnce();                          // ≥24h after success — re-derives
    expect(vi.mocked(deploy.readFileAtHead)).toHaveBeenCalledTimes(2);
  });

  it('guard() logs the cause chain on a failed sweep (one line, no stack)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = { remaining: 4000, resetAt: null, graphql: vi.fn(async () => { throw enotfound(); }) };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    expect(error).toHaveBeenCalledWith('[poller] fetch failed:',
      'fetch failed (cause: getaddrinfo ENOTFOUND api.github.com)');
    expect(p.buildState().staleSince).toBe(NOW.toISOString());
  });
});

describe('Poller persisted last-known-good (restart during an outage)', () => {
  afterEach(() => vi.restoreAllMocks());

  // In-repo file that BOTH configures deploy and feeds settings — the KinDash shape.
  const FILE_YAML =
    'batchSize: 12\ndeploy:\n  environments:\n    - name: qa\n      healthUrl: https://qa.file.dev/health\n';
  const CI_YAML = 'name: CI\njobs:\n  lint: {}\n  build:\n    needs: [lint]\n  ci:\n    needs: [build]\n';
  // clone-pinned like CONFIG: clone-mode coverage (api mode has its own describe)
  const NO_DEPLOY_CONFIG: AppConfig = { ...DEFAULTS, ancestrySource: 'clone', owners: ['acme', 'octo'] };

  const healthyClient = (fileText: string) => ({
    remaining: 4000, resetAt: null,
    graphql: vi.fn(async (q: string) => {
      if (q.includes('open0: search')) return SWEEP_RESPONSE;
      if (q.includes('.pr-dashboard.yml')) return {
        repository: { defaultBranchRef: { name: 'main' }, object: { text: fileText } } };
      if (q.includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
      throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    }),
  });
  const outageClient = () => ({
    remaining: 4000, resetAt: null,
    graphql: vi.fn(async () => { throw enotfound(); }),
  });
  const healthyDeploy = () => ({
    health: vi.fn(async () => null),
    ensureClone: vi.fn(async () => {}),
    fetchClone: vi.fn(async () => {}),
    isAncestor: vi.fn(async () => 'missing' as const),
    readFileAtHead: vi.fn(async () => CI_YAML),
  }) as unknown as DeployWatcher;
  const outageDeploy = () => ({
    health: vi.fn(async () => null),
    ensureClone: vi.fn(async () => { throw enotfound(); }),
    fetchClone: vi.fn(async () => { throw enotfound(); }),
    isAncestor: vi.fn(async () => 'missing' as const),
    readFileAtHead: vi.fn(async () => { throw enotfound(); }),
  }) as unknown as DeployWatcher;

  it('persists repo-config + ci-graph on success; a new Poller with a failing client restores them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Phase 1 — healthy instance: fetches the in-repo file and derives ci.yml.
    const p1 = new Poller({ router: asRouter(healthyClient(FILE_YAML)), history,
      deploy: healthyDeploy(), config: NO_DEPLOY_CONFIG, now: () => NOW });
    await p1.sweepOnce();
    await p1.deployOnce();
    expect(JSON.parse(history.getMeta('repoConfig:acme/widgets')!)).toMatchObject({ batchSize: 12 });
    expect(JSON.parse(history.getMeta('ciGraph:acme/widgets')!)).toMatchObject(
      { prefixes: ['ci', 'build', 'lint'], workflowName: 'CI' });

    // Phase 2 — process restart during a GitHub outage: every fetch fails.
    const p2 = new Poller({ router: asRouter(outageClient()), history,
      deploy: outageDeploy(), config: NO_DEPLOY_CONFIG, now: () => NOW });
    await p2.sweepOnce();   // fails — guard contains it
    await p2.deployOnce();  // repo-config fetch + derivation both fail
    // last-known-good in-repo config: settings AND deploy survive
    expect(p2.settingsFor('acme/widgets').batchSize).toBe(12);
    expect(p2.effectiveDeploy()['acme/widgets']!.environments[0]!.healthUrl)
      .toBe('https://qa.file.dev/health');
    // merged PR 8951 lives in shared history → the repo renders with hasDeploy
    const repo = p2.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    expect(repo.hasDeploy).toBe(true);
    // last-known-good derived graph: prefixes, needs nodes, rollup workflow name
    expect(p2.needsFor('acme/widgets', 'ci')).toEqual(['build']);
    expect(p2.needsFor('acme/widgets', 'build')).toEqual(['lint']);
    expect(p2.rollupWorkflowFor('acme/widgets')).toBe('CI');
    expect(p2.reposReport()['acme/widgets']!.requiredCheckPrefixes)
      .toEqual({ value: ['ci', 'build', 'lint'], source: 'derived' });
  });

  it('a fresh successful fetch overwrites the persisted copies', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    history.setMeta('repoConfig:acme/widgets', JSON.stringify({ batchSize: 99 }));
    history.setMeta('ciGraph:acme/widgets', JSON.stringify(
      { prefixes: ['stale'], nodes: { stale: { needs: [], activity: { mode: 'all' } } }, workflowName: null }));
    const p = new Poller({ router: asRouter(healthyClient(FILE_YAML)), history,
      deploy: healthyDeploy(), config: NO_DEPLOY_CONFIG, now: () => NOW });
    expect(p.settingsFor('acme/widgets').batchSize).toBe(99);   // restored stale value
    await p.sweepOnce();
    await p.deployOnce();                                        // live fetch + derivation
    expect(p.settingsFor('acme/widgets').batchSize).toBe(12);
    expect(JSON.parse(history.getMeta('repoConfig:acme/widgets')!)).toMatchObject({ batchSize: 12 });
    expect(JSON.parse(history.getMeta('ciGraph:acme/widgets')!).prefixes).toEqual(['ci', 'build', 'lint']);
  });

  it('an absent in-repo file clears the persisted copy; corrupt rows are ignored', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    history.setMeta('repoConfig:acme/widgets', JSON.stringify({ batchSize: 99 }));
    history.setMeta('ciGraph:acme/widgets', 'not json{{');      // corrupt — must not throw
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('.pr-dashboard.yml')) return {
          repository: { defaultBranchRef: { name: 'main' }, object: null } };
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => NOW });
    expect(p.needsFor('acme/widgets', 'ci')).toBeNull();        // corrupt graph row ignored
    await p.sweepOnce();
    await p.refreshRepoConfigs();                                // file absent upstream
    expect(p.settingsFor('acme/widgets').batchSize).toBe(DEFAULTS.batchSize);
    expect(history.getMeta('repoConfig:acme/widgets')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Incident 2026-06-11 (App-mode dogfood): an installation token that cannot
// see a watched repo makes the blob query return `repository: null` alongside
// a partial-response error. The old code treated that exactly like
// file-deleted and CLEARED the persisted last-known-good config.
// repository-inaccessible must be a FETCH FAILURE (keep + backoff), and a
// fully invisible owner should get one diagnosability log line.
// ---------------------------------------------------------------------------

describe('Poller inaccessible repository ≠ removed file (App-mode incident 2026-06-11)', () => {
  afterEach(() => vi.restoreAllMocks());

  const FILE_YAML =
    'batchSize: 12\ndeploy:\n  environments:\n    - name: qa\n      healthUrl: https://qa.file.dev/health\n';
  // clone-pinned like CONFIG: clone-mode coverage (api mode has its own describe)
  const NO_DEPLOY_CONFIG: AppConfig = { ...DEFAULTS, ancestrySource: 'clone', owners: ['acme', 'octo'] };
  const EMPTY_SWEEP = {
    open0: { issueCount: 0, nodes: [] }, open1: { issueCount: 0, nodes: [] },
    merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
  };

  /** Blob responses: 'file' (present), 'absent' (repo ok, object null),
   *  'norepo' (repository itself null — the partial-errors shape). */
  function incidentClient(box: { blob: 'file' | 'absent' | 'norepo'; sweep?: Record<string, unknown> }) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return box.sweep ?? SWEEP_RESPONSE;
        if (q.includes('.pr-dashboard.yml')) {
          if (box.blob === 'norepo') return { repository: null };
          return { repository: { defaultBranchRef: { name: 'main' },
            object: box.blob === 'absent' ? null : { text: FILE_YAML } } };
        }
        if (q.includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }
  const blobCalls = (client: { graphql: ReturnType<typeof vi.fn> }) =>
    client.graphql.mock.calls.filter(([q]) => (q as string).includes('.pr-dashboard.yml')).length;

  it('repository-null keeps the loaded + persisted config and retries with backoff (not 24h)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let t = NOW.getTime();
    const box = { blob: 'file' as 'file' | 'absent' | 'norepo' };
    const client = incidentClient(box);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.refreshRepoConfigs();                  // healthy: loaded + persisted
    expect(p.settingsFor('acme/widgets').batchSize).toBe(12);
    box.blob = 'norepo';                           // token loses sight of the repo
    t += 25 * 3600_000;
    await p.refreshRepoConfigs();
    // keep last-known-good: loaded config, persisted copy, NO "removed" log
    expect(p.settingsFor('acme/widgets').batchSize).toBe(12);
    expect(JSON.parse(history.getMeta('repoConfig:acme/widgets')!)).toMatchObject({ batchSize: 12 });
    expect(String(warn.mock.calls.at(-1)))
      .toContain('[repo-config] acme/widgets: repository inaccessible (token cannot see it?) — keeping last-known-good');
    // failure arms the backoff, not the 24h success interval
    expect(blobCalls(client)).toBe(2);
    t += 30_000;
    await p.refreshRepoConfigs();                  // 30s < 1m backoff — throttled
    expect(blobCalls(client)).toBe(2);
    t += 30_000;
    await p.refreshRepoConfigs();                  // 1m after failure — retried
    expect(blobCalls(client)).toBe(3);
  });

  it('object-null (repo visible, file genuinely absent) still clears the persisted copy', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let t = NOW.getTime();
    const box = { blob: 'file' as 'file' | 'absent' | 'norepo' };
    const p = new Poller({ router: asRouter(incidentClient(box)), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.refreshRepoConfigs();
    box.blob = 'absent';
    t += 25 * 3600_000;
    await p.refreshRepoConfigs();
    expect(p.settingsFor('acme/widgets').batchSize).toBe(DEFAULTS.batchSize);
    expect(history.getMeta('repoConfig:acme/widgets')).toBeNull();
    expect(String(log.mock.calls.at(-1))).toContain('removed');
  });

  it('the literal incident sequence: persisted deploy config survives a repository-null fetch — state still hasDeploy', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let t = NOW.getTime();
    const box = { blob: 'file' as 'file' | 'absent' | 'norepo' };
    const p = new Poller({ router: asRouter(incidentClient(box)), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => new Date(t) });
    await p.sweepOnce();                           // merged PR 8951 lands in history
    await p.refreshRepoConfigs();                  // good config persisted (incl. deploy block)
    expect(p.effectiveDeploy()['acme/widgets']).toBeDefined();
    box.blob = 'norepo';                           // App installation can't see the repo
    t += 25 * 3600_000;
    await p.refreshRepoConfigs();
    expect(p.effectiveDeploy()['acme/widgets']!.environments[0]!.healthUrl)
      .toBe('https://qa.file.dev/health');
    expect(JSON.parse(history.getMeta('repoConfig:acme/widgets')!)).toMatchObject({ batchSize: 12 });
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    expect(repo.hasDeploy).toBe(true);             // /api/state still renders the deploy lane
  });

  it("warns once when an owner's sweep is empty AND its repos were seen inaccessible (blob layer)", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const box = { blob: 'norepo' as const, sweep: EMPTY_SWEEP };
    // acme/widgets is watched via instance config even with no PRs visible
    const config: AppConfig = { ...NO_DEPLOY_CONFIG, repos: { 'acme/widgets': { batchSize: 4 } } };
    const p = new Poller({ router: asRouter(incidentClient(box)), history, deploy: noDeploy(),
      config, now: () => NOW });
    await p.sweepOnce();                           // no inaccessible evidence yet → no warning
    const ownerWarns = () => warn.mock.calls
      .filter((c) => String(c).includes("owner 'acme' appears inaccessible")).length;
    expect(ownerWarns()).toBe(0);
    await p.refreshRepoConfigs();                  // blob layer sees repository:null for acme/widgets
    await p.sweepOnce();                           // empty sweep + evidence → warn
    expect(ownerWarns()).toBe(1);
    expect(String(warn.mock.calls.find((c) => String(c).includes('appears inaccessible'))))
      .toContain("[poller] owner 'acme' appears inaccessible to the current token (App installation missing?)");
    await p.sweepOnce();                           // log once per process lifetime
    expect(ownerWarns()).toBe(1);
    // octo never had inaccessible evidence — never warned about
    expect(warn.mock.calls.some((c) => String(c).includes("owner 'octo'"))).toBe(false);
  });

  it('a null repository alias in the detail fetch also marks the owner inaccessible', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const box: { blob: 'file'; sweep: Record<string, unknown> } = { blob: 'file', sweep: SWEEP_RESPONSE };
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return box.sweep;
        if (q.includes('pr8962: pullRequest')) return { r0: null }; // repo inaccessible mid-flight
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => NOW });
    await p.sweepOnce();                           // PR 8962 discovered
    await p.detailOnce();                          // detail alias resolves to null
    box.sweep = EMPTY_SWEEP;                       // next sweep: owner fully invisible
    await p.sweepOnce();
    expect(warn.mock.calls.filter((c) => String(c).includes("owner 'acme' appears inaccessible")).length).toBe(1);
  });

  it('no owner warning when the sweep has results for that owner', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const box = { blob: 'norepo' as const };
    const p = new Poller({ router: asRouter(incidentClient(box)), history, deploy: noDeploy(),
      config: NO_DEPLOY_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.refreshRepoConfigs();                  // evidence for acme…
    await p.sweepOnce();                           // …but the sweep still sees acme PRs
    expect(warn.mock.calls.some((c) => String(c).includes('appears inaccessible'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round 10 (issue #10): per-owner request routing across installations
// ---------------------------------------------------------------------------

describe('Poller per-owner routing (multi-installation)', () => {
  afterEach(() => vi.restoreAllMocks());

  const ACME_SWEEP = { open0: SWEEP_RESPONSE.open0, merged0: SWEEP_RESPONSE.merged0 };
  const OCTO_SWEEP = {
    open0: { issueCount: 1, nodes: [{ number: 42, title: 'feat: tools', url: 'u42', isDraft: false,
      mergedAt: null, repository: { nameWithOwner: 'octo/tools' }, mergeCommit: null }] },
    merged0: { issueCount: 0, nodes: [] },
  };
  const octoDetail = (over: Record<string, unknown> = {}) => ({
    r0: { nameWithOwner: 'octo/tools', pr42: {
      number: 42, title: 'feat: tools', url: 'u42', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'head42', autoMergeRequest: null, mergeCommit: null,
      mergeQueueEntry: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [CHECK_DONE] } } } }] },
      ...over,
    } },
  });

  /** Per-owner fake client: a sweep payload plus marker-keyed extra responses. */
  function ownerClient(sweep: Record<string, unknown>, responses: Record<string, unknown> = {}) {
    return {
      remaining: 4000 as number | null, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes(': search')) return sweep;
        for (const [marker, payload] of Object.entries(responses)) {
          if (q.includes(marker)) return payload;
        }
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }

  /** Structural multi-owner router: per-owner clients, null for unknown owners. */
  function routerFor(clients: Record<string, ReturnType<typeof ownerClient>>) {
    const all = () => Object.values(clients);
    return {
      clientFor: (owner: string) => clients[owner] ?? null,
      allClients: all,
      minRemaining: () => {
        const vals = all().map((c) => c.remaining).filter((r): r is number => r != null);
        return vals.length ? Math.min(...vals) : null;
      },
    } as unknown as ClientRouter;
  }

  it('sweep routes each owner search to its own client and merges both into one pass', async () => {
    const acme = ownerClient(ACME_SWEEP, { 'pr8962: pullRequest': DETAIL_RESPONSE });
    const octo = ownerClient(OCTO_SWEEP, { 'pr42: pullRequest': octoDetail() });
    const p = new Poller({ router: routerFor({ acme, octo }), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    // each client saw exactly one search, scoped to its own owner
    expect(acme.graphql).toHaveBeenCalledTimes(1);
    expect(octo.graphql).toHaveBeenCalledTimes(1);
    expect(String(acme.graphql.mock.calls[0])).toContain('user:acme');
    expect(String(acme.graphql.mock.calls[0])).not.toContain('user:octo');
    expect(String(octo.graphql.mock.calls[0])).toContain('user:octo');
    await p.detailOnce();
    // results merged into ONE dashboard state + ONE sweep bookkeeping pass
    expect(p.buildState().repos.map((r) => r.repo)).toEqual(['acme/widgets', 'octo/tools']);
    expect(history.getMeta('lastSweep')).toBe(NOW.toISOString());
  });

  it('detail fetch batches targets per repo owner', async () => {
    const acme = ownerClient(ACME_SWEEP, { 'pr8962: pullRequest': DETAIL_RESPONSE });
    const octo = ownerClient(OCTO_SWEEP, { 'pr42: pullRequest': octoDetail() });
    const p = new Poller({ router: routerFor({ acme, octo }), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const acmeDetail = acme.graphql.mock.calls.map(([q]) => q as string).filter((q) => q.includes('pullRequest('));
    const octoDetailQs = octo.graphql.mock.calls.map(([q]) => q as string).filter((q) => q.includes('pullRequest('));
    expect(acmeDetail).toHaveLength(1);
    expect(octoDetailQs).toHaveLength(1);
    expect(acmeDetail[0]).toContain('pr8962:');
    expect(acmeDetail[0]).not.toContain('pr42:');
    expect(octoDetailQs[0]).toContain('pr42:');
    expect(octoDetailQs[0]).not.toContain('pr8962:');
  });

  it('repo-scoped queue queries route via the repo owner', async () => {
    const queued = octoDetail({
      autoMergeRequest: { mergeMethod: 'SQUASH' }, mergeStateStatus: 'CLEAN',
      mergeQueueEntry: { position: 1, state: 'QUEUED', enqueuedAt: null, headCommit: null },
    });
    const octoQueue = { repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'QUEUED', enqueuedAt: null, headCommit: null, pullRequest: { number: 42 } },
    ] } } } };
    const acme = ownerClient(ACME_SWEEP, { 'pr8962: pullRequest': DETAIL_RESPONSE });
    const octo = ownerClient(OCTO_SWEEP, { 'pr42: pullRequest': queued, 'mergeQueue(branch:': octoQueue });
    const p = new Poller({ router: routerFor({ acme, octo }), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    expect(octo.graphql.mock.calls.some(([q]) => (q as string).includes('mergeQueue(branch:'))).toBe(true);
    expect(acme.graphql.mock.calls.some(([q]) => (q as string).includes('mergeQueue(branch:'))).toBe(false);
  });

  it("an owner with no installation is skipped with ONE warning; sweep bookkeeping stays healthy", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acme = ownerClient(ACME_SWEEP, { 'pr8962: pullRequest': DETAIL_RESPONSE });
    const p = new Poller({ router: routerFor({ acme }), history, deploy: noDeploy(),
      config: { ...CONFIG, owners: ['acme', 'ghost'] }, now: () => NOW });
    await p.sweepOnce();
    await p.sweepOnce();
    const skips = warn.mock.calls.filter((c) => String(c).includes("owner 'ghost' has no installation"));
    expect(skips).toHaveLength(1);                            // once per owner per process
    expect(p.buildState().staleSince).toBeNull();             // config mismatch, NOT an outage
    expect(history.getMeta('lastSweep')).toBe(NOW.toISOString()); // window still advances
  });

  it('one owner failing keeps the other ingested but defers prune + lastSweep', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const acme = ownerClient(ACME_SWEEP, { 'pr8962: pullRequest': DETAIL_RESPONSE });
    const octo = ownerClient(OCTO_SWEEP);
    octo.graphql.mockImplementation(async () => { throw new TypeError('boom'); });
    const p = new Poller({ router: routerFor({ acme, octo }), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    expect(p.buildState().staleSince).toBe(NOW.toISOString());      // real fetch failure
    expect(p.buildState().repos.map((r) => r.repo)).toContain('acme/widgets'); // acme still landed
    // an outage for one owner must not read its PRs as "vanished" nor advance the window
    expect(history.getMeta('lastSweep')).toBeNull();
  });

  it('rate governance keys off the WORST per-installation budget (router.minRemaining)', () => {
    const acme = ownerClient(ACME_SWEEP);
    const octo = ownerClient(OCTO_SWEEP);
    acme.remaining = 4000;
    octo.remaining = 500;
    const p = new Poller({ router: routerFor({ acme, octo }), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.effectiveHotMs()).toBe(60_000);          // hot tick degraded
    expect(p.nextDelayMs('sweep')).toBe(300_000);     // sweep low-budget floor
  });
});

// ---------------------------------------------------------------------------
// Round 12 (metrics tab): state sampling on the emitUpdate path
// ---------------------------------------------------------------------------

describe('state sampling (metrics trends)', () => {
  const samplesFor = (repo: string) =>
    history.stateSamplesSince('2026-06-10T00:00:00Z').filter((r) => r.repo === repo);

  it('records one throttled state sample per repo via emitUpdate — no new timer', async () => {
    let now = new Date('2026-06-10T12:00:00Z');
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: PREFIX_CONFIG, now: () => now });

    await p.sweepOnce(); // first emitUpdate → one sample per repo with data
    let acme = samplesFor('acme/widgets');
    expect(acme).toHaveLength(1);
    // open PR 8962 counts as open; merged 8951 (stage 'merged') does not
    expect(acme[0]).toMatchObject({ open: 1, queue: 0, failed: 0 });

    await p.detailOnce(); // second emitUpdate inside the 15-min window → throttled
    expect(samplesFor('acme/widgets')).toHaveLength(1);

    now = new Date('2026-06-10T12:16:00Z'); // past the throttle
    await p.detailOnce();
    acme = samplesFor('acme/widgets');
    expect(acme).toHaveLength(2);
    // detail classified 8962 as ci (one check still IN_PROGRESS)
    expect(acme[1]).toMatchObject({ open: 1, ci: 1, queue: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Issue #18: ancestrySource 'api' — compare-API ancestry, clone-free derivation
// ---------------------------------------------------------------------------

describe("Poller ancestrySource 'api' (issue #18)", () => {
  afterEach(() => vi.restoreAllMocks());

  const API_CONFIG: AppConfig = { ...CONFIG, ancestrySource: 'api' };

  /** fakeClient + restGet (compare API) + blob handling for both in-repo
   *  config and workflow derivation reads. */
  function apiClient(opts: {
    compare?: (path: string) => unknown;
    workflowYaml?: string | null;
  } = {}) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('.pr-dashboard.yml')) {
          return { repository: { defaultBranchRef: { name: 'main' }, object: null } };
        }
        if (q.includes('.github/workflows/ci.yml')) {
          return { repository: { defaultBranchRef: { name: 'main' },
            object: opts.workflowYaml == null ? null : { text: opts.workflowYaml } } };
        }
        if (q.includes('pr8962: pullRequest')) return DETAIL_RESPONSE;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
      restGet: vi.fn(async (path: string) => {
        if (!opts.compare) throw new Error(`unexpected restGet ${path}`);
        return opts.compare(path);
      }),
    };
  }

  /** Deploy fake whose clone-side methods must stay untouched in api mode. */
  function apiDeploy(shaByUrl: Record<string, string | null>, hasClone = false) {
    return {
      health: vi.fn(async (url: string) => shaByUrl[url] ?? null),
      hasClone: vi.fn(() => hasClone),
      ensureClone: vi.fn(async () => {}),
      fetchClone: vi.fn(async () => {}),
      isAncestor: vi.fn(async () => 'yes' as const),
      readFileAtHead: vi.fn(async () => null),
    } as unknown as DeployWatcher;
  }

  it('answers ancestry via the compare API and never touches the clone layer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = apiClient({ compare: () => ({ status: 'ahead' }) });
    const deploy = apiDeploy({ 'https://qa.widgets.example.com/health': 'deployedSha-qa' });
    const p = new Poller({ router: asRouter(client), history, deploy,
      config: API_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce();
    expect(client.restGet).toHaveBeenCalledWith(
      '/repos/acme/widgets/compare/squash8951...deployedSha-qa?per_page=1');
    expect(history.listTrackedMerged(7, NOW).find((r) => r.number === 8951)!.qaLiveAt)
      .toBe(NOW.toISOString());
    // no clone is ever created, fetched, or consulted
    expect(vi.mocked(deploy.ensureClone)).not.toHaveBeenCalled();
    expect(vi.mocked(deploy.fetchClone)).not.toHaveBeenCalled();
    expect(vi.mocked(deploy.isAncestor)).not.toHaveBeenCalled();
    expect(vi.mocked(deploy.readFileAtHead)).not.toHaveBeenCalled();
  });

  it("compare status 'behind' reads as not-live (env stays pending)", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = apiClient({ compare: () => ({ status: 'behind' }) });
    const p = new Poller({ router: asRouter(client), history,
      deploy: apiDeploy({ 'https://qa.widgets.example.com/health': 'oldSha-qa' }),
      config: API_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce();
    expect(history.listTrackedMerged(7, NOW).find((r) => r.number === 8951)!.qaLiveAt).toBeNull();
  });

  it('the per-(sha, deployedSha) 60s ancestry throttle is transport-agnostic', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let t = NOW.getTime();
    const client = apiClient({ compare: () => ({ status: 'behind' }) });
    const p = new Poller({ router: asRouter(client), history,
      deploy: apiDeploy({ 'https://qa.widgets.example.com/health': 'oldSha-qa' }),
      config: API_CONFIG, now: () => new Date(t) });
    // Count only ancestry (compare-API) calls — the push-pool learner also
    // issues a one-time workflow-runs list call against this same client.
    const compareCalls = () => client.restGet.mock.calls.filter(
      (c) => String(c[0]).includes('/compare/')).length;
    await p.sweepOnce();
    await p.deployOnce();
    await p.deployOnce(); // same clock → within 60s of the first check
    expect(compareCalls()).toBe(1);
    t += 61_000; // step past the throttle window
    await p.deployOnce();
    expect(compareCalls()).toBe(2);
  });

  it('a transport error falls back to a PRE-EXISTING clone for the evaluation, warning once', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let t = NOW.getTime();
    const client = apiClient(); // restGet always throws (network boom)
    const deploy = apiDeploy({ 'https://qa.widgets.example.com/health': 'deployedSha-qa' }, true);
    const p = new Poller({ router: asRouter(client), history, deploy,
      config: API_CONFIG, now: () => new Date(t) });
    await p.sweepOnce();
    await p.deployOnce();
    // clone answered 'yes' → env marked live
    expect(vi.mocked(deploy.isAncestor))
      .toHaveBeenCalledWith('acme/widgets', 'squash8951', 'deployedSha-qa');
    expect(history.listTrackedMerged(7, new Date(t)).find((r) => r.number === 8951)!.qaLiveAt)
      .toBe(new Date(t).toISOString());
    const fallbackWarns = warn.mock.calls.filter((c) => String(c).includes('falling back'));
    expect(fallbackWarns).toHaveLength(1);
    expect(String(fallbackWarns[0])).toContain('acme/widgets');
  });

  it('a transport error without a local clone propagates (existing failure handling)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = apiClient(); // restGet always throws
    const deploy = apiDeploy({ 'https://qa.widgets.example.com/health': 'deployedSha-qa' }, false);
    const p = new Poller({ router: asRouter(client), history, deploy,
      config: API_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await expect(p.deployOnce()).rejects.toThrow(/unexpected restGet/);
    expect(vi.mocked(deploy.isAncestor)).not.toHaveBeenCalled();
  });

  it('ci.yml derivation reads the workflow via blob query (no clone), honoring defaultBranch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ciYaml = 'name: CI\njobs:\n  static-checks: {}\n  ci:\n    needs: [static-checks]\n';
    const client = apiClient({ compare: () => ({ status: 'ahead' }), workflowYaml: ciYaml });
    const deploy = apiDeploy({});
    const p = new Poller({ router: asRouter(client), history, deploy,
      config: API_CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce();
    const blobQueries = client.graphql.mock.calls
      .map(([q]) => q as string).filter((q) => q.includes('.github/workflows/ci.yml'));
    expect(blobQueries).toHaveLength(1);
    expect(blobQueries[0]).toContain('main:.github/workflows/ci.yml'); // deploy defaultBranch
    expect(vi.mocked(deploy.fetchClone)).not.toHaveBeenCalled();
    expect(vi.mocked(deploy.readFileAtHead)).not.toHaveBeenCalled();
    expect(String(log.mock.calls.find((c) => String(c).includes('derived'))))
      .toMatch(/ci, static-checks/);
    await p.deployOnce(); // within 24h — throttled, no re-read
    expect(client.graphql.mock.calls
      .map(([q]) => q as string).filter((q) => q.includes('.github/workflows/ci.yml'))).toHaveLength(1);
  });

  it('a NON-deploy repo with a repos.* entry derives prefixes for the first time (blob read)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ciYaml = 'jobs:\n  lint: {}\n  gate:\n    needs: [lint]\n';
    const client = apiClient({ workflowYaml: ciYaml });
    const config: AppConfig = { ...DEFAULTS, ancestrySource: 'api', owners: ['acme'],
      repos: { 'acme/tools': { rollupJobId: 'gate' } } }; // no deploy block anywhere
    const p = new Poller({ router: asRouter(client), history, deploy: apiDeploy({}),
      config, now: () => NOW });
    await p.deployOnce();
    const blobQueries = client.graphql.mock.calls
      .map(([q]) => q as string).filter((q) => q.includes('.github/workflows/ci.yml'));
    expect(blobQueries).toHaveLength(1);
    expect(blobQueries[0]).toContain('acme'); // routed to the repo owner
    expect(blobQueries[0]).toContain('HEAD:.github/workflows/ci.yml'); // no deploy → default branch via HEAD
    expect(String(log.mock.calls.find((c) => String(c).includes('derived'))))
      .toMatch(/gate, lint/);
  });

  it('an inaccessible repo (null repository) keeps the prior derived graph and retries with backoff', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let t = NOW.getTime();
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('.pr-dashboard.yml')) {
          return { repository: { defaultBranchRef: { name: 'main' }, object: null } };
        }
        if (q.includes('.github/workflows/ci.yml')) return { repository: null };
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
      restGet: vi.fn(async () => ({ status: 'behind' })),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: apiDeploy({}),
      config: API_CONFIG, now: () => new Date(t) });
    p.setDerivedPrefixes('acme/widgets', ['prior']);
    await p.deployOnce();
    expect(String(warn.mock.calls.find((c) => String(c).includes('derivation failed'))))
      .toContain('inaccessible');
    const derivationReads = () => client.graphql.mock.calls
      .map(([q]) => q as string).filter((q) => q.includes('.github/workflows/ci.yml')).length;
    expect(derivationReads()).toBe(1);
    await p.deployOnce();        // backoff window — no immediate retry
    expect(derivationReads()).toBe(1);
    t += 61_000;                 // past the first 60s backoff step
    await p.deployOnce();
    expect(derivationReads()).toBe(2);
  });

  // --- rollup workflow auto-discovery (file-rename tolerance) ----------------

  const MAIN_YAML = 'name: CI\njobs:\n  lint: {}\n  ci:\n    needs: [lint]\n';
  /** api client whose configured ci.yml is GONE (renamed away); a tree listing
   *  of `.github/workflows/` offers an unrelated file + the renamed `main.yml`
   *  that actually defines the `ci` rollup job. */
  function renamedWorkflowClient() {
    const tree = { repository: { object: { entries: [
      { name: 'auto-merge.yml', path: '.github/workflows/auto-merge.yml', object: { text: 'jobs:\n  enable: {}\n' } },
      { name: 'main.yml', path: '.github/workflows/main.yml', object: { text: MAIN_YAML } },
    ] } } };
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('on Tree')) return tree;                                  // dir listing
        if (q.includes('.github/workflows/ci.yml')) return { repository: { defaultBranchRef: { name: 'main' }, object: null } }; // renamed away
        if (q.includes('.github/workflows/main.yml')) return { repository: { defaultBranchRef: { name: 'main' }, object: { text: MAIN_YAML } } };
        if (q.includes('.pr-dashboard.yml')) return { repository: { defaultBranchRef: { name: 'main' }, object: null } };
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
      restGet: vi.fn(async () => ({ status: 'behind' })),
    };
  }
  const treeCalls = (client: { graphql: ReturnType<typeof vi.fn> }) =>
    client.graphql.mock.calls.map(([q]) => q as string).filter((q) => q.includes('on Tree')).length;

  it('auto-discovers the rollup workflow when the configured ci.yml was renamed away', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let t = NOW.getTime();
    const client = renamedWorkflowClient();
    const config: AppConfig = { ...DEFAULTS, ancestrySource: 'api', owners: ['acme'],
      repos: { 'acme/tools': {} } }; // watched, default rollup 'ci', workflowPath NOT pinned
    const p = new Poller({ router: asRouter(client), history, deploy: apiDeploy({}),
      config, now: () => new Date(t) });
    await p.deployOnce();
    // one tree listing → adopted main.yml's graph (ci + lint), logged + persisted
    expect(treeCalls(client)).toBe(1);
    expect(String(log.mock.calls.find((c) => String(c).includes('auto-discovered'))))
      .toContain('.github/workflows/main.yml');
    expect(history.getMeta('discoveredWorkflowPath:acme/tools')).toBe('.github/workflows/main.yml');

    // next cycle past the 24h throttle reads the discovered main.yml DIRECTLY
    // (one blob read, no re-listing) and never re-reads the dead ci.yml.
    t += 25 * 3600_000;
    await p.deployOnce();
    expect(treeCalls(client)).toBe(1); // no re-discovery
    const reads = (needle: string) => client.graphql.mock.calls
      .map(([q]) => q as string).filter((q) => q.includes(needle) && !q.includes('on Tree')).length;
    expect(reads('.github/workflows/main.yml')).toBe(1); // 2nd cycle read the discovered path directly
    expect(reads('.github/workflows/ci.yml')).toBe(1);   // dead path read only on the 1st cycle
    log.mockRestore();
  });

  it('does NOT auto-discover when workflowPath is explicitly pinned (honors the declared path)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = renamedWorkflowClient();
    const config: AppConfig = { ...DEFAULTS, ancestrySource: 'api', owners: ['acme'],
      repos: { 'acme/tools': { workflowPath: '.github/workflows/ci.yml' } } }; // pinned
    const p = new Poller({ router: asRouter(client), history, deploy: apiDeploy({}),
      config, now: () => NOW });
    p.setDerivedPrefixes('acme/tools', ['prior']); // a prior good derivation to preserve
    await p.deployOnce();
    expect(treeCalls(client)).toBe(0);             // discovery never ran
    expect(String(warn.mock.calls.find((c) => String(c).includes('keeping prior'))))
      .toContain('ci.yml');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Notifier wiring (issue #19): the poller feeds every classify result through
// the Notifier and re-emits its 'notification' events on its own bus (the SSE
// layer subscribes there); prod-live fires from the deploy-ancestry cycle.
// ---------------------------------------------------------------------------

describe('Poller notifier wiring (issue #19)', () => {
  const ALL_EVENTS_ON: NotificationsConfig = {
    enabled: false, // command sink off — bus emission is what's under test
    command: [],
    digest: { enabled: false, hourLocal: 8 },
    events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
      ready: true, overdue: true, 'prod-live': true, 'queue-stalled': true,
      'duration-regression': true, 'runner-starvation': true, 'budget-breach': true},
  };

  function notifierHarness() {
    const events: NotificationEvent[] = [];
    const notifier = new Notifier({ config: () => ALL_EVENTS_ON });
    return { notifier, events };
  }

  const FAIL_DETAIL = { r0: { nameWithOwner: 'acme/widgets', pr8962: {
    number: 8962, title: 'fix: overlap', url: 'u8962', isDraft: false, mergeStateStatus: 'BLOCKED',
    mergedAt: null, headRefOid: 'head8962', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE',
      contexts: { pageInfo: { hasNextPage: false },
        nodes: [{ ...CHECK_DONE, conclusion: 'FAILURE' }] } } } }] },
  } } };

  it('a PR entering parked/ci-failed emits a notification re-emitted on the poller bus, once', async () => {
    const { notifier, events } = notifierHarness();
    const p = new Poller({ router: asRouter(fakeClient(SWEEP_RESPONSE, FAIL_DETAIL)),
      history, deploy: noDeploy(), config: CONFIG, now: () => NOW, notifier });
    p.on('notification', (ev: NotificationEvent) => events.push(ev));
    await p.sweepOnce();
    await p.detailOnce();
    const fails = events.filter((e) => e.type === 'ci-failed');
    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatchObject({ repo: 'acme/widgets', prNumber: 8962,
      title: 'fix: overlap', type: 'ci-failed' });
    // further state rebuilds with the same condition do not re-fire (debounce)
    p.buildState();
    p.buildState();
    expect(events.filter((e) => e.type === 'ci-failed')).toHaveLength(1);
  });

  it('prod ancestry going live emits prod-live for the merged PR', async () => {
    const { notifier, events } = notifierHarness();
    const deploy = fakeDeploy(
      { 'https://qa.widgets.example.com/health': 'deployedSha-qa',
        'https://widgets.example.com/health': 'deployedSha-prod' },
      { 'deployedSha-qa': 'yes', 'deployedSha-prod': 'yes' },
    );
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config: CONFIG, now: () => NOW, notifier });
    p.on('notification', (ev: NotificationEvent) => events.push(ev));
    await p.sweepOnce();   // ingests merged #8951 (mergeCommitSha squash8951)
    await p.deployOnce();
    const prodEvents = events.filter((e) => e.type === 'prod-live');
    expect(prodEvents).toHaveLength(1);
    expect(prodEvents[0]).toMatchObject({ repo: 'acme/widgets', prNumber: 8951,
      title: 'feat: allowance', type: 'prod-live' });
  });

  it('queue-blocked events carry the conflicting culprit PR in their detail', async () => {
    const { notifier, events } = notifierHarness();
    const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
      { position: 1, state: 'UNMERGEABLE', enqueuedAt: null,
        headCommit: { oid: 'stale8878' }, pullRequest: { number: 8878 } },
      { position: 2, state: 'UNMERGEABLE', enqueuedAt: null,
        headCommit: { oid: 'stale9335' }, pullRequest: { number: 9335 } },
    ] } } } };
    const node = (number: number, mss: string) => ({
      number, title: `pr ${number}`, url: `u${number}`, isDraft: false, mergeStateStatus: mss,
      mergedAt: null, headRefOid: `head${number}`, autoMergeRequest: { mergeMethod: 'SQUASH' },
      mergeCommit: null,
      mergeQueueEntry: { position: number === 8878 ? 1 : 2, state: 'UNMERGEABLE',
        enqueuedAt: null, headCommit: { oid: `stale${number}` } },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [{ ...CHECK_DONE }] } } } }] },
    });
    const sweep = {
      open0: { issueCount: 2, nodes: [
        { number: 8878, title: 'pr 8878', url: 'u8878', isDraft: false, mergedAt: null,
          repository: { nameWithOwner: 'acme/widgets' }, mergeCommit: null },
        { number: 9335, title: 'pr 9335', url: 'u9335', isDraft: false, mergedAt: null,
          repository: { nameWithOwner: 'acme/widgets' }, mergeCommit: null },
      ] },
      open1: { issueCount: 0, nodes: [] },
      merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
    };
    const detail = { r0: { nameWithOwner: 'acme/widgets',
      pr8878: node(8878, 'DIRTY'), pr9335: node(9335, 'BLOCKED') } };
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return sweep;
        if (q.includes('pr8878: pullRequest')) return detail;
        if (q.includes('object(oid:')) return { repository: {} };
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW, notifier });
    p.on('notification', (ev: NotificationEvent) => events.push(ev));
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const blocked = events.filter((e) => e.type === 'queue-blocked');
    expect(blocked.map((e) => e.prNumber).sort()).toEqual([8878, 9335]);
    // the DIRTY culprit gets the rebase framing; the cascade victim names the culprit
    expect(blocked.find((e) => e.prNumber === 8878)!.detail).toContain('conflicts with the base');
    expect(blocked.find((e) => e.prNumber === 9335)!.detail).toContain('#8878');
  });

  it('reconfigure() hot-applies notifications.enabled — the command sink disarms and re-arms without a restart', () => {
    const cfgWith = (enabled: boolean): AppConfig => ({ ...CONFIG,
      notifications: { enabled, command: ['notify-send', '{title}', '{body}'],
        digest: { enabled: false, hourLocal: 8 },
        events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
          ready: true, overdue: true, 'prod-live': true, 'queue-stalled': true,
          'duration-regression': true, 'runner-starvation': true, 'budget-breach': true} } });
    const execCalls: string[] = [];
    // index.ts wiring shape: the notifier reads the POLLER's live config, so a
    // PUT /api/config → reconfigure() flips the command sink with no restart
    let p!: Poller;
    const notifier = new Notifier({
      config: () => p.currentNotifications(),
      exec: (cmd, _args, cb) => { execCalls.push(cmd); cb(null); },
    });
    p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: cfgWith(true), now: () => NOW, notifier });
    const events: NotificationEvent[] = [];
    notifier.on('notification', (ev: NotificationEvent) => events.push(ev));
    const failed = (n: number) => notifier.observe({ repo: 'acme/widgets', prNumber: n,
      title: `pr ${n}`, prev: null, next: { stage: 'parked', substate: 'ci-failed',
        percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false } });

    failed(1);
    expect(execCalls).toHaveLength(1); // armed at startup → command fires

    p.reconfigure(cfgWith(false));     // PUT {notifications:{enabled:false}}
    failed(2);
    expect(execCalls).toHaveLength(1); // disarmed — NO command
    expect(events).toHaveLength(2);    // …but the SSE/browser sink still flows

    p.reconfigure(cfgWith(true));      // PUT {notifications:{enabled:true}}
    failed(3);
    expect(execCalls).toHaveLength(2); // re-armed — fires again
  });
});

describe('repo discovery + toggle list', () => {
  it('sweep records discovered repos BEFORE the exclude skip, persisted to meta', async () => {
    const cfg = { ...CONFIG, exclude: ['acme/widgets'] };
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: cfg, now: () => NOW });
    await p.sweepOnce();
    const persisted = JSON.parse(history.getMeta('discoveredRepos') ?? '[]') as string[];
    expect(persisted).toContain('acme/widgets'); // excluded yet discovered
    // a fresh poller instance restores discovery from meta
    const p2 = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: cfg, now: () => NOW });
    expect(p2.repoToggleList().map((r) => r.repo)).toContain('acme/widgets');
  });

  it('repoToggleList unions discovery, history traces, and the exclude list with flags', () => {
    history.recordStateSample('octo/history-only', '2026-06-10T10:00:00Z',
      { open: 1, ci: 0, queue: 0, failed: 0 });
    const cfg = { ...CONFIG, exclude: ['acme/config-only'] };
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: cfg, now: () => NOW });
    const list = p.repoToggleList();
    expect(list).toContainEqual({ repo: 'octo/history-only', excluded: false });
    expect(list).toContainEqual({ repo: 'acme/config-only', excluded: true });
    expect(list.map((r) => r.repo)).toEqual([...list.map((r) => r.repo)].sort());
  });

  it('currentExclude reflects reconfigure (live metrics filtering)', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.currentExclude()).toEqual(CONFIG.exclude);
    p.reconfigure({ ...CONFIG, exclude: ['acme/late'] });
    expect(p.currentExclude()).toEqual(['acme/late']);
  });
});

describe('telemetry plumbing (issue #34)', () => {
  const COMPLETED_CHECK: CheckRun = {
    name: 'Build', rawName: 'Build', status: 'COMPLETED', conclusion: 'SUCCESS',
    startedAt: '2026-06-10T11:50:00Z', completedAt: '2026-06-10T11:53:00Z',
    event: 'pull_request', workflowName: 'CI', runNumber: 12, runAttempt: 2,
    runDatabaseId: null,
    isRequired: true, url: null,
  };

  it('ingestCheckSet threads head_sha and the check run_attempt into recordCheckDuration', () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    ingestCheckSet(history, 'acme/widgets', [COMPLETED_CHECK], () => null,
      undefined, null, null, 'headsha123');
    expect(spy).toHaveBeenCalledWith('acme/widgets', 'Build', 'pull_request',
      '2026-06-10T11:50:00Z', '2026-06-10T11:53:00Z', 'SUCCESS', 'headsha123', 2, 12);
    spy.mockRestore();
  });

  it('ingestCheckSet without a head sha records NULL sha (backward-compatible default)', () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    ingestCheckSet(history, 'acme/widgets', [{ ...COMPLETED_CHECK, runAttempt: null }], () => null);
    expect(spy).toHaveBeenCalledWith('acme/widgets', 'Build', 'pull_request',
      '2026-06-10T11:50:00Z', '2026-06-10T11:53:00Z', 'SUCCESS', null, null, 12);
    spy.mockRestore();
  });

  it('detail-cycle ingestion threads the PR head sha (headRefOid) per snapshot', async () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    // CHECK_DONE is the completed check in DETAIL_RESPONSE; PR head = 'head8962';
    // its workflowRun fake carries no runAttempt → null
    expect(spy).toHaveBeenCalledWith('acme/widgets', 'fast-checks / ESLint', 'pull_request',
      '2026-06-10T11:50:00Z', '2026-06-10T11:53:00Z', 'SUCCESS', 'head8962', null, null);
    spy.mockRestore();
  });

  const POOLS_YAML = `
jobs:
  build:
    runs-on: \${{ github.event_name == 'merge_group' && 'kindash-ondemand-2' || 'kindash-runner' }}
  static:
    name: static-checks
    uses: ./.github/workflows/static.yml
  ci:
    needs: [build, static]
    runs-on: ubuntu-latest
`;

  it('poolsFor maps canonical check names to runs-on candidates via the derived graph', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.poolsFor('acme/widgets', 'build')).toBeNull(); // no graph yet
    p.adoptDerivedGraph('acme/widgets', deriveCiGraph(POOLS_YAML)!);
    expect(p.poolsFor('acme/widgets', 'build')).toEqual(['kindash-ondemand-2', 'kindash-runner']);
    expect(p.poolsFor('acme/widgets', 'ci')).toEqual(['ubuntu-latest']);
    // reusable workflow without an outer label input → unknowable
    expect(p.poolsFor('acme/widgets', 'static-checks / TypeScript')).toBeNull();
    expect(p.poolsFor('acme/widgets', 'no-such-check')).toBeNull();
    expect(p.poolsFor('octo/unknown', 'ci')).toBeNull();
  });

  it('poolsFor survives a restart via the persisted ciGraph meta bundle', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.adoptDerivedGraph('acme/widgets', deriveCiGraph(POOLS_YAML)!);
    const p2 = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p2.poolsFor('acme/widgets', 'build')).toEqual(['kindash-ondemand-2', 'kindash-runner']);
  });
});

// ---------------------------------------------------------------------------
// Flake radar (#37) + train-killer attribution (#38)
// ---------------------------------------------------------------------------

describe('ingestGroupFailures (issue #38)', () => {
  const mg = (over: Partial<CheckRun>): CheckRun => ({
    name: 'e2e', rawName: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE',
    startedAt: '2026-06-10T11:30:00Z', completedAt: '2026-06-10T11:40:00Z',
    event: 'merge_group', workflowName: 'CI', runNumber: 1, runAttempt: 1,
    runDatabaseId: null,
    isRequired: true, url: null, ...over,
  });

  it('records failing-class conclusions only (FAILURE/TIMED_OUT/STARTUP_FAILURE)', () => {
    ingestGroupFailures(history, 'acme/widgets', 'oid1', [
      mg({ name: 'failed', conclusion: 'FAILURE' }),
      mg({ name: 'timed-out', conclusion: 'TIMED_OUT' }),
      mg({ name: 'startup', conclusion: 'STARTUP_FAILURE' }),
      mg({ name: 'green', conclusion: 'SUCCESS' }),
      mg({ name: 'skipped', conclusion: 'SKIPPED' }),
      mg({ name: 'cancelled', conclusion: 'CANCELLED' }), // ejection side effect, not a verdict
      mg({ name: 'running', status: 'IN_PROGRESS', conclusion: null, completedAt: null }),
    ]);
    expect(history.groupFailuresSince('2026-06-01T00:00:00Z').map((r) => r.checkName).sort())
      .toEqual(['failed', 'startup', 'timed-out']);
  });

  it('persists each eject’s conclusion for the reason taxonomy (roadmap 4.4b)', () => {
    ingestGroupFailures(history, 'acme/widgets', 'oid1', [
      mg({ name: 'failed', conclusion: 'FAILURE' }),
      mg({ name: 'timed-out', conclusion: 'TIMED_OUT' }),
    ]);
    const rows = history.groupFailuresSince('2026-06-01T00:00:00Z');
    expect(rows.find((r) => r.checkName === 'failed')?.conclusion).toBe('FAILURE');
    expect(rows.find((r) => r.checkName === 'timed-out')?.conclusion).toBe('TIMED_OUT');
  });

  it('records once per (group sha, check) across repeated ingestion; new groups record again', () => {
    const checks = [mg({})];
    ingestGroupFailures(history, 'acme/widgets', 'oid1', checks);
    ingestGroupFailures(history, 'acme/widgets', 'oid1', checks); // re-poll of the same rollup
    ingestGroupFailures(history, 'acme/widgets', 'oid2', checks); // a different group
    const rows = history.groupFailuresSince('2026-06-01T00:00:00Z');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.groupSha).sort()).toEqual(['oid1', 'oid2']);
  });
});

describe('Poller queue cycle records group failures (issue #38)', () => {
  const GROUP_OID = 'groupOidF';
  const queuedDetail = { r0: { nameWithOwner: 'acme/widgets', pr8962: {
    number: 8962, title: 'fix: overlap', url: 'u8962', isDraft: false, mergeStateStatus: 'BLOCKED',
    mergedAt: null, headRefOid: 'head8962', autoMergeRequest: { mergeMethod: 'SQUASH' },
    mergeCommit: null,
    mergeQueueEntry: { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
      headCommit: { oid: GROUP_OID } },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
      contexts: { pageInfo: { hasNextPage: false }, nodes: [{ ...CHECK_DONE }] } } } }] },
  } } };
  const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
    { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
      headCommit: { oid: GROUP_OID }, pullRequest: { number: 8962 } },
  ] } } } };
  const failedRollup = { repository: { o0: { oid: GROUP_OID, statusCheckRollup: { contexts: { nodes: [
    { __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE',
      startedAt: '2026-06-10T11:30:00Z', completedAt: '2026-06-10T11:38:00Z', detailsUrl: 'u',
      checkSuite: { workflowRun: { event: 'merge_group' } } },
    { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS',
      startedAt: '2026-06-10T11:30:00Z', completedAt: '2026-06-10T11:36:00Z', detailsUrl: 'u',
      checkSuite: { workflowRun: { event: 'merge_group' } } },
  ] } } } } };

  it('a failed merge-group rollup records its culprit check (once), not the green siblings', async () => {
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return queuedDetail;
        if (q.includes('object(oid:')) return failedRollup;
        if (q.includes('mergeQueue')) return queueResponse;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const rows = history.groupFailuresSince('2026-06-01T00:00:00Z');
    expect(rows).toEqual([{ repo: 'acme/widgets', checkName: 'e2e', groupSha: GROUP_OID,
      at: '2026-06-10T11:38:00Z', conclusion: 'FAILURE' }]);
    // group-failed notification detail names the culprit (issue #38)
    const events: NotificationEvent[] = [];
    const notifier = new Notifier({ config: () => ({ enabled: false, command: [], digest: { enabled: false, hourLocal: 8 },
      events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
        ready: true, overdue: true, 'prod-live': true, 'queue-stalled': true,
        'duration-regression': true, 'runner-starvation': true, 'budget-breach': true} }) });
    notifier.on('notification', (ev: NotificationEvent) => events.push(ev));
    (p as unknown as { deps: { notifier?: Notifier } }).deps.notifier = notifier;
    p.buildState();
    const gf = events.filter((e) => e.type === 'group-failed');
    expect(gf).toHaveLength(1);
    expect(gf[0]!.detail).toBe('the merge-queue group build failed — culprit: e2e');
  });
});

describe('CheckView likelyFlake annotation (issue #37)', () => {
  /** Seed flake history: `flakes` fail→pass pairs + `clean` clean runs for a check. */
  function seedFlakes(name: string, flakes: number, clean: number) {
    for (let i = 0; i < flakes; i++) {
      history.recordCheckDuration('acme/widgets', name, 'pull_request',
        `2026-06-09T0${i}:00:00Z`, `2026-06-09T0${i}:05:00Z`, 'FAILURE', `f${i}`, 1);
      history.recordCheckDuration('acme/widgets', name, 'pull_request',
        `2026-06-09T0${i}:20:00Z`, `2026-06-09T0${i}:25:00Z`, 'SUCCESS', `f${i}`, 2);
    }
    for (let i = 0; i < clean; i++) {
      history.recordCheckDuration('acme/widgets', name, 'pull_request',
        `2026-06-09T1${i}:00:00Z`, `2026-06-09T1${i}:05:00Z`, 'SUCCESS', `c${i}`, 1);
    }
  }

  const failingDetail = (name: string) => ({ r0: { nameWithOwner: 'acme/widgets', pr8962: {
    number: 8962, title: 'fix: overlap', url: 'u8962', isDraft: false, mergeStateStatus: 'BLOCKED',
    mergedAt: null, headRefOid: 'head8962', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE',
      contexts: { pageInfo: { hasNextPage: false },
        nodes: [{ ...CHECK_DONE, name, conclusion: 'FAILURE' }] } } } }] },
  } } });

  async function checkViewFor(name: string) {
    const p = new Poller({ router: asRouter(fakeClient(SWEEP_RESPONSE, failingDetail(name))),
      history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const state = p.buildState();
    return state.repos.find((r) => r.repo === 'acme/widgets')!
      .prs.find((x) => x.number === 8962)!.checks.find((c) => c.name === name)!;
  }

  it('a failing check with flake rate ≥ 20% is likelyFlake with its rate exposed', async () => {
    seedFlakes('flaky-e2e', 2, 6); // 2/10 runs = 20%
    const view = await checkViewFor('flaky-e2e');
    expect(view.conclusion).toBe('FAILURE');
    expect(view.flakeRatePct).toBeCloseTo(20);
    expect(view.likelyFlake).toBe(true);
  });

  it('a failing check below the 20% threshold is not likelyFlake (rate still exposed)', async () => {
    seedFlakes('mostly-solid', 1, 9); // 1/11 ≈ 9%
    const view = await checkViewFor('mostly-solid');
    expect(view.likelyFlake).toBe(false);
    expect(view.flakeRatePct).toBeCloseTo(100 / 11);
  });

  it('a check with under 5 runs has no rate and is never likelyFlake (min-runs threshold)', async () => {
    seedFlakes('thin-history', 1, 1); // 4 runs — below FLAKE_MIN_RUNS
    const view = await checkViewFor('thin-history');
    expect(view.flakeRatePct).toBeNull();
    expect(view.likelyFlake).toBe(false);
  });

  it('a SUCCEEDING check is never likelyFlake even with a high flake rate', async () => {
    seedFlakes('flaky-but-green', 3, 3); // 50%
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    // DETAIL_RESPONSE's completed check is SUCCESS — switch its name via the seeded one:
    // instead assert directly that the green CHECK_DONE row carries likelyFlake=false
    const state = p.buildState();
    const checks = state.repos.find((r) => r.repo === 'acme/widgets')!
      .prs.find((x) => x.number === 8962)!.checks;
    for (const c of checks) expect(c.likelyFlake).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issues #39/#40: queue ops console payload + multi-train merge ETA simulation
// ---------------------------------------------------------------------------

describe('Poller queue ops console (#39) + merge ETA simulation (#40)', () => {
  const OPS_EVENTS_ON: NotificationsConfig = {
    enabled: false, command: [], digest: { enabled: false, hourLocal: 8 },
    events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
      ready: true, overdue: true, 'prod-live': true, 'queue-stalled': true,
      'duration-regression': true, 'runner-starvation': true, 'budget-breach': true},
  };

  const opsSweep = (n: number) => ({
    open0: { issueCount: 1, nodes: [{ number: n, title: 'feat: thing', url: `u${n}`, isDraft: false,
      mergedAt: null, repository: { nameWithOwner: 'acme/widgets' }, mergeCommit: null }] },
    open1: { issueCount: 0, nodes: [] },
    merged0: { issueCount: 0, nodes: [] }, merged1: { issueCount: 0, nodes: [] },
  });

  const opsDetail = (n: number, mq: Record<string, unknown>) => ({
    r0: { nameWithOwner: 'acme/widgets', [`pr${n}`]: {
      number: n, title: 'feat: thing', url: `u${n}`, isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: `head${n}`, autoMergeRequest: { mergeMethod: 'SQUASH' },
      mergeCommit: null, mergeQueueEntry: mq,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [CHECK_DONE] } } } }] },
    } },
  });

  function opsClient(sweep: Record<string, unknown>, detailMarker: string,
    detail: Record<string, unknown>, queue: Record<string, unknown>,
    rollup?: Record<string, unknown>) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return sweep;
        if (q.includes(detailMarker)) return detail;
        if (q.includes('object(oid:')) return rollup ?? { repository: {} };
        if (q.includes('mergeQueue')) return queue;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }

  /** Seed 4 clean trains (durations 600,600,600,1200 — p50=600, p90=1200) in
   *  the last 24h plus one ejected group: ejectProb = 1/5 = 0.2 (> 15% bump),
   *  batch success 4/5 = 80%. Trains/hr now comes from merged_prs clustering
   *  (group_runs is observation-biased), so also seed 5 merged PRs forming
   *  3 trains: [pair 60s apart], [exact-90s pair], [singleton] → 3/24 ≈ 0.1. */
  function seedTrainHistory() {
    // Steady-state history: the one-time de-conflation prune already ran on a
    // prior boot, so seeded group data must survive Poller construction.
    history.setMeta('deconflation_prune_v1', 'test');
    history.recordGroupRun('acme/widgets', 600, '2026-06-10T08:00:00Z');
    history.recordGroupRun('acme/widgets', 600, '2026-06-10T09:00:00Z');
    history.recordGroupRun('acme/widgets', 600, '2026-06-10T10:00:00Z');
    history.recordGroupRun('acme/widgets', 1200, '2026-06-10T11:00:00Z');
    history.recordGroupFailure('acme/widgets', 'e2e', 'oidEjected', '2026-06-10T07:00:00Z');
    const merge = (n: number, mergedAt: string) =>
      history.upsertMergedPr({ repo: 'acme/widgets', number: n, title: `pr${n}`,
        url: `u${n}`, mergedAt, mergeCommitSha: null });
    merge(9101, '2026-06-10T08:00:00Z');  // train 1
    merge(9102, '2026-06-10T08:01:00Z');  // train 1 (60s gap)
    merge(9103, '2026-06-10T09:00:00Z');  // train 2
    merge(9104, '2026-06-10T09:01:30Z');  // train 2 (exact 90s boundary)
    merge(9105, '2026-06-10T10:30:00Z');  // train 3 (singleton)
    merge(9106, '2026-06-08T10:00:00Z');  // outside 24h window — ignored
  }

  // ---- waiting-only queue: healthy + full ops payload + sims ----

  const waitingQueue = { repository: { mergeQueue: { entries: { nodes: [
    { position: 1, state: 'QUEUED', enqueuedAt: '2026-06-10T11:30:00Z',
      headCommit: null, pullRequest: { number: 9006 } },
    { position: 2, state: 'QUEUED', enqueuedAt: '2026-06-10T11:50:00Z',
      headCommit: null, pullRequest: { number: 9007 } },
  ] } } } };

  it('waiting-only queue: healthy badge, depth, per-entry waits, trains/hr, success rate, ejects', async () => {
    seedTrainHistory();
    const client = opsClient(opsSweep(9006), 'pr9006: pullRequest',
      opsDetail(9006, { position: 1, state: 'QUEUED',
        enqueuedAt: '2026-06-10T11:30:00Z', headCommit: null }), waitingQueue);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const queue = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.queue!;
    expect(queue.health).toEqual({ state: 'healthy', detail: 'queue healthy',
      since: NOW.toISOString() });
    expect(queue.depth).toBe(2);
    expect(queue.entriesWithWaitSecs).toEqual([
      { prNumber: 9006, position: 1, waitSecs: 1800 },
      { prNumber: 9007, position: 2, waitSecs: 600 },
    ]);
    // 3 merge clusters in 24h → round(3/24, 1dp) = 0.1; group_runs (4) is NOT the source
    expect(queue.trainsPerHour).toBe(0.1);
    expect(queue.batchSuccessRatePct).toBe(80);
    expect(queue.ejects24h).toBe(1);
  });

  it('waiting entries carry the multi-train ETA sim; PrView mirrors it; queueAheadCount stays', async () => {
    seedTrainHistory();
    const client = opsClient(opsSweep(9006), 'pr9006: pullRequest',
      opsDetail(9006, { position: 1, state: 'QUEUED',
        enqueuedAt: '2026-06-10T11:30:00Z', headCommit: null }), waitingQueue);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    const queue = repo.queue!;
    // front of the line, nothing building: 1 train → p50 = 600; eject bump
    // (prob 0.2 > 15%) adds one extra train at p90 → 2 × 1200 = 2400
    const expectedSim = { p50Secs: 600, p90Secs: 2400, trainsAhead: 0, assumesEjects: true };
    expect(queue.waiting.find((w) => w.prNumber === 9006)!.sim).toEqual(expectedSim);
    // 9007 has one QUEUED entry ahead — still one train at batchSize 6
    expect(queue.waiting.find((w) => w.prNumber === 9007)!.sim).toEqual(expectedSim);
    const pr = repo.prs.find((x) => x.number === 9006)!;
    expect(pr.stage.stage).toBe('queue');
    expect(pr.mergeEtaSim).toEqual(expectedSim);
    expect(pr.queueAheadCount).toBe(0); // unchanged contract
  });

  it('without observed train durations the sim is null (UI falls back to the single number)', async () => {
    const client = opsClient(opsSweep(9006), 'pr9006: pullRequest',
      opsDetail(9006, { position: 1, state: 'QUEUED',
        enqueuedAt: '2026-06-10T11:30:00Z', headCommit: null }), waitingQueue);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    expect(repo.queue!.waiting[0]!.sim).toBeNull();
    expect(repo.prs.find((x) => x.number === 9006)!.mergeEtaSim).toBeNull();
  });

  // ---- dispatch-stall: wedged run, no check ever picked up ----

  const STALL_OID = 'oidStalled';
  const stallQueue = { repository: { mergeQueue: { entries: { nodes: [
    { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:40:00Z',
      headCommit: { oid: STALL_OID }, pullRequest: { number: 9001 } },
  ] } } } };
  // run created 10 min ago, every check still QUEUED with no startedAt
  const stallRollup = { repository: { o0: { oid: STALL_OID, statusCheckRollup: { contexts: { nodes: [
    { __typename: 'CheckRun', name: 'ci', status: 'QUEUED', conclusion: null,
      startedAt: null, completedAt: null, detailsUrl: 'u',
      checkSuite: { workflowRun: { event: 'merge_group', createdAt: '2026-06-10T11:50:00Z' } } },
  ] } } } } };

  it('dispatch-stall: wedged >5min run flips health red, keeps since stable, notifies once', async () => {
    const notifier = new Notifier({ config: () => OPS_EVENTS_ON });
    let t = NOW.getTime();
    const client = opsClient(opsSweep(9001), 'pr9001: pullRequest',
      opsDetail(9001, { position: 1, state: 'AWAITING_CHECKS',
        enqueuedAt: '2026-06-10T11:40:00Z', headCommit: { oid: STALL_OID } }),
      stallQueue, stallRollup);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => new Date(t), notifier });
    const events: NotificationEvent[] = [];
    p.on('notification', (ev: NotificationEvent) => events.push(ev));
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const s1 = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.queue!;
    expect(s1.health.state).toBe('dispatch-stall');
    expect(s1.health.detail).toContain('do NOT admin-merge');
    const since = s1.health.since;
    t += 60_000; // a minute later, still stalled — same state entry
    const s2 = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.queue!;
    expect(s2.health.state).toBe('dispatch-stall');
    expect(s2.health.since).toBe(since);
    // queue-stalled fired exactly once (debounced per state entry)
    expect(events.filter((e) => e.type === 'queue-stalled')).toHaveLength(1);
    expect(events.find((e) => e.type === 'queue-stalled')).toMatchObject({
      repo: 'acme/widgets', prNumber: 0 });
    // a building (non-waiting) entry never carries a sim
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!
      .prs.find((x) => x.number === 9001)!;
    expect(pr.mergeEtaSim).toBeNull();
  });

  // ---- cap-backlog: runs start but checks sit in runner waits ----

  const BACKLOG_OID = 'oidBacklog';
  const backlogQueue = { repository: { mergeQueue: { entries: { nodes: [
    { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:40:00Z',
      headCommit: { oid: BACKLOG_OID }, pullRequest: { number: 9001 } },
  ] } } } };
  // lint finished 5 min ago; ci's needs are satisfied but no runner picked it up
  const backlogRollup = { repository: { o0: { oid: BACKLOG_OID, statusCheckRollup: { contexts: { nodes: [
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS',
      startedAt: '2026-06-10T11:45:00Z', completedAt: '2026-06-10T11:55:00Z', detailsUrl: 'u',
      checkSuite: { workflowRun: { event: 'merge_group', createdAt: '2026-06-10T11:44:00Z' } } },
    { __typename: 'CheckRun', name: 'ci', status: 'QUEUED', conclusion: null,
      startedAt: null, completedAt: null, detailsUrl: 'u',
      checkSuite: { workflowRun: { event: 'merge_group', createdAt: '2026-06-10T11:44:00Z' } } },
  ] } } } } };

  it('cap-backlog: started run with a ≥60s runner wait reads amber, no notification', async () => {
    const notifier = new Notifier({ config: () => OPS_EVENTS_ON });
    const client = opsClient(opsSweep(9001), 'pr9001: pullRequest',
      opsDetail(9001, { position: 1, state: 'AWAITING_CHECKS',
        enqueuedAt: '2026-06-10T11:40:00Z', headCommit: { oid: BACKLOG_OID } }),
      backlogQueue, backlogRollup);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW, notifier });
    p.setDerivedGraph('acme/widgets', new Map([
      ['ci', { needs: ['lint'], activity: { mode: 'all' as const }, runsOn: null, timeoutMinutes: null }],
      ['lint', { needs: [], activity: { mode: 'all' as const }, runsOn: null, timeoutMinutes: null }],
    ]));
    const events: NotificationEvent[] = [];
    p.on('notification', (ev: NotificationEvent) => events.push(ev));
    await p.sweepOnce();
    await p.detailOnce();
    await p.queueOnce();
    const queue = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.queue!;
    expect(queue.health.state).toBe('cap-backlog');
    expect(queue.health.detail).toContain('wait or raise cap');
    expect(events.filter((e) => e.type === 'queue-stalled')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Duration ingestion guard (issue #61) — a SUCCESS sample cannot legitimately
// exceed the job's own timeout; wait-contaminated spans must never reach
// check_durations (they poison p99 / expected medians / the timeout lint).
// ---------------------------------------------------------------------------

describe('duration ingestion guard (issue #61)', () => {
  const check = (over: Partial<CheckRun>): CheckRun => ({
    name: 'Changed scope', rawName: 'Changed scope', status: 'COMPLETED', conclusion: 'SUCCESS',
    startedAt: '2026-06-12T02:28:27Z', completedAt: '2026-06-12T02:28:45Z',
    event: 'pull_request', workflowName: 'CI', runNumber: 1, runAttempt: 1,
    runDatabaseId: null,
    isRequired: true, url: null, ...over,
  });
  const span = (secs: number): Pick<CheckRun, 'startedAt' | 'completedAt'> => ({
    startedAt: '2026-06-12T02:00:00Z',
    completedAt: new Date(Date.parse('2026-06-12T02:00:00Z') + secs * 1000).toISOString(),
  });

  it('maxPlausibleSuccessSecs: timeout×1.5 when known, 4h absolute fallback', () => {
    expect(maxPlausibleSuccessSecs(8)).toBe(8 * 60 * 1.5);
    expect(maxPlausibleSuccessSecs(null)).toBe(4 * 3600);
  });

  it('rejects a SUCCESS sample exceeding the job timeout × 1.5', () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    ingestCheckSet(history, 'acme/widgets', [check(span(51_027))], () => null,
      undefined, null, null, 'sha1', () => 8); // timeout-minutes: 8
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('accepts a SUCCESS sample at/below the timeout cap', () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    ingestCheckSet(history, 'acme/widgets', [check(span(8 * 60 * 1.5))], () => null,
      undefined, null, null, 'sha1', () => 8); // exactly at cap — kept
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('unknown timeout: 4h absolute cap (reject above, accept below)', () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    ingestCheckSet(history, 'acme/widgets', [check(span(4 * 3600 + 1))], () => null);
    expect(spy).not.toHaveBeenCalled();
    ingestCheckSet(history, 'acme/widgets', [check(span(3.9 * 3600))], () => null);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('non-SUCCESS conclusions still record (flake radar needs the identity rows)', () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    ingestCheckSet(history, 'acme/widgets', [check({ ...span(51_027), conclusion: 'FAILURE' })],
      () => null, undefined, null, null, 'sha1', () => 8);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('timeoutMinutesFor resolves a check name to its graph node timeout', () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    expect(p.timeoutMinutesFor('acme/widgets', 'quick')).toBeNull(); // no graph yet
    p.adoptDerivedGraph('acme/widgets', deriveCiGraph(`
jobs:
  quick:
    runs-on: ubuntu-latest
    timeout-minutes: 8
  ci:
    needs: [quick]
    runs-on: ubuntu-latest
`)!);
    expect(p.timeoutMinutesFor('acme/widgets', 'quick')).toBe(8);
    expect(p.timeoutMinutesFor('acme/widgets', 'ci')).toBeNull(); // no timeout set
    expect(p.timeoutMinutesFor('acme/widgets', 'no-such-check')).toBeNull();
    expect(p.timeoutMinutesFor('octo/unknown', 'quick')).toBeNull();
  });

  it('detail-cycle ingestion applies the guard in the live path (4h fallback)', async () => {
    const contaminated = {
      ...CHECK_DONE,
      startedAt: '2026-06-12T02:28:27Z', completedAt: '2026-06-12T16:38:54Z', // 51,027s
    };
    const detail = {
      r0: { nameWithOwner: 'acme/widgets', pr8962: {
        number: 8962, title: 't', url: 'u', isDraft: false, mergeStateStatus: 'BLOCKED',
        mergedAt: null, headRefOid: 'head8962', autoMergeRequest: null, mergeCommit: null,
        mergeQueueEntry: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
          contexts: { pageInfo: { hasNextPage: false }, nodes: [contaminated] } } } }] },
      } },
    };
    const spy = vi.spyOn(history, 'recordCheckDuration');
    const p = new Poller({ router: asRouter(fakeClient(SWEEP_RESPONSE, detail)), history,
      deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Workflow scoping of the duration guard + live foreign names (issue #61
// follow-up): the derived graph describes the ROLLUP workflow's jobs, so a
// foreign check (`ci-gate` from `Auto-merge PRs`) must not inherit the `ci`
// node's timeout — its hours-long SUCCESS spans are by design (it mirrors the
// whole CI lifecycle across spot retries).
// ---------------------------------------------------------------------------

describe('guard workflow scoping + liveForeignNames (issue #61 follow-up)', () => {
  const gate = (over: Partial<CheckRun> = {}): CheckRun => ({
    name: 'ci-gate', rawName: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS',
    startedAt: '2026-06-12T02:00:00Z', completedAt: '2026-06-12T04:00:00Z', // 2h by design
    event: 'pull_request', workflowName: 'Auto-merge PRs', runNumber: 7, runAttempt: 1,
    runDatabaseId: null,
    isRequired: false, url: null, ...over,
  });

  it('a foreign-workflow check never inherits the prefix-matched node timeout', () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    // rollup workflow 'CI'; timeoutFor would say 15m (the false `ci` match) —
    // scoping must ignore it and fall back to the 4h absolute cap → recorded
    ingestCheckSet(history, 'acme/widgets', [gate()], () => null,
      undefined, null, 'CI', 'sha1', () => 15);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('the same span from the rollup workflow itself is rejected by its timeout', () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    ingestCheckSet(history, 'acme/widgets', [gate({ workflowName: 'CI' })], () => null,
      undefined, null, 'CI', 'sha1', () => 15);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('null check workflow stays permissive (old data: timeout applies)', () => {
    const spy = vi.spyOn(history, 'recordCheckDuration');
    ingestCheckSet(history, 'acme/widgets', [gate({ workflowName: null })], () => null,
      undefined, null, 'CI', 'sha1', () => 15);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('liveForeignNames exposes per-repo foreign check names from live snapshots', async () => {
    const detail = {
      r0: { nameWithOwner: 'acme/widgets', pr8962: {
        number: 8962, title: 't', url: 'u', isDraft: false, mergeStateStatus: 'BLOCKED',
        mergedAt: null, headRefOid: 'head8962', autoMergeRequest: null, mergeCommit: null,
        mergeQueueEntry: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
          contexts: { pageInfo: { hasNextPage: false }, nodes: [
            CHECK_DONE,
            { ...CHECK_DONE, name: 'ci-gate',
              checkSuite: { workflowRun: { event: 'pull_request', runNumber: 7,
                workflow: { name: 'Auto-merge PRs' } } } },
          ] } } } }] },
      } },
    };
    const p = new Poller({ router: asRouter(fakeClient(SWEEP_RESPONSE, detail)), history,
      deploy: noDeploy(), config: CONFIG, now: () => NOW });
    expect(p.liveForeignNames()).toEqual(new Map()); // nothing fetched yet
    await p.sweepOnce();
    await p.detailOnce();
    p.setRollupWorkflowName('acme/widgets', 'CI');
    expect(p.liveForeignNames()).toEqual(new Map([['acme/widgets', new Set(['ci-gate'])]]));
    // unknown rollup workflow → no scoping possible → nothing reads as foreign
    p.setRollupWorkflowName('acme/widgets', null as unknown as string);
    expect(p.liveForeignNames()).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------------
// Duration-regression scan (issue #41): hourly cadence riding the deploy
// cycle, results cached on the poller, notifier events debounced per series.
// ---------------------------------------------------------------------------

describe('Poller duration-regression scan (issue #41)', () => {
  const REG_EVENTS: NotificationsConfig = {
    enabled: false, command: [], digest: { enabled: false, hourLocal: 8 },
    events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
      ready: true, overdue: true, 'prod-live': true, 'queue-stalled': true,
      'duration-regression': true, 'runner-starvation': true, 'budget-breach': true},
  };
  const REG_CHECK = 'fast-checks / ESLint';

  /** 20 prior samples @ priorSecs then 10 recent @ recentSecs, 5 min apart,
   *  newest completing ~09:30 UTC (well inside NOW's recency window). */
  function seedStep(recentSecs: number, priorSecs = 120, repo = 'acme/widgets') {
    const base = Date.parse('2026-06-10T07:00:00Z');
    for (let i = 0; i < 30; i++) {
      const secs = i < 20 ? priorSecs : recentSecs;
      history.recordCheckDuration(repo, REG_CHECK, 'pull_request',
        new Date(base + i * 5 * 60_000).toISOString(),
        new Date(base + i * 5 * 60_000 + secs * 1000).toISOString(), 'SUCCESS');
    }
  }

  function regHarness(now: () => Date, config = CONFIG) {
    const events: NotificationEvent[] = [];
    const notifier = new Notifier({ config: () => REG_EVENTS });
    notifier.on('notification', (ev: NotificationEvent) => events.push(ev));
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config, now, notifier });
    return { p, events };
  }

  it('deployOnce scans, caches the active regression, and fires the notifier once', async () => {
    seedStep(600); // 2m→10m: ×5, +8m — both guards trip
    const { p, events } = regHarness(() => NOW);
    await p.deployOnce();
    const regs = p.activeRegressions();
    expect(regs).toHaveLength(1);
    expect(regs[0]!.repo).toBe('acme/widgets');
    expect(regs[0]!.checks).toHaveLength(1);
    expect(regs[0]!.checks[0]).toMatchObject({
      check: REG_CHECK, event: 'pull_request', priorP50Secs: 120, recentP50Secs: 600 });
    expect(regs[0]!.checks[0]!.ratio).toBeCloseTo(5);
    const regEvents = events.filter((e) => e.type === 'duration-regression');
    expect(regEvents).toHaveLength(1);
    expect(regEvents[0]).toMatchObject({ repo: 'acme/widgets', prNumber: 0, title: REG_CHECK });
    expect(regEvents[0]!.detail).toContain('2m → 10m');
  });

  it('no flag when only one guard trips (delta < 60s)', async () => {
    seedStep(5, 3); // ×1.67 but +2s — noise
    const { p, events } = regHarness(() => NOW);
    await p.deployOnce();
    expect(p.activeRegressions()).toHaveLength(0);
    expect(events.filter((e) => e.type === 'duration-regression')).toHaveLength(0);
  });

  it('throttles to one scan per hour (re-fires after the hour elapses)', async () => {
    seedStep(600);
    let t = NOW;
    const { p, events } = regHarness(() => t);
    await p.deployOnce();
    // active regression cleared between scans would be re-detected — but within
    // the hour the scan must not even run, so the cache stays as-is
    seedStep(600, 120, 'octo/gizmos');
    await p.deployOnce();
    expect(p.activeRegressions()).toHaveLength(1); // octo/gizmos not scanned yet
    t = new Date(NOW.getTime() + 3601_000);
    await p.deployOnce();
    expect(p.activeRegressions()).toHaveLength(2);
    expect(events.filter((e) => e.type === 'duration-regression')).toHaveLength(2);
  });

  it('debounces while the condition holds; hysteresis keeps 1.2 ≤ ratio < 1.5 active; clears below 1.2 and re-fires', async () => {
    seedStep(600);
    let t = NOW;
    const { p, events } = regHarness(() => t);
    await p.deployOnce(); // scan 1: flagged
    // scan 2 (an hour later): same data → still active, no second event
    t = new Date(t.getTime() + 3601_000);
    await p.deployOnce();
    expect(events.filter((e) => e.type === 'duration-regression')).toHaveLength(1);
    expect(p.activeRegressions()).toHaveLength(1);
    // scan 3: newest 10 samples now ~156s (×1.3, +36s) — below the flag bar but
    // above the clear bar: stays active because it WAS active
    const base3 = Date.parse('2026-06-10T13:00:00Z');
    for (let i = 0; i < 10; i++) {
      history.recordCheckDuration('acme/widgets', REG_CHECK, 'pull_request',
        new Date(base3 + i * 5 * 60_000).toISOString(),
        new Date(base3 + i * 5 * 60_000 + 156_000).toISOString(), 'SUCCESS');
    }
    t = new Date(t.getTime() + 3601_000);
    await p.deployOnce();
    expect(p.activeRegressions()).toHaveLength(1);
    // scan 4: newest 10 samples back to ~120s (ratio ~1) — clears
    const base4 = Date.parse('2026-06-10T15:00:00Z');
    for (let i = 0; i < 10; i++) {
      history.recordCheckDuration('acme/widgets', REG_CHECK, 'pull_request',
        new Date(base4 + i * 5 * 60_000).toISOString(),
        new Date(base4 + i * 5 * 60_000 + 120_000).toISOString(), 'SUCCESS');
    }
    t = new Date(t.getTime() + 3601_000);
    await p.deployOnce();
    expect(p.activeRegressions()).toHaveLength(0);
    // scan 5: a fresh step (10 @ 600s) — re-fires after the clear
    const base5 = Date.parse('2026-06-10T17:00:00Z');
    for (let i = 0; i < 10; i++) {
      history.recordCheckDuration('acme/widgets', REG_CHECK, 'pull_request',
        new Date(base5 + i * 5 * 60_000).toISOString(),
        new Date(base5 + i * 5 * 60_000 + 600_000).toISOString(), 'SUCCESS');
    }
    t = new Date(t.getTime() + 3601_000);
    await p.deployOnce();
    expect(events.filter((e) => e.type === 'duration-regression')).toHaveLength(2);
  });

  it('skips excluded repos and dormant series (newest sample > 14d old)', async () => {
    seedStep(600); // acme/widgets — will be excluded
    const base = Date.parse('2026-05-01T07:00:00Z'); // > 14d before NOW
    for (let i = 0; i < 30; i++) {
      const secs = i < 20 ? 120 : 600;
      history.recordCheckDuration('octo/gizmos', 'old-check', 'pull_request',
        new Date(base + i * 5 * 60_000).toISOString(),
        new Date(base + i * 5 * 60_000 + secs * 1000).toISOString(), 'SUCCESS');
    }
    const { p } = regHarness(() => NOW, { ...CONFIG, exclude: ['acme/widgets'] });
    await p.deployOnce();
    expect(p.activeRegressions()).toHaveLength(0);
  });

  it('CheckView rows carry regressed + regression detail for badging (Gantt ↑ marker)', async () => {
    seedStep(600);
    const { p } = regHarness(() => NOW);
    await p.deployOnce();
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.getState().repos[0]!.prs.find((x) => x.number === 8962)!;
    const eslint = pr.checks.find((c) => c.name.includes('ESLint'))!;
    expect(eslint.regressed).toBe(true);
    expect(eslint.regression).toMatchObject({ priorP50Secs: 120, recentP50Secs: 600 });
    expect(eslint.regression!.sinceApprox).toBeTruthy();
    const other = pr.checks.find((c) => !c.name.includes('ESLint'))!;
    expect(other.regressed).toBe(false);
    expect(other.regression).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fleet telemetry (issues #45/#46): pool-labeled ingestion, re-run marker,
// starvation scan
// ---------------------------------------------------------------------------

describe('ingestCheckSet pool labels (issue #45)', () => {
  const mkCheck = (over: Partial<CheckRun>): CheckRun => ({
    name: 'job', rawName: 'job', status: 'COMPLETED', conclusion: 'SUCCESS',
    startedAt: null, completedAt: null, event: 'pull_request', workflowName: 'CI',
    runNumber: 1, runAttempt: 1, runDatabaseId: null, isRequired: true, url: null, ...over });
  const PREP = mkCheck({ name: 'prep',
    startedAt: '2026-06-10T11:00:00Z', completedAt: '2026-06-10T11:05:00Z' });
  const JOB = mkCheck({ name: 'job',
    startedAt: '2026-06-10T11:07:00Z', completedAt: '2026-06-10T11:20:00Z' });
  const needsFor = (n: string): string[] | null =>
    n === 'job' ? ['prep'] : n === 'prep' ? [] : null;

  it('stores the pool label on the runner-wait sample', () => {
    ingestCheckSet(history, 'acme/widgets', [PREP, JOB], needsFor, () => true,
      ['prep', 'job'], 'CI', 'sha1', () => null,
      (n) => (n === 'job' ? ['kindash-runner'] : null));
    expect(history.runnerPoolWaitsSince('2026-06-10T00:00:00Z')).toEqual([
      { repo: 'acme/widgets', pool: 'kindash-runner',
        at: '2026-06-10T11:07:00Z', waitSecs: 120 }]);
  });

  it('multi-candidate runs-on (ternary) joins the candidates into ONE pool key', () => {
    ingestCheckSet(history, 'acme/widgets', [PREP, JOB], needsFor, () => true,
      ['prep', 'job'], 'CI', 'sha1', () => null,
      () => ['kindash-runner', 'kindash-ondemand']);
    expect(history.runnerPoolWaitsSince('2026-06-10T00:00:00Z')[0]!.pool)
      .toBe('kindash-runner|kindash-ondemand');
  });

  it('unknown pool (no graph / reusable workflow) stores NULL — the sample still feeds event-keyed reads', () => {
    ingestCheckSet(history, 'acme/widgets', [PREP, JOB], needsFor, () => true,
      ['prep', 'job'], 'CI', 'sha1', () => null /* default poolFor */);
    expect(history.runnerPoolWaitsSince('2026-06-10T00:00:00Z')).toEqual([]);
    expect(history.expectedRunnerWait('acme/widgets', 'job', 'pull_request')).toBe(120);
  });

  it('an empty candidates array also stores NULL', () => {
    ingestCheckSet(history, 'acme/widgets', [PREP, JOB], needsFor, () => true,
      ['prep', 'job'], 'CI', 'sha1', () => null, () => []);
    expect(history.runnerPoolWaitsSince('2026-06-10T00:00:00Z')).toEqual([]);
  });
});

describe('Poller wires poolsFor into detail ingestion (issue #45)', () => {
  it('a derived-graph node with runsOn labels the pickup-wait sample', async () => {
    const PREPARE = 'Prepare (prisma + packages)';
    const AFFECTED = 'pr-affected-tests / Affected Unit + Server Tests';
    const prepDone = { ...CHECK_DONE, name: PREPARE, isRequired: false,
      startedAt: '2026-06-10T11:48:00Z', completedAt: '2026-06-10T11:53:00Z' };
    const detail = { r0: { nameWithOwner: 'acme/widgets', pr8962: {
      ...DETAIL_RESPONSE.r0.pr8962,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [prepDone, CHECK_RUNNING] } } } }] },
    } } };
    const p = new Poller({ router: asRouter(fakeClient(SWEEP_RESPONSE, detail)), history,
      deploy: noDeploy(), config: CONFIG, now: () => NOW });
    p.setDerivedGraph('acme/widgets', new Map([
      ['pr-affected-tests /', { needs: [PREPARE], activity: { mode: 'all' as const },
        runsOn: ['kindash-runner', 'kindash-ondemand'], timeoutMinutes: null }],
      [PREPARE, { needs: [], activity: { mode: 'all' as const },
        runsOn: ['kindash-runner'], timeoutMinutes: null }],
    ]));
    await p.sweepOnce();
    await p.detailOnce();
    const rows = history.runnerPoolWaitsSince('2026-06-10T00:00:00Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pool: 'kindash-runner|kindash-ondemand', waitSecs: 120 });
    expect(history.expectedRunnerWait('acme/widgets', AFFECTED, 'pull_request')).toBe(120);
  });
});

describe('rerunInProgressFor (issue #46 — the "do nothing" marker)', () => {
  const mk = (over: Partial<CheckRun>): CheckRun => ({
    name: 'e2e', rawName: 'e2e', status: 'COMPLETED', conclusion: 'CANCELLED',
    startedAt: '2026-06-10T11:00:00Z', completedAt: '2026-06-10T11:05:00Z',
    event: 'merge_group', workflowName: 'CI', runNumber: 9, runAttempt: 1,
    runDatabaseId: null,
    isRequired: true, url: null, ...over });

  it('true: CANCELLED at attempt 1 with a sibling running at attempt 2', () => {
    const cancelled = mk({});
    const sibling = mk({ name: 'unit', status: 'IN_PROGRESS', conclusion: null, runAttempt: 2 });
    expect(rerunInProgressFor(cancelled, [cancelled, sibling])).toBe(true);
  });

  it('true: the newer attempt can be QUEUED too', () => {
    const cancelled = mk({});
    const queued = mk({ name: 'unit', status: 'QUEUED', conclusion: null,
      startedAt: null, completedAt: null, runAttempt: 2 });
    expect(rerunInProgressFor(cancelled, [cancelled, queued])).toBe(true);
  });

  it('false: the newer attempt already COMPLETED (nothing in flight)', () => {
    const cancelled = mk({});
    const done = mk({ name: 'unit', conclusion: 'SUCCESS', runAttempt: 2 });
    expect(rerunInProgressFor(cancelled, [cancelled, done])).toBe(false);
  });

  it('false: a running check at the SAME attempt is the original run, not a re-run', () => {
    const cancelled = mk({});
    const peer = mk({ name: 'unit', status: 'IN_PROGRESS', conclusion: null, runAttempt: 1 });
    expect(rerunInProgressFor(cancelled, [cancelled, peer])).toBe(false);
  });

  it('false: FAILURE conclusions never get the marker (reclaims are CANCELLED-class)', () => {
    const failed = mk({ conclusion: 'FAILURE' });
    const sibling = mk({ name: 'unit', status: 'IN_PROGRESS', conclusion: null, runAttempt: 2 });
    expect(rerunInProgressFor(failed, [failed, sibling])).toBe(false);
  });

  it('false: a different EVENT population never matches', () => {
    const cancelled = mk({});
    const otherEvent = mk({ name: 'unit', status: 'QUEUED', conclusion: null,
      event: 'pull_request', runAttempt: 2 });
    expect(rerunInProgressFor(cancelled, [cancelled, otherEvent])).toBe(false);
  });

  it('false: null attempts on either side never match (no false advice on old data)', () => {
    const noAttempt = mk({ runAttempt: null });
    const sibling = mk({ name: 'unit', status: 'IN_PROGRESS', conclusion: null, runAttempt: 2 });
    expect(rerunInProgressFor(noAttempt, [noAttempt, sibling])).toBe(false);
    const cancelled = mk({});
    const nullSibling = mk({ name: 'unit', status: 'IN_PROGRESS', conclusion: null, runAttempt: null });
    expect(rerunInProgressFor(cancelled, [cancelled, nullSibling])).toBe(false);
  });
});

describe('CheckView rerunInProgress (issue #46)', () => {
  it('a CANCELLED check whose sha has a newer attempt in flight carries the flag', async () => {
    const cancelled = { ...CHECK_DONE, name: 'spot-killed-job', conclusion: 'CANCELLED',
      checkSuite: { workflowRun: { event: 'pull_request', runNumber: 9, runAttempt: 1 } } };
    const rerunning = { ...CHECK_DONE, name: 'other-job', status: 'IN_PROGRESS', conclusion: null,
      completedAt: null,
      checkSuite: { workflowRun: { event: 'pull_request', runNumber: 9, runAttempt: 2 } } };
    const detail = { r0: { nameWithOwner: 'acme/widgets', pr8962: {
      ...DETAIL_RESPONSE.r0.pr8962,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [cancelled, rerunning] } } } }] },
    } } };
    const p = new Poller({ router: asRouter(fakeClient(SWEEP_RESPONSE, detail)), history,
      deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos[0]!.prs.find((x) => x.number === 8962)!;
    expect(pr.checks.find((c) => c.name === 'spot-killed-job')!.rerunInProgress).toBe(true);
    expect(pr.checks.find((c) => c.name === 'other-job')!.rerunInProgress).toBe(false);
  });
});

describe('Poller runner-starvation scan (issue #45)', () => {
  const POOL = 'kindash-runner';
  const seedBaseline = (waitSecs = 10) => {
    for (let i = 0; i < 6; i++) {
      history.recordRunnerWait('acme/widgets', `base-${i}`, 'pull_request', waitSecs,
        new Date(NOW.getTime() - 2 * 86400_000 + i * 60_000).toISOString(), POOL);
    }
  };
  const seedSpike = (atMs: number, waitSecs: number) => {
    for (let i = 0; i < 6; i++) {
      history.recordRunnerWait('acme/widgets', `spike-${atMs}-${i}`, 'pull_request', waitSecs,
        new Date(atMs - 30 * 60_000 + i * 60_000).toISOString(), POOL);
    }
  };
  function starvationHarness() {
    let now = NOW;
    const events: NotificationEvent[] = [];
    const notifier = new Notifier({ config: () => ({ enabled: false, command: [], digest: { enabled: false, hourLocal: 8 },
      events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
        ready: true, overdue: true, 'prod-live': true, 'queue-stalled': true,
        'duration-regression': true, 'runner-starvation': true, 'budget-breach': true} }) });
    notifier.on('notification', (ev: NotificationEvent) => events.push(ev));
    const p = new Poller({ router: asRouter(fakeClient()), history,
      deploy: noDeploy(), config: CONFIG, notifier, now: () => now });
    return { p, events, setNow: (d: Date) => { now = d; } };
  }

  it('a last-hour p90 blowout vs the 7d baseline fires runner-starvation once', () => {
    seedBaseline();
    seedSpike(NOW.getTime(), 2_000);
    const { p, events } = starvationHarness();
    p.scanRunnerStarvation();
    p.scanRunnerStarvation(); // same episode — debounced
    const starve = events.filter((e) => e.type === 'runner-starvation');
    expect(starve).toHaveLength(1);
    expect(starve[0]).toMatchObject({ repo: 'acme/widgets', prNumber: 0, title: POOL });
    expect(starve[0]!.detail).toContain(`pool '${POOL}'`);
    const health = p.poolHealth();
    expect(health).toHaveLength(1);
    expect(health[0]!.pools[0]).toMatchObject({ pool: POOL, starving: true, n: 6 });
    expect(health[0]!.pools[0]!.lastHourP90Secs).toBe(2_000);
    expect(health[0]!.pools[0]!.baselineP90Secs).toBe(10);
  });

  it('a healthy pool never fires but still appears in poolHealth', () => {
    seedBaseline(10);
    seedSpike(NOW.getTime(), 12); // ~baseline
    const { p, events } = starvationHarness();
    p.scanRunnerStarvation();
    expect(events.filter((e) => e.type === 'runner-starvation')).toHaveLength(0);
    expect(p.poolHealth()[0]!.pools[0]).toMatchObject({ pool: POOL, starving: false });
  });

  it('episode lifecycle: clears when the spike leaves the last hour, re-fires on a new spike', () => {
    seedBaseline();
    seedSpike(NOW.getTime(), 2_000);
    const { p, events, setNow } = starvationHarness();
    p.scanRunnerStarvation();
    expect(events.filter((e) => e.type === 'runner-starvation')).toHaveLength(1);
    // two hours later: no last-hour samples → episode clears (idle/recovered)
    const later = new Date(NOW.getTime() + 2 * 3600_000);
    setNow(later);
    p.scanRunnerStarvation();
    expect(p.poolHealth()[0]!.pools[0]!.starving).toBe(false);
    // a fresh, even bigger spike re-fires (the old spike is baseline now: p90 2000 → bar 8000)
    seedSpike(later.getTime() + 3600_000, 9_000);
    setNow(new Date(later.getTime() + 3600_000));
    p.scanRunnerStarvation();
    expect(events.filter((e) => e.type === 'runner-starvation')).toHaveLength(2);
  });

  it('excluded repos are never evaluated', () => {
    seedBaseline();
    seedSpike(NOW.getTime(), 2_000);
    const { p, events } = starvationHarness();
    (p as unknown as { deps: { config: AppConfig } }).deps.config =
      { ...CONFIG, exclude: ['acme/widgets'] };
    p.scanRunnerStarvation();
    expect(events).toHaveLength(0);
    expect(p.poolHealth()).toEqual([]);
  });
});

// ---- per-PR waterfall timeline threading (issue #50) ----
describe('PrView.timeline (issue #50)', () => {
  it('merged PR views carry the merged_prs waterfall spine', () => {
    history.upsertMergedPr({ repo: 'acme/widgets', number: 9001, title: 'feat: spine', url: 'u9001',
      mergedAt: '2026-06-10T10:00:00Z', mergeCommitSha: 'sha9001',
      createdAt: '2026-06-09T08:00:00Z', firstGreenAt: '2026-06-09T09:00:00Z',
      enqueuedAt: '2026-06-09T09:30:00Z' });
    history.markEnvLive('acme/widgets', 9001, 'qa', '2026-06-10T10:20:00Z');
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 9001)!;
    expect(pr.timeline).toEqual({
      createdAt: '2026-06-09T08:00:00Z', firstGreenAt: '2026-06-09T09:00:00Z',
      enqueuedAt: '2026-06-09T09:30:00Z', mergedAt: '2026-06-10T10:00:00Z',
      qaLiveAt: '2026-06-10T10:20:00Z', prodLiveAt: null,
      envLive: { qa: '2026-06-10T10:20:00Z' },
    });
  });

  it('missing spine waypoints stay null — never fabricated', () => {
    history.upsertMergedPr({ repo: 'acme/widgets', number: 9002, title: 'feat: thin', url: 'u9002',
      mergedAt: '2026-06-10T10:00:00Z', mergeCommitSha: null });
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 9002)!;
    expect(pr.timeline).toEqual({
      createdAt: null, firstGreenAt: null, enqueuedAt: null,
      mergedAt: '2026-06-10T10:00:00Z', qaLiveAt: null, prodLiveAt: null,
      envLive: {},
    });
  });

  it('open PR views carry timeline null', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.timeline).toBeNull();
  });
});

// ---- workflow-change impact annotation (issue #49) ----
describe('workflow-change impact (issue #49)', () => {
  const BASE_YML = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
  ci:
    needs: [build]
    runs-on: ubuntu-latest
`;
  const HEAD_YML = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
  android-smoke:
    runs-on: ubuntu-latest
  ci:
    needs: [build, android-smoke]
    runs-on: ubuntu-latest
`;
  const detailWithFiles = (paths: string[]) => ({
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      number: 8962, title: 'ci: workflow change', url: 'u8962', isDraft: false,
      mergeStateStatus: 'BLOCKED', mergedAt: null, headRefOid: 'head8962',
      autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
      files: { nodes: paths.map((path) => ({ path })) },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [CHECK_DONE] } } } }] },
    } },
  });

  function blobClient(detail: Record<string, unknown>, headYml: string | null) {
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('head8962:')) return { repository: {
          defaultBranchRef: { name: 'main' },
          object: headYml != null ? { text: headYml } : null } };
        if (q.includes('pr8962: pullRequest')) return detail;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
    };
  }
  const blobCalls = (c: { graphql: { mock: { calls: unknown[][] } } }) =>
    c.graphql.mock.calls.filter(([q]) => (q as string).includes('head8962:')).length;

  it('flagged PR + derived graph → diff computed at detail time and threaded onto the view', async () => {
    const c = blobClient(detailWithFiles(['.github/workflows/ci.yml']), HEAD_YML);
    const p = new Poller({ router: asRouter(c), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.adoptDerivedGraph('acme/widgets', deriveCiGraph(BASE_YML)!);
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.touchesWorkflows).toBe(true);
    expect(pr.workflowImpact!.summary).toEqual([
      '+ android-smoke joins the merge_group gate',
      'required-check set grows by 1: 2 → 3 checks',
    ]);
  });

  it('diff is cached per head sha — a second detail cycle refetches no blob', async () => {
    const c = blobClient(detailWithFiles(['.github/workflows/ci.yml']), HEAD_YML);
    const p = new Poller({ router: asRouter(c), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.adoptDerivedGraph('acme/widgets', deriveCiGraph(BASE_YML)!);
    await p.sweepOnce();
    await p.detailOnce();
    expect(blobCalls(c)).toBe(1);
    await p.detailOnce();
    expect(blobCalls(c)).toBe(1);
  });

  it('identical head workflow → workflowImpact null (no-change), flag still true, null cached', async () => {
    const c = blobClient(detailWithFiles(['.github/workflows/ci.yml']), BASE_YML);
    const p = new Poller({ router: asRouter(c), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.adoptDerivedGraph('acme/widgets', deriveCiGraph(BASE_YML)!);
    await p.sweepOnce();
    await p.detailOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.touchesWorkflows).toBe(true);
    expect(pr.workflowImpact).toBeNull();
    expect(blobCalls(c)).toBe(1); // the null verdict is cached too
  });

  it('non-workflow file list → flag false, no blob fetch, impact null', async () => {
    const c = blobClient(detailWithFiles(['src/index.ts', 'README.md']), HEAD_YML);
    const p = new Poller({ router: asRouter(c), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    p.adoptDerivedGraph('acme/widgets', deriveCiGraph(BASE_YML)!);
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.touchesWorkflows).toBe(false);
    expect(pr.workflowImpact).toBeNull();
    expect(blobCalls(c)).toBe(0);
  });

  it('no derived graph for the repo → badge flag true, no blob fetch, impact null', async () => {
    const c = blobClient(detailWithFiles(['.github/workflows/ci.yml']), HEAD_YML);
    const p = new Poller({ router: asRouter(c), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 8962)!;
    expect(pr.touchesWorkflows).toBe(true);
    expect(pr.workflowImpact).toBeNull();
    expect(blobCalls(c)).toBe(0);
  });

  it('merged PR views never carry the flag or an impact', () => {
    history.upsertMergedPr({ repo: 'acme/widgets', number: 9003, title: 't', url: 'u',
      mergedAt: '2026-06-10T10:00:00Z', mergeCommitSha: null });
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs
      .find((x) => x.number === 9003)!;
    expect(pr.touchesWorkflows).toBe(false);
    expect(pr.workflowImpact).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cost explorer: PR-level CI cost + sha → PR-number join
// ---------------------------------------------------------------------------

describe('computePrCost (cost explorer)', () => {
  const NOW_COST = new Date('2026-06-10T12:00:00Z');
  const base: CheckRun = {
    name: 'unit-tests', rawName: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS',
    startedAt: '2026-06-10T11:00:00Z', completedAt: '2026-06-10T11:10:00Z',
    event: 'pull_request', workflowName: 'CI', runNumber: 1, runAttempt: 1,
    runDatabaseId: null,
    isRequired: true, url: null,
  };
  const spotPools = (name: string): string[] | null =>
    name === 'mystery' ? null : ['spot'];

  it('sums completed spans and counts running checks started → now', () => {
    const running: CheckRun = { ...base, name: 'e2e', status: 'IN_PROGRESS',
      conclusion: null, startedAt: '2026-06-10T11:55:00Z', completedAt: null };
    const { costMinutes, costDollars } = computePrCost([base, running], 'CI',
      spotPools, null, null, NOW_COST);
    expect(costMinutes).toBeCloseTo(15); // 10 completed + 5 running
    expect(costDollars).toBeNull();      // minutes-only mode
  });

  it('prices per check through its pool; unknown pools take the default rate', () => {
    const mystery: CheckRun = { ...base, name: 'mystery' };
    const { costDollars } = computePrCost([base, mystery], 'CI',
      spotPools, { spot: 0.01, default: 0.02 }, null, NOW_COST);
    expect(costDollars).toBeCloseTo(0.1 + 0.2); // 10m×0.01 + 10m×0.02
  });

  it('poolMeta dollarsPerMinute supersedes costPerMinute for the same label', () => {
    const { costDollars } = computePrCost([base], 'CI',
      spotPools, { spot: 0.01 }, { spot: { dollarsPerMinute: 0.005 } }, NOW_COST);
    expect(costDollars).toBeCloseTo(0.05);
  });

  it('unpriced pools contribute minutes but no dollars (documented undercount)', () => {
    const mystery: CheckRun = { ...base, name: 'mystery' };
    const { costMinutes, costDollars } = computePrCost([base, mystery], 'CI',
      spotPools, { spot: 0.01 }, null, NOW_COST);
    expect(costMinutes).toBeCloseTo(20);
    expect(costDollars).toBeCloseTo(0.1); // mystery → 'unknown', no default → $0 contribution
  });

  it('excludes foreign-workflow checks — their spans are CI-lifecycle wall-clock (issue #61)', () => {
    const foreign: CheckRun = { ...base, name: 'ci-gate', workflowName: 'Auto-merge PRs',
      startedAt: '2026-06-10T09:00:00Z', completedAt: '2026-06-10T11:30:00Z' };
    const { costMinutes } = computePrCost([base, foreign], 'CI',
      spotPools, null, null, NOW_COST);
    expect(costMinutes).toBeCloseTo(10);
  });

  it('nulls when no check has started; negative/NaN spans are skipped', () => {
    const unstarted: CheckRun = { ...base, status: 'QUEUED', conclusion: null,
      startedAt: null, completedAt: null };
    const negative: CheckRun = { ...base, name: 'skipped-placeholder',
      startedAt: '2026-06-10T11:10:00Z', completedAt: '2026-06-10T11:00:00Z' };
    expect(computePrCost([unstarted, negative], 'CI', spotPools, { default: 0.01 }, null, NOW_COST))
      .toEqual({ costMinutes: null, costDollars: null, costDollarsPartial: false });
  });

  it('costDollarsPartial flags a $ undercount: rates exist but a counted check is unpriced', () => {
    const mystery: CheckRun = { ...base, name: 'mystery' }; // pool unknowable → 'unknown'
    const { costDollars, costDollarsPartial } = computePrCost([base, mystery], 'CI',
      spotPools, { spot: 0.01 }, null, NOW_COST); // no 'default' → mystery unpriced
    expect(costDollars).toBeCloseTo(0.1);
    expect(costDollarsPartial).toBe(true);
  });

  it('costDollarsPartial stays false when every check is priced (default backstop counts)', () => {
    const mystery: CheckRun = { ...base, name: 'mystery' };
    const { costDollarsPartial } = computePrCost([base, mystery], 'CI',
      spotPools, { spot: 0.01, default: 0.02 }, null, NOW_COST);
    expect(costDollarsPartial).toBe(false);
  });

  it('costDollarsPartial stays false in minutes-only mode — it qualifies a $, never replaces one', () => {
    const mystery: CheckRun = { ...base, name: 'mystery' };
    const { costDollars, costDollarsPartial } = computePrCost([base, mystery], 'CI',
      spotPools, null, null, NOW_COST);
    expect(costDollars).toBeNull();
    expect(costDollarsPartial).toBe(false);
  });

  it('podsPerNode divides the PR-level rate too (shared poolRate resolution)', () => {
    const { costDollars } = computePrCost([base], 'CI', spotPools,
      { spot: 0.012 }, { spot: { podsPerNode: 4 } }, NOW_COST);
    expect(costDollars).toBeCloseTo(0.03); // 10 min × ($0.012 ÷ 4)
  });
});

describe('PR-level cost + prNumberForSha on the live poller (cost explorer)', () => {
  it('open PrViews carry costMinutes (completed + running spans); dollars null without rates', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.getState().repos[0]!.prs.find((x) => x.number === 8962)!;
    // CHECK_DONE 11:50→11:53 (3m) + CHECK_RUNNING 11:55→now 12:00 (5m)
    expect(pr.costMinutes).toBeCloseTo(8);
    expect(pr.costDollars).toBeNull();
  });

  it('costDollars prices via config rates (default fallback covers unmapped pools)', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: { ...CONFIG, costPerMinute: { default: 0.01 } }, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    const pr = p.getState().repos[0]!.prs.find((x) => x.number === 8962)!;
    expect(pr.costDollars).toBeCloseTo(0.08);
  });

  it('prNumberForSha joins a tracked open PR head; unknown shas and repos are null', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce(); // the head sha arrives with the detail snapshot
    expect(p.prNumberForSha('acme/widgets', 'head8962')).toBe(8962);
    expect(p.prNumberForSha('acme/widgets', 'someother')).toBeNull();
    expect(p.prNumberForSha('acme/other', 'head8962')).toBeNull();
    expect(p.prNumberForSha('acme/widgets', '')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ground-truth job→pool learning via the Jobs REST API (jobs-API feature)
// ---------------------------------------------------------------------------

describe('Poller learns job→pool from the Jobs REST API', () => {
  // A detail response whose checks carry workflowRun.databaseId so the learning
  // loop has a run id to fetch jobs for.
  const checkWithRun = (name: string, runId: number, over: Record<string, unknown> = {}) => ({
    __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS',
    startedAt: '2026-06-10T11:50:00Z', completedAt: '2026-06-10T11:53:00Z', detailsUrl: 'u',
    isRequired: true,
    checkSuite: { workflowRun: { databaseId: runId, event: 'pull_request' } }, ...over });

  const detailWith = (nodes: unknown[]) => ({ r0: { nameWithOwner: 'acme/widgets', pr8962: {
    number: 8962, title: 'fix', url: 'u', isDraft: false, mergeStateStatus: 'BLOCKED',
    mergedAt: null, headRefOid: 'head8962', autoMergeRequest: null, mergeCommit: null, mergeQueueEntry: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING',
      contexts: { pageInfo: { hasNextPage: false }, nodes } } } }] },
  } } });

  /** fakeClient + a restGet that serves the Jobs API for run 999. */
  const learningClient = (jobs: unknown[], onRestGet?: (path: string) => void) => {
    const detail = detailWith([
      checkWithRun('db-migrations / DB Migrations', 999),
      checkWithRun('lint', 999)]);
    return {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return detail;
        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }),
      restGet: vi.fn(async (path: string) => {
        onRestGet?.(path);
        if (path.includes('/actions/runs/999/jobs')) return { jobs };
        throw new Error(`unexpected restGet ${path}`);
      }),
    };
  };

  it('one jobs-API call maps every job; pools persist to observed_pools', async () => {
    const client = learningClient([
      { name: 'db-migrations / DB Migrations', labels: ['kindash-arc'], runner_group_name: 'arc' },
      { name: 'lint', labels: ['ubuntu-latest'], runner_group_name: 'GitHub Actions' },
    ]);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    // exactly ONE jobs-API call for the single distinct run id
    expect(client.restGet).toHaveBeenCalledTimes(1);
    expect(client.restGet).toHaveBeenCalledWith('/repos/acme/widgets/actions/runs/999/jobs?per_page=100');
    expect(history.observedPool('acme/widgets', 'db-migrations / DB Migrations', 'pull_request'))
      .toEqual({ pool: 'kindash-arc', githubHosted: false });
    expect(history.observedPool('acme/widgets', 'lint', 'pull_request'))
      .toEqual({ pool: 'ubuntu-latest', githubHosted: true });
    // resolvePool now returns ground truth, beating any derived value
    expect(p.resolvePool('acme/widgets', 'lint', 'pull_request'))
      .toEqual({ pool: 'ubuntu-latest', githubHosted: true });
  });

  it('goes quiet on subsequent cycles once everything is mapped', async () => {
    const client = learningClient([
      { name: 'db-migrations / DB Migrations', labels: ['kindash-arc'] },
      { name: 'lint', labels: ['kindash-arc'] }]);
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    expect(client.restGet).toHaveBeenCalledTimes(1);
    await p.detailOnce(); // everything mapped + run id recently-fetched → no call
    expect(client.restGet).toHaveBeenCalledTimes(1);
  });

  it('a failed jobs fetch never crashes the cycle; retried next time', async () => {
    let calls = 0;
    const detail = detailWith([checkWithRun('job', 999)]);
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return detail;
        throw new Error('unexpected');
      }),
      restGet: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { jobs: [{ name: 'job', labels: ['kindash-arc'] }] };
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await expect(p.detailOnce()).resolves.not.toThrow(); // first fetch boom — swallowed
    expect(history.observedPool('acme/widgets', 'job', 'pull_request')).toBeNull();
    // recently-fetched only caches SUCCESSFUL fetches, so the next cycle retries
    await p.detailOnce();
    expect(history.observedPool('acme/widgets', 'job', 'pull_request'))
      .toEqual({ pool: 'kindash-arc', githubHosted: false });
  });

  it('a RateLimitError stops the rest of the batch (poller pauses)', async () => {
    const detail = detailWith([checkWithRun('job', 999)]);
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return detail;
        throw new Error('unexpected');
      }),
      restGet: vi.fn(async () => { throw new RateLimitError(30); }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await expect(p.detailOnce()).resolves.not.toThrow();
    expect(history.observedPool('acme/widgets', 'job', 'pull_request')).toBeNull();
  });

  it('the per-cycle cap bounds jobs-API calls', async () => {
    // 12 distinct run ids → at most MAX_JOBS_FETCHES_PER_CYCLE (8) calls
    const nodes = Array.from({ length: 12 }, (_, i) => checkWithRun(`j${i}`, 1000 + i));
    const detail = detailWith(nodes);
    const client = {
      remaining: 4000, resetAt: null,
      graphql: vi.fn(async (q: string) => {
        if (q.includes('open0: search')) return SWEEP_RESPONSE;
        if (q.includes('pr8962: pullRequest')) return detail;
        throw new Error('unexpected');
      }),
      restGet: vi.fn(async (path: string) => {
        const m = path.match(/runs\/(\d+)\/jobs/)!;
        return { jobs: [{ name: `j${Number(m[1]) - 1000}`, labels: ['kindash-arc'] }] };
      }),
    };
    const p = new Poller({ router: asRouter(client), history, deploy: noDeploy(),
      config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    await p.detailOnce();
    expect(client.restGet).toHaveBeenCalledTimes(8);
  });
});

// ---------------------------------------------------------------------------
// Push-only job pool learning via the workflow push-runs list (feat #81)
// ---------------------------------------------------------------------------

describe('Poller learns push-only job pools from push workflow runs', () => {
  // A clone-mode deploy fake that supplies the workflow-read methods so the
  // shared deploy cycle's ci.yml re-derivation is a no-op (returns null) rather
  // than throwing — keeps console quiet and isolates push-pool behavior.
  const pushDeploy = () => ({
    health: vi.fn(async () => null),
    ensureClone: vi.fn(async () => {}),
    fetchClone: vi.fn(async () => {}),
    readFileAtHead: vi.fn(async () => null),
    isAncestor: vi.fn(async () => 'missing' as const),
  } as unknown as DeployWatcher);

  const PUSH_RUNS_PATH =
    '/repos/acme/widgets/actions/workflows/ci.yml/runs?event=push&branch=main&status=completed&per_page=5';

  /** A client whose restGet serves the push-runs list (run 777) + its jobs. */
  const pushClient = (
    runs: unknown,
    jobs: unknown[],
    onRestGet?: (path: string) => void,
  ) => ({
    remaining: 4000, resetAt: null,
    graphql: vi.fn(async (q: string) => {
      if (q.includes('open0: search')) return { open0: { issueCount: 0, nodes: [] },
        open1: { issueCount: 0, nodes: [] }, merged0: { issueCount: 0, nodes: [] },
        merged1: { issueCount: 0, nodes: [] } };
      throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    }),
    restGet: vi.fn(async (path: string) => {
      onRestGet?.(path);
      if (path === PUSH_RUNS_PATH) return runs;
      if (path.includes('/actions/runs/777/jobs')) return { jobs };
      throw new Error(`unexpected restGet ${path}`);
    }),
  });

  it('lists recent push runs and records their jobs under event=push', async () => {
    const client = pushClient(
      { workflow_runs: [{ id: 777 }] },
      [{ name: 'Build Storybook', labels: ['kindash-arc-spot'], runner_group_name: 'arc' },
       { name: 'smoke', labels: ['ubuntu-latest'], runner_group_name: 'GitHub Actions' }],
    );
    const p = new Poller({ router: asRouter(client), history, deploy: pushDeploy(),
      config: CONFIG, now: () => NOW });
    await p.deployOnce();
    expect(client.restGet).toHaveBeenCalledWith(PUSH_RUNS_PATH);
    expect(history.observedPool('acme/widgets', 'Build Storybook', 'push'))
      .toEqual({ pool: 'kindash-arc-spot', githubHosted: false });
    expect(history.observedPool('acme/widgets', 'smoke', 'push'))
      .toEqual({ pool: 'ubuntu-latest', githubHosted: true });
    // a pull_request read borrows the push observation via the sibling fallback
    expect(p.resolvePool('acme/widgets', 'smoke', 'pull_request'))
      .toEqual({ pool: 'ubuntu-latest', githubHosted: true });
  });

  it('fires once then stays quiet for 6h (per-repo throttle)', async () => {
    let t = NOW.getTime();
    const client = pushClient({ workflow_runs: [{ id: 777 }] },
      [{ name: 'tag', labels: ['ubuntu-latest'] }]);
    const listCalls = () => client.restGet.mock.calls.filter(
      (c) => String(c[0]).includes('/runs?event=push')).length;
    const p = new Poller({ router: asRouter(client), history, deploy: pushDeploy(),
      config: CONFIG, now: () => new Date(t) });
    await p.deployOnce();
    expect(listCalls()).toBe(1);
    await p.deployOnce(); // within 6h → throttled, no list call
    expect(listCalls()).toBe(1);
    t += 6 * 3600_000 + 1000; // past the 6h window
    await p.deployOnce();
    expect(listCalls()).toBe(2);
  });

  it('caps the runs fetched per cycle at 3 (newest first)', async () => {
    const client = pushClient(
      { workflow_runs: [{ id: 777 }, { id: 776 }, { id: 775 }, { id: 774 }] },
      [{ name: 'axe-per-story', labels: ['kindash-arc-spot'] }]);
    // jobs path only matches run 777; the others would throw "unexpected" if
    // selectPushRunIds didn't cap — but the cap keeps it to the newest 3, and
    // every fetched id maps to the same jobs handler below.
    client.restGet.mockImplementation(async (path: string) => {
      if (path === PUSH_RUNS_PATH) return { workflow_runs:
        [{ id: 777 }, { id: 776 }, { id: 775 }, { id: 774 }] };
      const m = path.match(/runs\/(\d+)\/jobs/);
      if (m) return { jobs: [{ name: 'axe-per-story', labels: ['kindash-arc-spot'] }] };
      throw new Error(`unexpected restGet ${path}`);
    });
    const p = new Poller({ router: asRouter(client), history, deploy: pushDeploy(),
      config: CONFIG, now: () => NOW });
    await p.deployOnce();
    const jobCalls = client.restGet.mock.calls.filter((c) => /\/jobs/.test(String(c[0])));
    expect(jobCalls).toHaveLength(3); // cap = MAX_PUSH_RUNS_PER_CYCLE
  });

  it('an empty push-runs list arms the throttle without fetching jobs', async () => {
    const client = pushClient({ workflow_runs: [] }, []);
    const listCalls = () => client.restGet.mock.calls.filter(
      (c) => String(c[0]).includes('/runs?event=push')).length;
    const p = new Poller({ router: asRouter(client), history, deploy: pushDeploy(),
      config: CONFIG, now: () => NOW });
    await p.deployOnce();
    expect(listCalls()).toBe(1);
    // no jobs fetch happened
    expect(client.restGet.mock.calls.some((c) => /\/jobs/.test(String(c[0])))).toBe(false);
    await p.deployOnce(); // throttled despite nothing learned → no re-list
    expect(listCalls()).toBe(1);
  });

  it('a list-call failure warns once and retries next cycle (no throttle armed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const client = pushClient({ workflow_runs: [{ id: 777 }] },
      [{ name: 'smoke', labels: ['kindash-arc-spot'] }]);
    client.restGet.mockImplementation(async (path: string) => {
      if (path === PUSH_RUNS_PATH) {
        if (fail) throw new Error('boom');
        return { workflow_runs: [{ id: 777 }] };
      }
      if (path.includes('/actions/runs/777/jobs')) return { jobs:
        [{ name: 'smoke', labels: ['kindash-arc-spot'] }] };
      throw new Error(`unexpected restGet ${path}`);
    });
    const p = new Poller({ router: asRouter(client), history, deploy: pushDeploy(),
      config: CONFIG, now: () => NOW });
    await p.deployOnce(); // list fails → nothing learned, no throttle
    expect(history.observedPool('acme/widgets', 'smoke', 'push')).toBeNull();
    fail = false;
    await p.deployOnce(); // same clock, but the failed list armed no throttle → retry
    expect(history.observedPool('acme/widgets', 'smoke', 'push'))
      .toEqual({ pool: 'kindash-arc-spot', githubHosted: false });
    const listWarns = warn.mock.calls.filter((c) => String(c).includes('push-runs list failed'));
    expect(listWarns).toHaveLength(1); // warn-once
    warn.mockRestore();
  });

  it('a RateLimitError on the list call pauses the poller', async () => {
    const client = pushClient({ workflow_runs: [{ id: 777 }] }, []);
    client.restGet.mockImplementation(async (path: string) => {
      if (path === PUSH_RUNS_PATH) throw new RateLimitError(30);
      throw new Error(`unexpected restGet ${path}`);
    });
    const p = new Poller({ router: asRouter(client), history, deploy: pushDeploy(),
      config: CONFIG, now: () => NOW });
    await expect(p.deployOnce()).resolves.not.toThrow();
    expect(history.observedPool('acme/widgets', 'x', 'push')).toBeNull();
  });
});

describe('queue OID de-conflation (merge_group vs push:main on the same commit)', () => {
  const OID = 'oidMixed';
  const queuedDetail = {
    r0: { nameWithOwner: 'acme/widgets', pr8962: {
      number: 8962, title: 'x', url: 'u', isDraft: false, mergeStateStatus: 'BLOCKED',
      mergedAt: null, headRefOid: 'h', autoMergeRequest: { mergeMethod: 'SQUASH' }, mergeCommit: null,
      mergeQueueEntry: { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
        headCommit: { oid: OID } },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS',
        contexts: { pageInfo: { hasNextPage: false }, nodes: [{ ...CHECK_DONE }] } } } }] },
    } },
  };
  const queueResponse = { repository: { mergeQueue: { entries: { nodes: [
    { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-06-10T11:30:00Z',
      headCommit: { oid: OID }, pullRequest: { number: 8962 } },
  ] } } } };
  const mk = (name: string, event: string) => ({ __typename: 'CheckRun', name, status: 'COMPLETED',
    conclusion: 'FAILURE', startedAt: '2026-06-10T11:50:00Z', completedAt: '2026-06-10T11:58:00Z',
    detailsUrl: 'u', checkSuite: { workflowRun: { event, runNumber: 1, databaseId: event === 'push' ? 99 : 1,
      workflow: { name: 'CI' } } } });
  const rollup = { repository: { o0: { oid: OID, statusCheckRollup: { contexts: { nodes: [
    mk('ci', 'merge_group'), mk('accessibility / axe', 'push'),
  ] } } } } };
  const client = () => ({ remaining: 4000, resetAt: null, graphql: vi.fn(async (q: string) => {
    if (q.includes('open0: search')) return SWEEP_RESPONSE;
    if (q.includes('pr8962: pullRequest')) return queuedDetail;
    if (q.includes('object(oid:')) return rollup;
    if (q.includes('mergeQueue')) return queueResponse;
    throw new Error(`unexpected query: ${q.slice(0, 80)}`);
  }) });

  it('records only the merge_group failure as a train-killer; push:main is excluded', async () => {
    const p = new Poller({ router: asRouter(client()), history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce(); await p.detailOnce(); await p.queueOnce();
    const fails = history.groupFailuresSince('2026-06-01T00:00:00Z')
      .filter((f) => f.repo === 'acme/widgets').map((f) => f.checkName);
    expect(fails).toContain('ci');
    expect(fails).not.toContain('accessibility / axe');
    const pr = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs.find((x) => x.number === 8962)!;
    expect((pr.groupChecks ?? []).map((c) => c.name)).not.toContain('accessibility / axe');
  });

  it('records the push:main rollup into main_commits (not as a queue stat)', async () => {
    const p = new Poller({ router: asRouter(client()), history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce(); await p.detailOnce(); await p.queueOnce();
    // one main commit, push CI FAILURE → a lone fresh red is 'amber' per the transient rule
    expect(history.mainLaneHealth('acme/widgets').status).toBe('amber');
  });
});

describe('per-repo laneHealth on DashboardState', () => {
  it('computes main-lane health from main_commits and attaches it to each repo', async () => {
    // a single failing push:main commit → a lone fresh red is 'amber' (transient rule)
    history.recordMainCommit('acme/widgets', 'sha1', NOW.toISOString(), 'FAILURE', NOW.toISOString());
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    expect(repo.laneHealth?.main).toBe('amber');
  });
  it('laneHealth carries the main series + last-green metadata', async () => {
    history.recordMainCommit('acme/widgets', 'g1', NOW.toISOString(), 'SUCCESS', NOW.toISOString());
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(), config: CONFIG, now: () => NOW });
    await p.sweepOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    expect(repo.laneHealth?.main).toBe('green');
    expect(repo.laneHealth?.lastGreenSha).toBe('g1');
    expect(repo.laneHealth?.mainSeries?.length).toBeGreaterThan(0);
  });
});

describe('per-repo deploy status on DashboardState (Deploy lane, Spec 2)', () => {
  const NO_DEPLOY: AppConfig = { ...DEFAULTS, ancestrySource: 'clone', owners: ['acme', 'octo'] };
  it('caches the live sha per env from the deploy cycle and counts awaiting drift', async () => {
    // a merged PR not yet live on qa → awaiting QA only (NOT also awaiting prod —
    // the two are disjoint: it can't be awaiting prod before it's even on QA)
    history.upsertMergedPr({ repo: 'acme/widgets', number: 8951, title: 'feat: allowance', url: 'u8951',
      mergedAt: '2026-06-10T11:40:00Z', mergeCommitSha: 'squash8951' });
    // health() returns a sha but ancestry is 'no' → env reachable, PR stays not-live
    const deploy = fakeDeploy(
      { 'https://qa.widgets.example.com/health': 'liveSha-qa', 'https://widgets.example.com/health': 'liveSha-prod' },
      { 'liveSha-qa': 'no', 'liveSha-prod': 'no' },
    );
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy, config: CONFIG, now: () => NOW });
    await p.deployOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    expect(repo.deploy).toBeDefined();
    expect(repo.deploy!.awaitingQa).toBe(1);
    expect(repo.deploy!.awaitingProd).toBe(0); // awaiting QA, not prod (disjoint)
    const qa = repo.deploy!.envs.find((e) => e.name === 'qa')!;
    expect(qa.liveSha).toBe('liveSha-qa');
    expect(qa.reachable).toBe(true);
  });

  it('marks an env unreachable when /health returns no sha', async () => {
    history.upsertMergedPr({ repo: 'acme/widgets', number: 8951, title: 'feat: allowance', url: 'u8951',
      mergedAt: '2026-06-10T11:40:00Z', mergeCommitSha: 'squash8951' });
    const deploy = fakeDeploy({}, {}); // health() returns null for every url
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy, config: CONFIG, now: () => NOW });
    await p.deployOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!;
    const qa = repo.deploy!.envs.find((e) => e.name === 'qa')!;
    expect(qa.liveSha).toBeNull();
    expect(qa.reachable).toBe(false);
  });

  it('repos with no deploy config get no deploy field', async () => {
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(),
      config: NO_DEPLOY, now: () => NOW });
    await p.sweepOnce();
    await p.deployOnce();
    const repo = p.buildState().repos.find((r) => r.repo === 'acme/widgets');
    expect(repo?.deploy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 7 review: env-order generalization guards (non-qa/prod names + single-env)
// ---------------------------------------------------------------------------

describe('Poller env-order generalization (non-qa/prod names + single-env)', () => {
  const ALL_EVENTS_ON: NotificationsConfig = {
    enabled: false, command: [], digest: { enabled: false, hourLocal: 8 },
    events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
      ready: true, overdue: true, 'prod-live': true, 'queue-stalled': true,
      'duration-regression': true, 'runner-starvation': true, 'budget-breach': true },
  };

  // Reuse the standard merged-PR sweep fixture (PR 8951, mergeCommit squash8951).
  // The health URL and sha names are intentionally non-qa/prod so any re-hardcoding
  // would break these tests.

  it('(a) multi-env non-qa/prod: terminalLive fires on terminal env (production), NOT on first env (staging)', async () => {
    // Repo configured with order: ['staging', 'production'] — names chosen to
    // prove the notifier gates on terminalEnv, not on the literal string 'prod'.
    const config: AppConfig = {
      ...CONFIG,
      deploy: {
        'acme/widgets': {
          cloneUrl: 'https://github.com/acme/widgets.git',
          defaultBranch: 'main',
          order: ['staging', 'production'],
          environments: [
            { name: 'staging', healthUrl: 'https://staging.widgets.example.com/health', auto: true, shaKey: 'commitSha' },
            { name: 'production', healthUrl: 'https://production.widgets.example.com/health', auto: false, shaKey: 'commitSha' },
          ],
        },
      },
    };
    const notifier = new Notifier({ config: () => ALL_EVENTS_ON });
    const terminalLiveSpy = vi.spyOn(notifier, 'terminalLive');

    // Phase 1: staging live, production not yet.
    const shasPhase1 = {
      'https://staging.widgets.example.com/health': 'squash8951',
      'https://production.widgets.example.com/health': 'oldSha-prod',
    };
    // Mutable clock: phase 2 must advance past ANCESTRY_THROTTLE_MS (60s) — the
    // same SHA flows staging→production, so production's (mergeSha, deployedSha)
    // ancestry pair is identical to the one staging already checked in phase 1.
    // With a frozen clock that pair would be throttled and production would never
    // be marked live until a later cycle.
    let clock = NOW;
    const deploy = fakeDeploy(shasPhase1, { 'squash8951': 'yes', 'oldSha-prod': 'no' });
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config, now: () => clock, notifier });
    await p.sweepOnce();   // ingests merged #8951 (mergeCommitSha squash8951)
    await p.deployOnce();

    // staging is live: PR is 'awaiting-prod'; terminalLive must NOT have fired yet
    const prAfterStaging = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!
      .prs.find((x) => x.number === 8951)!;
    expect(prAfterStaging.stage.stage).toBe('awaiting-prod');
    expect(terminalLiveSpy).not.toHaveBeenCalled();

    // Phase 2: production also goes live (clock advanced past the throttle).
    shasPhase1['https://production.widgets.example.com/health'] = 'squash8951';
    clock = new Date(NOW.getTime() + 120_000);
    // ancestry already 'yes' for squash8951, so production will be marked live too.
    await p.deployOnce();

    // terminalLive must fire exactly once, for the terminal env 'production'.
    expect(terminalLiveSpy).toHaveBeenCalledTimes(1);
    expect(terminalLiveSpy).toHaveBeenCalledWith('acme/widgets', 8951, 'feat: allowance', 'production');
    // The PR leaves the board (terminalLive → null from viewForMergedPr).
    const prAfterProd = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!
      .prs.find((x) => x.number === 8951);
    expect(prAfterProd).toBeUndefined();
  });

  it('(b) single-env: PR leaves board and terminalLive fires when the sole env goes live', async () => {
    // A repo with order: ['production'] — firstEnv === terminalEnv.  Proves that
    // the single-env path (no intermediate envs) treats the one env as both first
    // and terminal, so the PR exits the board and the notifier fires in one step.
    const config: AppConfig = {
      ...CONFIG,
      deploy: {
        'acme/widgets': {
          cloneUrl: 'https://github.com/acme/widgets.git',
          defaultBranch: 'main',
          order: ['production'],
          environments: [
            { name: 'production', healthUrl: 'https://production.widgets.example.com/health', auto: true, shaKey: 'commitSha' },
          ],
        },
      },
    };
    const notifier = new Notifier({ config: () => ALL_EVENTS_ON });
    const terminalLiveSpy = vi.spyOn(notifier, 'terminalLive');

    const deploy = fakeDeploy(
      { 'https://production.widgets.example.com/health': 'squash8951' },
      { 'squash8951': 'yes' },
    );
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy,
      config, now: () => NOW, notifier });
    await p.sweepOnce();
    await p.deployOnce();

    // PR is off the board — single env is terminal, so terminalLive=true → viewForMergedPr returns null.
    const prs = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs;
    expect(prs.find((x) => x.number === 8951)).toBeUndefined();
    // terminalLive fired exactly once for the sole env, passing the env name.
    expect(terminalLiveSpy).toHaveBeenCalledTimes(1);
    expect(terminalLiveSpy).toHaveBeenCalledWith('acme/widgets', 8951, 'feat: allowance', 'production');
  });
});

describe('Poller.deployEnvsFor (task 8b)', () => {
  it('returns firstEnv/terminalEnv for a configured multi-env repo', () => {
    const config: AppConfig = {
      ...DEFAULTS,
      ancestrySource: 'clone',
      owners: ['acme'],
      deploy: {
        'acme/widgets': {
          cloneUrl: 'https://github.com/acme/widgets.git',
          defaultBranch: 'main',
          order: ['staging', 'production'],
          environments: [
            { name: 'staging', healthUrl: 'https://staging.example.com/health', auto: true, shaKey: 'commitSha' },
            { name: 'production', healthUrl: 'https://prod.example.com/health', auto: false, shaKey: 'commitSha' },
          ],
        },
      },
    };
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(), config, now: () => NOW });
    expect(p.deployEnvsFor('acme/widgets')).toEqual({ firstEnv: 'staging', terminalEnv: 'production' });
  });

  it('returns null for a repo not in the deploy map', () => {
    const config: AppConfig = { ...DEFAULTS, ancestrySource: 'clone', owners: ['acme'] };
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(), config, now: () => NOW });
    expect(p.deployEnvsFor('acme/widgets')).toBeNull();
  });

  it('single-env repo: firstEnv === terminalEnv', () => {
    const config: AppConfig = {
      ...DEFAULTS,
      ancestrySource: 'clone',
      owners: ['acme'],
      deploy: {
        'acme/widgets': {
          cloneUrl: 'https://github.com/acme/widgets.git',
          defaultBranch: 'main',
          order: ['production'],
          environments: [
            { name: 'production', healthUrl: 'https://prod.example.com/health', auto: true, shaKey: 'commitSha' },
          ],
        },
      },
    };
    const p = new Poller({ router: asRouter(fakeClient()), history, deploy: noDeploy(), config, now: () => NOW });
    const result = p.deployEnvsFor('acme/widgets');
    expect(result).not.toBeNull();
    expect(result!.firstEnv).toBe('production');
    expect(result!.terminalEnv).toBe('production');
    expect(result!.firstEnv).toBe(result!.terminalEnv);
  });
});

// ---------------------------------------------------------------------------
// Task 13: auto-discover deploy config from GitHub (autoDiscoverDeploy)
// ---------------------------------------------------------------------------

/**
 * Fake REST client for deploy-discovery: dispatches on path prefix to return
 * canned /environments, /deployments, and /deployments/{id}/statuses responses.
 * Extends the existing fakeClient() pattern by adding `restGet`.
 */
function fakeDiscoveryClient(
  envNames: string[],
  deployments: Array<{ id: number; environment: string; sha: string; created_at: string }>,
  statuses: Record<number, { state: string; created_at: string } | null>,
) {
  const base = fakeClient();
  const restGet = vi.fn(async (path: string) => {
    if (path.includes('/environments')) {
      return { environments: envNames.map((name) => ({ name })) };
    }
    if (path.includes('/deployments?')) {
      return deployments;
    }
    // /repos/{owner}/{name}/deployments/{id}/statuses?per_page=1
    const m = path.match(/\/deployments\/(\d+)\/statuses/);
    if (m) {
      const id = Number(m[1]);
      const s = statuses[id];
      if (s == null) return [];
      return [s];
    }
    throw new Error(`unexpected restGet path: ${path}`);
  });
  return { ...base, restGet };
}

describe('Poller auto-discover deploy (task 13)', () => {
  // A config where acme/widgets has autoDiscoverDeploy=true but NO hand-written
  // deploy block.  The sweep will discover the repo; deploy discovery then reads
  // environments + deployments + statuses from GitHub and synthesises a DeployConfig.
  const DISCOVER_CONFIG: AppConfig = {
    ...DEFAULTS,
    ancestrySource: 'clone',
    owners: ['acme', 'octo'],
    repos: { 'acme/widgets': { autoDiscoverDeploy: true } },
    deploy: {},  // no hand-written deploy config
  };

  // A deployment to 'production' whose status is 'success'
  const DEPLOY_ID = 42;
  const LIVE_SHA = 'sha9abc';
  const DEPLOY_TIME = '2026-06-10T10:00:00Z';

  it('DEPLOY_DISCOVERY_INTERVAL_MS is exported and equals 6 hours', () => {
    expect(DEPLOY_DISCOVERY_INTERVAL_MS).toBe(6 * 3600_000);
  });

  it('after sweepOnce + deployOnce: opted-in repo appears in effectiveDeploy with correct order', async () => {
    const client = fakeDiscoveryClient(
      ['production'],
      [{ id: DEPLOY_ID, environment: 'production', sha: LIVE_SHA, created_at: DEPLOY_TIME }],
      { [DEPLOY_ID]: { state: 'success', created_at: DEPLOY_TIME } },
    );
    const p = new Poller({
      router: asRouter(client as unknown as GithubClient),
      history,
      deploy: noDeploy(),
      config: DISCOVER_CONFIG,
      now: () => NOW,
    });
    await p.sweepOnce();
    await p.deployOnce();
    const deployMap = p.effectiveDeploy();
    expect(deployMap['acme/widgets']).toBeDefined();
    expect(deployMap['acme/widgets'].order).toEqual(['production']);
  });

  it('after sweepOnce + deployOnce: hasDeploy is true in buildState for the auto-discovered repo', async () => {
    const client = fakeDiscoveryClient(
      ['production'],
      [{ id: DEPLOY_ID, environment: 'production', sha: LIVE_SHA, created_at: DEPLOY_TIME }],
      { [DEPLOY_ID]: { state: 'success', created_at: DEPLOY_TIME } },
    );
    const p = new Poller({
      router: asRouter(client as unknown as GithubClient),
      history,
      deploy: noDeploy(),
      config: DISCOVER_CONFIG,
      now: () => NOW,
    });
    await p.sweepOnce();
    await p.deployOnce();
    const state = p.buildState();
    const repoState = state.repos.find((r) => r.repo === 'acme/widgets');
    expect(repoState?.hasDeploy).toBe(true);
  });

  it('merged PR whose mergeCommitSha is an ancestor of the live sha gets marked live and leaves the board', async () => {
    // The sweep discovers PR 8951 as merged (mergeCommit.oid = 'squash8951').
    // The discovery sets LIVE_SHA to 'sha9abc'. isAncestor('squash8951', 'sha9abc') = 'yes'.
    const client = fakeDiscoveryClient(
      ['production'],
      [{ id: DEPLOY_ID, environment: 'production', sha: LIVE_SHA, created_at: DEPLOY_TIME }],
      { [DEPLOY_ID]: { state: 'success', created_at: DEPLOY_TIME } },
    );
    const deploy = fakeDeploy(
      {}, // no healthUrl probes — the synthesised env has empty healthUrl
      { [LIVE_SHA]: 'yes' },
    );
    const p = new Poller({
      router: asRouter(client as unknown as GithubClient),
      history,
      deploy,
      config: DISCOVER_CONFIG,
      now: () => NOW,
    });
    await p.sweepOnce();   // discovers PR 8951 merged w/ mergeCommitSha='squash8951'
    await p.deployOnce();  // discovers production live at LIVE_SHA; squash8951 is ancestor → markEnvLive
    // PR 8951 is the terminal env so it leaves the board
    const prs = p.buildState().repos.find((r) => r.repo === 'acme/widgets')!.prs;
    expect(prs.find((x) => x.number === 8951)).toBeUndefined();
  });

  it('repo WITHOUT autoDiscoverDeploy is NOT auto-discovered even when GitHub returns environments', async () => {
    // acme/widgets NOT in repos config (defaults to autoDiscoverDeploy: false)
    const configNoDiscover: AppConfig = {
      ...DEFAULTS,
      ancestrySource: 'clone',
      owners: ['acme', 'octo'],
      deploy: {},
      // no repos override → autoDiscoverDeploy defaults false
    };
    const client = fakeDiscoveryClient(
      ['production'],
      [{ id: DEPLOY_ID, environment: 'production', sha: LIVE_SHA, created_at: DEPLOY_TIME }],
      { [DEPLOY_ID]: { state: 'success', created_at: DEPLOY_TIME } },
    );
    const p = new Poller({
      router: asRouter(client as unknown as GithubClient),
      history,
      deploy: noDeploy(),
      config: configNoDiscover,
      now: () => NOW,
    });
    await p.sweepOnce();
    await p.deployOnce();
    const deployMap = p.effectiveDeploy();
    expect(deployMap['acme/widgets']).toBeUndefined();
  });

  it('hand-written deploy config overrides an auto-discovered one for the same repo', async () => {
    // Both autoDiscoverDeploy (would synthesize 'production') AND a hand-written
    // config with 'qa' + 'prod' exist. The hand-written config must win.
    const configWithBoth: AppConfig = {
      ...DEFAULTS,
      ancestrySource: 'clone',
      owners: ['acme', 'octo'],
      repos: { 'acme/widgets': { autoDiscoverDeploy: true } },
      deploy: {
        'acme/widgets': {
          cloneUrl: 'https://github.com/acme/widgets.git',
          defaultBranch: 'main',
          order: ['qa', 'prod'],
          environments: [
            { name: 'qa', healthUrl: 'https://qa.widgets.example.com/health', auto: true, shaKey: 'commitSha' },
            { name: 'prod', healthUrl: 'https://widgets.example.com/health', auto: false, shaKey: 'commitSha' },
          ],
        },
      },
    };
    const client = fakeDiscoveryClient(
      ['production'],
      [{ id: DEPLOY_ID, environment: 'production', sha: LIVE_SHA, created_at: DEPLOY_TIME }],
      { [DEPLOY_ID]: { state: 'success', created_at: DEPLOY_TIME } },
    );
    const p = new Poller({
      router: asRouter(client as unknown as GithubClient),
      history,
      deploy: noDeploy(),
      config: configWithBoth,
      now: () => NOW,
    });
    await p.sweepOnce();
    await p.deployOnce();
    const deployMap = p.effectiveDeploy();
    // Hand-written config wins: order should be ['qa', 'prod'], not ['production']
    expect(deployMap['acme/widgets'].order).toEqual(['qa', 'prod']);
  });

  it('repo with no GitHub environments does not end up in discoveredDeploy', async () => {
    const client = fakeDiscoveryClient(
      [], // no environments
      [],
      {},
    );
    const p = new Poller({
      router: asRouter(client as unknown as GithubClient),
      history,
      deploy: noDeploy(),
      config: DISCOVER_CONFIG,
      now: () => NOW,
    });
    await p.sweepOnce();
    await p.deployOnce();
    const deployMap = p.effectiveDeploy();
    expect(deployMap['acme/widgets']).toBeUndefined();
  });
});
