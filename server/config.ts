import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath, resolveUserPath } from './paths';
import { buildViewerQuery } from './queries';
import { DEFAULT_NOTIFICATIONS, NOTIFICATION_EVENT_TYPES, type NotificationsConfig } from './notifier';
import type { RepoFileConfig } from './repo-config';

export interface EnvConfig {
  name: 'qa' | 'prod';
  healthUrl: string;
  auto: boolean;
  /** JSON key in the /health payload that carries the deployed commit sha. */
  shaKey: string;
}
export interface DeployConfig {
  environments: EnvConfig[];
  /** Git URL for the local bare clone. Used only when `ancestrySource` is
   *  'clone' (or as the fallback target of a pre-existing clone in 'api' mode);
   *  optional in user config — defaults to the repo's GitHub URL. */
  cloneUrl: string;
  defaultBranch: string;
}
export interface RepoConfig {
  /** A check whose canonical name starts with any of these prefixes is treated as
   *  required even before GitHub marks it isRequired. Needed for repos whose single
   *  required check (e.g. a `ci` rollup) materializes near the end of the run —
   *  mid-run every check reads isRequired:false, so advisory checks would pollute
   *  progress % and an advisory FAILURE would falsely park the PR.
   *  Omitted → ci.yml-derived prefixes; explicit [] disables prefixes entirely. */
  requiredCheckPrefixes?: string[];
  /** The rollup job id in the workflow whose needs-closure defines required checks. */
  rollupJobId?: string;
  /** Workflow file (repo-relative) to derive required-check prefixes from. */
  workflowPath?: string;
  /** Merge-queue batch size for this repo (defaults to the global batchSize). */
  batchSize?: number;
}
/** One pool's cost-explorer metadata (file-only `poolMeta` map). */
export interface PoolMetaEntry {
  /** Display-only instance type for the pool ('m7a.2xlarge spot'). */
  instanceType?: string;
  /** $ per runner-minute — takes precedence over costPerMinute[pool]. */
  dollarsPerMinute?: number;
  /** Bin-packing divisor (ARC/Kubernetes pools): when N runner pods share one
   *  node, pricing each job-minute at the NODE's $/min overstates spend N×.
   *  The effective rate for the label is divided by this (label's own entry,
   *  else the 'default' entry's, else 1). Must be ≥ 1; fractional values are
   *  allowed (average packing density). */
  podsPerNode?: number;
  /** Operator free-text (rendered as a tooltip where the pool appears). */
  note?: string;
}

/**
 * Effective $/runner-minute for a pool label, across both rate sources.
 * Precedence per label: poolMeta[pool].dollarsPerMinute > costPerMinute[pool];
 * then the same pair for the 'default' key. The winning rate is divided by
 * podsPerNode (label's entry, else 'default''s, else 1) — N runner pods
 * bin-packed onto one node each cost 1/N of the node's rate. Null = unpriced
 * (callers keep $ figures null).
 */
export function poolRate(pool: string,
  costPerMinute: Record<string, number> | null,
  poolMeta: Record<string, PoolMetaEntry> | null): number | null {
  const base = poolMeta?.[pool]?.dollarsPerMinute
    ?? costPerMinute?.[pool]
    ?? poolMeta?.['default']?.dollarsPerMinute
    ?? costPerMinute?.['default']
    ?? null;
  if (base == null) return null;
  return base / (poolMeta?.[pool]?.podsPerNode ?? poolMeta?.['default']?.podsPerNode ?? 1);
}

/**
 * Empirically-derived fully-loaded $/runner-minute (issue #100 — cost auto-rate):
 * the window's fleet actual bill divided by the window's tracked EC2-fleet
 * runner-minutes. A single blended rate that spreads idle/boot/teardown across
 * job-minutes. Null when there's no usable denominator (no minutes yet) or
 * either side isn't a finite number — callers then fall back to the static
 * `poolRate`, never crash. A zero bill is an honest $0/min (not null).
 */
export function empiricalRate(fleetDollars: number, trackedMinutes: number): number | null {
  if (!Number.isFinite(fleetDollars) || !Number.isFinite(trackedMinutes)) return null;
  if (trackedMinutes <= 0) return null;
  return fleetDollars / trackedMinutes;
}

/** Whether ANY $/minute rate is configured (costPerMinute present, or any
 *  poolMeta entry carries dollarsPerMinute) — when false, every dollar figure
 *  must be null (minutes-only mode), never fabricated zeroes. */
