import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, repoSettings, effectiveRepoSettings, effectiveDeployMap, resolveOwners, validateConfigPatch, writeConfigPatch, configFileSources, _resetDeployAllowlistWarnings, SAFE_CONFIG_KEYS, READ_ONLY_CONFIG_KEYS, DEFAULTS, type AppConfig } from '../config';
import { parseRepoConfig } from '../repo-config';
import { APP_ROOT } from '../paths';

const dirs: string[] = [];
function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'prdash-config-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('missing file returns de-personalized defaults (no owners, no deploy)', () => {
    const cfg = loadConfig('/nonexistent/config.json');
    expect(cfg.owners).toEqual([]);
    expect(cfg.deploy).toEqual({});
    expect(cfg.repos).toEqual({});
    expect(cfg.tokenSource).toBe('gh');
    expect(cfg.apiUrl).toBe('https://api.github.com/graphql');
    expect(cfg.rateLimitFloor).toBe(1000);
    expect(cfg.batchSize).toBe(6);
  });

  it('spec-example deploy entry: uppercase env name lowercased, cloneUrl/defaultBranch/shaKey defaulted', () => {
    const path = writeConfig({
      deploy: {
        'acme/widgets': {
          environments: [{ name: 'QA', healthUrl: 'https://qa.widgets.dev/health' }],
        },
      },
    });
    const cfg = loadConfig(path);
    const dc = cfg.deploy['acme/widgets'];
    expect(dc.cloneUrl).toBe('https://github.com/acme/widgets.git');
    expect(dc.defaultBranch).toBe('main');
    expect(dc.environments).toEqual([
      { name: 'qa', healthUrl: 'https://qa.widgets.dev/health', auto: true, shaKey: 'commitSha' },
    ]);
  });

  it('explicit shaKey on an environment is preserved', () => {
    const path = writeConfig({
      deploy: {
        'acme/widgets': {
          environments: [{ name: 'prod', healthUrl: 'https://widgets.dev/health', shaKey: 'gitSha' }],
        },
      },
    });
    expect(loadConfig(path).deploy['acme/widgets'].environments[0].shaKey).toBe('gitSha');
  });

  it('throws on a bogus env name after normalization', () => {
    const path = writeConfig({
      deploy: {
        'acme/widgets': {
          environments: [{ name: 'staging', healthUrl: 'https://x/health' }],
        },
      },
    });
    expect(() => loadConfig(path)).toThrow(/acme\/widgets.*"qa" or "prod".*staging/);
  });

  it('throws when an environment is missing healthUrl', () => {
    const path = writeConfig({
      deploy: { 'acme/widgets': { environments: [{ name: 'prod' }] } },
    });
    expect(() => loadConfig(path)).toThrow(/acme\/widgets.*prod.*healthUrl/);
  });

  it('throws on an invalid tokenSource', () => {
    const path = writeConfig({ tokenSource: 'keyring' });
    expect(() => loadConfig(path)).toThrow(/tokenSource must be "gh", "env", or "app".*keyring/);
  });

  it('accepts tokenSource "app" with a valid app block; absolute privateKeyPath preserved', () => {
    const path = writeConfig({
      tokenSource: 'app',
      app: { appId: 12345, privateKeyPath: '/etc/keys/app.pem', installationId: 77 },
    });
    const cfg = loadConfig(path);
    expect(cfg.tokenSource).toBe('app');
    expect(cfg.app).toEqual({ appId: 12345, privateKeyPath: '/etc/keys/app.pem', installationId: 77 });
  });

  it('resolves app.privateKeyPath like other paths: ~/ → homedir, relative → APP_ROOT', () => {
    const tilde = loadConfig(writeConfig({
      tokenSource: 'app', app: { appId: 1, privateKeyPath: '~/keys/x.pem' } }));
    expect(tilde.app!.privateKeyPath).toBe(join(homedir(), 'keys/x.pem'));
    const rel = loadConfig(writeConfig({
      tokenSource: 'app', app: { appId: 1, privateKeyPath: 'keys/x.pem' } }));
    expect(rel.app!.privateKeyPath).toBe(join(APP_ROOT, 'keys/x.pem'));
  });

  it('tokenSource "app" without an app block → clear error', () => {
    const path = writeConfig({ tokenSource: 'app' });
    expect(() => loadConfig(path)).toThrow(/tokenSource "app" requires an "app" block/);
  });

  it('app.appId must be a positive integer; app.privateKeyPath must be a non-empty string', () => {
    expect(() => loadConfig(writeConfig({
      tokenSource: 'app', app: { appId: 0, privateKeyPath: '/k.pem' } })))
      .toThrow(/app\.appId must be a positive integer/);
    expect(() => loadConfig(writeConfig({
      tokenSource: 'app', app: { appId: 1.5, privateKeyPath: '/k.pem' } })))
      .toThrow(/app\.appId must be a positive integer/);
    expect(() => loadConfig(writeConfig({
      tokenSource: 'app', app: { appId: 1, privateKeyPath: '' } })))
      .toThrow(/app\.privateKeyPath/);
    expect(() => loadConfig(writeConfig({
      tokenSource: 'app', app: { appId: 1, privateKeyPath: '/k.pem', installationId: -2 } })))
      .toThrow(/app\.installationId/);
  });

  it('an app block under tokenSource "gh" is left alone (not validated, not resolved)', () => {
    const cfg = loadConfig(writeConfig({ tokenSource: 'gh', app: { appId: 'junk' } }));
    expect(cfg.tokenSource).toBe('gh');
  });

  it('accepts tokenSource "env" and a custom apiUrl/rateLimitFloor', () => {
    const path = writeConfig({
      tokenSource: 'env',
      apiUrl: 'https://github.example.com/api/graphql',
      rateLimitFloor: 250,
    });
    const cfg = loadConfig(path);
    expect(cfg.tokenSource).toBe('env');
    expect(cfg.apiUrl).toBe('https://github.example.com/api/graphql');
    expect(cfg.rateLimitFloor).toBe(250);
  });

  it('webhooks default: disabled, standard path, no secretPath; hotMs not explicit', () => {
    const cfg = loadConfig('/nonexistent/config.json');
    expect(cfg.webhooks).toEqual({ enabled: false, path: '/api/webhooks/github' });
    expect(cfg.hotMsExplicit).toBe(false);
  });

  it('webhooks block merges over defaults; secretPath resolved like other paths', () => {
    const cfg = loadConfig(writeConfig({
      webhooks: { enabled: true, secretPath: '~/secrets/hook' } }));
    expect(cfg.webhooks.enabled).toBe(true);
    expect(cfg.webhooks.path).toBe('/api/webhooks/github'); // default survives partial block
    expect(cfg.webhooks.secretPath).toBe(join(homedir(), 'secrets/hook'));
    const rel = loadConfig(writeConfig({
      webhooks: { enabled: false, secretPath: 'secrets/hook' } }));
    expect(rel.webhooks.secretPath).toBe(join(APP_ROOT, 'secrets/hook'));
  });

  it('webhooks.path must start with "/"', () => {
    expect(() => loadConfig(writeConfig({ webhooks: { path: 'api/webhooks' } })))
      .toThrow(/webhooks\.path must start with "\/"/);
  });

  it('webhooks enabled without a secretPath → clear startup error', () => {
    expect(() => loadConfig(writeConfig({ webhooks: { enabled: true } })))
      .toThrow(/webhooks.*secretPath/);
  });

  it('webhooks.enabled / webhooks.secretPath types are validated', () => {
    expect(() => loadConfig(writeConfig({ webhooks: { enabled: 'yes' } })))
      .toThrow(/webhooks\.enabled must be a boolean/);
    expect(() => loadConfig(writeConfig({ webhooks: { secretPath: '' } })))
      .toThrow(/webhooks\.secretPath/);
  });

  it('hotMsExplicit is true only when the FILE sets intervals.hotMs', () => {
    expect(loadConfig(writeConfig({ intervals: { hotMs: 20_000 } })).hotMsExplicit).toBe(true);
    expect(loadConfig(writeConfig({ intervals: { sweepMs: 90_000 } })).hotMsExplicit).toBe(false);
    expect(loadConfig(writeConfig({})).hotMsExplicit).toBe(false);
  });

  it('a PUT-applied intervals.hotMs write flips hotMsExplicit on the reloaded config', () => {
    const path = writeConfig({ owners: ['acme'] });
    const next = writeConfigPatch(path, { intervals: { hotMs: 20_000 } });
    expect(next.hotMsExplicit).toBe(true);
  });

  it('user repos entries merge over empty defaults', () => {
    const path = writeConfig({
      repos: { 'acme/widgets': { requiredCheckPrefixes: ['build'] } },
    });
    const merged = loadConfig(path);
    expect(merged.repos!['acme/widgets'].requiredCheckPrefixes).toEqual(['build']);
  });

  it('explicit cloneUrl/defaultBranch/auto are preserved', () => {
    const path = writeConfig({
      deploy: {
        'acme/widgets': {
          cloneUrl: 'git@github.com:acme/widgets.git',
          defaultBranch: 'trunk',
          environments: [{ name: 'prod', healthUrl: 'https://widgets.dev/health', auto: true }],
        },
      },
    });
    const dc = loadConfig(path).deploy['acme/widgets'];
    expect(dc.cloneUrl).toBe('git@github.com:acme/widgets.git');
    expect(dc.defaultBranch).toBe('trunk');
    expect(dc.environments[0]).toEqual({
      name: 'prod', healthUrl: 'https://widgets.dev/health', auto: true, shaKey: 'commitSha' });
  });
});

