import express from 'express';
import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DashboardState, RepoSettingsReport } from './poller';
import { READ_ONLY_CONFIG_KEYS, validateConfigPatch, type AppConfig, type ConfigPatch } from './config';
import { maskWebhookUrl } from './notifier';
import { resolveMetricsQuery, type MetricsBucket, type MetricsPayload, type MetricsWindow } from './metrics';
import { verifySignature, routeEvent, type WebhookRoute } from './webhooks';

/**
 * Wiring for /api/config. Note the security boundary lives HERE (and in
 * validateConfigPatch), not in the UI: only the safe subset (owners, exclude,
 * retentionDays, batchSize, intervals) is writable; tokenSource/apiUrl/port and
 * deploy/repos are file-only. Config never contains token VALUES — `tokenSource`
 * is a mode string — so GET can return the resolved config wholesale.
 */
export interface ConfigApi {
  /** Live instance config. */
  get: () => AppConfig;
  /** Path PUT writes to (the loaded config file, or the default repo-root config.json). */
  writableTo: string;
  /** Per-key file-vs-default attribution for the instance config. */
  fileSources: () => Record<string, 'default' | 'file'>;
  /** Per-repo effective settings with per-field source attribution. */
  repos: () => Record<string, RepoSettingsReport>;
  /** Persist a validated safe-subset patch and hot-apply it (write + reconfigure). */
  apply: (patch: ConfigPatch) => void;
}

/**
 * CSRF guard for mutating endpoints (PUT /api/config, POST /api/admin/restart).
 * The server binds 127.0.0.1, but a malicious page in the operator's browser
 * can still fire cross-site requests at loopback — browsers attach
 * Sec-Fetch-Site / Origin to those, so:
 *   - Sec-Fetch-Site present and not same-origin/none → 403
 *   - Origin present and its host not 127.0.0.1/localhost (any port) → 403
 *   - neither header present (curl/scripts) → allowed
 * The webhook path never uses this guard — it is signature-authenticated and
 * GitHub's delivery is cross-origin by nature.
 */
function sameOriginGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({ error: `cross-site request blocked (sec-fetch-site: ${site})` });
    return;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    let host: string | null;
    try { host = new URL(origin).hostname; } catch { host = null; }
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.status(403).json({ error: `cross-origin request blocked (origin: ${origin})` });
      return;
    }
  }
  next();
}

/** One validated cost-actuals row (cost explorer phase 2). */
export interface CostActualInput {
  scope: string; date: string; dollars: number; source: string | null;
}

export type CostActualsValidation =
  | { ok: true; rows: CostActualInput[] }
  | { ok: false; errors: string[] };

const COST_ACTUAL_KEYS = new Set(['scope', 'date', 'dollars', 'source']);
/** Sanity cap on rows per POST — a year of dailies fits with headroom. */
const COST_ACTUALS_MAX_ROWS = 1000;

/**
 * Strict validation for POST /api/cost/actuals: a single row object or an
 * array of them. Per row: `date` must be a REAL calendar YYYY-MM-DD day,
 * `dollars` a finite number ≥ 0; `scope` defaults to 'fleet' (any non-empty
 * pool label is accepted — the importer can't know the dashboard's pool keys);
 * `source` is optional free-text. Unknown keys are rejected (a typo'd field
 * silently dropping data is worse than a 400). All-or-nothing: any invalid
 * row fails the whole request so a cron never half-imports.
 */
