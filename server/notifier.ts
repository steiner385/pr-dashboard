import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { StageResult } from './types';
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType, type NotificationKind } from '../shared/notification-events';

// Re-exported from the shared registry so existing server importers (config,
// index) keep importing from notifier; the single definition lives in shared/.
export { NOTIFICATION_EVENT_TYPES };
export type { NotificationEventType, NotificationKind };

/**
 * Notifier — the single detection source for alert-worthy PR transitions
 * (issue #19). The poller feeds it every classify result (`observe`) plus the
 * prod-ancestry "shipped" signal (`terminalLive`); it derives notification events,
 * debounces them, and fans out to two sinks:
 *
 *   - bus: `emit('notification', ev)` — re-emitted by the poller onto the SSE
 *     stream as a named `notification` event (browser Web Notifications).
 *   - command: an argv template run via execFile (NEVER a shell — a hostile PR
 *     title can't inject), gated by `notifications.enabled`.
 *
 * Debounce: once per (PR, event type) while the condition holds — cleared when
 * the condition clears, so a re-entered condition re-fires. `prod-live` can't
 * clear, so it fires once per PR per process lifetime.
 */

/** Repo-level event types: prNumber 0, debounce keys outside the PR lifecycle
 *  (prune() must not touch them), and the rendered subject is the repo. */
const REPO_LEVEL_TYPES: ReadonlySet<NotificationEventType> =
  new Set(['queue-stalled', 'duration-regression', 'runner-starvation', 'budget-breach']);

/** Daily-digest knobs (issue #51) — file-only, like the rest of the block. */
export interface DigestConfig {
  /** Opt-in: the scheduler is armed only when true. */
  enabled: boolean;
  /** Local hour (0–23) the digest fires at, every day. */
  hourLocal: number;
}

/** The `notifications` config block (file-only — never PUT-writable). */
export interface NotificationsConfig {
  /** Master switch for the COMMAND and WEBHOOK sinks. Event detection and SSE
   *  emission stay on regardless — the browser sink has its own opt-in
   *  (bell + permission). */
  enabled: boolean;
  /** Argv template for the host command. `{title}`/`{body}` are substituted in
   *  every ARGUMENT (argv[0], the executable, is never substituted). Run via
   *  execFile — no shell, so placeholder content can't inject. */
  command: string[];
  /** Generic webhook sink (issue #51): when set (and `enabled`), every event is
   *  POSTed as JSON `{type, repo, prNumber, title, detail, at}`. The URL often
   *  carries a token (Slack/Discord) — file-only, NOT in the PUT carve-out, and
   *  the UI only ever sees it host-masked. Fire-and-forget: 5s timeout, NO
   *  retries (v1 — a missed notification is cheaper than a duplicate storm),
   *  failures logged at most once per hour. */
  webhookUrl?: string;
  /** Daily digest schedule (issue #51). */
  digest: DigestConfig;
  /** Per-event-type toggles; a type set false fires NEITHER sink. The digest
   *  is NOT an entry here — it is gated by `digest.enabled` alone. */
  events: Record<NotificationEventType, boolean>;
}

export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  enabled: false,
  command: ['notify-send', '{title}', '{body}'],
  digest: { enabled: false, hourLocal: 8 },
  events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
    ready: false, overdue: false, 'prod-live': true, 'queue-stalled': true,
    // alert types, not status types — ON by default (issues #41/#45, roadmap 5.6c)
    'duration-regression': true, 'runner-starvation': true, 'budget-breach': true },
};

/**
 * Display form of a webhook URL: scheme + host only ('https://hooks.slack.com/…').
 * Slack/Discord/ntfy webhook PATHS are bearer tokens — the full URL must never
 * reach the browser (GET /api/config masks through this before responding).
 */
export function maskWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '(unparseable URL)';
  }
}

/** One notification event — the SSE `notification` payload.
 *  Repo-level events carry prNumber 0; title = repo ('queue-stalled') or the
 *  check name ('duration-regression'). */
export interface NotificationEvent {
  repo: string;
  prNumber: number;
  /** PR title. For 'digest': the pre-rendered subject line (repo is ''). */
  title: string;
  type: NotificationKind;
  detail: string;
  /** The deploy environment name for 'prod-live' events (terminalLive). Absent on
   *  other event types. */
  env?: string;
  /** Server-rendered display strings (renderNotification), attached when the event
   *  is fired so EVERY display sink — host command and the browser bell over SSE —
   *  shows the identical text. The single source of truth for notification display;
   *  the browser must not re-derive labels/subjects (that drift is the bug). */
  rendered?: { title: string; body: string };
}

