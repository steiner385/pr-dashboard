import express from 'express';
import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DashboardState, RepoSettingsReport } from './poller';
import { READ_ONLY_CONFIG_KEYS, validateConfigPatch, validateRunnerRoutingPatch, type AppConfig, type ConfigPatch } from './config';
import { maskWebhookUrl } from './notifier';
import { resolveMetricsQuery, type MetricsBucket, type MetricsPayload, type MetricsWindow } from './metrics';
import { verifySignature, routeEvent, type WebhookRoute } from './webhooks';
import { PermissionError, type MergeMethod, type ReadyMergeInput, type ReadyMergeResult } from './pr-actions';
import type { DraftPrResult } from './demotion-action';
import type { DemotionCandidate } from './estimator/demotion-candidates';
import type { PromotionCandidate } from './estimator/promotion-candidates';
import type { RoutingState } from './runner-routing';
import type { RunnerPlan, RunnerJobKey } from './estimator/runner-plan';
import { RUNNER_JOB_META } from './estimator/runner-plan';

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
 * CSRF guard factory for mutating endpoints (POST /api/cost/actuals,
 * PUT /api/config, POST /api/admin/restart). A malicious page in the operator's
 * browser can fire cross-site requests at the dashboard — browsers attach
 * Sec-Fetch-Site / Origin, so:
 *   - Sec-Fetch-Site present and not same-origin/none → 403
 *   - Origin present and its host NOT in `allowedHosts()` → 403
 *   - neither header present (curl/scripts) → allowed
 * `allowedHosts()` is resolved per request (so hot-reload of bindHosts/
 * allowedOriginHosts takes effect) and always includes 127.0.0.1/localhost plus
 * any configured bind/origin hosts — this lets the UI served over a Tailscale
 * IP/MagicDNS name make mutating requests to itself while still blocking a
 * cross-origin page. The webhook path never uses this guard (it is
 * signature-authenticated and GitHub's delivery is cross-origin by nature).
 */
function makeSameOriginGuard(allowedHosts: () => Set<string>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      res.status(403).json({ error: `cross-site request blocked (sec-fetch-site: ${site})` });
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      let host: string | null;
      try { host = new URL(origin).hostname; } catch { host = null; }
      if (host == null || !allowedHosts().has(host)) {
        res.status(403).json({ error: `cross-origin request blocked (origin: ${origin})` });
        return;
      }
    }
    next();
  };
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
  /** GET /api/protection-map?repo=owner/name — the CI/CD Designer's DerivedModel
   *  (check × tier matrix) for a repo. Resolves null when the repo has no
   *  derivable ci.yml. Wired in index.ts (fetches workflows + reads history). */
  protectionMap?: (repo: string) => Promise<unknown>;
  /** GET /api/repos — discovered repos with their excluded flags (settings toggles). */
  repos?: () => { repo: string; excluded: boolean }[];
  /** POST /api/cost/actuals — operator-imported daily spend (cost explorer
   *  phase 2). Upsert is all-or-nothing over the validated rows. */
  costActuals?: { upsert: (rows: CostActualInput[]) => void };
  /** POST /api/pr/ready-merge — flip a draft PR ready-for-review and arm
   *  auto-merge. Wired in index.ts to the per-owner GithubClient. */
  prActions?: { readyAndAutoMerge: (input: ReadyMergeInput) => Promise<ReadyMergeResult> };
  /** POST /api/demotion/draft-pr — open a scaffold draft PR proposing a check's
   *  demotion to a lower-frequency tier. Wired in index.ts to the per-owner
   *  GithubClient (needs contents: write). */
  demotionAction?: { draftPr: (input: { owner: string; repo: string; candidate: DemotionCandidate }) => Promise<DraftPrResult> };
  /** POST /api/promotion/draft-pr — open a scaffold draft PR proposing a check's
   *  shift-left to an earlier tier (#150.2). Same wiring as demotionAction. */
  promotionAction?: { draftPr: (input: { owner: string; repo: string; candidate: PromotionCandidate }) => Promise<DraftPrResult> };
  /** Runner-routing capability (feature/runner-routing) — the controller's live
   *  state + computed plan, plus a write path for the browser-writable config
   *  subset. The endpoints that consume this are added by a later task; this
   *  task only threads the capability through. */
  runnerRouting?: {
    state: () => RoutingState;
    plan: () => RunnerPlan;
    applyConfig: (patch: Record<string, unknown>) => void;
  };
  /** Unified-workspace IDE/model loop router (spec 001) — mounted at /api/workspace
   *  when present. Built in index.ts via workspaceDepsFromClient + createWorkspaceRouter.
   *  Strangler-fig: absent (flag off) leaves the app unchanged. */
  workspaceRouter?: express.Router;
  /** Restart endpoint knobs — `exit` injectable for tests. */
  restart?: { exit?: (code: number) => void; delayMs?: number };
}): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Same-origin guard for mutating endpoints — accepts loopback plus any
  // configured bind/origin hosts (e.g. a Tailscale IP/MagicDNS name) so the
  // dashboard works when reached across the tailnet. Resolved per request.
  const originGuard = makeSameOriginGuard(() => {
    const cfg = opts.config?.get();
    return new Set<string>(['127.0.0.1', 'localhost',
      ...(cfg?.bindHosts ?? []), ...(cfg?.allowedOriginHosts ?? [])]);
  });

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

  // Unified-workspace IDE/model loop (spec 001). Mounted only when wired (flag on);
  // the same-origin guard gates its mutating (non-GET) routes like the rest of /api.
  if (opts.workspaceRouter) {
    app.use('/api/workspace',
      (req, res, next) => (req.method === 'GET' ? next() : originGuard(req, res, next)),
      opts.workspaceRouter);
  }
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

  if (opts.protectionMap) {
    const protectionMap = opts.protectionMap;
    app.get('/api/protection-map', async (req, res) => {
      const repo = typeof req.query.repo === 'string' ? req.query.repo.trim() : '';
      if (!repo || !repo.includes('/')) {
        res.status(400).json({ error: 'expected ?repo=owner/name' });
        return;
      }
      try {
        const model = await protectionMap(repo);
        if (model == null) { res.status(404).json({ error: `no derivable ci.yml for ${repo}` }); return; }
        res.json(model);
      } catch (e) {
        res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  if (opts.costActuals) {
    const sink = opts.costActuals;
    // Same-origin guard like the other mutating endpoints: browsers can't
    // cross-site POST money figures at loopback, while header-less clients
    // (curl, an infra cron piping `aws ce get-cost-and-usage`) pass freely.
    app.post('/api/cost/actuals', originGuard, (req, res) => {
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

  if (opts.prActions) {
    const actions = opts.prActions;
    // Same-origin guarded like the other mutating endpoints. Body is the data
    // the PrRow already holds: { repo: "owner/name", number, mergeMethod? }.
    app.post('/api/pr/ready-merge', originGuard, async (req, res) => {
      const body = (req.body ?? {}) as { repo?: unknown; number?: unknown; mergeMethod?: unknown };
      const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
      const slash = repo.indexOf('/');
      const owner = slash > 0 ? repo.slice(0, slash) : '';
      const name = slash > 0 ? repo.slice(slash + 1) : '';
      const number = typeof body.number === 'number' ? body.number : NaN;
      const method = body.mergeMethod;
      if (!owner || !name || name.includes('/') || !Number.isInteger(number) || number <= 0) {
        res.status(400).json({ error: 'expected { repo: "owner/name", number }' });
        return;
      }
      if (method !== undefined && method !== 'SQUASH' && method !== 'MERGE' && method !== 'REBASE') {
        res.status(400).json({ error: 'mergeMethod must be SQUASH | MERGE | REBASE' });
        return;
      }
      try {
        const result = await actions.readyAndAutoMerge({
          owner, repo: name, number, mergeMethod: method as MergeMethod | undefined });
        res.json(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = e instanceof PermissionError ? 403
          : /not found/i.test(msg) ? 404
          : /not OPEN|no installation/i.test(msg) ? 409
          : 502;
        res.status(status).json({ error: msg });
      }
    });
  }

  if (opts.demotionAction) {
    const demotion = opts.demotionAction;
    // Same-origin guarded. Body: { repo: "owner/name", candidate: DemotionCandidate }.
    app.post('/api/demotion/draft-pr', originGuard, async (req, res) => {
      const body = (req.body ?? {}) as { repo?: unknown; candidate?: unknown };
      const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
      const slash = repo.indexOf('/');
      const owner = slash > 0 ? repo.slice(0, slash) : '';
      const name = slash > 0 ? repo.slice(slash + 1) : '';
      const c = body.candidate as Record<string, unknown> | undefined;
      const validCandidate = !!c && typeof c.name === 'string' && typeof c.event === 'string'
        && typeof c.currentTier === 'string' && typeof c.suggestedTier === 'string'
        && typeof c.successRatePct === 'number' && typeof c.runsInWindow === 'number'
        && typeof c.minutesInWindow === 'number';
      if (!owner || !name || name.includes('/') || !validCandidate) {
        res.status(400).json({ error: 'expected { repo: "owner/name", candidate: DemotionCandidate }' });
        return;
      }
      try {
        const result = await demotion.draftPr({ owner, repo: name, candidate: c as unknown as DemotionCandidate });
        res.json(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = e instanceof PermissionError ? 403
          : /no installation|default branch/i.test(msg) ? 409
          : 502;
        res.status(status).json({ error: msg });
      }
    });
  }

  if (opts.promotionAction) {
    const promotion = opts.promotionAction;
    // Same-origin guarded. Body: { repo: "owner/name", candidate: PromotionCandidate }.
    app.post('/api/promotion/draft-pr', originGuard, async (req, res) => {
      const body = (req.body ?? {}) as { repo?: unknown; candidate?: unknown };
      const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
      const slash = repo.indexOf('/');
      const owner = slash > 0 ? repo.slice(0, slash) : '';
      const name = slash > 0 ? repo.slice(slash + 1) : '';
      const c = body.candidate as Record<string, unknown> | undefined;
      const validCandidate = !!c && typeof c.name === 'string' && typeof c.event === 'string'
        && typeof c.currentTier === 'string' && typeof c.suggestedTier === 'string'
        && typeof c.realFailures === 'number' && typeof c.runsInWindow === 'number'
        && typeof c.minutesInWindow === 'number' && typeof c.failRatePct === 'number';
      if (!owner || !name || name.includes('/') || !validCandidate) {
        res.status(400).json({ error: 'expected { repo: "owner/name", candidate: PromotionCandidate }' });
        return;
      }
      try {
        const result = await promotion.draftPr({ owner, repo: name, candidate: c as unknown as PromotionCandidate });
        res.json(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = e instanceof PermissionError ? 403
          : /no installation|default branch/i.test(msg) ? 409
          : 502;
        res.status(status).json({ error: msg });
      }
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

    app.put('/api/config', originGuard, (req, res) => {
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

  if (opts.runnerRouting) {
    const rr = opts.runnerRouting;
    // GET is read-only (no origin guard). Returns the computed plan + map plus
    // the live routing state fields so the UI can show sync health.
    app.get('/api/runner-plan', (_req, res) => {
      const s = rr.state();
      const { map, plan } = rr.plan();
      // Enrich each row with display context (real check name + owning workflow)
      // so the UI can group the picker by workflow. Metadata is keyed by job key;
      // an unknown key (shouldn't happen — contract-tested) simply omits context.
      const enrichedPlan = plan.map((row) => {
        const meta = RUNNER_JOB_META[row.key as RunnerJobKey];
        return meta ? { ...row, label: meta.label, workflow: meta.workflow } : row;
      });
      res.json({ plan: enrichedPlan, map, enabled: s.enabled, shedCount: s.shedCount,
        shedThresholdMinutes: s.shedThresholdMinutes, reclaimRatePct: s.reclaimRatePct,
        lastPushedAt: s.lastPushedAt, lastPushedHash: s.lastPushedHash,
        lastVerifiedAt: s.lastVerifiedAt, lastError: s.lastError });
    });
    // PUT accepts only the browser-writable subset (enabled, shedThresholdMinutes,
    // overrides); file-only keys (targetRepo, reclaimWindow) are rejected.
    // Origin-guarded like /api/config to block cross-site mutation.
    app.put('/api/runner-routing', originGuard, (req, res) => {
      const v = validateRunnerRoutingPatch(req.body);
      if (!v.ok) {
        res.status(400).json({ error: 'invalid runner-routing patch', errors: v.errors });
        return;
      }
      try {
        rr.applyConfig(req.body as Record<string, unknown>);
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
      res.json({ applied: Object.keys(req.body as object) });
    });
  }

  // 202 now, exit(1) shortly after the response flushes — systemd
  // (Restart=on-failure) revives the service. No shell execution involved.
  const exitFn = opts.restart?.exit ?? ((code: number) => process.exit(code));
  const restartDelayMs = opts.restart?.delayMs ?? 250;
  app.post('/api/admin/restart', originGuard, (_req, res) => {
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