describe('repoSettings', () => {
  it('returns defaults for an unconfigured repo', () => {
    const s = repoSettings(DEFAULTS, 'acme/widgets');
    expect(s).toEqual({
      requiredCheckPrefixes: undefined,
      rollupJobId: 'ci',
      workflowPath: '.github/workflows/ci.yml',
      batchSize: DEFAULTS.batchSize,
    });
  });

  it('per-repo overrides win; batchSize defaults to the global value', () => {
    const config = {
      ...DEFAULTS,
      batchSize: 4,
      repos: {
        'acme/widgets': {
          requiredCheckPrefixes: ['rollup'],
          rollupJobId: 'rollup',
          workflowPath: '.github/workflows/main.yml',
          batchSize: 12,
        },
        'acme/gizmos': {},
      },
    };
    expect(repoSettings(config, 'acme/widgets')).toEqual({
      requiredCheckPrefixes: ['rollup'],
      rollupJobId: 'rollup',
      workflowPath: '.github/workflows/main.yml',
      batchSize: 12,
    });
    expect(repoSettings(config, 'acme/gizmos').batchSize).toBe(4);
    expect(repoSettings(config, 'acme/gizmos').rollupJobId).toBe('ci');
  });

  it('config.example.json parses and loads cleanly', () => {
    const examplePath = join(APP_ROOT, 'config.example.json');
    const cfg = loadConfig(examplePath);
    expect(cfg.owners).toEqual(['your-org', 'your-username']);
    expect(cfg.deploy['your-org/your-app'].environments).toHaveLength(2);
  });
});