export function hasAnyRate(costPerMinute: Record<string, number> | null,
  poolMeta: Record<string, PoolMetaEntry> | null): boolean {
  return costPerMinute != null
    || Object.values(poolMeta ?? {}).some((m) => m.dollarsPerMinute !== undefined);
}

/** GitHub App auth block (tokenSource 'app'). File-only — never PUT-writable. */
export interface AppAuthConfig {
  /** Numeric GitHub App id (App settings → "App ID"). */
  appId: number;
  /** Path to the App's PEM private key (~/ and package-root-relative supported). */
  privateKeyPath: string;
  /** Installation to mint tokens for; auto-discovered when exactly one exists. */
  installationId?: number;
}

/** Optional webhook receiver (file-only — never PUT-writable). */
export interface WebhooksConfig {
  /** Master switch; the POST endpoint is mounted only when true. */
  enabled: boolean;
  /** Path to the shared webhook secret file (written by `pnpm app:setup`).
   *  Required when enabled; ~/ and package-root-relative supported. */
  secretPath?: string;
  /** URL path the receiver mounts at (must start with '/'). */
  path: string;
}

export interface AppConfig {
  owners: string[];
  exclude: string[];
  port: number;
  /** Interface addresses the server binds (one listener each). Default
   *  `['127.0.0.1']` (loopback only). Add a Tailscale IP to reach the dashboard
   *  from other tailnet devices; a non-loopback bind that fails (e.g. Tailscale
   *  not up yet) is logged and skipped — loopback always comes up. File-only. */
  bindHosts: string[];
  /** Extra Origin hostnames the mutating-endpoint same-origin guard accepts in
   *  addition to 127.0.0.1/localhost and `bindHosts` — e.g. a Tailscale MagicDNS
   *  name (`host.tailnet.ts.net`) when the UI is reached by name, not IP. */
  allowedOriginHosts: string[];
  retentionDays: number;
  batchSize: number;
  /** Where the GitHub token comes from: 'gh' = gh CLI keyring, 'env' = GITHUB_TOKEN,
   *  'app' = GitHub App installation tokens (requires the `app` block). */
  tokenSource: 'gh' | 'env' | 'app';
  /** GitHub App credentials — required (and validated) when tokenSource === 'app'. */
  app?: AppAuthConfig;
  /** GitHub GraphQL endpoint (override for GitHub Enterprise). */
  apiUrl: string;
  /** Remaining rate-limit budget below which polling degrades to slow intervals. */
  rateLimitFloor: number;
  /** Optional signed webhook receiver — out-of-band poller nudges. */
  webhooks: WebhooksConfig;
  /** How deploy ancestry ("is this merge commit contained in the deployed
   *  sha?") is answered: 'api' (default) = GitHub compare API, no local clones;
   *  'clone' = local bare clones in data/clones/ (the pre-#18 mechanism).
   *  In 'api' mode clones are never created; a pre-existing clone is used as a
   *  best-effort fallback when the compare API fails transport-wise. */
  ancestrySource: 'api' | 'clone';
  /** Desktop/browser notifications for alert-worthy transitions (issue #19).
   *  File-only — never PUT-writable (the command template execs on the host). */
  notifications: NotificationsConfig;
  /** Hostname allowlist for IN-REPO (`.pr-dashboard.yml`-sourced) deploy URLs:
   *  exact match or `*.suffix` wildcard (subdomains only — list the apex
   *  separately). Unset → no filtering. Instance-config deploy entries are
   *  exempt (the operator wrote them). File-only — never PUT-writable. */
  deployUrlAllowlist?: string[];
  /** CI cost attribution (issue #43): runner-pool label → $ per runner-minute.
   *  Composite labels ('a|b' runs-on ternaries) and 'unknown' may be listed
   *  explicitly; the 'default' key prices everything unlisted. Absent → the
   *  CI cost panel reports minutes only. File-only — never PUT-writable
   *  (money figures must come from the operator's file, not the browser). */
  costPerMinute?: Record<string, number>;
  /** Cost explorer: per-pool metadata — instance type (display), optional
   *  $/runner-minute (SUPERSEDES the flat costPerMinute entry for the same
   *  label), and a free-text note. The 'default' key participates in rate
   *  fallback exactly like costPerMinute's. File-only — never PUT-writable
   *  (money figures must come from the operator's file, not the browser). */
  poolMeta?: Record<string, PoolMetaEntry>;
  /** Cost auto-rate (issue #100): when true, NON-github-hosted runner-minutes
   *  are priced at the empirically-derived fully-loaded rate (fleet actuals ÷
   *  tracked EC2 runner-minutes over the cost window) instead of the static
   *  per-pool `poolRate`. Self-correcting from imported actuals; falls back to
   *  the static rate when no fleet actuals exist yet. Default false (opt-in) —
   *  the static-rate behavior is unchanged when off. File-only. */
  costAutoRate: boolean;
  deploy: Record<string, DeployConfig>;
  repos?: Record<string, RepoConfig>;
  intervals: { sweepMs: number; hotMs: number; deployMs: number };
  /** INTERNAL — set by loadConfig, never user-written: whether intervals.hotMs
   *  was explicitly present in the config file. The webhook hot-interval relax
   *  (×4) is skipped when the operator pinned hotMs themselves. */
  hotMsExplicit: boolean;
}

