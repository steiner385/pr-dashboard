import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createApp } from '../api';
import { PermissionError } from '../pr-actions';
import type { DashboardState } from '../poller';

const STATE: DashboardState = {
  generatedAt: '2026-06-10T12:00:00Z', staleSince: null,
  repos: [{ repo: 'acme/widgets', hasDeploy: true, prs: [], queue: null }],
};

describe('api', () => {
  it('GET /api/state returns the snapshot', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter() });
    const res = await request(app).get('/api/state');
    expect(res.status).toBe(200);
    expect(res.body.repos[0].repo).toBe('acme/widgets');
  });

  it('GET /api/events sends the initial snapshot as an SSE frame', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter() });
    // supertest 7: .buffer(false) discards the custom parser result; omit it so
    // the parse callback's cb(null, data) is received as res.body (a string).
    const res = await request(app).get('/api/events')
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (data.includes('\n\n')) { (res as any).destroy(); cb(null, data); }
        });
      });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.body)).toContain('"acme/widgets"');
  });

  it('GET /api/events relays bus notification events as named SSE frames (issue #19)', async () => {
    const bus = new EventEmitter();
    const app = createApp({ getState: () => STATE, bus });
    const EV = { repo: 'acme/widgets', prNumber: 7, title: 'fix: the thing',
      type: 'ci-failed', detail: 'a required check failed' };
    // emit on an interval until the stream observes the frame — the SSE handler
    // subscribes asynchronously, so a single fire-and-forget emit could race it
    const timer = setInterval(() => bus.emit('notification', EV), 10);
    try {
      const res = await request(app).get('/api/events')
        .parse((res, cb) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (data.includes('event: notification')) { (res as any).destroy(); cb(null, data); }
          });
        });
      const body = String(res.body);
      const frame = body.split('\n\n').find((f) => f.includes('event: notification'))!;
      expect(frame).toBeDefined();
      expect(frame).toContain('event: notification');
      const json = JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
      expect(json).toEqual(EV);
    } finally {
      clearInterval(timer);
    }
  });

  it('SSE notification listeners are removed on close (no leak)', async () => {
    const bus = new EventEmitter();
    const app = createApp({ getState: () => STATE, bus });
    await request(app).get('/api/events')
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (data.includes('\n\n')) { (res as any).destroy(); cb(null, data); }
        });
      });
    // destroy() fired 'close' — both update and notification listeners must be gone
    await new Promise((r) => setTimeout(r, 20));
    expect(bus.listenerCount('update')).toBe(0);
    expect(bus.listenerCount('notification')).toBe(0);
  });
});

describe('api SPA fallback', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function staticDirWithIndex(): string {
    const dir = mkdtempSync(join(tmpdir(), 'prdash-static-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>pr-dashboard</title>');
    return dir;
  }

  it('GET a client route serves index.html (200), even with a RELATIVE staticDir', async () => {
    // index.ts passes 'dist/public' (relative) — res.sendFile requires an absolute
    // path, so createApp must resolve it or every SPA fallback hit 500s
    const relDir = relative(process.cwd(), staticDirWithIndex());
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), staticDir: relDir });
    const res = await request(app).get('/client/route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('pr-dashboard');
  });

  it('GET / serves the static index.html', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), staticDir: staticDirWithIndex() });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('pr-dashboard');
  });
});

// ---------------------------------------------------------------------------
// Round 7 Task Z2: /api/config + /api/admin/restart
// ---------------------------------------------------------------------------

import { vi } from 'vitest';
import { writeConfigPatch, DEFAULTS, type AppConfig, type ConfigPatch } from '../config';
import type { ConfigApi } from '../api';
import type { RepoSettingsReport } from '../poller';

const LIVE_CONFIG: AppConfig = { ...DEFAULTS, owners: ['acme'], retentionDays: 7 };
const REPORT: Record<string, RepoSettingsReport> = {
  'acme/widgets': {
    rollupJobId: { value: 'ci', source: 'default' },
    workflowPath: { value: '.github/workflows/ci.yml', source: 'default' },
    batchSize: { value: 6, source: 'override' },
    requiredCheckPrefixes: { value: ['ci'], source: 'derived' },
    deploy: { value: null, source: 'override' },
  },
};