/** One classify result for a tracked PR, with the previous result for context. */
export interface StageTransition {
  repo: string;
  prNumber: number;
  title: string;
  prev: StageResult | null;
  next: StageResult;
  /** The queue's conflicting-culprit PR number, when known (queue-blocked detail). */
  queueCulprit?: number | null;
  /** Failing-class check names of the PR's merge-group build, when known
   *  (group-failed detail names the train killer — issue #38). */
  groupCulpritChecks?: string[] | null;
}

const LABELS: Record<NotificationEventType, string> = {
  'ci-failed': 'CI failed',
  'group-failed': 'merge-queue group failed',
  'queue-blocked': 'queue blocked',
  ready: 'ready to merge',
  overdue: 'overdue',
  'prod-live': 'live on prod',
  'queue-stalled': 'merge queue STALLED',
  'duration-regression': 'duration regression',
  'runner-starvation': 'runner pool starving',
  'budget-breach': 'budget breach',
};

/** Render an event to the {title}/{body} strings both sinks display. */
export function renderNotification(ev: NotificationEvent): { title: string; body: string } {
  // digest frames arrive pre-rendered (subject in title, multi-line body in detail)
  if (ev.type === 'digest') return { title: ev.title, body: ev.detail };
  // repo-level events have no PR — "repo#0" must never render
  const subject = REPO_LEVEL_TYPES.has(ev.type) ? ev.repo : `${ev.repo}#${ev.prNumber}`;
  return {
    title: `${subject} ${LABELS[ev.type]}`,
    body: ev.detail ? `${ev.title} — ${ev.detail}` : ev.title,
  };
}

type StageEventType = Exclude<NotificationEventType,
  'prod-live' | 'queue-stalled' | 'duration-regression' | 'runner-starvation' | 'budget-breach'>;

interface Condition {
  /** Whether the condition holds for a classify result (drives debounce clearing). */
  isActive: (s: StageResult) => boolean;
  /** Extra entry gate evaluated only when the condition newly activates. */
  enteredFrom?: (prev: StageResult | null) => boolean;
}

const CONDITIONS: Record<StageEventType, Condition> = {
  'ci-failed': { isActive: (s) => s.stage === 'parked' && s.substate === 'ci-failed' },
  'group-failed': { isActive: (s) => s.stage === 'queue' && s.substate === 'group-failed' },
  // both UNMERGEABLE flavors: genuine conflict ('unmergeable') and cascade
  // victim ('queue-blocked') — the detail string distinguishes them
  'queue-blocked': { isActive: (s) => s.stage === 'queue'
    && (s.substate === 'queue-blocked' || s.substate === 'unmergeable') },
  ready: {
    isActive: (s) => s.stage === 'ready' && (s.substate === 'armed' || s.substate === 'idle'),
    // only the ci → ready edge is news ("checks just went green"); a PR first
    // seen ready, or one wandering back from queue/parked, is not
    enteredFrom: (prev) => prev?.stage === 'ci',
  },
  overdue: { isActive: (s) => s.overdue },
};

function detailFor(type: StageEventType, t: StageTransition): string {
  switch (type) {
    case 'ci-failed': return 'a required check failed';
    case 'group-failed':
      return t.groupCulpritChecks?.length
        ? `the merge-queue group build failed — culprit: ${t.groupCulpritChecks.join(', ')}`
        : 'the merge-queue group build failed';
    case 'queue-blocked':
      if (t.next.substate === 'unmergeable') {
        return 'conflicts with the base branch — facing ejection from the queue';
      }
      return t.queueCulprit != null && t.queueCulprit !== t.prNumber
        ? `blocked in the merge queue behind conflicting PR #${t.queueCulprit}`
        : 'blocked in the merge queue by a conflicting entry ahead';
    case 'ready': return t.next.substate === 'armed'
      ? 'CI green — auto-merge armed' : 'CI green — ready to merge';
    case 'overdue': return `${t.next.stage} stage is running past its expected duration`;
  }
}

/** execFile-shaped callable — injectable for tests. */
export type ExecLike = (cmd: string, args: string[], cb: (err: Error | null) => void) => unknown;

/** fetch-shaped callable (the subset the webhook sink uses) — injectable for tests. */
export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number }>;

/** Webhook POST abort timeout — a slow receiver must never back up a poll cycle. */
export const WEBHOOK_TIMEOUT_MS = 5_000;
/** Webhook failures log at most this often (the command sink logs once ever;
 *  webhooks are remote and may recover, so an hourly reminder is kept). */
const WEBHOOK_FAILURE_LOG_INTERVAL_MS = 3600_000;

export interface NotifierDeps {
  /** Live notifications config (a getter so hot-applied config swaps take effect). */
  config: () => NotificationsConfig;
  exec?: ExecLike;
  /** Webhook transport — defaults to global fetch. */
  fetchFn?: FetchLike;
  log?: (msg: string) => void;
  /** Clock (epoch ms) — drives the webhook-failure log throttle and the
   *  payload `at` timestamp; injectable for tests. */
  now?: () => number;
}

