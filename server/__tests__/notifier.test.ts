import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notifier, renderNotification, maskWebhookUrl, DEFAULT_NOTIFICATIONS,
  type NotificationEvent, type NotificationsConfig } from '../notifier';
import type { StageResult } from '../types';

const stage = (s: StageResult['stage'], substate: string | null = null,
  overdue = false): StageResult =>
  ({ stage: s, substate, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue });

/** Config with every event type enabled (the matrix tests exercise all six). */
const ALL_ON: NotificationsConfig = {
  enabled: true,
  command: ['notify-send', '{title}', '{body}'],
  digest: { enabled: false, hourLocal: 8 },
  events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
    ready: true, overdue: true, 'prod-live': true, 'queue-stalled': true,
    'duration-regression': true, 'runner-starvation': true, 'budget-breach': true },
};

type ExecCall = { cmd: string; args: string[]; cb: (err: Error | null) => void };
type FetchCall = { url: string; init: { method: string; headers: Record<string, string>;
  body: string; signal: AbortSignal } };

function harness(cfg: NotificationsConfig = ALL_ON, opts: {
  fetchResult?: () => Promise<{ ok: boolean; status: number }>;
  now?: () => number;
} = {}) {
  const execCalls: ExecCall[] = [];
  const fetchCalls: FetchCall[] = [];
  const logs: string[] = [];
  const events: NotificationEvent[] = [];
  const notifier = new Notifier({
    config: () => cfg,
    exec: (cmd, args, cb) => { execCalls.push({ cmd, args, cb }); },
    fetchFn: (url, init) => {
      fetchCalls.push({ url, init });
      return (opts.fetchResult ?? (() => Promise.resolve({ ok: true, status: 200 })))();
    },
    now: opts.now,
    log: (msg) => logs.push(msg),
  });
  notifier.on('notification', (ev: NotificationEvent) => events.push(ev));
  const observe = (prev: StageResult | null, next: StageResult, queueCulprit: number | null = null) =>
    notifier.observe({ repo: 'acme/widgets', prNumber: 7, title: 'fix: the thing',
      prev, next, queueCulprit });
  return { notifier, observe, execCalls, fetchCalls, logs, events };
}