function configApp(over: Partial<ConfigApi> = {}, apply = vi.fn()) {
  const api: ConfigApi = {
    get: () => LIVE_CONFIG,
    writableTo: '/srv/prdash/config.json',
    fileSources: () => ({ owners: 'file', retentionDays: 'default' }),
    repos: () => REPORT,
    apply,
    ...over,
  };
  return createApp({ getState: () => STATE, bus: new EventEmitter(), config: api });
}

describe('GET /api/config', () => {
  it('returns resolved config, read-only flags, per-field + per-repo sources, writableTo', async () => {
    const res = await request(configApp()).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.resolved.owners).toEqual(['acme']);
    expect(res.body.resolved.tokenSource).toBe('gh'); // the MODE string, never a token value
    expect(res.body.readOnlyKeys).toEqual(['tokenSource', 'apiUrl', 'port', 'app', 'ancestrySource', 'costPerMinute', 'poolMeta']);
    expect(res.body.sources).toEqual({
      configPath: '/srv/prdash/config.json',
      perField: { owners: 'file', retentionDays: 'default' },
    });
    expect(res.body.repos['acme/widgets'].deploy.source).toBe('override');
    expect(res.body.repos['acme/widgets'].requiredCheckPrefixes.source).toBe('derived');
    expect(res.body.writableTo).toBe('/srv/prdash/config.json');
  });

  it('is absent when no ConfigApi is wired (404, not a crash)', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter() });
    expect((await request(app).get('/api/config')).status).toBe(404);
  });

  it('masks notifications.webhookUrl to scheme+host — the token-bearing path never reaches the browser (issue #51)', async () => {
    const withHook: AppConfig = { ...LIVE_CONFIG, notifications: {
      ...LIVE_CONFIG.notifications,
      webhookUrl: 'https://hooks.slack.com/services/T123/B456/secret-token' } };
    const res = await request(configApp({ get: () => withHook })).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.resolved.notifications.webhookUrl).toBe('https://hooks.slack.com/…');
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
    // no webhookUrl configured → the key is simply absent
    const bare = await request(configApp()).get('/api/config');
    expect(bare.body.resolved.notifications.webhookUrl).toBeUndefined();
  });
});