export const DEFAULTS: AppConfig = {
  owners: [],
  exclude: [],
  port: 4400,
  bindHosts: ['127.0.0.1'],
  allowedOriginHosts: [],
  retentionDays: 7,
  batchSize: 6,
  tokenSource: 'gh',
  apiUrl: 'https://api.github.com/graphql',
  rateLimitFloor: 1000,
  ancestrySource: 'api',
  notifications: DEFAULT_NOTIFICATIONS,
  webhooks: { enabled: false, path: '/api/webhooks/github' },
  costAutoRate: false,
  deploy: {},
  repos: {},
  intervals: { sweepMs: 60_000, hotMs: 15_000, deployMs: 30_000 },
  hotMsExplicit: false,
};

/** Internal AppConfig keys that are not config-file fields (excluded from sources). */
const INTERNAL_CONFIG_KEYS = new Set(['hotMsExplicit']);

/** Per-repo settings with all defaults applied. */
export interface RepoSettings {
  requiredCheckPrefixes?: string[];
  rollupJobId: string;
  workflowPath: string;
  batchSize: number;
}

/**
 * Per-repo settings with the in-repo `.pr-dashboard.yml` layer applied.
 * Field-level precedence: instance config `repos.*` override > in-repo file >
 * defaults. (The derived layer — ci.yml prefixes — sits between in-repo and
 * defaults for requiredCheckPrefixes only, and is applied by the poller.)
 */
export function effectiveRepoSettings(
  repo: string, config: AppConfig, fileCfg?: RepoFileConfig | null,
): RepoSettings {
  const rc = config.repos?.[repo] ?? {};
  return {
    requiredCheckPrefixes: rc.requiredCheckPrefixes ?? fileCfg?.requiredCheckPrefixes,
    rollupJobId: rc.rollupJobId ?? fileCfg?.rollupJobId ?? 'ci',
    workflowPath: rc.workflowPath ?? fileCfg?.workflowPath ?? '.github/workflows/ci.yml',
    batchSize: rc.batchSize ?? fileCfg?.batchSize ?? config.batchSize,
  };
}

/** Instance-config-only repo settings (no in-repo layer). */
export function repoSettings(config: AppConfig, repo: string): RepoSettings {
  return effectiveRepoSettings(repo, config);
}

/** Hostname of a deploy URL: standard URLs via URL, scp-like git remotes
 *  (`git@host:owner/repo.git`) via pattern match. Null when underivable. */
function deployUrlHost(url: string): string | null {
  try { return new URL(url).hostname; } catch { /* not a standard URL */ }
  const scp = /^(?:[^@/]+@)?([^:/]+):/.exec(url);
  return scp ? scp[1]!.toLowerCase() : null;
}

/** Exact hostname match, or `*.suffix` wildcard (subdomains only). */
function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  return p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p;
}

/** Warn once per (repo, offending URL) — the merge runs on every poller tick. */
const warnedDeployDrops = new Set<string>();
/** Test hook: clear the once-logged warning memory. */
export function _resetDeployAllowlistWarnings(): void { warnedDeployDrops.clear(); }

/**
 * deployUrlAllowlist enforcement for IN-REPO deploy entries: every URL the
 * entry would make this instance touch (cloneUrl = `git fetch` target,
 * healthUrls = polled endpoints) must have an allowlisted host, or the whole
 * entry is dropped with a once-logged warning. A host that cannot be derived
 * fails closed. With ancestrySource 'api' the instance never touches the
 * cloneUrl (no clone is ever created), so only healthUrls are checked.
 */