export class Notifier extends EventEmitter {
  /** `${repo}#${prNumber}|${type}` of currently-active (already fired) conditions. */
  private active = new Set<string>();
  private commandFailureLogged = false;
  private lastWebhookFailureLogMs = -Infinity;

  constructor(private deps: NotifierDeps) {
    super();
  }

  /** Feed one classify result; fires events for newly-entered conditions. */
  observe(t: StageTransition): void {
    for (const type of Object.keys(CONDITIONS) as StageEventType[]) {
      const cond = CONDITIONS[type];
      const key = `${t.repo}#${t.prNumber}|${type}`;
      if (!cond.isActive(t.next)) {
        this.active.delete(key); // condition cleared — eligible to re-fire on re-entry
        continue;
      }
      if (this.active.has(key)) continue; // already fired for this activation
      this.active.add(key);
      if (cond.enteredFrom && !cond.enteredFrom(t.prev)) continue;
      this.fire({ repo: t.repo, prNumber: t.prNumber, title: t.title, type,
        detail: detailFor(type, t) });
    }
  }

  /**
   * Repo-level queue-health feed (issue #39): fires 'queue-stalled' once per
   * dispatch-stall ENTRY — the debounce key clears as soon as the health
   * classifier reports any other state, so a re-entered stall re-fires.
   * Cap-backlog/healthy never notify (backlog self-heals; a banner suffices).
   */
  queueHealth(repo: string, state: string, detail: string): void {
    const key = `${repo}|queue-stalled`;
    if (state !== 'dispatch-stall') {
      this.active.delete(key);
      return;
    }
    if (this.active.has(key)) return; // already fired for this stall
    this.active.add(key);
    this.fire({ repo, prNumber: 0, title: repo, type: 'queue-stalled', detail });
  }

  /**
   * Duration-regression feed (issue #41): the poller's hourly scan reports
   * every evaluated (repo, check, event) series with its current active flag.
   * Fires once per series ENTRY; `active=false` (measured ratio fell below the
   * clear threshold, or the series left the candidate set) clears the debounce
   * key, so a re-entered regression re-fires. The event is repo-level
   * (prNumber 0) with the CHECK name as the title.
   */
  durationRegression(repo: string, check: string, event: string,
    active: boolean, detail: string): void {
    // check names contain spaces and ' / ' — NUL-separate the key parts
    const key = `${repo}\u0000${check}\u0000${event}|duration-regression`;
    if (!active) {
      this.active.delete(key);
      return;
    }
    if (this.active.has(key)) return; // already fired for this activation
    this.active.add(key);
    this.fire({ repo, prNumber: 0, title: check, type: 'duration-regression', detail });
  }

  /**
   * Budget-breach feed (roadmap 5.6c): a tool-global alert when a configured
   * budget crosses its threshold. `scope` is the budget scope ('fleet' or a pool
   * label) and renders as the subject; `kind` (minutes/cost/flake/…) is the title.
   * Fires once per breach ENTRY; `active=false` (spend fell back under threshold,
   * or the budget was removed) clears the debounce key so a re-breach re-fires.
   */
  budgetBreach(scope: string, kind: string, active: boolean, detail: string): void {
    const key = `${scope}\x00${kind}|budget-breach`;
    if (!active) {
      this.active.delete(key);
      return;
    }
    if (this.active.has(key)) return; // already fired for this breach
    this.active.add(key);
    this.fire({ repo: scope, prNumber: 0, title: kind, type: 'budget-breach', detail });
  }

  /**
   * Runner-starvation feed (issue #45): the poller's hourly scan reports every
   * evaluated (repo, pool) with its current starving flag. Fires once per pool
   * ENTRY; `starving=false` (hysteresis cleared, or the pool left the
   * evaluated set) clears the debounce key, so a re-starved pool re-fires.
   * Repo-level (prNumber 0) with the POOL as the title.
   */
  runnerStarvation(repo: string, pool: string, starving: boolean, detail: string): void {
    // pool labels are operator-controlled but keep the NUL convention anyway
    const key = `${repo}\u0000${pool}|runner-starvation`;
    if (!starving) {
      this.active.delete(key);
      return;
    }
    if (this.active.has(key)) return; // already fired for this starvation episode
    this.active.add(key);
    this.fire({ repo, prNumber: 0, title: pool, type: 'runner-starvation', detail });
  }