describe('effectiveRepoSettings (instance override > in-repo > default)', () => {
  const FILE = parseRepoConfig('acme/widgets', `
rollupJobId: rollup
workflowPath: .github/workflows/main.yml
requiredCheckPrefixes: ['from-file']
batchSize: 12
`)!;

  it('in-repo values beat defaults when no instance override exists', () => {
    expect(effectiveRepoSettings('acme/widgets', DEFAULTS, FILE)).toEqual({
      requiredCheckPrefixes: ['from-file'],
      rollupJobId: 'rollup',
      workflowPath: '.github/workflows/main.yml',
      batchSize: 12,
    });
  });

  it('instance overrides beat in-repo values, per field', () => {
    const config: AppConfig = { ...DEFAULTS,
      repos: { 'acme/widgets': { rollupJobId: 'ci-gate', batchSize: 4 } } };
    const s = effectiveRepoSettings('acme/widgets', config, FILE);
    expect(s.rollupJobId).toBe('ci-gate');             // override wins
    expect(s.batchSize).toBe(4);                       // override wins
    expect(s.workflowPath).toBe('.github/workflows/main.yml'); // in-repo survives
    expect(s.requiredCheckPrefixes).toEqual(['from-file']);    // in-repo survives
  });

  it('explicit [] prefixes in the override still beat in-repo prefixes', () => {
    const config: AppConfig = { ...DEFAULTS,
      repos: { 'acme/widgets': { requiredCheckPrefixes: [] } } };
    expect(effectiveRepoSettings('acme/widgets', config, FILE).requiredCheckPrefixes).toEqual([]);
  });

  it('no file config behaves exactly like repoSettings', () => {
    expect(effectiveRepoSettings('acme/widgets', DEFAULTS, null))
      .toEqual(repoSettings(DEFAULTS, 'acme/widgets'));
  });
});