function inRepoDeployAllowed(
  repo: string, dc: DeployConfig, allowlist: readonly string[],
  ancestrySource: AppConfig['ancestrySource'],
): boolean {
  const urls = ancestrySource === 'clone'
    ? [dc.cloneUrl, ...dc.environments.map((e) => e.healthUrl)]
    : dc.environments.map((e) => e.healthUrl);
  for (const url of urls) {
    const host = deployUrlHost(url);
    if (host !== null && allowlist.some((p) => hostMatches(host, p))) continue;
    const key = `${repo}|${url}`;
    if (!warnedDeployDrops.has(key)) {
      warnedDeployDrops.add(key);
      console.warn(`[config] deployUrlAllowlist: dropping in-repo deploy entry for ${repo} — `
        + `host of ${url} is not allowlisted`);
    }
    return false;
  }
  return true;
}

/**
 * Effective deploy map: instance config `deploy.*` entries override (whole-entry,
 * not field-merged) in-repo file deploy blocks. A repo can BECOME a deploy repo
 * via its `.pr-dashboard.yml` — but an instance entry always wins, so e.g. a
 * config.json deploy block stays `override`-sourced no matter what the repo ships.
 * When `deployUrlAllowlist` is set, in-repo entries must pass it; instance
 * entries are exempt (and skip the check entirely when they shadow a file entry).
 */
export function effectiveDeployMap(
  config: AppConfig, fileCfgs: ReadonlyMap<string, RepoFileConfig>,
): Record<string, DeployConfig> {
  const map: Record<string, DeployConfig> = {};
  const allowlist = config.deployUrlAllowlist;
  for (const [repo, fc] of fileCfgs) {
    if (!fc.deploy) continue;
    if (repo in config.deploy) continue; // shadowed by the override below — never takes effect
    if (allowlist && !inRepoDeployAllowed(repo, fc.deploy, allowlist, config.ancestrySource)) continue;
    map[repo] = fc.deploy;
  }
  for (const [repo, dc] of Object.entries(config.deploy)) map[repo] = dc;
  return map;
}

/** Minimal structural client — keeps config decoupled from GithubClient. */
export interface ViewerClient {
  graphql<T>(query: string): Promise<T>;
}

/** Minimal structural registry — keeps config decoupled from InstallationRegistry. */
export interface InstallationAccountsSource {
  accounts(): { login: string }[];
}

/**
 * Owners fallback: when no owners are configured, derive them — mutating
 * `config.owners` in place. Configured owners always win; the source is never
 * consulted then.
 *
 * - App mode passes the installation registry: owners default to the accounts
 *   the App is installed on (every installation is watched).
 * - gh/env modes pass the GraphQL client: one `{ viewer { login } }` query —
 *   owners default to the token owner.
 */
export async function resolveOwners(
  config: AppConfig, source: ViewerClient | InstallationAccountsSource,
): Promise<void> {
  if (config.owners.length > 0) return;
  if ('accounts' in source) {
    const logins = source.accounts().map((a) => a.login);
    if (logins.length === 0) {
      throw new Error('owners auto-derivation: the App has no installation accounts');
    }
    config.owners = logins;
    console.log(`[config] no owners configured — defaulting to installation accounts: ${logins.join(', ')}`);
    return;
  }
  const data = await source.graphql<{ viewer: { login: string } }>(buildViewerQuery());
  const login = data?.viewer?.login;
  if (!login) throw new Error('owners auto-derivation: viewer query returned no login');
  config.owners = [login];
  console.log(`[config] no owners configured — defaulting to token owner '${login}'`);
}

/** Fill cloneUrl/defaultBranch defaults and validate/normalize environments. */
function normalizeDeployConfig(repo: string, dc: Partial<DeployConfig>): DeployConfig {
  const environments = (dc.environments ?? []).map((env): EnvConfig => {
    const name = String(env.name ?? '').toLowerCase() as EnvConfig['name'];
    if (name !== 'qa' && name !== 'prod') {
      throw new Error(
        `config: deploy["${repo}"] environment name must be "qa" or "prod" (got "${String(env.name)}")`);
    }
    if (!env.healthUrl) {
      throw new Error(`config: deploy["${repo}"] environment "${name}" is missing healthUrl`);
    }
    return { name, healthUrl: env.healthUrl, auto: env.auto ?? name === 'qa', shaKey: env.shaKey ?? 'commitSha' };
  });
  return {
    cloneUrl: dc.cloneUrl ?? `https://github.com/${repo}.git`,
    defaultBranch: dc.defaultBranch ?? 'main',
    environments,
  };
}

// ---- config API (Z2): safe-subset writes ------------------------------------

