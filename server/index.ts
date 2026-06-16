import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveOwners, writeConfigPatch, writeRunnerRoutingPatch, configFileSources,
  type AppConfig, type InstallationAccountsSource, type ViewerClient } from './config';
import { createTokenSource, AppJwtSigner, InstallationRegistry, type TokenProvider } from './auth';
import { GithubClient } from './github';
import { ClientRouter } from './client-router';
import { readyAndAutoMerge } from './pr-actions';
import { openDemotionDraftPr } from './demotion-action';
import { HistoryStore } from './history';
import { DeployWatcher } from './deploy-watcher';
import { Poller, describeError } from './poller';
import { RunnerRoutingController } from './runner-routing';
import { Notifier, NOTIFICATION_EVENT_TYPES, maskWebhookUrl } from './notifier';
import { DigestScheduler, composeDigest, gatherDigestInput, queueHealthFromState } from './digest';
import { backfillRepo } from './backfill';
import { computeMetrics } from './metrics';
import { createApp } from './api';
import { loadWebhookSecret } from './webhooks';
import { dataDir, staticDir, configPath } from './paths';

/** Re-list the App's installations this often (new installs appear without a restart). */
const REGISTRY_REFRESH_MS = 24 * 3600_000;

const pexec = promisify(execFile);

/** gh env hygiene: a stale GITHUB_TOKEN/GH_TOKEN in the environment shadows the
 *  gh keyring login (matches server/auth.ts) — strip both before exec'ing gh. */
function ghEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e.GITHUB_TOKEN;
  delete e.GH_TOKEN;
  return e;
}

/** Append one runner-routing audit entry (write/delete) to a JSONL log. Best
 *  effort: a logging failure must never break the control loop. */
function appendRunnerAudit(entry: object): void {
  try {
    mkdirSync('logs', { recursive: true });
    appendFileSync('logs/runner-map.jsonl', `${JSON.stringify(entry)}\n`);
  } catch { /* best effort */ }
}