describe('effectiveDeployMap', () => {
  const fileWithDeploy = parseRepoConfig('acme/gizmos', `
deploy:
  environments:
    - name: qa
      healthUrl: https://qa.gizmos.dev/health
`)!;

  it('a repo can become a deploy repo via its in-repo file', () => {
    const map = effectiveDeployMap(DEFAULTS, new Map([['acme/gizmos', fileWithDeploy]]));
    expect(map['acme/gizmos']!.environments[0]!.healthUrl).toBe('https://qa.gizmos.dev/health');
    expect(map['acme/gizmos']!.cloneUrl).toBe('https://github.com/acme/gizmos.git');
  });

  it('an instance config deploy entry overrides the in-repo block whole-entry (instance-override case)', () => {
    const instanceDc = { cloneUrl: 'https://github.com/acme/gizmos.git', defaultBranch: 'main',
      environments: [{ name: 'qa' as const, healthUrl: 'https://qa.instance.dev/health', auto: true, shaKey: 'commitSha' }] };
    const config: AppConfig = { ...DEFAULTS, deploy: { 'acme/gizmos': instanceDc } };
    const map = effectiveDeployMap(config, new Map([['acme/gizmos', fileWithDeploy]]));
    expect(map['acme/gizmos']).toBe(instanceDc); // the override object itself — not field-merged
  });

  it('a file without a deploy block contributes nothing', () => {
    const noDeploy = parseRepoConfig('acme/gizmos', 'batchSize: 3\n')!;
    expect(effectiveDeployMap(DEFAULTS, new Map([['acme/gizmos', noDeploy]]))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Round 8 Task A4: deployUrlAllowlist (in-repo deploy URL hardening)
// ---------------------------------------------------------------------------

describe('deployUrlAllowlist', () => {
  const inRepoDeploy = (healthUrl: string, cloneUrl?: string) => parseRepoConfig('acme/gizmos', `
deploy:
  ${cloneUrl ? `cloneUrl: ${cloneUrl}` : ''}
  environments:
    - name: qa
      healthUrl: ${healthUrl}
`)!;
  const withAllowlist = (deployUrlAllowlist?: string[],
    ancestrySource: AppConfig['ancestrySource'] = 'clone'): AppConfig =>
    ({ ...DEFAULTS, deployUrlAllowlist, ancestrySource });
  const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  let warn: ReturnType<typeof spyWarn>;
  beforeEach(() => {
    _resetDeployAllowlistWarnings();
    warn = spyWarn();
  });
  afterEach(() => warn.mockRestore());

  it('loadConfig validates the type and normalizes hostnames to lowercase', () => {
    expect(() => loadConfig(writeConfig({ deployUrlAllowlist: 'github.com' })))
      .toThrow(/deployUrlAllowlist must be an array/);
    expect(() => loadConfig(writeConfig({ deployUrlAllowlist: ['github.com', ''] })))
      .toThrow(/deployUrlAllowlist/);
    expect(loadConfig(writeConfig({ deployUrlAllowlist: [' GitHub.com '] })).deployUrlAllowlist)
      .toEqual(['github.com']);
  });

  it('unset allowlist → no filtering of in-repo deploy entries', () => {
    const map = effectiveDeployMap(withAllowlist(undefined),
      new Map([['acme/gizmos', inRepoDeploy('https://qa.evil.example/health')]]));
    expect(map['acme/gizmos']).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('in-repo entry with a non-allowlisted healthUrl host is dropped, warned ONCE', () => {
    const cfg = withAllowlist(['github.com', 'qa.gizmos.dev']);
    const fileCfgs = new Map([['acme/gizmos', inRepoDeploy('https://qa.evil.example/health')]]);
    expect(effectiveDeployMap(cfg, fileCfgs)).toEqual({});
    expect(effectiveDeployMap(cfg, fileCfgs)).toEqual({}); // second merge: no re-warn
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toMatch(/acme\/gizmos.*qa\.evil\.example/s);
  });

  it('exact host match keeps the entry (cloneUrl host must match too)', () => {
    const cfg = withAllowlist(['github.com', 'qa.gizmos.dev']);
    const map = effectiveDeployMap(cfg,
      new Map([['acme/gizmos', inRepoDeploy('https://qa.gizmos.dev/health')]]));
    expect(map['acme/gizmos']!.environments[0]!.healthUrl).toBe('https://qa.gizmos.dev/health');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a non-allowlisted cloneUrl host drops the entry even when healthUrl matches', () => {
    const cfg = withAllowlist(['qa.gizmos.dev']); // github.com (default cloneUrl) missing
    const map = effectiveDeployMap(cfg,
      new Map([['acme/gizmos', inRepoDeploy('https://qa.gizmos.dev/health')]]));
    expect(map).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('github.com');
  });

  it('scp-style cloneUrl hosts (git@host:owner/repo.git) are extracted and checked', () => {
    const cfg = withAllowlist(['qa.gizmos.dev', 'ghe.corp.example']);
    const ok = effectiveDeployMap(cfg, new Map([['acme/gizmos',
      inRepoDeploy('https://qa.gizmos.dev/health', 'git@ghe.corp.example:acme/gizmos.git')]]));
    expect(ok['acme/gizmos']).toBeDefined();
    const bad = effectiveDeployMap(cfg, new Map([['acme/gizmos',
      inRepoDeploy('https://qa.gizmos.dev/health', 'git@evil.example:acme/gizmos.git')]]));
    expect(bad).toEqual({});
  });

  it("ancestrySource 'api' (the default): cloneUrl is never touched, so its host is not checked", () => {
    const cfg = withAllowlist(['qa.gizmos.dev'], 'api'); // github.com (default cloneUrl) NOT allowlisted
    const map = effectiveDeployMap(cfg,
      new Map([['acme/gizmos', inRepoDeploy('https://qa.gizmos.dev/health')]]));
    expect(map['acme/gizmos']).toBeDefined(); // kept — only healthUrl hosts matter in api mode
    expect(warn).not.toHaveBeenCalled();
    // a non-allowlisted healthUrl still drops the entry in api mode
    expect(effectiveDeployMap(cfg,
      new Map([['acme/gizmos', inRepoDeploy('https://qa.evil.example/health')]]))).toEqual({});
  });

  it('*.suffix wildcard matches subdomains (not the bare apex)', () => {
    const cfg = withAllowlist(['github.com', '*.gizmos.dev']);
    const sub = effectiveDeployMap(cfg,
      new Map([['acme/gizmos', inRepoDeploy('https://qa.gizmos.dev/health')]]));
    expect(sub['acme/gizmos']).toBeDefined();
    _resetDeployAllowlistWarnings();
    const apex = effectiveDeployMap(cfg,
      new Map([['acme/gizmos', inRepoDeploy('https://gizmos.dev/health')]]));
    expect(apex).toEqual({}); // apex requires an exact entry
  });

  it('instance-override deploy entries are exempt (the operator wrote them)', () => {
    const instanceDc = { cloneUrl: 'https://anywhere.example/repo.git', defaultBranch: 'main',
      environments: [{ name: 'qa' as const, healthUrl: 'https://qa.anywhere.example/health',
        auto: true, shaKey: 'commitSha' }] };
    const cfg: AppConfig = { ...withAllowlist(['github.com']), deploy: { 'acme/gizmos': instanceDc } };
    const map = effectiveDeployMap(cfg,
      new Map([['acme/gizmos', inRepoDeploy('https://qa.evil.example/health')]]));
    expect(map['acme/gizmos']).toBe(instanceDc);
    expect(warn).not.toHaveBeenCalled(); // override wins whole-entry; nothing in-repo survives to warn about
  });
});

describe('resolveOwners', () => {
  const configWith = (owners: string[]): AppConfig => ({ ...DEFAULTS, owners });

  it('configured owners win — the viewer query is never issued', async () => {
    const client = { graphql: vi.fn(async () => ({ viewer: { login: 'tokenowner' } })) };
    const config = configWith(['acme', 'octo']);
    await resolveOwners(config, client as never);
    expect(client.graphql).not.toHaveBeenCalled();
    expect(config.owners).toEqual(['acme', 'octo']);
  });

  it('empty owners → one viewer query, owners = [login], derivation logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = { graphql: vi.fn(async () => ({ viewer: { login: 'tokenowner' } })) };
    const config = configWith([]);
    await resolveOwners(config, client as never);
    expect(client.graphql).toHaveBeenCalledTimes(1);
    expect(String(client.graphql.mock.calls[0])).toContain('viewer { login }');
    expect(config.owners).toEqual(['tokenowner']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]))
      .toContain("no owners configured — defaulting to token owner 'tokenowner'");
    log.mockRestore();
  });

  it('rejects when the viewer query yields no login', async () => {
    const client = { graphql: vi.fn(async () => ({ viewer: null })) };
    await expect(resolveOwners(configWith([]), client as never))
      .rejects.toThrow(/viewer query returned no login/);
  });

  // Round 10 (issue #10): App mode defaults owners to the installation accounts.
  it('empty owners + an accounts source (App mode) → owners = installation logins, logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const registry = { accounts: vi.fn(() => [{ id: 11, login: 'acme' }, { id: 22, login: 'globex' }]) };
    const config = configWith([]);
    await resolveOwners(config, registry as never);
    expect(config.owners).toEqual(['acme', 'globex']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0])).toContain('installation accounts: acme, globex');
    log.mockRestore();
  });

  it('configured owners win over installation accounts — accounts() is never consulted', async () => {
    const registry = { accounts: vi.fn(() => [{ id: 11, login: 'acme' }]) };
    const config = configWith(['keepme']);
    await resolveOwners(config, registry as never);
    expect(registry.accounts).not.toHaveBeenCalled();
    expect(config.owners).toEqual(['keepme']);
  });

  it('rejects when the accounts source yields no accounts', async () => {
    const registry = { accounts: vi.fn(() => []) };
    await expect(resolveOwners(configWith([]), registry as never))
      .rejects.toThrow(/no installation accounts/);
  });
});

// ---------------------------------------------------------------------------
// Round 7 Task Z2: safe-subset config writes
// ---------------------------------------------------------------------------

describe('validateConfigPatch', () => {
  it('exports the safe subset and read-only key lists the API advertises', () => {
    expect(SAFE_CONFIG_KEYS).toEqual(['owners', 'exclude', 'retentionDays', 'batchSize', 'intervals', 'notifications']);
    expect(READ_ONLY_CONFIG_KEYS).toEqual(['tokenSource', 'apiUrl', 'port', 'app', 'ancestrySource']);
  });

  it('accepts the full safe subset and normalizes it', () => {
    const v = validateConfigPatch({
      owners: ['acme', ' octo '],
      exclude: ['acme/legacy'],
      retentionDays: 14,
      batchSize: 8,
      intervals: { sweepMs: 30_000, hotMs: 10_000 },
    });
    expect(v).toEqual({ ok: true, patch: {
      owners: ['acme', 'octo'],
      exclude: ['acme/legacy'],
      retentionDays: 14,
      batchSize: 8,
      intervals: { sweepMs: 30_000, hotMs: 10_000 },
    } });
  });

  it('rejects unknown keys, listing them', () => {
    const v = validateConfigPatch({ retentionDays: 7, banana: true });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.offendingKeys).toEqual(['banana']);
  });

  it('rejects every forbidden key — tokenSource/apiUrl/port/deploy/repos — listing all of them', () => {
    const v = validateConfigPatch({
      tokenSource: 'env', apiUrl: 'https://evil.example/graphql', port: 1337,
      deploy: {}, repos: {},
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.offendingKeys.sort())
        .toEqual(['apiUrl', 'deploy', 'port', 'repos', 'tokenSource']);
    }
  });

  it('rejects app/webhooks/deployUrlAllowlist (forbidden ahead of the features that use them)', () => {
    const v = validateConfigPatch({
      app: { appId: 1, privateKeyPath: '/tmp/x.pem' },
      webhooks: { enabled: true },
      deployUrlAllowlist: ['evil.example'],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.offendingKeys.sort()).toEqual(['app', 'deployUrlAllowlist', 'webhooks']);
    }
  });

  it('rejects bad types per field without losing the key attribution', () => {
    const v = validateConfigPatch({
      owners: [], exclude: [42], retentionDays: 0, batchSize: 2.5,
      intervals: { sweepMs: 50, bogusMs: 1000 },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.offendingKeys).toEqual([]);
      expect(Object.keys(v.fieldErrors).sort()).toEqual([
        'batchSize', 'exclude', 'intervals.bogusMs', 'intervals.sweepMs', 'owners', 'retentionDays']);
    }
  });

  it('rejects owners containing characters outside [A-Za-z0-9-]', () => {
    // GitHub handles only allow letters, digits, and hyphens — injection guard.
    for (const bad of [['acme"evil'], ['acme\\evil'], ['acme org'], ['acme_org']]) {
      const v = validateConfigPatch({ owners: bad });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.fieldErrors.owners).toMatch(/letters, digits, and hyphens/);
    }
  });

  it('accepts owners that are valid GitHub handles (letters, digits, hyphens)', () => {
    const v = validateConfigPatch({ owners: ['acme', 'my-org', 'User123', 'X'] });
    expect(v.ok).toBe(true);
  });

  it('rejects a non-object body', () => {
    for (const body of [null, 'str', 42, ['owners']]) {
      const v = validateConfigPatch(body);
      expect(v.ok).toBe(false);
    }
  });

  // notifications carve-out: ONLY `enabled` is PUT-writable — it can merely
  // flip the pre-configured command on/off (no injection surface). command/
  // events/anything else inside the block stay file-only.
  describe('notifications carve-out', () => {
    it('accepts { notifications: { enabled: boolean } } — the only writable sub-key', () => {
      for (const enabled of [true, false]) {
        const v = validateConfigPatch({ notifications: { enabled } });
        expect(v).toEqual({ ok: true, patch: { notifications: { enabled } } });
      }
    });

    it('accepts the toggle alongside the rest of the safe subset', () => {
      const v = validateConfigPatch({ batchSize: 4, notifications: { enabled: false } });
      expect(v).toEqual({ ok: true, patch: { batchSize: 4, notifications: { enabled: false } } });
    });

    it('rejects command inside notifications (the injection surface), as notifications.command', () => {
      const v = validateConfigPatch({ notifications: { enabled: true, command: ['xcalc'] } });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.offendingKeys).toEqual(['notifications.command']);
    });

    it('rejects events / secretPath / unknown sub-keys, listing each', () => {
      const v = validateConfigPatch({ notifications: {
        enabled: false, events: { ready: true }, secretPath: '/tmp/x', banana: 1 } });
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.offendingKeys.sort())
          .toEqual(['notifications.banana', 'notifications.events', 'notifications.secretPath']);
      }
    });

    it('rejects a non-boolean enabled with a field error', () => {
      const v = validateConfigPatch({ notifications: { enabled: 'yes' } });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.fieldErrors['notifications.enabled']).toMatch(/boolean/);
    });

    it('rejects an empty notifications object (enabled is the point of the carve-out)', () => {
      const v = validateConfigPatch({ notifications: {} });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.fieldErrors['notifications.enabled']).toMatch(/required/);
    });

    it('rejects a non-object notifications value', () => {
      for (const bad of [true, 'on', 7, ['enabled']]) {
        const v = validateConfigPatch({ notifications: bad });
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.fieldErrors.notifications).toMatch(/object/);
      }
    });
  });
});