export function validateCostActualsBody(body: unknown): CostActualsValidation {
  const errors: string[] = [];
  const list = Array.isArray(body) ? body : [body];
  if (list.length === 0) return { ok: false, errors: ['body must contain at least one row'] };
  if (list.length > COST_ACTUALS_MAX_ROWS) {
    return { ok: false, errors: [`body exceeds ${COST_ACTUALS_MAX_ROWS} rows`] };
  }
  const rows: CostActualInput[] = [];
  list.forEach((item, i) => {
    const at = Array.isArray(body) ? `[${i}]` : 'body';
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at} must be an object ({ scope?, date, dollars, source? })`);
      return;
    }
    const r = item as Record<string, unknown>;
    const unknown = Object.keys(r).filter((k) => !COST_ACTUAL_KEYS.has(k));
    if (unknown.length) {
      errors.push(`${at} has unknown key(s) ${unknown.join(', ')} (allowed: scope, date, dollars, source)`);
    }
    let scope = 'fleet';
    if (r.scope !== undefined) {
      if (typeof r.scope !== 'string' || !r.scope.trim()) {
        errors.push(`${at}.scope must be a non-empty string ('fleet' or a pool label)`);
      } else scope = r.scope.trim();
    }
    let date: string | null = null;
    if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      errors.push(`${at}.date must be a YYYY-MM-DD string (got ${JSON.stringify(r.date)})`);
    } else {
      // calendar-real days only — '2026-02-31' must not become a silent key
      const parsed = new Date(`${r.date}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== r.date) {
        errors.push(`${at}.date is not a real calendar day (got ${JSON.stringify(r.date)})`);
      } else date = r.date;
    }
    let dollars: number | null = null;
    if (typeof r.dollars !== 'number' || !Number.isFinite(r.dollars) || r.dollars < 0) {
      errors.push(`${at}.dollars must be a finite number ≥ 0 (got ${JSON.stringify(r.dollars)})`);
    } else dollars = r.dollars;
    let source: string | null = null;
    if (r.source !== undefined) {
      if (typeof r.source !== 'string' || !r.source.trim()) {
        errors.push(`${at}.source must be a non-empty string when present`);
      } else source = r.source.trim();
    }
    if (date != null && dollars != null) rows.push({ scope, date, dollars, source });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, rows };
}

/** Wiring for the optional webhook receiver (mounted only when webhooks.enabled). */
export interface WebhookApi {
  /** URL path the receiver mounts at (config webhooks.path). */
  path: string;
  /** Shared HMAC secret (loaded from webhooks.secretPath at startup). */
  secret: string;
  /** Fires AFTER the 202 is sent; rejections are contained here. */
  nudge: (route: WebhookRoute) => void | Promise<void>;
}