describe('PUT /api/config', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('rejects unknown keys with 400 + the offending keys listed; apply is never called', async () => {
    const apply = vi.fn();
    const res = await request(configApp({}, apply)).put('/api/config')
      .send({ retentionDays: 14, banana: 1 });
    expect(res.status).toBe(400);
    expect(res.body.offendingKeys).toEqual(['banana']);
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects forbidden keys (tokenSource/apiUrl/port/deploy/repos) server-side', async () => {
    const apply = vi.fn();
    const res = await request(configApp({}, apply)).put('/api/config')
      .send({ tokenSource: 'env', apiUrl: 'https://evil/x', port: 1, deploy: {}, repos: {} });
    expect(res.status).toBe(400);
    expect(res.body.offendingKeys.sort()).toEqual(['apiUrl', 'deploy', 'port', 'repos', 'tokenSource']);
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects app/webhooks/deployUrlAllowlist server-side (forbidden ahead of the features)', async () => {
    const apply = vi.fn();
    const res = await request(configApp({}, apply)).put('/api/config')
      .send({ app: { appId: 1 }, webhooks: { enabled: true }, deployUrlAllowlist: [] });
    expect(res.status).toBe(400);
    expect(res.body.offendingKeys.sort()).toEqual(['app', 'deployUrlAllowlist', 'webhooks']);
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects bad types with per-field errors', async () => {
    const apply = vi.fn();
    const res = await request(configApp({}, apply)).put('/api/config')
      .send({ retentionDays: 'soon', intervals: { sweepMs: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.retentionDays).toMatch(/number/);
    expect(res.body.fieldErrors['intervals.sweepMs']).toMatch(/1000/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('happy path: applies the patch and reports applied/restartRequired', async () => {
    const apply = vi.fn();
    const res = await request(configApp({}, apply)).put('/api/config')
      .send({ owners: ['acme'], retentionDays: 14, intervals: { hotMs: 20_000 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      applied: ['owners', 'retentionDays', 'intervals'], restartRequired: [] });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({
      owners: ['acme'], retentionDays: 14, intervals: { hotMs: 20_000 } });
  });

  it('end-to-end write path: file read-modify-write preserves the deploy block, reconfigure sees the new value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prdash-api-config-'));
    dirs.push(dir);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({
      owners: ['acme'],
      deploy: { 'acme/widgets': { environments: [{ name: 'qa', healthUrl: 'https://qa.x/health' }] } },
    }, null, 2));
    const reconfigure = vi.fn();
    const apply = (patch: ConfigPatch) => reconfigure(writeConfigPatch(path, patch));
    const res = await request(configApp({ writableTo: path }, vi.fn().mockImplementation(apply)))
      .put('/api/config').send({ retentionDays: 14 });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.retentionDays).toBe(14);
    expect(onDisk.deploy['acme/widgets'].environments[0].healthUrl).toBe('https://qa.x/health');
    expect(reconfigure).toHaveBeenCalledTimes(1);
    expect(reconfigure.mock.calls[0]![0].retentionDays).toBe(14);
  });

  it('notifications.enabled carve-out: the toggle round-trips, command stays rejected', async () => {
    // accepted: enabled-only (flips the pre-configured command on/off)
    const apply = vi.fn();
    const ok = await request(configApp({}, apply)).put('/api/config')
      .send({ notifications: { enabled: false } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ applied: ['notifications'], restartRequired: [] });
    expect(apply).toHaveBeenCalledWith({ notifications: { enabled: false } });
    // rejected: any other sub-key (the command template execs on the host)
    const bad = await request(configApp({}, apply)).put('/api/config')
      .send({ notifications: { enabled: false, command: ['xcalc'] } });
    expect(bad.status).toBe(400);
    expect(bad.body.offendingKeys).toEqual(['notifications.command']);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('an apply failure surfaces as 500, not an unhandled rejection', async () => {
    const apply = vi.fn(() => { throw new Error('disk full'); });
    const res = await request(configApp({}, apply)).put('/api/config').send({ batchSize: 4 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('disk full');
  });
});

// ---------------------------------------------------------------------------
// Round 8 Task A3: webhook receiver
// ---------------------------------------------------------------------------

import { createHmac } from 'node:crypto';

const HOOK_SECRET = 'hook-secret';
const HOOK_PATH = '/api/webhooks/github';
const signBody = (body: string, secret = HOOK_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function webhookApp(nudge = vi.fn()) {
  const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
    webhooks: { path: HOOK_PATH, secret: HOOK_SECRET, nudge } });
  return { app, nudge };
}

describe('POST webhook path', () => {
  const PR_EVENT = JSON.stringify({
    repository: { full_name: 'acme/widgets' }, pull_request: { number: 8962 } });

  it('valid signature → 202 and the routed nudge fires', async () => {
    const { app, nudge } = webhookApp();
    const res = await request(app).post(HOOK_PATH)
      .set('content-type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', signBody(PR_EVENT))
      .send(PR_EVENT);
    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r)); // nudge fires after the response
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledWith({ kind: 'pr-detail', repo: 'acme/widgets', prNumber: 8962 });
  });

  it('bad signature → 401, nudge never called', async () => {
    const { app, nudge } = webhookApp();
    const res = await request(app).post(HOOK_PATH)
      .set('content-type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', signBody(PR_EVENT, 'wrong-secret'))
      .send(PR_EVENT);
    expect(res.status).toBe(401);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('missing signature header → 401', async () => {
    const { app, nudge } = webhookApp();
    const res = await request(app).post(HOOK_PATH)
      .set('content-type', 'application/json')
      .set('x-github-event', 'pull_request')
      .send(PR_EVENT);
    expect(res.status).toBe(401);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('unknown event with a valid signature → 202 accepted, but no nudge', async () => {
    const { app, nudge } = webhookApp();
    const body = JSON.stringify({ zen: 'Keep it simple.' });
    const res = await request(app).post(HOOK_PATH)
      .set('content-type', 'application/json')
      .set('x-github-event', 'ping')
      .set('x-hub-signature-256', signBody(body))
      .send(body);
    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(nudge).not.toHaveBeenCalled();
  });

  it('webhooks not wired (disabled) → 404', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter() });
    const res = await request(app).post(HOOK_PATH)
      .set('content-type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', signBody(PR_EVENT))
      .send(PR_EVENT);
    expect(res.status).toBe(404);
  });

  it('signature verification uses the RAW body bytes (json re-serialization must not break it)', async () => {
    const { app, nudge } = webhookApp();
    // key order + whitespace differ from JSON.stringify(JSON.parse(body)) output
    const body = '{ "pull_request": { "number": 7 },  "repository": { "full_name": "acme/widgets" } }';
    const res = await request(app).post(HOOK_PATH)
      .set('content-type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', signBody(body))
      .send(body);
    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(nudge).toHaveBeenCalledWith({ kind: 'pr-detail', repo: 'acme/widgets', prNumber: 7 });
  });

  it('other routes still parse JSON bodies normally (raw capture is webhook-scoped)', async () => {
    const apply = vi.fn();
    const api: ConfigApi = {
      get: () => LIVE_CONFIG, writableTo: '/srv/prdash/config.json',
      fileSources: () => ({}), repos: () => ({}), apply,
    };
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), config: api,
      webhooks: { path: HOOK_PATH, secret: HOOK_SECRET, nudge: vi.fn() } });
    const res = await request(app).put('/api/config').send({ retentionDays: 14 });
    expect(res.status).toBe(200);
    expect(apply).toHaveBeenCalledWith({ retentionDays: 14 });
  });
});

