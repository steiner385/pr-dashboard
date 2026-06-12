import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveOwners, writeConfigPatch, configFileSources,
  type AppConfig, type InstallationAccountsSource, type ViewerClient } from './config';
import { createTokenSource, AppJwtSigner, InstallationRegistry, type TokenProvider } from './auth';
import { GithubClient } from './github';
import { ClientRouter } from './client-router';
import { HistoryStore } from './history';
import { DeployWatcher } from './deploy-watcher';
import { Poller, describeError } from './poller';
import { backfillRepo } from './backfill';
import { computeMetrics } from './metrics';
import { createApp } from './api';
import { loadWebhookSecret } from './webhooks';
import { dataDir, staticDir, configPath } from './paths';

/** Re-list the App's installations this often (new installs appear without a restart). */
const REGISTRY_REFRESH_MS = 24 * 3600_000;

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
  const poller = new Poller({ router, history, deploy, config });
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
        poller.rollupWorkflowFor(repo))
        .catch((e) => console.warn(`backfill ${repo}: ${e}`));
    }
    history.setMeta('backfilled', new Date().toISOString());
  }

  poller.start();
  const cfgPath = configPath();
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
    metrics: (window, bucket) => computeMetrics(history, window, bucket),
    webhooks: webhookSecret != null ? {
      path: config.webhooks.path,
      secret: webhookSecret,
      nudge: (route) => poller.nudge(route),
    } : undefined,
    restart: {},
  });
  app.listen(config.port, '127.0.0.1', () => {
    console.log(`pr-dashboard on http://127.0.0.1:${config.port}`);
    if (webhookSecret != null) {
      console.log(`[webhooks] receiver enabled at POST ${config.webhooks.path} (loopback — use a tunnel for ingress)`);
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
