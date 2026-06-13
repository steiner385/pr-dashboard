import { describe, it, expect } from 'vitest';
import { parseRepoConfig, REPO_CONFIG_PATH } from '../repo-config';

const REPO = 'acme/widgets';

describe('parseRepoConfig', () => {
  it('exposes the canonical in-repo path constant', () => {
    expect(REPO_CONFIG_PATH).toBe('.pr-dashboard.yml');
  });

  it('parses the full spec-example schema with defaults applied', () => {
    const cfg = parseRepoConfig(REPO, `
rollupJobId: rollup
workflowPath: .github/workflows/main.yml
requiredCheckPrefixes: ['rollup', 'fast /']
batchSize: 6
deploy:
  defaultBranch: trunk
  environments:
    - name: qa
      healthUrl: https://qa.example.com/health
      auto: true
      shaKey: commitSha
    - name: prod
      healthUrl: https://example.com/health
`)!;
    expect(cfg.rollupJobId).toBe('rollup');
    expect(cfg.workflowPath).toBe('.github/workflows/main.yml');
    expect(cfg.requiredCheckPrefixes).toEqual(['rollup', 'fast /']);
    expect(cfg.batchSize).toBe(6);
    expect(cfg.deploy).toEqual({
      cloneUrl: 'https://github.com/acme/widgets.git', // defaulted from the repo
      defaultBranch: 'trunk',
      environments: [
        { name: 'qa', healthUrl: 'https://qa.example.com/health', auto: true, shaKey: 'commitSha' },
        // prod: auto defaults false, shaKey defaults commitSha
        { name: 'prod', healthUrl: 'https://example.com/health', auto: false, shaKey: 'commitSha' },
      ],
    });
    expect(cfg.warnings).toEqual([]);
  });

  it('normalizes env names to lowercase like loadConfig does', () => {
    const cfg = parseRepoConfig(REPO,
      'deploy:\n  environments:\n    - name: QA\n      healthUrl: https://qa.x/health\n')!;
    expect(cfg.deploy!.environments).toEqual([
      { name: 'qa', healthUrl: 'https://qa.x/health', auto: true, shaKey: 'commitSha' },
    ]);
  });

  it('is throw-free: a bogus env name drops that environment with a warning', () => {
    const cfg = parseRepoConfig(REPO, `
deploy:
  environments:
    - name: staging
      healthUrl: https://staging.x/health
    - name: prod
      healthUrl: https://x/health
`)!;
    expect(cfg.deploy!.environments).toHaveLength(1);
    expect(cfg.deploy!.environments[0]!.name).toBe('prod');
    expect(cfg.warnings.join(' ')).toMatch(/"qa" or "prod".*staging/);
  });

  it('an environment missing healthUrl is dropped with a warning', () => {
    const cfg = parseRepoConfig(REPO,
      'deploy:\n  environments:\n    - name: qa\n')!;
    expect(cfg.deploy!.environments).toEqual([]);
    expect(cfg.warnings.join(' ')).toMatch(/qa.*healthUrl/);
  });

  it('invalid scalar fields are dropped individually with warnings; valid ones survive', () => {
    const cfg = parseRepoConfig(REPO, `
rollupJobId: 42
workflowPath: .github/workflows/ci.yml
requiredCheckPrefixes: nope
batchSize: -3
`)!;
    expect(cfg.rollupJobId).toBeUndefined();
    expect(cfg.workflowPath).toBe('.github/workflows/ci.yml');
    expect(cfg.requiredCheckPrefixes).toBeUndefined();
    expect(cfg.batchSize).toBeUndefined();
    expect(cfg.warnings.join(' ')).toMatch(/rollupJobId/);
    expect(cfg.warnings.join(' ')).toMatch(/requiredCheckPrefixes/);
    expect(cfg.warnings.join(' ')).toMatch(/batchSize/);
  });

  it('explicit empty requiredCheckPrefixes is preserved (disables prefixes entirely)', () => {
    const cfg = parseRepoConfig(REPO, 'requiredCheckPrefixes: []\n')!;
    expect(cfg.requiredCheckPrefixes).toEqual([]);
    expect(cfg.warnings).toEqual([]);
  });

  it('non-string prefix entries are filtered with a warning', () => {
    const cfg = parseRepoConfig(REPO, 'requiredCheckPrefixes: ["ci", 42]\n')!;
    expect(cfg.requiredCheckPrefixes).toEqual(['ci']);
    expect(cfg.warnings.join(' ')).toMatch(/requiredCheckPrefixes/);
  });

  it('unknown top-level keys warn but do not fail the parse', () => {
    const cfg = parseRepoConfig(REPO, 'batchSize: 4\nfrobnicate: true\n')!;
    expect(cfg.batchSize).toBe(4);
    expect(cfg.warnings.join(' ')).toMatch(/frobnicate/);
  });

  it('a non-mapping deploy is dropped with a warning', () => {
    const cfg = parseRepoConfig(REPO, 'deploy: nope\n')!;
    expect(cfg.deploy).toBeUndefined();
    expect(cfg.warnings.join(' ')).toMatch(/deploy/);
  });

  it('returns null on unparseable YAML', () => {
    expect(parseRepoConfig(REPO, 'not: [valid: yaml')).toBeNull();
  });

  it('returns null for empty or non-mapping documents', () => {
    expect(parseRepoConfig(REPO, '')).toBeNull();
    expect(parseRepoConfig(REPO, '- a\n- b\n')).toBeNull();
    expect(parseRepoConfig(REPO, 'just a string')).toBeNull();
  });

  describe('aliases (check-rename continuity)', () => {
    it('parses a mapping of old-name -> new-name', () => {
      const cfg = parseRepoConfig(REPO, `
aliases:
  static-checks: checks
  integration-tests: integ
`);
      expect(cfg?.aliases).toEqual({ 'static-checks': 'checks', 'integration-tests': 'integ' });
      expect(cfg?.warnings).toEqual([]);
    });

    it('drops self-mapping and empty entries with a warning, keeps the rest', () => {
      const cfg = parseRepoConfig(REPO, `
aliases:
  same: same
  good: renamed
  blank: ""
`);
      expect(cfg?.aliases).toEqual({ good: 'renamed' });
      expect(cfg?.warnings.length).toBe(2);
    });

    it('drops a non-mapping aliases value with a warning', () => {
      const cfg = parseRepoConfig(REPO, 'aliases:\n  - a\n  - b\n');
      expect(cfg?.aliases).toBeUndefined();
      expect(cfg?.warnings.some((w) => w.includes('aliases'))).toBe(true);
    });

    it('omits aliases entirely when every entry is invalid', () => {
      const cfg = parseRepoConfig(REPO, 'aliases:\n  x: x\n');
      expect(cfg?.aliases).toBeUndefined();
    });
  });
});