// ---------------------------------------------------------------------------
// Round 8 Task A4: same-origin guard on mutating endpoints
// ---------------------------------------------------------------------------

describe('same-origin guard (PUT /api/config, POST /api/admin/restart)', () => {
  it('curl-style requests (no Sec-Fetch-Site, no Origin) are allowed', async () => {
    const apply = vi.fn();
    const res = await request(configApp({}, apply)).put('/api/config').send({ batchSize: 4 });
    expect(res.status).toBe(200);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('Sec-Fetch-Site same-origin and none are allowed', async () => {
    for (const site of ['same-origin', 'none']) {
      const apply = vi.fn();
      const res = await request(configApp({}, apply)).put('/api/config')
        .set('sec-fetch-site', site).send({ batchSize: 4 });
      expect(res.status).toBe(200);
      expect(apply).toHaveBeenCalledTimes(1);
    }
  });

  it('cross-site Sec-Fetch-Site is blocked with 403; apply never runs', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const apply = vi.fn();
      const res = await request(configApp({}, apply)).put('/api/config')
        .set('sec-fetch-site', site).send({ batchSize: 4 });
      expect(res.status).toBe(403);
      expect(apply).not.toHaveBeenCalled();
    }
  });

  it('localhost Origins are allowed on any port; foreign Origins are 403', async () => {
    for (const origin of ['http://127.0.0.1:4400', 'http://localhost:5173']) {
      const apply = vi.fn();
      const res = await request(configApp({}, apply)).put('/api/config')
        .set('origin', origin).send({ batchSize: 4 });
      expect(res.status).toBe(200);
      expect(apply).toHaveBeenCalledTimes(1);
    }
    for (const origin of ['https://evil.example', 'http://localhost.evil.example:80', 'null']) {
      const apply = vi.fn();
      const res = await request(configApp({}, apply)).put('/api/config')
        .set('origin', origin).send({ batchSize: 4 });
      expect(res.status).toBe(403);
      expect(apply).not.toHaveBeenCalled();
    }
  });

  it('POST /api/admin/restart is guarded too — cross-site never reaches exit', async () => {
    const exit = vi.fn();
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      restart: { exit, delayMs: 5 } });
    const res = await request(app).post('/api/admin/restart')
      .set('sec-fetch-site', 'cross-site');
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 25));
    expect(exit).not.toHaveBeenCalled();
  });

  it('the same-origin guard accepts configured bind/origin hosts (Tailscale), rejects others', async () => {
    const cfg = { bindHosts: ['127.0.0.1', '100.102.11.121'],
      allowedOriginHosts: ['dobby.tail0dd570.ts.net'] } as unknown as AppConfig;
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      config: { get: () => cfg, writableTo: '/tmp/x.json', fileSources: () => ({}), repos: () => ({}), apply: () => {} } });
    // a request from the Tailscale IP or MagicDNS name gets PAST the guard
    // (invalid empty patch → 400, NOT a 403 cross-origin block)
    const ip = await request(app).put('/api/config').set('origin', 'http://100.102.11.121:4400').send({});
    expect(ip.status).not.toBe(403);
    const dns = await request(app).put('/api/config').set('origin', 'http://dobby.tail0dd570.ts.net:4400').send({});
    expect(dns.status).not.toBe(403);
    // loopback still allowed; a foreign origin is still blocked
    const local = await request(app).put('/api/config').set('origin', 'http://127.0.0.1:4400').send({});
    expect(local.status).not.toBe(403);
    const evil = await request(app).put('/api/config').set('origin', 'http://evil.example.com').send({});
    expect(evil.status).toBe(403);
  });

  it('the webhook path is exempt (signature-authenticated, not origin-gated)', async () => {
    const nudge = vi.fn();
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      webhooks: { path: HOOK_PATH, secret: HOOK_SECRET, nudge } });
    const body = JSON.stringify({ repository: { full_name: 'acme/widgets' }, pull_request: { number: 1 } });
    const res = await request(app).post(HOOK_PATH)
      .set('origin', 'https://github.com')        // GitHub's delivery is cross-origin by nature
      .set('sec-fetch-site', 'cross-site')
      .set('content-type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', signBody(body))
      .send(body);
    expect(res.status).toBe(202);
  });

  it('GET endpoints are not origin-gated (read-only)', async () => {
    const res = await request(configApp()).get('/api/config')
      .set('sec-fetch-site', 'cross-site');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/admin/restart', () => {
  it('responds 202 immediately, then calls the injected exit(1) after the delay', async () => {
    const exit = vi.fn();
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      restart: { exit, delayMs: 10 } });
    const res = await request(app).post('/api/admin/restart');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ restarting: true });
    expect(exit).not.toHaveBeenCalled(); // response first, exit after the beat
    await new Promise((r) => setTimeout(r, 40));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Round 12 (metrics tab): GET /api/metrics