  /** The "shipped" signal: a merged PR's commit just became live on the terminal deploy env. */
  terminalLive(repo: string, prNumber: number, title: string, envName: string): void {
    const key = `${repo}#${prNumber}|prod-live`;
    if (this.active.has(key)) return; // can't clear — once per PR per process
    this.active.add(key);
    this.fire({ repo, prNumber, title, type: 'prod-live', detail: `deployed to ${envName}`, env: envName });
  }

  /** Drop debounce state for PRs no longer tracked (keys are `repo#number`).
   *  Repo-level keys (`repo|queue-stalled`, `…|duration-regression`,
   *  `…|runner-starvation`) are exempt — they clear via their own feeds
   *  (queueHealth / the hourly scans), not via PR lifecycle. */
  prune(livePrKeys: ReadonlySet<string>): void {
    for (const key of this.active) {
      if (key.endsWith('|queue-stalled') || key.endsWith('|duration-regression')
        || key.endsWith('|runner-starvation') || key.endsWith('|budget-breach')) continue;
      if (!livePrKeys.has(key.slice(0, key.lastIndexOf('|')))) this.active.delete(key);
    }
  }

  /**
   * Daily digest (issue #51): a pre-rendered subject + multi-line body from the
   * DigestScheduler, fanned out through every sink (SSE frame, command,
   * webhook). Not an `events` toggle type — `digest.enabled` gates the
   * scheduler itself; `enabled` still gates the command/webhook sinks.
   */
  sendDigest(subject: string, body: string): void {
    this.fire({ repo: '', prNumber: 0, title: subject, type: 'digest', detail: body });
  }

  private fire(ev: NotificationEvent): void {
    // type toggled off — no sink fires ('digest' is not an events key; it is
    // gated upstream by digest.enabled)
    if (ev.type !== 'digest' && this.deps.config().events[ev.type] === false) return;
    // Render ONCE here so every display sink (host command + the browser bell via
    // SSE) shows identical text — no parallel render rule on the client.
    const rendered = renderNotification(ev);
    this.emit('notification', { ...ev, rendered });
    this.runCommand(ev, rendered);
    this.postWebhook(ev);
  }

  /**
   * Webhook sink (issue #51): fire-and-forget JSON POST per event. 5s abort
   * timeout; NO retries in v1 (a dropped notification is cheaper than building
   * a delivery queue — revisit if it ever matters); failures are logged at
   * most once per hour and must never crash a poll cycle.
   */
  private postWebhook(ev: NotificationEvent): void {
    const cfg = this.deps.config();
    if (!cfg.enabled || !cfg.webhookUrl) return;
    const body = JSON.stringify({
      type: ev.type, repo: ev.repo, prNumber: ev.prNumber, title: ev.title,
      detail: ev.detail, at: new Date(this.nowMs()).toISOString(),
    });
    const fetchFn: FetchLike = this.deps.fetchFn ?? ((url, init) => fetch(url, init));
    try {
      void Promise.resolve(fetchFn(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })).then((res) => {
        if (!res.ok) this.logWebhookFailure(new Error(`receiver responded ${res.status}`));
      }).catch((e: unknown) => this.logWebhookFailure(e));
    } catch (e) {
      this.logWebhookFailure(e); // a sink failure must never crash a poll cycle
    }
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private logWebhookFailure(e: unknown): void {
    const now = this.nowMs();
    if (now - this.lastWebhookFailureLogMs < WEBHOOK_FAILURE_LOG_INTERVAL_MS) return;
    this.lastWebhookFailureLogMs = now;
    const msg = e instanceof Error ? e.message : String(e);
    (this.deps.log ?? console.warn)(
      `[notifier] webhook POST failed (no retries; logged at most hourly): ${msg}`);
  }

  private runCommand(ev: NotificationEvent, rendered: { title: string; body: string }): void {
    const cfg = this.deps.config();
    if (!cfg.enabled) return;
    const [cmd, ...args] = cfg.command;
    if (!cmd) return;
    const { title, body } = rendered;
    // substitution in ARGUMENTS only — argv[0] selects the executable and must
    // never be influenced by PR-controlled content
    const argv = args.map((a) => a.replaceAll('{title}', title).replaceAll('{body}', body));
    const exec = this.deps.exec ?? ((c, as, cb) => execFile(c, as, (err) => cb(err)));
    try {
      exec(cmd, argv, (err) => { if (err) this.logCommandFailureOnce(err); });
    } catch (e) {
      this.logCommandFailureOnce(e); // a sink failure must never crash a poll cycle
    }
  }

  private logCommandFailureOnce(e: unknown): void {
    if (this.commandFailureLogged) return;
    this.commandFailureLogged = true;
    const msg = e instanceof Error ? e.message : String(e);
    (this.deps.log ?? console.warn)(
      `[notifier] command failed (further failures suppressed): ${msg}`);
  }
}