describe('writeConfigPatch (read-modify-write)', () => {
  it('replaces only safe-subset keys; deploy/repos/tokenSource and hand-written extras survive verbatim', () => {
    const path = writeConfig({
      owners: ['acme'],
      tokenSource: 'env',
      port: 4500,
      deploy: { 'acme/widgets': { environments: [{ name: 'qa', healthUrl: 'https://qa.x/health' }] } },
      repos: { 'acme/widgets': { batchSize: 6 } },
      myHandWrittenNote: 'do not lose me',
      intervals: { sweepMs: 90_000, deployMs: 45_000 },
    });
    const next = writeConfigPatch(path, {
      retentionDays: 14,
      intervals: { sweepMs: 30_000 },
    });
    // returned config reflects the write
    expect(next.retentionDays).toBe(14);
    expect(next.intervals.sweepMs).toBe(30_000);
    expect(next.intervals.deployMs).toBe(45_000); // partial intervals merge key-wise
    // file content: untouched fields preserved exactly
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.tokenSource).toBe('env');
    expect(onDisk.port).toBe(4500);
    expect(onDisk.deploy['acme/widgets'].environments[0].healthUrl).toBe('https://qa.x/health');
    expect(onDisk.repos['acme/widgets'].batchSize).toBe(6);
    expect(onDisk.myHandWrittenNote).toBe('do not lose me');
    expect(onDisk.owners).toEqual(['acme']);
    expect(onDisk.intervals).toEqual({ sweepMs: 30_000, deployMs: 45_000 });
  });

  it('creates the file with just the submitted subset when none existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prdash-config-'));
    dirs.push(dir);
    const path = join(dir, 'sub', 'config.json'); // parent dir created too
    const next = writeConfigPatch(path, { owners: ['acme'], batchSize: 4 });
    expect(next.owners).toEqual(['acme']);
    expect(next.batchSize).toBe(4);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ owners: ['acme'], batchSize: 4 });
  });

  it('notifications.enabled flips in place — command/events survive byte-meaning-identical', () => {
    const path = writeConfig({
      owners: ['acme'],
      notifications: {
        enabled: true,
        command: ['notify-send', '{title}', '{body}'],
        events: { 'ci-failed': true, ready: false },
      },
    });
    const next = writeConfigPatch(path, { notifications: { enabled: false } });
    expect(next.notifications.enabled).toBe(false);
    expect(next.notifications.command).toEqual(['notify-send', '{title}', '{body}']);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.notifications).toEqual({
      enabled: false,
      command: ['notify-send', '{title}', '{body}'],
      events: { 'ci-failed': true, ready: false },
    });
  });

  it('a file without a notifications block gains one carrying only enabled; defaults fill the rest', () => {
    const path = writeConfig({ owners: ['acme'] });
    const next = writeConfigPatch(path, { notifications: { enabled: true } });
    expect(next.notifications.enabled).toBe(true);
    expect(next.notifications.command).toEqual(['notify-send', '{title}', '{body}']); // DEFAULT_NOTIFICATIONS
    expect(JSON.parse(readFileSync(path, 'utf8')).notifications).toEqual({ enabled: true });
  });
});