describe('Notifier transition matrix', () => {
  it('ci-failed fires on entering parked/ci-failed', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ repo: 'acme/widgets', prNumber: 7,
      title: 'fix: the thing', type: 'ci-failed' });
  });

  it('ci-failed fires on first observation (no prev) — restart still surfaces broken PRs', () => {
    const h = harness();
    h.observe(null, stage('parked', 'ci-failed'));
    expect(h.events.map((e) => e.type)).toEqual(['ci-failed']);
  });

  it('parked/draft and parked/conflicting do NOT fire ci-failed', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'draft'));
    h.observe(stage('ci'), stage('parked', 'conflicting'));
    expect(h.events).toHaveLength(0);
  });

  it('group-failed fires when queue/group-failed appears', () => {
    const h = harness();
    h.observe(stage('queue'), stage('queue', 'group-failed'));
    expect(h.events.map((e) => e.type)).toEqual(['group-failed']);
    expect(h.events[0]!.detail).toBe('the merge-queue group build failed');
  });

  it('group-failed detail names the culprit check(s) when known (issue #38)', () => {
    const h = harness();
    h.notifier.observe({ repo: 'acme/widgets', prNumber: 7, title: 'fix: the thing',
      prev: stage('queue'), next: stage('queue', 'group-failed'),
      groupCulpritChecks: ['e2e', 'unit'] });
    expect(h.events[0]!.detail)
      .toBe('the merge-queue group build failed — culprit: e2e, unit');
  });

  it('queue-blocked fires for the cascade-victim substate, naming the culprit', () => {
    const h = harness();
    h.observe(stage('queue'), stage('queue', 'queue-blocked'), 42);
    expect(h.events.map((e) => e.type)).toEqual(['queue-blocked']);
    expect(h.events[0]!.detail).toContain('#42');
  });

  it('queue-blocked fires for the unmergeable (genuine conflict) substate with a rebase detail', () => {
    const h = harness();
    h.observe(stage('queue'), stage('queue', 'unmergeable'), 7);
    expect(h.events.map((e) => e.type)).toEqual(['queue-blocked']);
    expect(h.events[0]!.detail).toContain('conflicts with the base');
  });

  it('ready fires when entering ready/armed from ci', () => {
    const h = harness();
    h.observe(stage('ci'), stage('ready', 'armed'));
    expect(h.events.map((e) => e.type)).toEqual(['ready']);
  });

  it('ready fires when entering ready/idle from ci', () => {
    const h = harness();
    h.observe(stage('ci'), stage('ready', 'idle'));
    expect(h.events.map((e) => e.type)).toEqual(['ready']);
  });

  it('ready does NOT fire from a null prev (process start: PR already ready)', () => {
    const h = harness();
    h.observe(null, stage('ready', 'armed'));
    expect(h.events).toHaveLength(0);
  });

  it('ready does NOT fire when entered from a non-ci stage (e.g. dequeued)', () => {
    const h = harness();
    h.observe(stage('queue'), stage('ready', 'idle'));
    expect(h.events).toHaveLength(0);
  });

  it('overdue fires when the stage overdue flag flips true', () => {
    const h = harness();
    h.observe(stage('ci'), stage('ci', null, true));
    expect(h.events.map((e) => e.type)).toEqual(['overdue']);
  });

  it('prod-live fires via terminalLive() with type prod-live and env field', () => {
    const h = harness();
    h.notifier.terminalLive('acme/widgets', 7, 'fix: the thing', 'prod');
    expect(h.events.map((e) => e.type)).toEqual(['prod-live']);
    expect(h.events[0]!.detail).toBe('deployed to prod');
    expect(h.events[0]!.env).toBe('prod');
  });

  it('terminalLive with non-prod env name produces correct detail and env field', () => {
    const h = harness();
    h.notifier.terminalLive('acme/widgets', 7, 'fix: the thing', 'production');
    expect(h.events[0]!.type).toBe('prod-live');
    expect(h.events[0]!.detail).toBe('deployed to production');
    expect(h.events[0]!.env).toBe('production');
  });
});

describe('Notifier debounce + re-entry', () => {
  it('fires once per (pr, eventType) while the condition holds', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    h.observe(stage('parked', 'ci-failed'), stage('parked', 'ci-failed'));
    h.observe(stage('parked', 'ci-failed'), stage('parked', 'ci-failed'));
    expect(h.events).toHaveLength(1);
  });

  it('re-fires after the condition cleared and re-entered', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    h.observe(stage('parked', 'ci-failed'), stage('ci'));        // retried — cleared
    h.observe(stage('ci'), stage('parked', 'ci-failed'));        // failed again
    expect(h.events.map((e) => e.type)).toEqual(['ci-failed', 'ci-failed']);
  });

  it('overdue clears when overdue flips back false, then re-fires', () => {
    const h = harness();
    h.observe(stage('ci'), stage('ci', null, true));
    h.observe(stage('ci', null, true), stage('ci', null, true));   // still overdue — no refire
    h.observe(stage('ci', null, true), stage('queue'));            // cleared
    h.observe(stage('queue'), stage('queue', null, true));         // overdue again
    expect(h.events.map((e) => e.type)).toEqual(['overdue', 'overdue']);
  });

  it('prod-live fires once per PR per process lifetime', () => {
    const h = harness();
    h.notifier.terminalLive('acme/widgets', 7, 't', 'prod');
    h.notifier.terminalLive('acme/widgets', 7, 't', 'prod');
    h.notifier.terminalLive('acme/widgets', 8, 't', 'prod');
    expect(h.events.filter((e) => e.type === 'prod-live').map((e) => e.prNumber)).toEqual([7, 8]);
  });

  it('debounce is keyed per PR — two PRs in the same state both fire', () => {
    const h = harness();
    h.notifier.observe({ repo: 'r/a', prNumber: 1, title: 'a', prev: stage('ci'), next: stage('parked', 'ci-failed') });
    h.notifier.observe({ repo: 'r/a', prNumber: 2, title: 'b', prev: stage('ci'), next: stage('parked', 'ci-failed') });
    expect(h.events.map((e) => e.prNumber)).toEqual([1, 2]);
  });

  it('prune() drops state for vanished PRs so a re-tracked PR can re-fire', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    h.notifier.prune(new Set());                          // PR no longer tracked
    h.observe(stage('ci'), stage('parked', 'ci-failed')); // re-appears, still failed
    expect(h.events).toHaveLength(2);
  });

  it('prune() keeps state for still-live PRs', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    h.notifier.prune(new Set(['acme/widgets#7']));
    h.observe(stage('parked', 'ci-failed'), stage('parked', 'ci-failed'));
    expect(h.events).toHaveLength(1);
  });
});

