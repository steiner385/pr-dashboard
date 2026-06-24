import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  composeDigest, gatherDigestInput, msUntilNextDigest, queueHealthFromState,
  DigestScheduler, DIGEST_WINDOW_HOURS,
  type DigestInput, type DigestRepoInput, type DigestSources,
} from '../digest';

const repoInput = (over: Partial<DigestRepoInput> = {}): DigestRepoInput => ({
  repo: 'acme/widgets', merges: 0, ejects: 0, topCulprit: null,
  pools: [], regressions: [], queue: null, ...over,
});

const input = (repos: DigestRepoInput[]): DigestInput =>
  ({ at: new Date('2026-06-12T12:00:00Z'), windowHours: 24, repos });

describe('composeDigest', () => {
  it('renders a quiet body when nothing is notable', () => {
    const { subject, body } = composeDigest(input([repoInput()]));
    expect(subject).toBe('Daily CI digest (24h) — 0 merges, 0 ejects');
    expect(body).toContain('Quiet 24h');
  });

  it('headline aggregates merges/ejects across repos', () => {
    const { subject } = composeDigest(input([
      repoInput({ repo: 'r/a', merges: 9 }),
      repoInput({ repo: 'r/b', merges: 5, ejects: 2 }),
    ]));
    expect(subject).toBe('Daily CI digest (24h) — 14 merges, 2 ejects');
  });

  it('top culprit line carries flake cross-ref and flake-likely flag', () => {
    const { body } = composeDigest(input([repoInput({
      ejects: 2,
      topCulprit: { name: 'e2e', ejects: 2, flakeRatePct: 12 },
    })]));
    expect(body).toContain('queue ejects: 2 (top culprit: e2e ×2, flake-likely — 12% flake rate)');
  });

  it('a low flake rate is shown without the flake-likely flag; null rate omits it', () => {
    const low = composeDigest(input([repoInput({
      ejects: 1, topCulprit: { name: 'unit', ejects: 1, flakeRatePct: 1 } })]));
    expect(low.body).toContain('(top culprit: unit ×1, 1% flake rate)');
    const unknown = composeDigest(input([repoInput({
      ejects: 1, topCulprit: { name: 'unit', ejects: 1, flakeRatePct: null } })]));
    expect(unknown.body).toContain('(top culprit: unit ×1)');
  });

  it('starving pools render p90 vs baseline; all-normal pools render one line', () => {
    const { subject, body } = composeDigest(input([repoInput({
      merges: 3,
      pools: [
        { pool: 'kindash-runner', lastHourP90Secs: 480, baselineP90Secs: 45, n: 9, starving: true },
        { pool: 'ubuntu-latest', lastHourP90Secs: 30, baselineP90Secs: 28, n: 40, starving: false },
      ],
    })]));
    expect(subject).toContain('1 pool starving');
    expect(body).toContain('runner waits: 1 pool STARVING — kindash-runner p90 8m vs 45s baseline');
    const normal = composeDigest(input([repoInput({
      merges: 1,
      pools: [{ pool: 'ubuntu-latest', lastHourP90Secs: 30, baselineP90Secs: 28, n: 40, starving: false }],
    })]));
    expect(normal.body).toContain('runner waits: all pools normal');
  });

  it('active duration regressions are listed with their step', () => {
    const { subject, body } = composeDigest(input([repoInput({
      regressions: [{ check: 'build-test', event: 'merge_group',
        priorP50Secs: 240, recentP50Secs: 600, ratio: 2.5, sinceApprox: '2026-06-12T01:00:00Z' }],
    })]));
    expect(subject).toContain('1 duration regression');
    expect(body).toContain('duration regressions: build-test (merge_group) p50 4m → 10m');
  });

  it('non-healthy queue states surface; healthy queues stay silent', () => {
    const stalled = composeDigest(input([repoInput({
      queue: { state: 'dispatch-stall', detail: 'do NOT admin-merge' } })]));
    expect(stalled.body).toContain('queue health: dispatch-stall — do NOT admin-merge');
    const healthy = composeDigest(input([repoInput({
      merges: 1, queue: { state: 'healthy', detail: 'fine' } })]));
    expect(healthy.body).not.toContain('queue health');
  });

  it('quiet repos are omitted from the body entirely', () => {
    const { body } = composeDigest(input([
      repoInput({ repo: 'r/quiet' }),
      repoInput({ repo: 'r/busy', merges: 2 }),
    ]));
    expect(body).not.toContain('r/quiet');
    expect(body).toContain('r/busy');
  });
});