/**
 * The ONLY keys PUT /api/config may write. Everything else — most importantly
 * tokenSource/apiUrl/app (token-touching), port, deploy/repos, and the
 * round-8 security keys (webhooks, deployUrlAllowlist) — is file-only:
 * validateConfigPatch rejects every key outside this list, so new config
 * fields are forbidden-by-default. The server-side validation below is the
 * security boundary, not the UI.
 *
 * `notifications` is a NARROW carve-out: only `{ enabled }` is writable — it
 * merely flips the pre-configured command/webhook sinks on/off (no injection
 * surface). `command`/`events`/`webhookUrl` (often token-bearing)/`digest`/
 * anything else inside the block stay file-only and are rejected as
 * `notifications.<key>` offendingKeys.
 */
export const SAFE_CONFIG_KEYS = ['owners', 'exclude', 'retentionDays', 'batchSize', 'intervals', 'notifications'] as const;
export type SafeConfigKey = (typeof SAFE_CONFIG_KEYS)[number];

/** Instance-config keys surfaced read-only in the UI (file-only for security).
 *  `notifications` is not listed: its `enabled` flag is PUT-writable (see the
 *  SAFE_CONFIG_KEYS carve-out); the rest of the block remains file-only. */
export const READ_ONLY_CONFIG_KEYS = ['tokenSource', 'apiUrl', 'port', 'app', 'ancestrySource', 'costPerMinute', 'poolMeta'] as const;

const INTERVAL_KEYS = ['sweepMs', 'hotMs', 'deployMs'] as const;

/** A validated safe-subset patch (every field optional; intervals may be partial). */
export interface ConfigPatch {
  owners?: string[];
  exclude?: string[];
  retentionDays?: number;
  batchSize?: number;
  intervals?: Partial<AppConfig['intervals']>;
  /** Carve-out: enabled is the ONLY writable notifications sub-key. */
  notifications?: { enabled: boolean };
}

export type ConfigPatchValidation =
  | { ok: true; patch: ConfigPatch }
  | { ok: false; offendingKeys: string[]; fieldErrors: Record<string, string> };

/**
 * Validate a PUT /api/config body. Unknown keys AND forbidden keys (tokenSource,
 * apiUrl, port, deploy, repos, …) are rejected together via `offendingKeys`;
 * type problems on allowed keys land in `fieldErrors`. Normalization mirrors
 * loadConfig: the accepted patch round-trips through the config file unchanged.
 */
export function validateConfigPatch(body: unknown): ConfigPatchValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, offendingKeys: [], fieldErrors: { body: 'must be a JSON object' } };
  }
  const raw = body as Record<string, unknown>;
  const offendingKeys = Object.keys(raw)
    .filter((k) => !(SAFE_CONFIG_KEYS as readonly string[]).includes(k));
  const fieldErrors: Record<string, string> = {};
  const patch: ConfigPatch = {};

  for (const key of ['owners', 'exclude'] as const) {
    if (raw[key] === undefined) continue;
    const v = raw[key];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s.trim())) {
      fieldErrors[key] = 'must be an array of non-empty strings';
    } else if (key === 'owners' && v.length === 0) {
      // an empty owners list would silently break the sweep query
      fieldErrors[key] = 'must contain at least one owner';
    } else if (key === 'owners' && (v as string[]).some((s) => !/^[A-Za-z0-9-]+$/.test(s.trim()))) {
      // owners are interpolated into GraphQL search strings; reject non-GitHub-handle chars
      fieldErrors[key] = 'each owner must contain only letters, digits, and hyphens';
    } else {
      patch[key] = (v as string[]).map((s) => s.trim());
    }
  }
  if (raw.retentionDays !== undefined) {
    const v = raw.retentionDays;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
      fieldErrors.retentionDays = 'must be a number ≥ 1';
    } else patch.retentionDays = v;
  }
  if (raw.batchSize !== undefined) {
    const v = raw.batchSize;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      fieldErrors.batchSize = 'must be a positive integer';
    } else patch.batchSize = v;
  }
  if (raw.intervals !== undefined) {
    const v = raw.intervals;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      fieldErrors.intervals = 'must be an object';
    } else {
      const iv = v as Record<string, unknown>;
      const intervals: Partial<AppConfig['intervals']> = {};
      for (const k of Object.keys(iv)) {
        if (!(INTERVAL_KEYS as readonly string[]).includes(k)) {
          fieldErrors[`intervals.${k}`] = `unknown interval (allowed: ${INTERVAL_KEYS.join(', ')})`;
          continue;
        }
        const ms = iv[k];
        if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1000) {
          fieldErrors[`intervals.${k}`] = 'must be an integer ≥ 1000 (milliseconds)';
        } else intervals[k as (typeof INTERVAL_KEYS)[number]] = ms;
      }
      if (Object.keys(intervals).length) patch.intervals = intervals;
    }
  }
  if (raw.notifications !== undefined) {
    const v = raw.notifications;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      fieldErrors.notifications = 'must be an object';
    } else {
      const nv = v as Record<string, unknown>;
      // carve-out boundary: enabled only flips the pre-configured command on/off;
      // command (the injection surface), events, and any future sub-key are
      // file-only and rejected exactly like top-level forbidden keys
      const forbidden = Object.keys(nv).filter((k) => k !== 'enabled');
      offendingKeys.push(...forbidden.map((k) => `notifications.${k}`));
      if (nv.enabled === undefined) {
        if (forbidden.length === 0) {
          fieldErrors['notifications.enabled'] = 'is required (the only writable notifications key)';
        }
      } else if (typeof nv.enabled !== 'boolean') {
        fieldErrors['notifications.enabled'] = 'must be a boolean';
      } else {
        patch.notifications = { enabled: nv.enabled };
      }
    }
  }

  if (offendingKeys.length || Object.keys(fieldErrors).length) {
    return { ok: false, offendingKeys, fieldErrors };
  }
  return { ok: true, patch };
}