describe('Notifier events config filtering', () => {
  it('a type toggled off fires neither the bus event nor the command', () => {
    const h = harness({ ...ALL_ON, events: { ...ALL_ON.events, 'ci-failed': false } });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.events).toHaveLength(0);
    expect(h.execCalls).toHaveLength(0);
  });

  it('defaults: ready and overdue are off; ci-failed/group-failed/queue-blocked/prod-live are on', () => {
    expect(DEFAULT_NOTIFICATIONS.events).toEqual({
      'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
      ready: false, overdue: false, 'prod-live': true, 'queue-stalled': true,
      'duration-regression': true, // alert types — default ON (issue #41)
      'runner-starvation': true,    // (issue #45)
      'budget-breach': true,        // (roadmap 5.6c)
    });
    const h = harness({ ...DEFAULT_NOTIFICATIONS, enabled: true });
    h.observe(stage('ci'), stage('ready', 'armed'));
    h.observe(stage('ci', null, false), stage('ci', null, true));
    expect(h.events).toHaveLength(0);
    h.observe(stage('ci', null, true), stage('parked', 'ci-failed'));
    expect(h.events.map((e) => e.type)).toEqual(['ci-failed']);
  });
});

describe('Notifier command sink', () => {
  it('substitutes {title}/{body} in args and execs without a shell', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.execCalls).toHaveLength(1);
    const { cmd, args } = h.execCalls[0]!;
    expect(cmd).toBe('notify-send');
    expect(args).toEqual([
      'acme/widgets#7 CI failed',
      'fix: the thing — a required check failed',
    ]);
  });

  it('a hostile title stays a single argv element (execFile arg safety)', () => {
    const h = harness();
    h.notifier.observe({ repo: 'r/a', prNumber: 1, title: '"; rm -rf / #',
      prev: stage('ci'), next: stage('parked', 'ci-failed') });
    expect(h.execCalls).toHaveLength(1);
    const { args } = h.execCalls[0]!;
    // body arg carries the hostile title verbatim as ONE element — never joined
    // into a shell string, never split into extra argv entries
    expect(args).toHaveLength(2);
    expect(args[1]).toBe('"; rm -rf / # — a required check failed');
  });

  it('substitutes placeholders anywhere in any arg, multiple times', () => {
    const h = harness({ ...ALL_ON, command: ['cmd', '--msg={title}:{title}', 'plain'] });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    const { args } = h.execCalls[0]!;
    expect(args[0]).toBe('--msg=acme/widgets#7 CI failed:acme/widgets#7 CI failed');
    expect(args[1]).toBe('plain');
  });

  it('argv[0] (the executable) is NOT substituted — a {title} there runs literally', () => {
    const h = harness({ ...ALL_ON, command: ['{title}', 'x'] });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.execCalls[0]!.cmd).toBe('{title}');
  });

  it('enabled:false skips the command but still emits the bus event (browser sink unaffected)', () => {
    const h = harness({ ...ALL_ON, enabled: false });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.events).toHaveLength(1);
    expect(h.execCalls).toHaveLength(0);
  });

  it('an empty command array is a no-op even when enabled', () => {
    const h = harness({ ...ALL_ON, command: [] });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.events).toHaveLength(1);
    expect(h.execCalls).toHaveLength(0);
  });

  it('command failures are logged once and never throw', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    h.notifier.terminalLive('r/a', 1, 't', 'prod');
    expect(h.execCalls).toHaveLength(2);
    h.execCalls[0]!.cb(new Error('notify-send: not found'));
    h.execCalls[1]!.cb(new Error('notify-send: not found'));
    expect(h.logs.filter((l) => l.includes('not found'))).toHaveLength(1);
  });

  it('a synchronously-throwing exec is contained and logged once', () => {
    const cfg = ALL_ON;
    const logs: string[] = [];
    const notifier = new Notifier({
      config: () => cfg,
      exec: () => { throw new Error('spawn EACCES'); },
      log: (m) => logs.push(m),
    });
    expect(() => {
      notifier.observe({ repo: 'r/a', prNumber: 1, title: 't',
        prev: stage('ci'), next: stage('parked', 'ci-failed') });
      notifier.terminalLive('r/a', 2, 't', 'prod');
    }).not.toThrow();
    expect(logs.filter((l) => l.includes('EACCES'))).toHaveLength(1);
  });

  it('uses real execFile by default without crashing on a missing binary', async () => {
    const cfg: NotificationsConfig = { ...ALL_ON,
      command: ['/nonexistent/definitely-not-a-binary-xyz', '{title}'] };
    const logs: string[] = [];
    const notifier = new Notifier({ config: () => cfg, log: (m) => logs.push(m) });
    notifier.observe({ repo: 'r/a', prNumber: 1, title: 't',
      prev: stage('ci'), next: stage('parked', 'ci-failed') });
    await vi.waitFor(() => { expect(logs.length).toBeGreaterThan(0); });
    expect(logs[0]).toContain('[notifier]');
  });
});

