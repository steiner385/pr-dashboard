import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notifier, renderNotification, DEFAULT_NOTIFICATIONS,
  type NotificationEvent, type NotificationsConfig } from '../notifier';
import type { StageResult } from '../types';

const stage = (s: StageResult['stage'], substate: string | null = null,
  overdue = false): StageResult =>
  ({ stage: s, substate, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue });

/** Config with every event type enabled (the matrix tests exercise all six). */
const ALL_ON: NotificationsConfig = {
  enabled: true,
  command: ['notify-send', '{title}', '{body}'],
  events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
    ready: true, overdue: true, 'prod-live': true, 'queue-stalled': true,
    'duration-regression': true, 'runner-starvation': true },
};

type ExecCall = { cmd: string; args: string[]; cb: (err: Error | null) => void };

function harness(cfg: NotificationsConfig = ALL_ON) {
  const execCalls: ExecCall[] = [];
  const logs: string[] = [];
  const events: NotificationEvent[] = [];
  const notifier = new Notifier({
    config: () => cfg,
    exec: (cmd, args, cb) => { execCalls.push({ cmd, args, cb }); },
    log: (msg) => logs.push(msg),
  });
  notifier.on('notification', (ev: NotificationEvent) => events.push(ev));
  const observe = (prev: StageResult | null, next: StageResult, queueCulprit: number | null = null) =>
    notifier.observe({ repo: 'acme/widgets', prNumber: 7, title: 'fix: the thing',
      prev, next, queueCulprit });
  return { notifier, observe, execCalls, logs, events };
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

  it('prod-live fires via prodLive()', () => {
    const h = harness();
    h.notifier.prodLive('acme/widgets', 7, 'fix: the thing');
    expect(h.events.map((e) => e.type)).toEqual(['prod-live']);
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
    h.notifier.prodLive('acme/widgets', 7, 't');
    h.notifier.prodLive('acme/widgets', 7, 't');
    h.notifier.prodLive('acme/widgets', 8, 't');
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
    h.notifier.prodLive('r/a', 1, 't');
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
      notifier.prodLive('r/a', 2, 't');
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
