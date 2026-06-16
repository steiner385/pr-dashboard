import { describe, it, expect } from 'vitest';
import {
  buildManifest, buildManifestPostPage, parseConversion, applyAppToConfig, webBaseFromApiUrl,
} from '../app-manifest';

describe('buildManifest', () => {
  const opts = {
    name: 'pr-dashboard',
    url: 'http://127.0.0.1:4400',
    redirectUrl: 'http://127.0.0.1:51234/callback',
  };

  it('default (no webhookUrl): builds a webhook-less manifest — no default_events, no hook_attributes', () => {
    const m = buildManifest(opts);
    expect(m).toEqual({
      name: 'pr-dashboard',
      url: 'http://127.0.0.1:4400',
      public: false,
      redirect_url: 'http://127.0.0.1:51234/callback',
      default_permissions: {
        checks: 'read',
        pull_requests: 'write',
        actions: 'read',
        contents: 'write',
        metadata: 'read',
      },
    });
  });

  it('default: omits hook_attributes key entirely', () => {
    expect('hook_attributes' in buildManifest(opts)).toBe(false);
  });

  it('default: omits default_events key entirely', () => {
    expect('default_events' in buildManifest(opts)).toBe(false);
  });

  it('webhookUrl variant: includes hook_attributes, default_events, and merge_queues:read permission', () => {
    const m = buildManifest({ ...opts, webhookUrl: 'https://example.com/webhook' });
    expect(m).toEqual({
      name: 'pr-dashboard',
      url: 'http://127.0.0.1:4400',
      public: false,
      redirect_url: 'http://127.0.0.1:51234/callback',
      default_permissions: {
        checks: 'read',
        pull_requests: 'write',
        actions: 'read',
        contents: 'write',
        metadata: 'read',
        merge_queues: 'read',
      },
      hook_attributes: { url: 'https://example.com/webhook', active: true },
      default_events: ['check_run', 'check_suite', 'pull_request', 'workflow_run', 'merge_group'],
    });
  });
});

describe('webBaseFromApiUrl', () => {
  it('maps api.github.com to github.com', () => {
    expect(webBaseFromApiUrl('https://api.github.com/graphql')).toBe('https://github.com');
  });

  it('keeps the host for GitHub Enterprise', () => {
    expect(webBaseFromApiUrl('https://ghe.example.com/api/graphql')).toBe('https://ghe.example.com');
  });
});

describe('buildManifestPostPage', () => {
  it('renders an auto-submitting form POSTing the manifest JSON to the create URL', () => {
    const manifest = buildManifest({
      name: 'pr-dashboard', url: 'https://x', redirectUrl: 'http://127.0.0.1:1/callback' });
    const page = buildManifestPostPage(manifest, 'https://github.com/settings/apps/new');
    expect(page).toContain('action="https://github.com/settings/apps/new"');
    expect(page).toContain('method="post"');
    expect(page).toContain('name="manifest"');
    expect(page).toContain('.submit()');
    // the manifest must survive HTML-escaping: unescape the value and round-trip it
    const value = /name="manifest" value="([^"]*)"/.exec(page)?.[1];
    expect(value).toBeTruthy();
    const unescaped = value!
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(JSON.parse(unescaped)).toEqual(manifest);
  });
});

describe('parseConversion', () => {
  const FULL = {
    id: 4242,
    slug: 'pr-dashboard',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
    webhook_secret: 'whsec123',
    html_url: 'https://github.com/apps/pr-dashboard',
    extra_noise: true,
  };

  it('extracts id/slug/pem/webhookSecret/htmlUrl', () => {
    expect(parseConversion(FULL)).toEqual({
      id: 4242,
      slug: 'pr-dashboard',
      pem: FULL.pem,
      webhookSecret: 'whsec123',
      htmlUrl: 'https://github.com/apps/pr-dashboard',
    });
  });

  it('tolerates a null webhook_secret (no webhook configured)', () => {
    expect(parseConversion({ ...FULL, webhook_secret: null }).webhookSecret).toBeNull();
  });

  it.each([
    ['id', { ...FULL, id: 'x' }, /"id"/],
    ['slug', { ...FULL, slug: '' }, /"slug"/],
    ['pem', { ...FULL, pem: 'not a key' }, /"pem"/],
    ['html_url', { ...FULL, html_url: undefined }, /"html_url"/],
  ])('rejects a missing/invalid %s with a clear error', (_field, body, re) => {
    expect(() => parseConversion(body)).toThrow(re);
  });

  it('rejects a non-object response', () => {
    expect(() => parseConversion(null)).toThrow(/not a JSON object/);
    expect(() => parseConversion('nope')).toThrow(/not a JSON object/);
  });
});

describe('applyAppToConfig', () => {
  it('sets tokenSource app + the app block, preserving every other key verbatim', () => {
    const existing = {
      owners: ['acme'],
      tokenSource: 'gh',
      deploy: { 'acme/widgets': { environments: [] } },
      handWritten: 'survives',
    };
    const next = applyAppToConfig(existing, { appId: 4242, privateKeyPath: '/home/u/.config/pr-dashboard/k.pem' });
    expect(next).toEqual({
      owners: ['acme'],
      tokenSource: 'app',
      app: { appId: 4242, privateKeyPath: '/home/u/.config/pr-dashboard/k.pem' },
      deploy: { 'acme/widgets': { environments: [] } },
      handWritten: 'survives',
    });
    expect(existing.tokenSource).toBe('gh'); // pure — input untouched
  });

  it('preserves an existing app.installationId while replacing appId/privateKeyPath', () => {
    const next = applyAppToConfig(
      { app: { appId: 1, privateKeyPath: '/old.pem', installationId: 77 } },
      { appId: 2, privateKeyPath: '/new.pem' });
    expect(next.app).toEqual({ appId: 2, privateKeyPath: '/new.pem', installationId: 77 });
  });

  it('works from an empty config file', () => {
    expect(applyAppToConfig({}, { appId: 9, privateKeyPath: '/k.pem' })).toEqual({
      tokenSource: 'app', app: { appId: 9, privateKeyPath: '/k.pem' } });
  });
});