describe('renderNotification', () => {
  it('renders repo#number + label as title and PR title + detail as body', () => {
    const r = renderNotification({ repo: 'acme/widgets', prNumber: 7,
      title: 'fix: the thing', type: 'prod-live', detail: 'live on prod' });
    expect(r.title).toBe('acme/widgets#7 live on prod');
    expect(r.body).toBe('fix: the thing — live on prod');
  });

  it('the fired SSE event carries the SAME rendered strings (single source of truth)', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.events).toHaveLength(1);
    const ev = h.events[0]!;
    // the browser bell consumes ev.rendered verbatim — it must equal renderNotification(ev)
    expect(ev.rendered).toEqual(renderNotification(ev));
    expect(ev.rendered?.title).toBe('acme/widgets#7 CI failed');
  });
});

// ---------------------------------------------------------------------------
// Issue #39: repo-level queue-stalled events
// ---------------------------------------------------------------------------

describe('Notifier queueHealth (queue-stalled)', () => {
  it('fires once on entering dispatch-stall (debounced while it holds)', () => {
    const h = harness();
    h.notifier.queueHealth('acme/widgets', 'dispatch-stall', 'dispatch-stall: queue recovery needed — do NOT admin-merge');
    h.notifier.queueHealth('acme/widgets', 'dispatch-stall', 'dispatch-stall: queue recovery needed — do NOT admin-merge');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ repo: 'acme/widgets', prNumber: 0,
      type: 'queue-stalled' });
    expect(h.events[0].detail).toContain('do NOT admin-merge');
  });

  it('re-fires after the stall clears and re-enters', () => {
    const h = harness();
    h.notifier.queueHealth('acme/widgets', 'dispatch-stall', 'stalled');
    h.notifier.queueHealth('acme/widgets', 'healthy', 'queue healthy');
    h.notifier.queueHealth('acme/widgets', 'dispatch-stall', 'stalled again');
    expect(h.events.map((e) => e.type)).toEqual(['queue-stalled', 'queue-stalled']);
  });

  it('cap-backlog and healthy never fire', () => {
    const h = harness();
    h.notifier.queueHealth('acme/widgets', 'cap-backlog', 'backlog');
    h.notifier.queueHealth('acme/widgets', 'healthy', 'fine');
    expect(h.events).toHaveLength(0);
  });

  it('prune does not clear the stall debounce (repo-level key, no PR lifecycle)', () => {
    const h = harness();
    h.notifier.queueHealth('acme/widgets', 'dispatch-stall', 'stalled');
    h.notifier.prune(new Set()); // no live PRs at all
    h.notifier.queueHealth('acme/widgets', 'dispatch-stall', 'stalled');
    expect(h.events).toHaveLength(1); // still debounced — no spurious re-fire
  });

  it('events config can disable queue-stalled', () => {
    const h = harness({ ...ALL_ON, events: { ...ALL_ON.events, 'queue-stalled': false } });
    h.notifier.queueHealth('acme/widgets', 'dispatch-stall', 'stalled');
    expect(h.events).toHaveLength(0);
    expect(h.execCalls).toHaveLength(0);
  });

  it('renderNotification titles the repo, never "repo#0"', () => {
    const { title, body } = renderNotification({ repo: 'acme/widgets', prNumber: 0,
      title: 'acme/widgets', type: 'queue-stalled',
      detail: 'dispatch-stall: queue recovery needed — do NOT admin-merge' });
    expect(title).toBe('acme/widgets merge queue STALLED');
    expect(title).not.toContain('#0');
    expect(body).toContain('do NOT admin-merge');
  });
});

