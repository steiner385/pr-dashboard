import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// We test the module's exported functions. Because the module reads env vars at
// call time (not at import time), we can set/clear them around each test.

const ENV_KEYS = ['PRDASH_DATA_DIR', 'PRDASH_CONFIG', 'XDG_CONFIG_HOME'] as const;

describe('paths', () => {
  let saved: Record<string, string | undefined>;
  const dirs: string[] = [];
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'prdash-paths-'));
    dirs.push(d);
    return d;
  };

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('APP_ROOT resolves to the package root (absolute, contains package.json)', async () => {
    // The contract is "the directory containing package.json", anchored to the
    // module location — NOT a specific folder basename (the checkout/clone dir
    // can be named anything, e.g. the repo rename to `chartroom`).
    const { APP_ROOT } = await import('../paths.js');
    expect(isAbsolute(APP_ROOT)).toBe(true);
    expect(existsSync(join(APP_ROOT, 'package.json'))).toBe(true);
  });

  it('dataDir() returns APP_ROOT/data by default', async () => {
    const { APP_ROOT, dataDir } = await import('../paths.js');
    expect(dataDir()).toBe(join(APP_ROOT, 'data'));
  });

  it('dataDir() respects PRDASH_DATA_DIR env override', async () => {
    process.env.PRDASH_DATA_DIR = '/tmp/custom-data';
    const { dataDir } = await import('../paths.js');
    expect(dataDir()).toBe('/tmp/custom-data');
  });

  it('configPath() falls back to <appRoot>/config.json when nothing exists', async () => {
    process.env.XDG_CONFIG_HOME = tempDir(); // empty — no pr-dashboard/config.json
    const { configPath } = await import('../paths.js');
    const appRoot = tempDir();
    expect(configPath(appRoot)).toBe(join(appRoot, 'config.json'));
  });

  it('configPath(): PRDASH_CONFIG env wins even over an existing repo config', async () => {
    const appRoot = tempDir();
    writeFileSync(join(appRoot, 'config.json'), '{}');
    process.env.PRDASH_CONFIG = '/tmp/my-config.json'; // need not exist
    const { configPath } = await import('../paths.js');
    expect(configPath(appRoot)).toBe('/tmp/my-config.json');
  });

  it('configPath(): existing <appRoot>/config.json wins over XDG', async () => {
    const appRoot = tempDir();
    writeFileSync(join(appRoot, 'config.json'), '{}');
    const xdg = tempDir();
    mkdirSync(join(xdg, 'pr-dashboard'), { recursive: true });
    writeFileSync(join(xdg, 'pr-dashboard', 'config.json'), '{}');
    process.env.XDG_CONFIG_HOME = xdg;
    const { configPath } = await import('../paths.js');
    expect(configPath(appRoot)).toBe(join(appRoot, 'config.json'));
  });

  it('configPath(): XDG config is used when the repo-level file is absent', async () => {
    const appRoot = tempDir(); // no config.json
    const xdg = tempDir();
    mkdirSync(join(xdg, 'pr-dashboard'), { recursive: true });
    writeFileSync(join(xdg, 'pr-dashboard', 'config.json'), '{}');
    process.env.XDG_CONFIG_HOME = xdg;
    const { configPath } = await import('../paths.js');
    expect(configPath(appRoot)).toBe(join(xdg, 'pr-dashboard', 'config.json'));
  });

  it('staticDir() returns APP_ROOT/dist/public', async () => {
    const { APP_ROOT, staticDir } = await import('../paths.js');
    expect(staticDir()).toBe(join(APP_ROOT, 'dist', 'public'));
  });
});
