/**
 * Pure pieces of the GitHub App manifest flow (`pnpm app:setup`).
 * Everything parseable/buildable lives here and is unit-tested; the
 * interactive HTTP glue stays thin in scripts/app-setup.ts.
 *
 * Flow: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

export interface ManifestOptions {
  /** App name shown on GitHub (editable on the create page; must be unique). */
  name: string;
  /** Homepage URL recorded on the App. */
  url: string;
  /** Localhost callback GitHub redirects to with ?code= after creation. */
  redirectUrl: string;
  /**
   * When set, registers an active webhook at this URL and adds `default_events`
   * + the `merge_queues: read` permission required for `merge_group` events.
   * When omitted the manifest is webhook-less (polling-primary default).
   */
  webhookUrl?: string;
}

export interface AppManifest {
  name: string;
  url: string;
  public: false;
  redirect_url: string;
  default_permissions: Record<string, 'read' | 'write'>;
  hook_attributes?: { url: string; active: true };
  default_events?: string[];
}

const WEBHOOK_EVENTS = ['check_run', 'check_suite', 'pull_request', 'workflow_run', 'merge_group'] as const;

/**
 * Build the App manifest: private App. Permissions are read-only except
 * `pull_requests: write` AND `contents: write`, which together back the one
 * write-action the dashboard offers — flip a draft PR ready-for-review and arm
 * auto-merge (pr-actions.ts). NOTE: `markPullRequestReadyForReview` and
 * `enablePullRequestAutoMerge` require `contents: write` (not just
 * pull_requests:write) because GitHub buckets them with operations that can
 * generate commits/merges — pull_requests:write alone returns FORBIDDEN
 * ("Resource not accessible by integration"). See cli/cli discussion #6924.
 * On an installation that predates these permissions, GitHub holds the upgrade
 * until the owner approves it (Settings → Applications); the action 403s with a
 * fix-it hint until then.
 *
 * By DEFAULT the manifest is webhook-less — no `default_events` and no
 * `hook_attributes`. GitHub rejects `default_events` without a hook URL, and
 * the `merge_group` event requires `merge_queues: read` which we must not
 * request unless we actually subscribe to it.
 *
 * Pass `opts.webhookUrl` to enable webhook delivery: adds `hook_attributes`,
 * `default_events`, and `merge_queues: read` to permissions.
 */
export function buildManifest(opts: ManifestOptions): AppManifest {
  const permissions: Record<string, 'read' | 'write'> = {
    checks: 'read',
    pull_requests: 'write', // mark-ready + enable-auto-merge (pr-actions.ts); read covers polling
    actions: 'read',
    contents: 'write', // REQUIRED by mark-ready + enable-auto-merge (GitHub buckets them with commit/merge ops); read covers ci.yml/clone reads
    metadata: 'read',
  };

  if (opts.webhookUrl) {
    permissions.merge_queues = 'read';
    return {
      name: opts.name,
      url: opts.url,
      public: false,
      redirect_url: opts.redirectUrl,
      default_permissions: permissions,
      hook_attributes: { url: opts.webhookUrl, active: true },
      default_events: [...WEBHOOK_EVENTS],
    };
  }

  return {
    name: opts.name,
    url: opts.url,
    public: false,
    redirect_url: opts.redirectUrl,
    default_permissions: permissions,
  };
}

/** Web (browser) base for the manifest create page, derived from the GraphQL apiUrl. */
export function webBaseFromApiUrl(apiUrl: string): string {
  const u = new URL(apiUrl);
  if (u.hostname === 'api.github.com') return 'https://github.com';
  return `${u.protocol}//${u.host}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Minimal HTML page that auto-POSTs the manifest to GitHub's
 * `…/settings/apps/new` endpoint (the manifest flow requires a form POST,
 * not a link). Served once by the local one-shot listener.
 */
export function buildManifestPostPage(manifest: AppManifest, createUrl: string): string {
  const value = escapeHtml(JSON.stringify(manifest));
  return `<!doctype html>
<meta charset="utf-8">
<title>pr-dashboard — create GitHub App</title>
<p>Redirecting to GitHub to create the <strong>${escapeHtml(manifest.name)}</strong> App…</p>
<form id="m" action="${escapeHtml(createUrl)}" method="post">
  <input type="hidden" name="manifest" value="${value}">
  <noscript><button type="submit">Create GitHub App</button></noscript>
</form>
<script>document.getElementById('m').submit()</script>
`;
}

/** Validated result of `POST /app-manifests/{code}/conversions`. */
export interface AppConversion {
  id: number;
  slug: string;
  pem: string;
  webhookSecret: string | null;
  htmlUrl: string;
}

export function parseConversion(json: unknown): AppConversion {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('app-manifest conversion: response is not a JSON object');
  }
  const r = json as Record<string, unknown>;
  if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id < 1) {
    throw new Error('app-manifest conversion: missing/invalid "id"');
  }
  if (typeof r.slug !== 'string' || !r.slug) {
    throw new Error('app-manifest conversion: missing/invalid "slug"');
  }
  if (typeof r.pem !== 'string' || !r.pem.includes('PRIVATE KEY')) {
    throw new Error('app-manifest conversion: missing/invalid "pem"');
  }
  if (typeof r.html_url !== 'string' || !r.html_url) {
    throw new Error('app-manifest conversion: missing/invalid "html_url"');
  }
  const webhookSecret = typeof r.webhook_secret === 'string' && r.webhook_secret
    ? r.webhook_secret : null;
  return { id: r.id, slug: r.slug, pem: r.pem, webhookSecret, htmlUrl: r.html_url };
}

/**
 * Pure config-file patch for the setup script's read-modify-write: switch
 * tokenSource to 'app' and set the app block, preserving every other key
 * (and a previously chosen app.installationId) verbatim.
 */
export function applyAppToConfig(
  existing: Record<string, unknown>,
  app: { appId: number; privateKeyPath: string },
): Record<string, unknown> {
  const prior = existing.app && typeof existing.app === 'object' && !Array.isArray(existing.app)
    ? (existing.app as Record<string, unknown>) : {};
  return {
    ...existing,
    tokenSource: 'app',
    app: { ...prior, appId: app.appId, privateKeyPath: app.privateKeyPath },
  };
}