// ---------------------------------------------------------------------------
// Issue #41: repo-level duration-regression events
// ---------------------------------------------------------------------------

describe('Notifier durationRegression', () => {
  const DETAIL = 'p50 4m → 10m (×2.5, merge_group) since 2026-06-12T11:51:00Z';

  it('fires once per (repo, check, event) while the condition holds', () => {
    const h = harness();
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', true, DETAIL);
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', true, DETAIL);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ repo: 'acme/widgets', prNumber: 0,
      title: 'build-test', type: 'duration-regression', detail: DETAIL });
  });

  it('re-fires after the condition clears (ratio < 1.2) and re-enters', () => {
    const h = harness();
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', true, DETAIL);
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', false, '');
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', true, DETAIL);
    expect(h.events.map((e) => e.type))
      .toEqual(['duration-regression', 'duration-regression']);
  });

  it('inactive evaluations never fire', () => {
    const h = harness();
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', false, '');
    expect(h.events).toHaveLength(0);
  });

  it('debounce is keyed per (check, event) — pull_request and merge_group fire separately', () => {
    const h = harness();
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', true, DETAIL);
    h.notifier.durationRegression('acme/widgets', 'build-test', 'pull_request', true, DETAIL);
    h.notifier.durationRegression('acme/widgets', 'lint', 'merge_group', true, DETAIL);
    expect(h.events).toHaveLength(3);
  });

  it('prune does not clear the debounce (repo-level key, no PR lifecycle)', () => {
    const h = harness();
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', true, DETAIL);
    h.notifier.prune(new Set());
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', true, DETAIL);
    expect(h.events).toHaveLength(1);
  });

  it('events config can disable duration-regression', () => {
    const h = harness({ ...ALL_ON, events: { ...ALL_ON.events, 'duration-regression': false } });
    h.notifier.durationRegression('acme/widgets', 'build-test', 'merge_group', true, DETAIL);
    expect(h.events).toHaveLength(0);
    expect(h.execCalls).toHaveLength(0);
  });

  it('renderNotification titles the repo (never "repo#0"), body carries the check + step', () => {
    const { title, body } = renderNotification({ repo: 'acme/widgets', prNumber: 0,
      title: 'build-test', type: 'duration-regression', detail: DETAIL });
    expect(title).toBe('acme/widgets duration regression');
    expect(title).not.toContain('#0');
    expect(body).toBe(`build-test — ${DETAIL}`);
  });
});