describe('gatherDigestInput', () => {
  const now = new Date('2026-06-12T12:00:00Z');

  const history = (over: Partial<DigestSources['history']> = {}): DigestSources['history'] => ({
    mergedSince: () => [],
    groupFailuresSince: () => [],
    flakeStatsByRepo: () => new Map(),
    ...over,
  });

  const sources = (over: Partial<DigestSources> = {}): DigestSources => ({
    history: history(), exclude: [], activeRegressions: [], poolHealth: [],
    queueHealth: [], now, ...over,
  });

  it('counts merges per repo over the 24h window', () => {
    const mergedSince = vi.fn(() => [
      { repo: 'r/a', number: 1, mergedAt: '2026-06-12T01:00:00Z', createdAt: null, qaLiveAt: null, mergedBy: null, enqueuedAt: null, envLive: {} },
      { repo: 'r/a', number: 2, mergedAt: '2026-06-12T02:00:00Z', createdAt: null, qaLiveAt: null, mergedBy: null, enqueuedAt: null, envLive: {} },
      { repo: 'r/b', number: 3, mergedAt: '2026-06-12T03:00:00Z', createdAt: null, qaLiveAt: null, mergedBy: null, enqueuedAt: null, envLive: {} },
    ]);
    const out = gatherDigestInput(sources({ history: history({ mergedSince }) }));
    expect(mergedSince).toHaveBeenCalledWith('2026-06-11T12:00:00.000Z');
    expect(out.windowHours).toBe(DIGEST_WINDOW_HOURS);
    expect(out.repos.map((r) => [r.repo, r.merges])).toEqual([['r/a', 2], ['r/b', 1]]);
  });

  it('ejects = distinct group shas; top culprit = check with most rows, flake cross-ref applied', () => {
    const out = gatherDigestInput(sources({ history: history({
      groupFailuresSince: () => [
        { repo: 'r/a', checkName: 'e2e', groupSha: 's1', at: '2026-06-12T01:00:00Z', conclusion: 'FAILURE' },
        { repo: 'r/a', checkName: 'unit', groupSha: 's1', at: '2026-06-12T01:00:00Z', conclusion: 'FAILURE' },
        { repo: 'r/a', checkName: 'e2e', groupSha: 's2', at: '2026-06-12T02:00:00Z', conclusion: 'TIMED_OUT' },
      ],
      flakeStatsByRepo: () => new Map([['r/a', [
        { name: 'e2e', event: 'merge_group', flakeEvents: 3, totalRuns: 25,
          flakeRatePct: 12, flakeAts: [], runAts: [] },
        { name: 'e2e', event: 'pull_request', flakeEvents: 1, totalRuns: 50,
          flakeRatePct: 2, flakeAts: [], runAts: [] },
        // below FLAKE_MIN_RUNS — must not participate
        { name: 'unit', event: 'merge_group', flakeEvents: 1, totalRuns: 2,
          flakeRatePct: 50, flakeAts: [], runAts: [] },
      ]]]),
    }) }));
    expect(out.repos).toHaveLength(1);
    const r = out.repos[0]!;
    expect(r.ejects).toBe(2);
    // max rate ACROSS events for the culprit name
    expect(r.topCulprit).toEqual({ name: 'e2e', ejects: 2, flakeRatePct: 12 });
  });

  it('joins live caches (regressions, pool health, queue health) per repo', () => {
    const reg = { check: 'lint', event: 'pull_request', priorP50Secs: 60,
      recentP50Secs: 120, ratio: 2, sinceApprox: '2026-06-12T00:00:00Z' };
    const pool = { pool: 'p', lastHourP90Secs: 10, baselineP90Secs: 8, n: 5, starving: false };
    const out = gatherDigestInput(sources({
      activeRegressions: [{ repo: 'r/a', checks: [reg] }],
      poolHealth: [{ repo: 'r/a', pools: [pool] }],
      queueHealth: [{ repo: 'r/a', state: 'cap-backlog', detail: 'backlog' }],
    }));
    expect(out.repos).toEqual([{
      repo: 'r/a', merges: 0, ejects: 0, topCulprit: null,
      pools: [pool], regressions: [reg], queue: { state: 'cap-backlog', detail: 'backlog' },
    }]);
  });

  it('excluded repos are dropped from every source', () => {
    const out = gatherDigestInput(sources({
      exclude: ['r/noisy'],
      history: history({ mergedSince: () => [
        { repo: 'r/noisy', number: 1, mergedAt: '2026-06-12T01:00:00Z', createdAt: null, qaLiveAt: null, mergedBy: null, enqueuedAt: null, envLive: {} }] }),
      queueHealth: [{ repo: 'r/noisy', state: 'healthy', detail: 'fine' }],
    }));
    expect(out.repos).toEqual([]);
  });
});