// ---------------------------------------------------------------------------

import type { MetricsBucket, MetricsPayload, MetricsWindow } from '../metrics';

const EMPTY_METRICS = (w: MetricsWindow, b: MetricsBucket): MetricsPayload =>
  ({ window: w, bucket: b, runnerWaits: [], queue: [], queueEfficiency: [], batchAdvisor: [], recommendations: [], configChanges: [], slowestJobs: [],
    velocity: [], leadTime: [], trends: [], calibration: [], flakiness: [], demotionCandidates: [], promotionCandidates: [], trainKillers: [],
    criticalPath: [], needsGraph: [], lint: [], regressions: [],
    runnerPools: [], reclaims: [], concurrency: [], cost: [], costJobs: [], costRuns: [],
    costActuals: [], costAutoRate: null });

describe('GET /api/metrics', () => {
  function metricsApp() {
    const metrics = vi.fn(EMPTY_METRICS);
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), metrics });
    return { app, metrics };
  }

  it('defaults to window=3d bucket=hour', async () => {
    const { app, metrics } = metricsApp();
    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(metrics).toHaveBeenCalledWith('3d', 'hour');
    expect(res.body).toEqual(EMPTY_METRICS('3d', 'hour'));
  });

  it('accepts window + bucket query params', async () => {
    const { app, metrics } = metricsApp();
    const res = await request(app).get('/api/metrics?window=7d&bucket=day');
    expect(res.status).toBe(200);
    expect(metrics).toHaveBeenCalledWith('7d', 'day');
    expect(res.body.window).toBe('7d');
    expect(res.body.bucket).toBe('day');
  });

  it('clamps hour buckets to day for windows > 7d', async () => {
    const { app, metrics } = metricsApp();
    const res = await request(app).get('/api/metrics?window=14d&bucket=hour');
    expect(metrics).toHaveBeenCalledWith('14d', 'day');
    expect(res.body.bucket).toBe('day');
  });

  it('back-compat: accepts legacy windowDays values', async () => {
    const { app, metrics } = metricsApp();
    expect((await request(app).get('/api/metrics?windowDays=7')).body.window).toBe('7d');
    expect((await request(app).get('/api/metrics?windowDays=30')).body.window).toBe('30d');
    expect((await request(app).get('/api/metrics?windowDays=999')).body.window).toBe('30d');
    expect(metrics.mock.calls).toEqual([['7d', 'hour'], ['30d', 'day'], ['30d', 'day']]);
  });

  it('is absent when no metrics fn is wired (404, not a crash)', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter() });
    expect((await request(app).get('/api/metrics')).status).toBe(404);
  });
});