// ---------------------------------------------------------------------------
// Roadmap 5.6c: tool-global budget-breach events
// ---------------------------------------------------------------------------

describe('Notifier budgetBreach', () => {
  const DETAIL = 'minutes — 12,000 of 10,000 (120%) over the trailing 30d';

  it('fires once per (scope, kind) while the breach holds', () => {
    const h = harness();
    h.notifier.budgetBreach('fleet', 'minutes', true, DETAIL);
    h.notifier.budgetBreach('fleet', 'minutes', true, DETAIL);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ repo: 'fleet', prNumber: 0, title: 'minutes', type: 'budget-breach', detail: DETAIL });
  });

  it('re-fires after the breach clears (spend back under threshold) and re-enters', () => {
    const h = harness();
    h.notifier.budgetBreach('fleet', 'minutes', true, DETAIL);
    h.notifier.budgetBreach('fleet', 'minutes', false, '');
    h.notifier.budgetBreach('fleet', 'minutes', true, DETAIL);
    expect(h.events.map((e) => e.type)).toEqual(['budget-breach', 'budget-breach']);
  });

  it('debounce is keyed per kind — minutes and cost breach independently', () => {
    const h = harness();
    h.notifier.budgetBreach('fleet', 'minutes', true, DETAIL);
    h.notifier.budgetBreach('fleet', 'cost', true, '$1,400 of $1,000');
    expect(h.events).toHaveLength(2);
  });

  it('prune does not clear the debounce (tool-global key, no PR lifecycle)', () => {
    const h = harness();
    h.notifier.budgetBreach('fleet', 'minutes', true, DETAIL);
    h.notifier.prune(new Set());
    h.notifier.budgetBreach('fleet', 'minutes', true, DETAIL);
    expect(h.events).toHaveLength(1);
  });

  it('renders "fleet budget breach" titled by scope, never "#0"', () => {
    const { title, body } = renderNotification({ repo: 'fleet', prNumber: 0, title: 'minutes', type: 'budget-breach', detail: DETAIL });
    expect(title).toBe('fleet budget breach');
    expect(title).not.toContain('#0');
    expect(body).toBe(`minutes — ${DETAIL}`);
  });

  it('events config can disable budget-breach', () => {
    const h = harness({ ...ALL_ON, events: { ...ALL_ON.events, 'budget-breach': false } });
    h.notifier.budgetBreach('fleet', 'minutes', true, DETAIL);
    expect(h.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #45: repo-level runner-starvation events
// ---------------------------------------------------------------------------

describe('Notifier runnerStarvation', () => {
  const DETAIL = "pool 'kindash-runner' pickup p90 25m over the last hour (7d baseline 40s, n=8) — capacity starvation likely";

  it('fires once per (repo, pool) while the episode holds', () => {
    const h = harness();
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', true, DETAIL);
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', true, DETAIL);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ repo: 'acme/widgets', prNumber: 0,
      title: 'kindash-runner', type: 'runner-starvation', detail: DETAIL });
  });

  it('re-fires after the episode clears (hysteresis) and re-enters', () => {
    const h = harness();
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', true, DETAIL);
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', false, '');
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', true, DETAIL);
    expect(h.events.map((e) => e.type)).toEqual(['runner-starvation', 'runner-starvation']);
  });

  it('non-starving evaluations never fire', () => {
    const h = harness();
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', false, '');
    expect(h.events).toHaveLength(0);
  });

  it('debounce is keyed per (repo, pool) — pools fire separately', () => {
    const h = harness();
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', true, DETAIL);
    h.notifier.runnerStarvation('acme/widgets', 'kindash-ondemand', true, DETAIL);
    h.notifier.runnerStarvation('octo/gizmos', 'kindash-runner', true, DETAIL);
    expect(h.events).toHaveLength(3);
  });

  it('prune does not clear the debounce (repo-level key, no PR lifecycle)', () => {
    const h = harness();
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', true, DETAIL);
    h.notifier.prune(new Set());
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', true, DETAIL);
    expect(h.events).toHaveLength(1);
  });

  it('events config can disable runner-starvation', () => {
    const h = harness({ ...ALL_ON, events: { ...ALL_ON.events, 'runner-starvation': false } });
    h.notifier.runnerStarvation('acme/widgets', 'kindash-runner', true, DETAIL);
    expect(h.events).toHaveLength(0);
    expect(h.execCalls).toHaveLength(0);
  });

  it('renderNotification titles the repo (never "repo#0"), body carries the pool + detail', () => {
    const { title, body } = renderNotification({ repo: 'acme/widgets', prNumber: 0,
      title: 'kindash-runner', type: 'runner-starvation', detail: DETAIL });
    expect(title).toBe('acme/widgets runner pool starving');
    expect(title).not.toContain('#0');
    expect(body).toBe(`kindash-runner — ${DETAIL}`);
  });
});

// ---------------------------------------------------------------------------
// Issue #51: generic webhook sink + daily digest
// ---------------------------------------------------------------------------

const HOOK = 'https://hooks.example.com/T123/B456/secret-token';
const WITH_HOOK: NotificationsConfig = { ...ALL_ON, webhookUrl: HOOK };

describe('Notifier webhook sink (issue #51)', () => {
  it('POSTs JSON {type, repo, prNumber, title, detail, at} per event', () => {
    const h = harness(WITH_HOOK, { now: () => Date.parse('2026-06-12T08:00:00Z') });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.fetchCalls).toHaveLength(1);
    const { url, init } = h.fetchCalls[0]!;
    expect(url).toBe(HOOK);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      type: 'ci-failed', repo: 'acme/widgets', prNumber: 7,
      title: 'fix: the thing', detail: 'a required check failed',
      at: '2026-06-12T08:00:00.000Z',
    });
  });

  it('no webhookUrl → no POST (command sink unaffected)', () => {
    const h = harness();
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.execCalls).toHaveLength(1);
  });

  it('enabled:false disarms the webhook sink (SSE event still emitted)', () => {
    const h = harness({ ...WITH_HOOK, enabled: false });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.events).toHaveLength(1);
  });

  it('a type toggled off fires no webhook either', () => {
    const h = harness({ ...WITH_HOOK, events: { ...ALL_ON.events, 'ci-failed': false } });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    expect(h.fetchCalls).toHaveLength(0);
  });

  it('a rejecting fetch is contained and logged (never crashes the cycle)', async () => {
    const h = harness(WITH_HOOK, { fetchResult: () => Promise.reject(new Error('ECONNREFUSED')) });
    expect(() => h.observe(stage('ci'), stage('parked', 'ci-failed'))).not.toThrow();
    await vi.waitFor(() => {
      expect(h.logs.some((l) => l.includes('ECONNREFUSED'))).toBe(true);
    });
    expect(h.logs[0]).toContain('no retries');
  });

  it('a non-ok response is logged with its status', async () => {
    const h = harness(WITH_HOOK, { fetchResult: () => Promise.resolve({ ok: false, status: 404 }) });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    await vi.waitFor(() => {
      expect(h.logs.some((l) => l.includes('404'))).toBe(true);
    });
  });

  it('failures log at most once per hour, then resume', async () => {
    let nowMs = Date.parse('2026-06-12T08:00:00Z');
    const h = harness(WITH_HOOK, {
      fetchResult: () => Promise.reject(new Error('down')), now: () => nowMs });
    h.observe(stage('ci'), stage('parked', 'ci-failed'));
    await vi.waitFor(() => expect(h.logs).toHaveLength(1));
    nowMs += 30 * 60_000; // +30min — still throttled
    h.notifier.terminalLive('r/a', 1, 't', 'prod');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.logs).toHaveLength(1);
    nowMs += 31 * 60_000; // past the hour — logs again
    h.notifier.terminalLive('r/a', 2, 't', 'prod');
    await vi.waitFor(() => expect(h.logs).toHaveLength(2));
  });

  it('a synchronously-throwing fetch is contained', () => {
    const logs: string[] = [];
    const notifier = new Notifier({
      config: () => WITH_HOOK,
      exec: (_c, _a, cb) => cb(null),
      fetchFn: () => { throw new Error('bad signal'); },
      log: (m) => logs.push(m),
    });
    expect(() => notifier.terminalLive('r/a', 1, 't', 'prod')).not.toThrow();
    expect(logs.some((l) => l.includes('bad signal'))).toBe(true);
  });
});