/**
 * Read-modify-write the config file: parse the existing JSON, replace ONLY the
 * safe-subset keys carried by the patch (intervals merge key-wise), and keep
 * every other field byte-meaning-identical — deploy/repos/tokenSource and any
 * hand-written extras survive verbatim (re-serialized with 2-space indent).
 * Creates the file (and parent directory) when none exists yet.
 * Returns the re-loaded AppConfig so callers hot-apply exactly what persisted.
 */
export function writeConfigPatch(path: string, patch: ConfigPatch): AppConfig {
  const existing: Record<string, unknown> = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : {};
  const next: Record<string, unknown> = { ...existing };
  // nested partials merge key-wise into the existing block — a PUT carrying
  // intervals.{sweepMs} or notifications.{enabled} must not clobber siblings
  // (hotMs / the file-only command+events)
  const NESTED: ReadonlySet<SafeConfigKey> = new Set(['intervals', 'notifications'] as const);
  for (const key of SAFE_CONFIG_KEYS) {
    if (patch[key] === undefined) continue;
    next[key] = NESTED.has(key)
      ? { ...(typeof existing[key] === 'object' && existing[key] ? existing[key] as object : {}),
          ...patch[key] as object }
      : patch[key];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return loadConfig(path);
}

/** Per-key attribution for the instance config: set in the file vs default. */
export function configFileSources(path: string): Record<string, 'default' | 'file'> {
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(path)) existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // unreadable/corrupt file → everything reads as default
  }
  return Object.fromEntries(
    Object.keys(DEFAULTS)
      .filter((k) => !INTERNAL_CONFIG_KEYS.has(k))
      .map((k) => [k, k in existing ? 'file' : 'default']));
}