describe('GET /api/repos', () => {
  it('serves the toggle list; 404 when not wired', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      repos: () => [{ repo: 'acme/a', excluded: false }, { repo: 'acme/b', excluded: true }] });
    const res = await request(app).get('/api/repos');
    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([
      { repo: 'acme/a', excluded: false },
      { repo: 'acme/b', excluded: true },
    ]);
    const bare = createApp({ getState: () => STATE, bus: new EventEmitter() });
    expect((await request(bare).get('/api/repos')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Cost actuals import (cost explorer phase 2): POST /api/cost/actuals
// ---------------------------------------------------------------------------

import { validateCostActualsBody, type CostActualInput } from '../api';

describe('validateCostActualsBody', () => {
  it('accepts a single row; scope defaults to fleet, source to null', () => {
    const v = validateCostActualsBody({ date: '2026-06-11', dollars: 123.45 });
    expect(v).toEqual({ ok: true,
      rows: [{ scope: 'fleet', date: '2026-06-11', dollars: 123.45, source: null }] });
  });

  it('accepts an array of rows with explicit scope/source (trimmed)', () => {
    const v = validateCostActualsBody([
      { scope: ' kindash-arc ', date: '2026-06-10', dollars: 80, source: ' aws-ce ' },
      { date: '2026-06-11', dollars: 90.5 },
    ]);
    expect(v).toEqual({ ok: true, rows: [
      { scope: 'kindash-arc', date: '2026-06-10', dollars: 80, source: 'aws-ce' },
      { scope: 'fleet', date: '2026-06-11', dollars: 90.5, source: null },
    ] });
  });

  it('rejects malformed dates, impossible calendar days, and bad dollars', () => {
    for (const body of [
      { date: '06/11/2026', dollars: 1 },
      { date: '2026-6-1', dollars: 1 },
      { date: '2026-02-31', dollars: 1 },     // not a real day
      { date: '2026-06-11', dollars: -1 },
      { date: '2026-06-11', dollars: '12' },
      { date: '2026-06-11', dollars: Infinity },
      { date: '2026-06-11' },
    ]) {
      const v = validateCostActualsBody(body);
      expect(v.ok, JSON.stringify(body)).toBe(false);
    }
  });

  it('rejects unknown keys, empty scope/source, non-object rows, and empty arrays', () => {
    expect(validateCostActualsBody({ date: '2026-06-11', dollars: 1, dolars: 2 }).ok).toBe(false);
    expect(validateCostActualsBody({ date: '2026-06-11', dollars: 1, scope: ' ' }).ok).toBe(false);
    expect(validateCostActualsBody({ date: '2026-06-11', dollars: 1, source: '' }).ok).toBe(false);
    expect(validateCostActualsBody('row').ok).toBe(false);
    expect(validateCostActualsBody(null).ok).toBe(false);
    expect(validateCostActualsBody([]).ok).toBe(false);
  });

  it('all-or-nothing: one bad row in an array fails the whole batch with indexed errors', () => {
    const v = validateCostActualsBody([
      { date: '2026-06-10', dollars: 1 },
      { date: 'nope', dollars: 1 },
    ]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' ')).toContain('[1].date');
  });
});

describe('POST /api/cost/actuals', () => {
  const actualsApp = (upsert: (rows: CostActualInput[]) => void) =>
    createApp({ getState: () => STATE, bus: new EventEmitter(), costActuals: { upsert } });

  it('upserts validated rows and reports the count', async () => {
    const upsert = vi.fn();
    const res = await request(actualsApp(upsert)).post('/api/cost/actuals')
      .send([{ date: '2026-06-11', dollars: 123.45, source: 'aws-ce' }]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ upserted: 1 });
    expect(upsert).toHaveBeenCalledWith(
      [{ scope: 'fleet', date: '2026-06-11', dollars: 123.45, source: 'aws-ce' }]);
  });

  it('400s invalid bodies with the error list; upsert never runs', async () => {
    const upsert = vi.fn();
    const res = await request(actualsApp(upsert)).post('/api/cost/actuals')
      .send({ date: 'yesterday', dollars: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid cost actuals');
    expect(res.body.errors.join(' ')).toContain('date');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('same-origin guard: cross-site browsers are 403, header-less crons pass', async () => {
    const upsert = vi.fn();
    const blocked = await request(actualsApp(upsert)).post('/api/cost/actuals')
      .set('sec-fetch-site', 'cross-site')
      .send({ date: '2026-06-11', dollars: 1 });
    expect(blocked.status).toBe(403);
    const foreign = await request(actualsApp(upsert)).post('/api/cost/actuals')
      .set('origin', 'https://evil.example')
      .send({ date: '2026-06-11', dollars: 1 });
    expect(foreign.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
    // no Origin / no Sec-Fetch-Site — exactly what `aws ce ... | curl` sends
    const curl = await request(actualsApp(upsert)).post('/api/cost/actuals')
      .send({ date: '2026-06-11', dollars: 1 });
    expect(curl.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('a throwing upsert surfaces as 500 with the message', async () => {
    const res = await request(actualsApp(() => { throw new Error('disk full'); }))
      .post('/api/cost/actuals').send({ date: '2026-06-11', dollars: 1 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('disk full');
  });

  it('404 when the endpoint is not wired (no costActuals opt)', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter() });
    const res = await request(app).post('/api/cost/actuals')
      .send({ date: '2026-06-11', dollars: 1 });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Task 5: GET /api/runner-plan + PUT /api/runner-routing
// ---------------------------------------------------------------------------

import { validateRunnerRoutingPatch } from '../config';

describe('runner routing endpoints', () => {
  const plan = { map: { integration: 'kindash-arc' as const }, plan: [{ key: 'integration', decision: 'kindash-arc' as const, source: 'auto' as const, p90Secs: 120, scoreMinutes: 2, reason: 'auto', collecting: false }] };
  const state = { enabled: false, shedThresholdMinutes: 1, reclaimRatePct: null,
    lastPushedAt: null, lastPushedHash: null, lastVerifiedAt: null,
    lastError: null, plan: plan.plan, shedCount: 1 };
  const deps = () => ({ runnerRouting: { state: () => state, plan: () => plan, applyConfig: vi.fn() } });

  it('GET /api/runner-plan returns plan + map + state', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), ...deps() });
    const res = await request(app).get('/api/runner-plan');
    expect(res.status).toBe(200);
    expect(res.body.map).toEqual({ integration: 'kindash-arc' });
    expect(res.body.shedCount).toBe(1);
    expect(res.body).toHaveProperty('lastError', null);
  });

  it('PUT /api/runner-routing accepts the writable subset', async () => {
    const d = deps();
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), ...d });
    const res = await request(app).put('/api/runner-routing').send({ shedThresholdMinutes: 2 });
    expect(res.status).toBe(200);
    expect(d.runnerRouting.applyConfig).toHaveBeenCalledWith({ shedThresholdMinutes: 2 });
  });

  it('PUT /api/runner-routing 400s on a file-only key', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), ...deps() });
    const res = await request(app).put('/api/runner-routing').send({ targetRepo: 'evil/repo' });
    expect(res.status).toBe(400);
  });

  it('is absent (404) when no runnerRouting capability is wired', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter() });
    expect((await request(app).get('/api/runner-plan')).status).toBe(404);
  });
});