describe('configFileSources', () => {
  it('attributes keys present in the file as file, everything else default', () => {
    const path = writeConfig({ owners: ['acme'], retentionDays: 14 });
    const sources = configFileSources(path);
    expect(sources.owners).toBe('file');
    expect(sources.retentionDays).toBe('file');
    expect(sources.port).toBe('default');
    expect(sources.tokenSource).toBe('default');
    expect(sources.intervals).toBe('default');
  });

  it('missing file → everything default', () => {
    const sources = configFileSources('/nonexistent/config.json');
    expect(new Set(Object.values(sources))).toEqual(new Set(['default']));
  });

  it('internal hotMsExplicit flag is never surfaced as a config field', () => {
    expect(configFileSources(writeConfig({ intervals: { hotMs: 5000 } }))).not.toHaveProperty('hotMsExplicit');
  });
});

// ---------------------------------------------------------------------------
// Issue #18: compare-API ancestry — ancestrySource config
// ---------------------------------------------------------------------------

describe('ancestrySource', () => {
  it("defaults to 'api' (no local clones required)", () => {
    expect(loadConfig('/nonexistent/config.json').ancestrySource).toBe('api');
    expect(loadConfig(writeConfig({})).ancestrySource).toBe('api');
  });

  it("accepts 'clone' (the pre-#18 bare-clone mechanism)", () => {
    expect(loadConfig(writeConfig({ ancestrySource: 'clone' })).ancestrySource).toBe('clone');
  });

  it('rejects anything else with a clear error', () => {
    expect(() => loadConfig(writeConfig({ ancestrySource: 'git' })))
      .toThrow(/ancestrySource must be "api" or "clone".*git/);
  });

  it('a deploy entry without cloneUrl is valid (cloneUrl is optional; GitHub URL default)', () => {
    const cfg = loadConfig(writeConfig({ deploy: { 'acme/widgets': {
      environments: [{ name: 'qa', healthUrl: 'https://qa.widgets.example.com/health' }] } } }));
    expect(cfg.ancestrySource).toBe('api');
    // default fill kept for clone mode / clone fallback — never fetched in api mode
    expect(cfg.deploy['acme/widgets']!.cloneUrl).toBe('https://github.com/acme/widgets.git');
  });

  it('is file-only: PUT /api/config rejects it (not in the safe subset)', () => {
    const v = validateConfigPatch({ ancestrySource: 'clone' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.offendingKeys).toContain('ancestrySource');
  });
});

// ---------------------------------------------------------------------------
// notifications config block (issue #19)
// ---------------------------------------------------------------------------

describe('notifications config', () => {
  it('defaults: disabled, notify-send template, alert types on / chatty types off', () => {
    const cfg = loadConfig('/nonexistent/config.json');
    expect(cfg.notifications).toEqual({
      enabled: false,
      command: ['notify-send', '{title}', '{body}'],
      digest: { enabled: false, hourLocal: 8 }, // issue #51 — off by default
      events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
        ready: false, overdue: false, 'prod-live': true, 'queue-stalled': true,
        'duration-regression': true, 'runner-starvation': true },
    });
  });

  it('a partial events block merges over the defaults (unspecified types keep theirs)', () => {
    const cfg = loadConfig(writeConfig({
      notifications: { enabled: true, events: { ready: true } } }));
    expect(cfg.notifications.enabled).toBe(true);
    expect(cfg.notifications.command).toEqual(['notify-send', '{title}', '{body}']); // default kept
    expect(cfg.notifications.events).toEqual({ 'ci-failed': true, 'group-failed': true,
      'queue-blocked': true, ready: true, overdue: false, 'prod-live': true,
      'queue-stalled': true, 'duration-regression': true, 'runner-starvation': true });
  });

  it('accepts a custom command array', () => {
    const cfg = loadConfig(writeConfig({
      notifications: { enabled: true, command: ['/usr/bin/my-hook', '--title', '{title}'] } }));
    expect(cfg.notifications.command).toEqual(['/usr/bin/my-hook', '--title', '{title}']);
  });

  it('rejects a non-boolean enabled', () => {
    expect(() => loadConfig(writeConfig({ notifications: { enabled: 'yes' } })))
      .toThrow(/notifications\.enabled must be a boolean/);
  });

  it('rejects a non-array / non-string-array command', () => {
    expect(() => loadConfig(writeConfig({ notifications: { command: 'notify-send {title}' } })))
      .toThrow(/notifications\.command must be an array of strings/);
    expect(() => loadConfig(writeConfig({ notifications: { command: ['notify-send', 42] } })))
      .toThrow(/notifications\.command must be an array of strings/);
  });

  it('rejects enabled:true with an empty command', () => {
    expect(() => loadConfig(writeConfig({ notifications: { enabled: true, command: [] } })))
      .toThrow(/notifications\.enabled requires a non-empty notifications\.command/);
  });

  it('rejects unknown event types and non-boolean toggles', () => {
    expect(() => loadConfig(writeConfig({ notifications: { events: { banana: true } } })))
      .toThrow(/notifications\.events\.banana is not a known event type/);
    expect(() => loadConfig(writeConfig({ notifications: { events: { ready: 1 } } })))
      .toThrow(/notifications\.events\.ready must be a boolean/);
  });

  it('PIN — command/events are file-only: PUT /api/config rejects every notifications sub-key except enabled', () => {
    const v = validateConfigPatch({ notifications: { enabled: true, command: ['evil'] } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.offendingKeys).toContain('notifications.command');
  });

  it('configFileSources attributes notifications file-vs-default', () => {
    expect(configFileSources(writeConfig({ notifications: { enabled: true } })).notifications).toBe('file');
    expect(configFileSources(writeConfig({})).notifications).toBe('default');
  });

  it('writeConfigPatch leaves a hand-written notifications block untouched', () => {
    const path = writeConfig({ owners: ['acme'],
      notifications: { enabled: true, command: ['my-hook', '{title}'] } });
    writeConfigPatch(path, { retentionDays: 14 });
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk.notifications).toEqual({ enabled: true, command: ['my-hook', '{title}'] });
  });
});