export function loadConfig(path?: string): AppConfig {
  const resolvedPath = path ?? configPath();
  const user: Partial<AppConfig> = existsSync(resolvedPath)
    ? (JSON.parse(readFileSync(resolvedPath, 'utf8')) as Partial<AppConfig>)
    : {};
  const merged: AppConfig = {
    ...DEFAULTS, ...user,
    intervals: { ...DEFAULTS.intervals, ...(user.intervals ?? {}) },
    deploy: { ...DEFAULTS.deploy, ...(user.deploy ?? {}) },
    repos: { ...DEFAULTS.repos, ...(user.repos ?? {}) },
    webhooks: { ...DEFAULTS.webhooks, ...(user.webhooks ?? {}) },
    notifications: { ...DEFAULTS.notifications, ...(user.notifications ?? {}),
      events: { ...DEFAULTS.notifications.events, ...(user.notifications?.events ?? {}) },
      digest: { ...DEFAULTS.notifications.digest, ...(user.notifications?.digest ?? {}) } },
    // internal, never honored from the file: derived from what the file actually set
    hotMsExplicit: user.intervals?.hotMs !== undefined,
  };
  // bindHosts / allowedOriginHosts: coerce to clean string arrays; bindHosts
  // must be non-empty (always serve loopback) — a bad/empty value falls back.
  const cleanHosts = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string' && h.trim().length > 0) : [];
  merged.bindHosts = cleanHosts(merged.bindHosts).length ? cleanHosts(merged.bindHosts) : ['127.0.0.1'];
  merged.allowedOriginHosts = cleanHosts(merged.allowedOriginHosts);
  // cost auto-rate (issue #100): a plain opt-in flag — coerce any truthy value
  // to a real boolean so a `1`/`"yes"` in the file can't leak a non-boolean into
  // the cost engine; missing/falsy → false (default behavior is the static rate).
  merged.costAutoRate = Boolean(merged.costAutoRate);
  if (merged.tokenSource !== 'gh' && merged.tokenSource !== 'env' && merged.tokenSource !== 'app') {
    throw new Error(`config: tokenSource must be "gh", "env", or "app" (got "${String(merged.tokenSource)}")`);
  }
  if (merged.ancestrySource !== 'api' && merged.ancestrySource !== 'clone') {
    throw new Error(`config: ancestrySource must be "api" or "clone" (got "${String(merged.ancestrySource)}")`);
  }
  if (merged.tokenSource === 'app') {
    const a = merged.app;
    if (!a || typeof a !== 'object') {
      throw new Error('config: tokenSource "app" requires an "app" block ({ appId, privateKeyPath })');
    }
    if (typeof a.appId !== 'number' || !Number.isInteger(a.appId) || a.appId < 1) {
      throw new Error(`config: app.appId must be a positive integer (got ${JSON.stringify(a.appId)})`);
    }
    if (typeof a.privateKeyPath !== 'string' || !a.privateKeyPath.trim()) {
      throw new Error('config: app.privateKeyPath must be a non-empty path to the App\'s PEM key');
    }
    if (a.installationId !== undefined
        && (typeof a.installationId !== 'number' || !Number.isInteger(a.installationId) || a.installationId < 1)) {
      throw new Error(`config: app.installationId must be a positive integer (got ${JSON.stringify(a.installationId)})`);
    }
    // resolved like other runtime paths (~/ → home, relative → package root);
    // file existence is checked by AppTokenSource at startup, with a clear error
    merged.app = { ...a, privateKeyPath: resolveUserPath(a.privateKeyPath) };
  }
  const w = merged.webhooks;
  if (typeof w.enabled !== 'boolean') {
    throw new Error(`config: webhooks.enabled must be a boolean (got ${JSON.stringify(w.enabled)})`);
  }
  if (typeof w.path !== 'string' || !w.path.startsWith('/')) {
    throw new Error(`config: webhooks.path must start with "/" (got ${JSON.stringify(w.path)})`);
  }
  if (w.secretPath !== undefined) {
    if (typeof w.secretPath !== 'string' || !w.secretPath.trim()) {
      throw new Error('config: webhooks.secretPath must be a non-empty path to the shared secret file');
    }
    // readability is checked at startup (loadWebhookSecret), with a clear error
    merged.webhooks = { ...w, secretPath: resolveUserPath(w.secretPath) };
  } else if (w.enabled) {
    throw new Error('config: webhooks.enabled requires webhooks.secretPath '
      + '(written by `pnpm app:setup`, or point it at a file holding the shared secret)');
  }
  const n = merged.notifications;
  if (typeof n.enabled !== 'boolean') {
    throw new Error(`config: notifications.enabled must be a boolean (got ${JSON.stringify(n.enabled)})`);
  }
  if (!Array.isArray(n.command) || n.command.some((a) => typeof a !== 'string')) {
    throw new Error('config: notifications.command must be an array of strings '
      + '(argv template — {title}/{body} are substituted in arguments, never via a shell)');
  }
  if (n.enabled && n.command.length === 0 && n.webhookUrl === undefined) {
    throw new Error('config: notifications.enabled requires a non-empty notifications.command '
      + 'or a notifications.webhookUrl');
  }
  if (n.webhookUrl !== undefined) {
    // file-only (NOT in the PUT carve-out — the URL often carries a token);
    // must be an absolute http(s) URL so the sink's fetch can't be pointed at
    // file:/data: schemes by a typo
    if (typeof n.webhookUrl !== 'string' || !/^https?:\/\//.test(n.webhookUrl)) {
      throw new Error('config: notifications.webhookUrl must be an http(s):// URL '
        + `(got ${JSON.stringify(n.webhookUrl)})`);
    }
    try { new URL(n.webhookUrl); } catch {
      throw new Error(`config: notifications.webhookUrl is not a valid URL (got ${JSON.stringify(n.webhookUrl)})`);
    }
  }
  const dg = n.digest;
  if (typeof dg.enabled !== 'boolean') {
    throw new Error(`config: notifications.digest.enabled must be a boolean (got ${JSON.stringify(dg.enabled)})`);
  }
  if (typeof dg.hourLocal !== 'number' || !Number.isInteger(dg.hourLocal)
      || dg.hourLocal < 0 || dg.hourLocal > 23) {
    throw new Error('config: notifications.digest.hourLocal must be an integer 0–23 '
      + `(got ${JSON.stringify(dg.hourLocal)})`);
  }
  for (const [k, v] of Object.entries(n.events)) {
    if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(k)) {
      throw new Error(`config: notifications.events.${k} is not a known event type `
        + `(allowed: ${NOTIFICATION_EVENT_TYPES.join(', ')})`);
    }
    if (typeof v !== 'boolean') {
      throw new Error(`config: notifications.events.${k} must be a boolean (got ${JSON.stringify(v)})`);
    }
  }
  if (merged.deployUrlAllowlist !== undefined) {
    const list: unknown = merged.deployUrlAllowlist;
    if (!Array.isArray(list) || list.some((h) => typeof h !== 'string' || !h.trim())) {
      throw new Error('config: deployUrlAllowlist must be an array of non-empty hostnames '
        + '(exact or "*.suffix" wildcard)');
    }
    merged.deployUrlAllowlist = list.map((h: string) => h.trim().toLowerCase());
  }
  if (merged.costPerMinute !== undefined) {
    const cpm: unknown = merged.costPerMinute;
    if (!cpm || typeof cpm !== 'object' || Array.isArray(cpm)) {
      throw new Error('config: costPerMinute must be an object mapping pool labels to $/minute '
        + `(got ${JSON.stringify(cpm)})`);
    }
    for (const [pool, rate] of Object.entries(cpm)) {
      // zero is a legitimate statement (a free/self-owned pool); negatives and
      // non-finites are not money
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
        throw new Error(`config: costPerMinute["${pool}"] must be a finite number ≥ 0 `
          + `(got ${JSON.stringify(rate)})`);
      }
    }
  }
  if (merged.poolMeta !== undefined) {
    const pm: unknown = merged.poolMeta;
    if (!pm || typeof pm !== 'object' || Array.isArray(pm)) {
      throw new Error('config: poolMeta must be an object mapping pool labels to '
        + `{ instanceType?, dollarsPerMinute?, note? } (got ${JSON.stringify(pm)})`);
    }
    const POOL_META_KEYS = new Set(['instanceType', 'dollarsPerMinute', 'podsPerNode', 'note']);
    for (const [pool, entry] of Object.entries(pm)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`config: poolMeta["${pool}"] must be an object (got ${JSON.stringify(entry)})`);
      }
      const e = entry as Record<string, unknown>;
      // unknown sub-keys are typos waiting to silently not price a pool — reject
      const unknown = Object.keys(e).filter((k) => !POOL_META_KEYS.has(k));
      if (unknown.length) {
        throw new Error(`config: poolMeta["${pool}"] has unknown key(s) ${unknown.join(', ')} `
          + '(allowed: instanceType, dollarsPerMinute, podsPerNode, note)');
      }
      for (const k of ['instanceType', 'note'] as const) {
        if (e[k] !== undefined && (typeof e[k] !== 'string' || !(e[k] as string).trim())) {
          throw new Error(`config: poolMeta["${pool}"].${k} must be a non-empty string `
            + `(got ${JSON.stringify(e[k])})`);
        }
      }
      // zero is a legitimate statement (a free/self-owned pool), like costPerMinute
      const rate = e.dollarsPerMinute;
      if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) {
        throw new Error(`config: poolMeta["${pool}"].dollarsPerMinute must be a finite number ≥ 0 `
          + `(got ${JSON.stringify(rate)})`);
      }
      // < 1 would INFLATE the rate — that's a misread of the knob, reject it
      const pods = e.podsPerNode;
      if (pods !== undefined && (typeof pods !== 'number' || !Number.isFinite(pods) || pods < 1)) {
        throw new Error(`config: poolMeta["${pool}"].podsPerNode must be a finite number ≥ 1 `
          + `(got ${JSON.stringify(pods)})`);
      }
    }
  }
  merged.deploy = Object.fromEntries(
    Object.entries(merged.deploy).map(([repo, dc]) => [repo, normalizeDeployConfig(repo, dc)]),
  );
  return merged;
}