describe('POST /api/pr/ready-merge', () => {
  const okResult = { markedReady: true, autoMergeArmed: true, alreadyArmed: false,
    cleanReadyToMerge: false, state: 'BLOCKED' };

  it('passes a valid body through to the capability and returns its result', async () => {
    const readyAndAutoMerge = vi.fn().mockResolvedValue(okResult);
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      prActions: { readyAndAutoMerge } });
    const res = await request(app).post('/api/pr/ready-merge')
      .send({ repo: 'acme/widgets', number: 42 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(okResult);
    expect(readyAndAutoMerge).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'widgets', number: 42, mergeMethod: undefined });
  });

  it('forwards an explicit mergeMethod', async () => {
    const readyAndAutoMerge = vi.fn().mockResolvedValue(okResult);
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      prActions: { readyAndAutoMerge } });
    await request(app).post('/api/pr/ready-merge')
      .send({ repo: 'acme/widgets', number: 42, mergeMethod: 'REBASE' });
    expect(readyAndAutoMerge).toHaveBeenCalledWith(
      expect.objectContaining({ mergeMethod: 'REBASE' }));
  });

  it('400s on a malformed repo or number', async () => {
    const readyAndAutoMerge = vi.fn();
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      prActions: { readyAndAutoMerge } });
    for (const body of [{ repo: 'widgets', number: 1 }, { repo: 'a/b', number: 0 },
      { repo: 'a/b', number: -3 }, { number: 1 }, { repo: 'a/b/c', number: 1 }]) {
      const res = await request(app).post('/api/pr/ready-merge').send(body);
      expect(res.status).toBe(400);
    }
    expect(readyAndAutoMerge).not.toHaveBeenCalled();
  });

  it('400s on an invalid mergeMethod', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      prActions: { readyAndAutoMerge: vi.fn() } });
    const res = await request(app).post('/api/pr/ready-merge')
      .send({ repo: 'acme/widgets', number: 1, mergeMethod: 'FASTFORWARD' });
    expect(res.status).toBe(400);
  });

  it('maps a PermissionError to 403', async () => {
    const readyAndAutoMerge = vi.fn().mockRejectedValue(new PermissionError('needs pull_requests:write'));
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      prActions: { readyAndAutoMerge } });
    const res = await request(app).post('/api/pr/ready-merge')
      .send({ repo: 'acme/widgets', number: 42 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pull_requests:write/);
  });

  it('maps a not-found error to 404', async () => {
    const readyAndAutoMerge = vi.fn().mockRejectedValue(new Error('PR acme/widgets#9 not found'));
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(),
      prActions: { readyAndAutoMerge } });
    const res = await request(app).post('/api/pr/ready-merge')
      .send({ repo: 'acme/widgets', number: 9 });
    expect(res.status).toBe(404);
  });

  it('is absent (404) when no prActions capability is wired', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter() });
    const res = await request(app).post('/api/pr/ready-merge')
      .send({ repo: 'acme/widgets', number: 1 });
    expect(res.status).toBe(404);
  });
});