// ---------------------------------------------------------------------------
// Issue #51: webhookUrl + digest config (file-only, like the rest of the block)
// ---------------------------------------------------------------------------

describe('notifications.webhookUrl + digest config (issue #51)', () => {
  it('defaults: no webhookUrl, digest disabled at 08 local', () => {
    const cfg = loadConfig('/nonexistent/config.json');
    expect(cfg.notifications.webhookUrl).toBeUndefined();
    expect(cfg.notifications.digest).toEqual({ enabled: false, hourLocal: 8 });
  });

  it('accepts an https webhookUrl and partial digest (defaults fill hourLocal)', () => {
    const cfg = loadConfig(writeConfig({ notifications: {
      webhookUrl: 'https://hooks.slack.com/services/T/B/x',
      digest: { enabled: true },
    } }));
    expect(cfg.notifications.webhookUrl).toBe('https://hooks.slack.com/services/T/B/x');
    expect(cfg.notifications.digest).toEqual({ enabled: true, hourLocal: 8 });
  });

  it('accepts a loopback http webhookUrl (local relay/test receiver)', () => {
    const cfg = loadConfig(writeConfig({ notifications: { webhookUrl: 'http://127.0.0.1:9099/hook' } }));
    expect(cfg.notifications.webhookUrl).toBe('http://127.0.0.1:9099/hook');
  });

  it('rejects non-http(s) and non-string webhookUrls at load', () => {
    expect(() => loadConfig(writeConfig({ notifications: { webhookUrl: 'file:///etc/passwd' } })))
      .toThrow(/webhookUrl must be an http\(s\):\/\/ URL/);
    expect(() => loadConfig(writeConfig({ notifications: { webhookUrl: 'hooks.slack.com/x' } })))
      .toThrow(/webhookUrl must be an http\(s\):\/\/ URL/);
    expect(() => loadConfig(writeConfig({ notifications: { webhookUrl: 42 } })))
      .toThrow(/webhookUrl/);
  });

  it('rejects a bad digest block at load', () => {
    expect(() => loadConfig(writeConfig({ notifications: { digest: { enabled: 'yes' } } })))
      .toThrow(/digest\.enabled must be a boolean/);
    for (const hourLocal of [24, -1, 8.5, '8']) {
      expect(() => loadConfig(writeConfig({ notifications: { digest: { enabled: true, hourLocal } } })))
        .toThrow(/digest\.hourLocal must be an integer 0–23/);
    }
  });

  it('enabled with a webhookUrl but an empty command is valid (webhook-only setup)', () => {
    const cfg = loadConfig(writeConfig({ notifications: {
      enabled: true, command: [], webhookUrl: 'https://hooks.example.com/x' } }));
    expect(cfg.notifications.enabled).toBe(true);
  });

  it('PIN — webhookUrl/digest are NOT in the PUT carve-out (token-bearing URL must stay file-only)', () => {
    const v = validateConfigPatch({ notifications: {
      enabled: true, webhookUrl: 'https://evil.example.com/exfil', digest: { enabled: true } } });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.offendingKeys).toContain('notifications.webhookUrl');
      expect(v.offendingKeys).toContain('notifications.digest');
    }
  });

  it('writeConfigPatch preserves webhookUrl + digest when PUT flips enabled', () => {
    const path = writeConfig({ owners: ['acme'], notifications: {
      enabled: true, command: ['notify-send', '{title}', '{body}'],
      webhookUrl: 'https://hooks.example.com/x', digest: { enabled: true, hourLocal: 7 } } });
    const next = writeConfigPatch(path, { notifications: { enabled: false } });
    expect(next.notifications.enabled).toBe(false);
    expect(next.notifications.webhookUrl).toBe('https://hooks.example.com/x');
    expect(next.notifications.digest).toEqual({ enabled: true, hourLocal: 7 });
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      notifications: Record<string, unknown> };
    expect(onDisk.notifications.webhookUrl).toBe('https://hooks.example.com/x');
    expect(onDisk.notifications.digest).toEqual({ enabled: true, hourLocal: 7 });
  });
});