async function main() {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // Webhooks enabled → the secret must be readable at startup (fail fast, clearly).
  let webhookSecret: string | null = null;
  if (config.webhooks.enabled) {
    try {
      webhookSecret = loadWebhookSecret(config.webhooks.secretPath!);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  const githubOptions = {
    onPartialErrors: (msgs: string[]) => console.warn('[github] partial response errors:', msgs.join('; ')),
    apiUrl: config.apiUrl,
  };

  let router: ClientRouter;
  let ownersSource: ViewerClient | InstallationAccountsSource;
  if (config.tokenSource === 'app') {
    // App mode: one instance watches repos across ALL of the App's installations —
    // per-installation tokens, per-owner request routing (issue #10).
    // app.installationId (when set) restricts the registry to one installation.
    let registry: InstallationRegistry;
    try {
      const signer = new AppJwtSigner({
        appId: config.app!.appId, privateKeyPath: config.app!.privateKeyPath });
      registry = new InstallationRegistry({
        signer, apiUrl: config.apiUrl, installationId: config.app!.installationId });
      await registry.load(); // 0 installations → clear install-first error
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      console.error('Check app.appId / app.privateKeyPath (and that the App is installed) — config tokenSource is "app".');
      process.exit(1);
    }
    console.log(`[auth] GitHub App installations: ${registry.accounts()
      .map((a) => `${a.login} (#${a.id})`).join(', ')}`);
    router = ClientRouter.forRegistry(registry, githubOptions);
    // pick up new installations without a restart; a failed refresh keeps the
    // previous mapping and is retried on the next tick
    setInterval(() => {
      registry.refresh().catch((e) => console.warn(
        `[auth] installation registry refresh failed: ${describeError(e)}`));
    }, REGISTRY_REFRESH_MS).unref();
    ownersSource = registry;
  } else {
    let tokens: TokenProvider;
    try {
      tokens = createTokenSource(config);
      await tokens.get();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      console.error(config.tokenSource === 'env'
        ? 'Set GITHUB_TOKEN — config tokenSource is "env".'
        : 'Run `gh auth login` first — the dashboard uses your gh keyring token.');
      process.exit(1);
    }
    const client = new GithubClient(tokens, fetch, githubOptions);
    router = ClientRouter.forSingle(client);
    ownersSource = client;
  }

  const clonesDir = join(dataDir(), 'clones');
  mkdirSync(clonesDir, { recursive: true });
  const history = new HistoryStore(join(dataDir(), 'history.db'));
  // No owners configured → App mode: every installation account; gh/env: the
  // token owner (one viewer query).
  try {
    await resolveOwners(config, ownersSource);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error('Configure "owners" in config.json or fix the token, then restart.');
    process.exit(1);
  }

  const deploy = new DeployWatcher(clonesDir);
  // Notifier (issue #19): reads the POLLER's live config, so a PUT /api/config
  // carrying notifications.enabled arms/disarms the command sink via
  // reconfigure() — no restart needed. SSE notification events always flow
  // (the browser sink gates itself via the bell + Notification permission);
  // `enabled` gates only the host command.
  let poller: Poller;
  const notifier = new Notifier({ config: () => poller.currentNotifications() });
  if (config.notifications.enabled) {
    const on = NOTIFICATION_EVENT_TYPES.filter((t) => config.notifications.events[t]);
    console.log(`[notifier] armed — command sink: ${config.notifications.command[0] ?? '(none)'}`
      + ` (events: ${on.join(', ') || 'none'})`);
    if (config.notifications.webhookUrl) {
      // never log the full URL — the path often carries a token (issue #51)
      console.log(`[notifier] webhook sink armed — ${maskWebhookUrl(config.notifications.webhookUrl)}`);
    }
  } else {
    console.log('[notifier] command/webhook sinks disabled (notifications.enabled=false) — '
      + 'browser notifications via SSE remain available');
  }
  poller = new Poller({ router, history, deploy, config, notifier });
  console.log(config.ancestrySource === 'api'
    ? '[deploy] ancestrySource: api — compare-API ancestry, no clones created (pre-existing clones serve as fallback only)'
    : `[deploy] ancestrySource: clone — bare clones in ${clonesDir}`);

  // In-repo `.pr-dashboard.yml` for every configured repo (GraphQL blob read) —
  // must land before derivation so in-repo workflowPath/rollupJobId apply.
  await poller.refreshRepoConfigs();

  // Derive required-check prefixes from each derivation-eligible repo's workflow
  // needs-graph (api mode: GraphQL blob read; clone mode: the bare clone).
  // Best-effort: on failure the poller falls back to configured prefixes (if
  // any) / the persisted last-known-good graph, and the deploy cycle retries
  // (capped backoff, then every 24h).
  await poller.refreshDerivedGraphs();

  if (!history.getMeta('backfilled')) {
    // On a fresh DB, set lastSweep 7 days back so the startup merged-window covers 7 days.
    history.setMeta('lastSweep', new Date(Date.now() - 7 * 86400_000).toISOString());
    console.log('First launch: backfilling check-run history…');
    await poller.sweepOnce(true);                   // deep sweep: paginate the 7-day merged window
    const repos = new Set<string>(Object.keys(poller.effectiveDeploy()));
    // backfill every repo that has an open PR too
    for (const { repo } of poller.getState().repos.flatMap((r) => r.prs)) repos.add(repo);
    for (const repo of repos) {
      const repoClient = router.clientFor(repo.split('/')[0] ?? '');
      if (!repoClient) {
        console.warn(`backfill ${repo}: owner has no installation — skipped`);
        continue;
      }
      await backfillRepo(repoClient, history, repo, 5, (n) => poller.needsFor(repo, n),
        (p, e) => poller.needActiveFor(repo, p, e), poller.graphKeysFor(repo),
        poller.rollupWorkflowFor(repo), (n) => poller.timeoutMinutesFor(repo, n),
        (n) => poller.poolsFor(repo, n))
        .catch((e) => console.warn(`backfill ${repo}: ${e}`));
    }
    history.setMeta('backfilled', new Date().toISOString());
  }

  poller.start();

  // Daily digest (issue #51): a self-rearming timer to the next local
  // digest.hourLocal; composes the 24h summary from history + the poller's
  // live caches and fans it out through every notifier sink.
  const digest = new DigestScheduler({
    config: () => config.notifications.digest,
    send: () => {
      const { subject, body } = composeDigest(gatherDigestInput({
        history,
        exclude: poller.currentExclude(),
        activeRegressions: poller.activeRegressions(),
        poolHealth: poller.poolHealth(),
        queueHealth: queueHealthFromState(poller.getState()),
      }));
      notifier.sendDigest(subject, body);
    },
  });
  digest.start();

  const cfgPath = configPath();

  // Runner-routing controller (feature/runner-routing). Reads the LIVE config
  // (so a hot config change reroutes without a restart), projects its inputs
  // from the poller's throttled cache, and reads/writes/deletes the target
  // repo's RUNNER_MAP GitHub Actions variable via `gh` — execFile with an argv
  // ARRAY (never a shell: the JSON --body is an injection surface), GITHUB_TOKEN
  // stripped so the gh keyring login wins. SAFETY: runnerRouting.enabled
  // defaults false, so the controller only ever DELETEs (converges to absent),
  // never writes, until an operator opts in.
  const routing = new RunnerRoutingController({
    config: () => config.runnerRouting,
    inputs: () => poller.runnerRoutingInputs(config.runnerRouting.targetRepo),
    readVar: async () => {
      try {
        const { stdout } = await pexec('gh',
          ['variable', 'get', 'RUNNER_MAP', '--repo', config.runnerRouting.targetRepo], { env: ghEnv() });
        return stdout.trim() || null;
      } catch { return null; }
    },
    writeVar: async (json) => {
      await pexec('gh',
        ['variable', 'set', 'RUNNER_MAP', '--repo', config.runnerRouting.targetRepo, '--body', json],
        { env: ghEnv() });
    },
    deleteVar: async () => {
      try {
        await pexec('gh',
          ['variable', 'delete', 'RUNNER_MAP', '--repo', config.runnerRouting.targetRepo], { env: ghEnv() });
      } catch { /* already absent */ }
    },
    now: () => Date.now(),
    audit: appendRunnerAudit,
  });
  await routing.init();
  // One controller step at the end of every poll cycle. The poller emits
  // 'update' after each metrics/state refresh; tick() self-serializes (an
  // in-flight guard), so overlapping cycles can't double-write. void: fire and
  // forget — a tick failure surfaces via the controller's lastError state, not
  // an unhandled rejection here.
  poller.on('update', () => { void routing.tick(); });

  const app = createApp({
    getState: () => poller.getState(),
    bus: poller,
    staticDir: process.env.NODE_ENV === 'production' ? staticDir() : undefined,
    config: {
      get: () => config,
      writableTo: cfgPath,
      fileSources: () => configFileSources(cfgPath),
      repos: () => poller.reposReport(),
      apply: (patch) => {
        const next = writeConfigPatch(cfgPath, patch);
        // owners may have been token-derived at startup; a file without an
        // owners key must not regress the running set to []
        if (next.owners.length === 0) next.owners = config.owners;
        config = next;
        poller.reconfigure(next);
      },
    },
    metrics: (window, bucket) => computeMetrics(history, window, bucket, new Date(),
      poller.currentExclude(), (repo) => poller.settingsFor(repo).batchSize,
      poller.allDerivedGraphs(), poller.liveForeignNames(), poller.activeRegressions(),
      (repo, name, event) => poller.resolvePool(repo, name, event), poller.poolHealth(),
      config.costPerMinute ?? null, config.poolMeta ?? null,
      (repo, sha) => poller.prNumberForSha(repo, sha), config.costAutoRate,
      (repo) => poller.settingsFor(repo).requiredCheckPrefixes ?? []),
    repos: () => poller.repoToggleList(),
    // cost actuals import (cost explorer phase 2) — rows land in SQLite and
    // surface through the metrics costActuals section
    costActuals: {
      upsert: (rows) => {
        for (const r of rows) history.upsertCostActual(r.scope, r.date, r.dollars, r.source);
      },
    },
    webhooks: webhookSecret != null ? {
      path: config.webhooks.path,
      secret: webhookSecret,
      nudge: (route) => poller.nudge(route),
    } : undefined,
    // ready+auto-merge write-action — routed to the PR owner's installation
    // client (App mode) or the single shared client (gh/env).
    prActions: {
      readyAndAutoMerge: (input) => {
        const client = router.clientFor(input.owner);
        if (!client) {
          return Promise.reject(new Error(`no installation covers ${input.owner}`));
        }
        return readyAndAutoMerge(client, input);
      },
    },
    // Demotion scaffold draft-PR — routed to the repo owner's installation
    // client (App mode) or the single shared client (gh/env).
    demotionAction: {
      draftPr: (input) => {
        const client = router.clientFor(input.owner);
        if (!client) {
          return Promise.reject(new Error(`no installation covers ${input.owner}`));
        }
        return openDemotionDraftPr(client, input.owner, input.repo, input.candidate);
      },
    },
    // Runner-routing capability (feature/runner-routing) — the controller's
    // live state + plan, and a write path for the browser-writable config
    // subset. The endpoints that consume this are a later task.
    runnerRouting: {
      state: () => routing.getState(),
      plan: () => routing.getPlan(),
      applyConfig: (patch) => {
        // Persist ONLY the writable subset (enabled, shedThresholdMinutes,
        // overrides). writeRunnerRoutingPatch does the nested merge so file-only
        // keys (targetRepo, reclaimWindow) survive; the controller reads the
        // live `config` ref, so reconfigure(next) hot-applies without a restart.
        const next = writeRunnerRoutingPatch(cfgPath, {
          enabled: typeof patch.enabled === 'boolean' ? patch.enabled : undefined,
          shedThresholdMinutes: typeof patch.shedThresholdMinutes === 'number'
            ? patch.shedThresholdMinutes : undefined,
          overrides: patch.overrides as Record<string, 'spot' | 'ondemand'> | undefined,
        });
        if (next.owners.length === 0) next.owners = config.owners;
        config = next;
        poller.reconfigure(next);
      },
    },
    restart: {},
  });
  // One listener per bind host (default loopback only; add a Tailscale IP to
  // reach the dashboard across the tailnet). A non-loopback bind that fails
  // (e.g. tailscaled not up yet) is logged and skipped so loopback still serves.
  const isLoopback = (h: string) => h === '127.0.0.1' || h === '::1' || h === 'localhost';
  for (const host of config.bindHosts) {
    const server = app.listen(config.port, host, () => {
      console.log(`pr-dashboard on http://${host}:${config.port}`);
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
      console.error(`[bind] could not listen on ${host}:${config.port} — ${e.message}`);
      if (isLoopback(host)) process.exit(1); // loopback is essential
    });
  }
  if (webhookSecret != null) {
    console.log(`[webhooks] receiver enabled at POST ${config.webhooks.path} (loopback — use a tunnel for ingress)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