export function createApp(opts: {
  getState: () => DashboardState;
  bus: EventEmitter;            // emits 'update'
  staticDir?: string;           // dist/public in production
  config?: ConfigApi;
  webhooks?: WebhookApi;
  /** GET /api/metrics — computed per request (one local SQLite pass, no caching). */
  metrics?: (window: MetricsWindow, bucket: MetricsBucket) => MetricsPayload;
  /** GET /api/repos — discovered repos with their excluded flags (settings toggles). */
  repos?: () => { repo: string; excluded: boolean }[];
  /** POST /api/cost/actuals — operator-imported daily spend (cost explorer
   *  phase 2). Upsert is all-or-nothing over the validated rows. */
  costActuals?: { upsert: (rows: CostActualInput[]) => void };
  /** Restart endpoint knobs — `exit` injectable for tests. */
  restart?: { exit?: (code: number) => void; delayMs?: number };
}): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Webhook receiver — mounted BEFORE express.json with a route-scoped raw-body
  // parser: signature verification needs the exact request bytes, and nothing
  // else in the app should pay the cost of buffering raw bodies.
  if (opts.webhooks) {
    const { path: hookPath, secret, nudge } = opts.webhooks;
    app.post(hookPath, express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
      const sig = req.headers['x-hub-signature-256'];
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (typeof sig !== 'string' || !verifySignature(secret, raw, sig)) {
        res.status(401).json({ error: 'invalid or missing signature' });
        return;
      }
      const event = req.headers['x-github-event'];
      let payload: unknown = null;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { /* underivable → routed by event only */ }
      const route = typeof event === 'string' ? routeEvent(event, payload) : null;
      res.status(202).json({ accepted: true, routed: route ? route.kind : null });
      // nudge after the response — GitHub gets its 202 regardless of cycle latency
      if (route) {
        void Promise.resolve()
          .then(() => nudge(route))
          .catch((e) => console.error('[webhooks] nudge failed:', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  app.use(express.json());
  opts.bus.setMaxListeners(0);
  // res.sendFile requires an absolute path — callers pass relative dirs like 'dist/public'
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : undefined;

  app.get('/api/state', (_req, res) => {
    res.json(opts.getState());
  });

  if (opts.repos) {
    const repos = opts.repos;
    app.get('/api/repos', (_req, res) => {
      res.json({ repos: repos() });
    });
  }

  if (opts.metrics) {
    const metrics = opts.metrics;
    app.get('/api/metrics', (req, res) => {
      const { window, bucket } = resolveMetricsQuery(req.query);
      res.json(metrics(window, bucket));
    });
  }

  if (opts.costActuals) {
    const sink = opts.costActuals;
    // Same-origin guard like the other mutating endpoints: browsers can't
    // cross-site POST money figures at loopback, while header-less clients
    // (curl, an infra cron piping `aws ce get-cost-and-usage`) pass freely.
    app.post('/api/cost/actuals', sameOriginGuard, (req, res) => {
      const v = validateCostActualsBody(req.body);
      if (!v.ok) {
        res.status(400).json({ error: 'invalid cost actuals', errors: v.errors });
        return;
      }
      try {
        sink.upsert(v.rows);
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
      res.json({ upserted: v.rows.length });
    });
  }

  if (opts.config) {
    const cfg = opts.config;
    app.get('/api/config', (_req, res) => {
      const resolved = cfg.get();
      // webhook URLs often carry tokens in the PATH (Slack/Discord) — the
      // browser only ever sees the scheme+host mask (issue #51)
      const notifications = resolved.notifications.webhookUrl
        ? { ...resolved.notifications,
            webhookUrl: maskWebhookUrl(resolved.notifications.webhookUrl) }
        : resolved.notifications;
      res.json({
        resolved: { ...resolved, notifications },
        readOnlyKeys: READ_ONLY_CONFIG_KEYS,
        sources: { configPath: cfg.writableTo, perField: cfg.fileSources() },
        repos: cfg.repos(),
        writableTo: cfg.writableTo,
      });
    });

    app.put('/api/config', sameOriginGuard, (req, res) => {
      const v = validateConfigPatch(req.body);
      if (!v.ok) {
        res.status(400).json({
          error: 'invalid config', offendingKeys: v.offendingKeys, fieldErrors: v.fieldErrors });
        return;
      }
      try {
        cfg.apply(v.patch);
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
      // the whole safe subset is hot-appliable today; restartRequired is kept
      // for future fields that can't be
      res.json({ applied: Object.keys(v.patch), restartRequired: [] });
    });
  }

  // 202 now, exit(1) shortly after the response flushes — systemd
  // (Restart=on-failure) revives the service. No shell execution involved.
  const exitFn = opts.restart?.exit ?? ((code: number) => process.exit(code));
  const restartDelayMs = opts.restart?.delayMs ?? 250;
  app.post('/api/admin/restart', sameOriginGuard, (_req, res) => {
    res.status(202).json({ restarting: true });
    setTimeout(() => exitFn(1), restartDelayMs).unref();
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = () => { if (res.destroyed) return; res.write(`data: ${JSON.stringify(opts.getState())}\n\n`); };
    // Named SSE event (issue #19): notification events ride the same stream as
    // the state pushes — EventSource clients opt in via addEventListener
    // ('notification'); the default onmessage handler never sees named events.
    const sendNotification = (ev: unknown) => {
      if (res.destroyed) return;
      res.write(`event: notification\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    send();
    opts.bus.on('update', send);
    opts.bus.on('notification', sendNotification);
    const ping = setInterval(() => { if (res.destroyed) { clearInterval(ping); return; } res.write(': ping\n\n'); }, 25_000);
    req.on('close', () => {
      opts.bus.off('update', send);
      opts.bus.off('notification', sendNotification);
      clearInterval(ping);
    });
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('*', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  }
  return app;
}