describe('queueHealthFromState', () => {
  it('extracts per-repo health rows, skipping repos without a queue', () => {
    const rows = queueHealthFromState({ repos: [
      { repo: 'r/a', queue: { health: { state: 'healthy', detail: 'fine' } } },
      { repo: 'r/b', queue: null },
    ] });
    expect(rows).toEqual([{ repo: 'r/a', state: 'healthy', detail: 'fine' }]);
  });
});

describe('msUntilNextDigest', () => {
  it('targets today when the hour is still ahead', () => {
    const now = new Date(2026, 5, 12, 6, 30, 0); // local 06:30
    expect(msUntilNextDigest(8, now)).toBe(1.5 * 3600_000);
  });

  it('targets tomorrow when the hour already passed (or is exactly now)', () => {
    const past = new Date(2026, 5, 12, 9, 0, 0);
    expect(msUntilNextDigest(8, past)).toBe(23 * 3600_000);
    const exact = new Date(2026, 5, 12, 8, 0, 0);
    expect(msUntilNextDigest(8, exact)).toBe(24 * 3600_000);
  });
});

describe('DigestScheduler', () => {
  afterEach(() => vi.useRealTimers());

  function schedHarness(enabled: boolean, hourLocal = 8) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 12, 7, 0, 0)); // local 07:00
    const sends: number[] = [];
    const logs: string[] = [];
    const sched = new DigestScheduler({
      config: () => ({ enabled, hourLocal }),
      send: () => sends.push(Date.now()),
      log: (m) => logs.push(m),
    });
    return { sched, sends, logs };
  }

  it('disabled: start() is a no-op (logged, no timer)', () => {
    const h = schedHarness(false);
    h.sched.start();
    vi.advanceTimersByTime(48 * 3600_000);
    expect(h.sends).toEqual([]);
    expect(h.logs[0]).toContain('disabled');
  });

  it('fires at the next hourLocal occurrence, then re-arms daily (self-rearming)', () => {
    const h = schedHarness(true);
    h.sched.start();
    expect(h.logs[0]).toContain('08:00 local');
    vi.advanceTimersByTime(3600_000 - 1);
    expect(h.sends).toHaveLength(0);
    vi.advanceTimersByTime(1); // 08:00
    expect(h.sends).toHaveLength(1);
    vi.advanceTimersByTime(24 * 3600_000); // 08:00 next day
    expect(h.sends).toHaveLength(2);
    vi.advanceTimersByTime(24 * 3600_000);
    expect(h.sends).toHaveLength(3);
  });

  it('a throwing send is contained and the chain still re-arms', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 12, 7, 0, 0));
    const logs: string[] = [];
    let calls = 0;
    const sched = new DigestScheduler({
      config: () => ({ enabled: true, hourLocal: 8 }),
      send: () => { calls++; throw new Error('compose exploded'); },
      log: (m) => logs.push(m),
    });
    sched.start();
    vi.advanceTimersByTime(3600_000);
    expect(calls).toBe(1);
    expect(logs.some((l) => l.includes('compose exploded'))).toBe(true);
    vi.advanceTimersByTime(24 * 3600_000);
    expect(calls).toBe(2); // still re-armed
  });

  it('stop() cancels the pending timer', () => {
    const h = schedHarness(true);
    h.sched.start();
    h.sched.stop();
    vi.advanceTimersByTime(48 * 3600_000);
    expect(h.sends).toEqual([]);
  });
});
