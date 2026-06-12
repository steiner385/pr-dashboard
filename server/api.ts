import express from 'express';
import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DashboardState, RepoSettingsReport } from './poller';
import { READ_ONLY_CONFIG_KEYS, validateConfigPatch, type AppConfig, type ConfigPatch } from './config';
import { clampWindowDays, type MetricsPayload, type MetricsWindow } from './metrics';
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
  metrics?: (windowDays: MetricsWindow) => MetricsPayload;
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

  if (opts.metrics) {
    const metrics = opts.metrics;
    app.get('/api/metrics', (req, res) => {
      res.json(metrics(clampWindowDays(req.query.windowDays)));
    });
  }

  if (opts.config) {
    const cfg = opts.config;
    app.get('/api/config', (_req, res) => {
      res.json({
        resolved: cfg.get(),
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
    send();
    opts.bus.on('update', send);
    const ping = setInterval(() => { if (res.destroyed) { clearInterval(ping); return; } res.write(': ping\n\n'); }, 25_000);
    req.on('close', () => { opts.bus.off('update', send); clearInterval(ping); });
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('*', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  }
  return app;
}