describe('Notifier digest delivery (issue #51)', () => {
  it('sendDigest fans out through SSE, command, and webhook with the pre-rendered text', () => {
    const h = harness(WITH_HOOK);
    h.notifier.sendDigest('Daily CI digest (24h) — 14 merges, 2 ejects', 'r/a:\n  merged: 14');
    expect(h.events).toEqual([{ repo: '', prNumber: 0, type: 'digest',
      title: 'Daily CI digest (24h) — 14 merges, 2 ejects', detail: 'r/a:\n  merged: 14',
      // pre-rendered display strings ride along for the browser bell (digest passes through)
      rendered: { title: 'Daily CI digest (24h) — 14 merges, 2 ejects', body: 'r/a:\n  merged: 14' } }]);
    // command sink gets the digest subject/body verbatim (no "repo#0" mangling)
    expect(h.execCalls[0]!.args).toEqual([
      'Daily CI digest (24h) — 14 merges, 2 ejects', 'r/a:\n  merged: 14']);
    expect(JSON.parse(h.fetchCalls[0]!.init.body)).toMatchObject({
      type: 'digest', repo: '', prNumber: 0 });
  });

  it('digest is not gated by the events map (no digest key exists)', () => {
    const allOff = Object.fromEntries(Object.keys(ALL_ON.events).map((k) => [k, false]));
    const h = harness({ ...ALL_ON, events: allOff as NotificationsConfig['events'] });
    h.notifier.sendDigest('subject', 'body');
    expect(h.events).toHaveLength(1);
  });

  it('enabled:false still emits the SSE digest frame but no command/webhook', () => {
    const h = harness({ ...WITH_HOOK, enabled: false });
    h.notifier.sendDigest('subject', 'body');
    expect(h.events).toHaveLength(1);
    expect(h.execCalls).toHaveLength(0);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it('renderNotification passes digest subject/body through untouched', () => {
    const r = renderNotification({ repo: '', prNumber: 0, title: 'subject',
      type: 'digest', detail: 'line1\nline2' });
    expect(r).toEqual({ title: 'subject', body: 'line1\nline2' });
  });
});

describe('maskWebhookUrl', () => {
  it('masks to scheme + host (the path may carry a token)', () => {
    expect(maskWebhookUrl('https://hooks.slack.com/services/T123/B456/tok'))
      .toBe('https://hooks.slack.com/…');
    expect(maskWebhookUrl('http://127.0.0.1:9099/hook')).toBe('http://127.0.0.1:9099/…');
  });

  it('never echoes an unparseable value back', () => {
    expect(maskWebhookUrl('not a url with secret')).toBe('(unparseable URL)');
  });
});
