import { describe, it, expect } from 'vitest';
import { derivePrefixes, deriveCiGraph, activeForEvent, ciGraphToJson, ciGraphFromJson, fileDefinesJob, discoverRollupWorkflow, type CiGraph } from '../required-checks';

const needsOf = (g: CiGraph, prefix: string) => g.nodes.get(prefix)?.needs;
const activeFor = (g: CiGraph, prefix: string, event: string) =>
  activeForEvent(g.nodes.get(prefix)!.activity, event);

// Fixture reproducing widgets's ci.yml shape: a `ci` rollup job whose needs-closure
// spans plain jobs, jobs with explicit `name:`, and reusable-workflow (`uses:`) jobs.
const ROLLUP_SHAPE = `
name: CI
on: pull_request
jobs:
  prepare:
    name: Prepare (prisma + packages)
    runs-on: ubuntu-latest
  changed-scope:
    name: Changed scope
    runs-on: ubuntu-latest
  fast-checks:
    uses: ./.github/workflows/_fast-checks.yml
    needs: [prepare, changed-scope]
  static-checks:
    name: static-checks
    uses: ./.github/workflows/_static-checks.yml
    needs: prepare
  build:
    runs-on: ubuntu-latest
    needs: [prepare]
  build-test:
    runs-on: ubuntu-latest
    needs: [prepare]
  db-migrations:
    uses: ./.github/workflows/_db-migrations.yml
    needs: prepare
  bats-tests:
    runs-on: ubuntu-latest
  mobile-checks:
    runs-on: ubuntu-latest
    needs: changed-scope
  pr-affected-tests:
    uses: ./.github/workflows/_affected.yml
    needs: [prepare, changed-scope]
  lighthouse:
    runs-on: ubuntu-latest
  ci:
    runs-on: ubuntu-latest
    needs:
      - static-checks
      - build
      - build-test
      - db-migrations
      - bats-tests
      - mobile-checks
      - fast-checks
      - pr-affected-tests
`;

describe('derivePrefixes', () => {
  it('walks the ci needs-closure: name override, uses-suffix, transitive needs, dedupe', () => {
    const prefixes = derivePrefixes(ROLLUP_SHAPE);
    expect(prefixes).toEqual([
      'ci',
      'static-checks /',      // uses: job → checks render as "static-checks / <inner>"
      'build',
      'build-test',
      'db-migrations /',
      'bats-tests',
      'mobile-checks',
      'fast-checks /',
      'pr-affected-tests /',
      'Prepare (prisma + packages)', // explicit name: wins over job key
      'Changed scope',
    ]);
    // jobs outside the closure are excluded
    expect(prefixes).not.toContain('lighthouse');
  });

  it('accepts a string-valued needs and a custom rollup job id', () => {
    const text = `
jobs:
  lint:
    runs-on: ubuntu-latest
  rollup:
    needs: lint
`;
    expect(derivePrefixes(text, 'rollup')).toEqual(['rollup', 'lint']);
  });

  it('is cycle-safe (visited set terminates a needs cycle)', () => {
    const text = `
jobs:
  a:
    needs: b
  b:
    needs: a
  ci:
    needs: a
`;
    expect(derivePrefixes(text)).toEqual(['ci', 'a', 'b']);
  });

  it('returns ["ci"] when the rollup job is missing', () => {
    expect(derivePrefixes('jobs:\n  other: {}\n')).toEqual(['ci']);
  });

  it('returns null for unparseable YAML (callers keep the richer fallback)', () => {
    expect(derivePrefixes('not: [valid: yaml')).toBeNull();
  });

  it('returns ["ci"] for valid but jobs-less YAML', () => {
    expect(derivePrefixes('name: CI\non: push\n')).toEqual(['ci']);
  });

  it('ignores needs entries that reference unknown jobs', () => {
    const text = `
jobs:
  ci:
    needs: [ghost, lint]
  lint: {}
`;
    expect(derivePrefixes(text)).toEqual(['ci', 'lint']);
  });
});

describe('deriveCiGraph workflowName', () => {
  it("returns the YAML top-level name: (e.g. 'CI')", () => {
    expect(deriveCiGraph(ROLLUP_SHAPE)!.workflowName).toBe('CI');
  });

  it('returns null when the workflow has no name:', () => {
    expect(deriveCiGraph('jobs:\n  ci: {}\n')!.workflowName).toBeNull();
  });

  it('carries workflowName on the degraded rollup-only graph too', () => {
    expect(deriveCiGraph('name: CI\non: push\n')!.workflowName).toBe('CI');
    expect(deriveCiGraph('jobs:\n  other: {}\n')!.workflowName).toBeNull();
  });

  it('non-string name: degrades to null', () => {
    expect(deriveCiGraph('name: 42\njobs:\n  ci: {}\n')!.workflowName).toBeNull();
  });
});

describe('deriveCiGraph', () => {
  it('returns prefixes plus a display-name-level needs adjacency in one parse', () => {
    const g = deriveCiGraph(ROLLUP_SHAPE)!;
    expect(g).not.toBeNull();
    // prefixes identical to derivePrefixes (the wrapper shares the walk)
    expect(g.prefixes).toEqual(derivePrefixes(ROLLUP_SHAPE));
    // rollup adjacency uses the same naming rules (uses-jobs carry the ' /' suffix)
    expect(needsOf(g, 'ci')).toEqual([
      'static-checks /', 'build', 'build-test', 'db-migrations /',
      'bats-tests', 'mobile-checks', 'fast-checks /', 'pr-affected-tests /',
    ]);
    // explicit name: wins over job key in adjacency values too
    expect(needsOf(g, 'static-checks /')).toEqual(['Prepare (prisma + packages)']);
    expect(needsOf(g, 'fast-checks /')).toEqual(['Prepare (prisma + packages)', 'Changed scope']);
    // root jobs have an empty needs list
    expect(needsOf(g, 'bats-tests')).toEqual([]);
    expect(needsOf(g, 'Prepare (prisma + packages)')).toEqual([]);
    // jobs outside the closure are absent
    expect(g.nodes.has('lighthouse')).toBe(false);
  });

  it('accepts a string-valued needs and a custom rollup job id', () => {
    const text = `
jobs:
  lint:
    runs-on: ubuntu-latest
  rollup:
    needs: lint
`;
    const g = deriveCiGraph(text, 'rollup')!;
    expect(needsOf(g, 'rollup')).toEqual(['lint']);
    expect(needsOf(g, 'lint')).toEqual([]);
  });

  it('ignores needs entries that reference unknown jobs in the adjacency', () => {
    const g = deriveCiGraph('jobs:\n  ci:\n    needs: [ghost, lint]\n  lint: {}\n')!;
    expect(needsOf(g, 'ci')).toEqual(['lint']);
  });

  it('is cycle-safe', () => {
    const g = deriveCiGraph('jobs:\n  a:\n    needs: b\n  b:\n    needs: a\n  ci:\n    needs: a\n')!;
    expect(needsOf(g, 'a')).toEqual(['b']);
    expect(needsOf(g, 'b')).toEqual(['a']);
  });

  it('returns null for unparseable YAML', () => {
    expect(deriveCiGraph('not: [valid: yaml')).toBeNull();
  });

  it('degrades to a rollup-only graph when the rollup job or jobs map is missing', () => {
    for (const text of ['jobs:\n  other: {}\n', 'name: CI\non: push\n']) {
      const g = deriveCiGraph(text)!;
      expect(g.prefixes).toEqual(['ci']);
      expect(g.nodes).toEqual(new Map([['ci', { needs: [], activity: { mode: 'all' }, runsOn: null, timeoutMinutes: null }]]));
    }
  });
});

// Fixture covering every `if:` pattern observed in widgets's real ci.yml.
const EVENT_GATED_SHAPE = `
name: CI
on: [pull_request, merge_group]
jobs:
  pr-affected-tests:
    if: github.event_name == 'pull_request'
    uses: ./.github/workflows/_selective-tests.yml
  android-smoke:
    if: github.event_name == 'merge_group'
    uses: ./.github/workflows/_android-smoke.yml
  integration-tests:
    if: >-
      github.event_name == 'merge_group' ||
      (github.event_name == 'pull_request' &&
       (needs.changed-scope.outputs.backend == 'true' ||
        contains(github.event.pull_request.labels.*.name, 'ci:full')))
    uses: ./.github/workflows/_integration-tests.yml
  accessibility:
    if: >-
      github.event_name != 'pull_request' ||
      github.event.pull_request.draft == false ||
      contains(github.event.pull_request.labels.*.name, 'ci:full')
    uses: ./.github/workflows/_accessibility-tests.yml
  build:
    runs-on: ubuntu-latest
  exotic:
    if: contains(github.event_name, 'pull')
    runs-on: ubuntu-latest
  mixed:
    if: github.event_name == 'merge_group' || github.event_name != 'push'
    runs-on: ubuntu-latest
  ci:
    if: always()
    runs-on: ubuntu-latest
    needs:
      - pr-affected-tests
      - android-smoke
      - integration-tests
      - accessibility
      - build
      - exotic
      - mixed
`;

describe('deriveCiGraph event activity', () => {
  const g = deriveCiGraph(EVENT_GATED_SHAPE)!;

  it("if: github.event_name == 'pull_request' → active for PR only", () => {
    expect(activeFor(g, 'pr-affected-tests /', 'pull_request')).toBe(true);
    expect(activeFor(g, 'pr-affected-tests /', 'merge_group')).toBe(false);
    expect(activeFor(g, 'pr-affected-tests /', 'push')).toBe(false);
  });

  it("if: github.event_name == 'merge_group' → active for merge_group only", () => {
    expect(activeFor(g, 'android-smoke /', 'merge_group')).toBe(true);
    expect(activeFor(g, 'android-smoke /', 'pull_request')).toBe(false);
  });

  it('compound mg || (pr && non-event clauses) → potentially active for both, never push', () => {
    // non-event clauses are assumed true — pull_request stays potentially active
    expect(activeFor(g, 'integration-tests /', 'merge_group')).toBe(true);
    expect(activeFor(g, 'integration-tests /', 'pull_request')).toBe(true);
    expect(activeFor(g, 'integration-tests /', 'push')).toBe(false);
  });

  it("negative-only != 'pull_request' || other → active everywhere except PR", () => {
    expect(activeFor(g, 'accessibility /', 'pull_request')).toBe(false);
    expect(activeFor(g, 'accessibility /', 'merge_group')).toBe(true);
    expect(activeFor(g, 'accessibility /', 'push')).toBe(true);
  });

  it('no if, if: always(), exotic event_name use, and mixed ==/!= → active everywhere (safe)', () => {
    for (const prefix of ['build', 'ci', 'exotic', 'mixed']) {
      expect(activeFor(g, prefix, 'pull_request')).toBe(true);
      expect(activeFor(g, prefix, 'merge_group')).toBe(true);
      expect(activeFor(g, prefix, 'push')).toBe(true);
    }
  });

  it('two job keys sharing a display name union their activity (only ∪ only)', () => {
    const merged = deriveCiGraph(`
jobs:
  a:
    name: shared
    if: github.event_name == 'pull_request'
  b:
    name: shared
    if: github.event_name == 'merge_group'
  ci:
    needs: [a, b]
`)!;
    expect(activeFor(merged, 'shared', 'pull_request')).toBe(true);
    expect(activeFor(merged, 'shared', 'merge_group')).toBe(true);
    expect(activeFor(merged, 'shared', 'push')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CiGraph JSON encode/decode (persisted last-known-good in the history meta table)
// ---------------------------------------------------------------------------

describe('ciGraphToJson / ciGraphFromJson', () => {
  const graph = (): CiGraph => deriveCiGraph(`
name: CI
jobs:
  lint:
    if: github.event_name == 'pull_request'
  build:
    name: Build /
    uses: ./.github/workflows/build.yml
  advisory:
    if: github.event_name != 'merge_group'
  ci:
    needs: [lint, build, advisory]
`)!;

  it('round-trips a derived graph through JSON.stringify/parse', () => {
    const g = graph();
    const back = ciGraphFromJson(JSON.parse(JSON.stringify(ciGraphToJson(g))));
    expect(back).not.toBeNull();
    expect(back!.prefixes).toEqual(g.prefixes);
    expect(back!.workflowName).toBe('CI');
    expect([...back!.nodes.keys()]).toEqual([...g.nodes.keys()]);
    for (const [prefix, node] of g.nodes) {
      expect(back!.nodes.get(prefix)).toEqual(node); // needs + activity preserved
    }
    // restored activity still drives event classification
    expect(activeForEvent(back!.nodes.get('lint')!.activity, 'merge_group')).toBe(false);
    expect(activeForEvent(back!.nodes.get('advisory')!.activity, 'merge_group')).toBe(false);
    expect(activeForEvent(back!.nodes.get('advisory')!.activity, 'pull_request')).toBe(true);
  });

  it('round-trips a null workflowName', () => {
    const g = deriveCiGraph('jobs:\n  ci: {}\n')!;
    expect(g.workflowName).toBeNull();
    expect(ciGraphFromJson(ciGraphToJson(g))!.workflowName).toBeNull();
  });

  it('rejects structurally invalid values (corrupt/legacy rows)', () => {
    expect(ciGraphFromJson(null)).toBeNull();
    expect(ciGraphFromJson('ci')).toBeNull();
    expect(ciGraphFromJson([])).toBeNull();
    expect(ciGraphFromJson({})).toBeNull();                                 // no prefixes
    expect(ciGraphFromJson({ prefixes: 'ci', nodes: {}, workflowName: null })).toBeNull();
    expect(ciGraphFromJson({ prefixes: ['ci'], nodes: [], workflowName: null })).toBeNull();
    expect(ciGraphFromJson({ prefixes: ['ci'], nodes: {}, workflowName: 7 })).toBeNull();
    expect(ciGraphFromJson({ prefixes: ['ci'],                              // bad node needs
      nodes: { ci: { needs: 'lint', activity: { mode: 'all' } } }, workflowName: null })).toBeNull();
    expect(ciGraphFromJson({ prefixes: ['ci'],                              // bad activity mode
      nodes: { ci: { needs: [], activity: { mode: 'sometimes' } } }, workflowName: null })).toBeNull();
    expect(ciGraphFromJson({ prefixes: ['ci'],                              // only/except need events
      nodes: { ci: { needs: [], activity: { mode: 'only' } } }, workflowName: null })).toBeNull();
  });

  it('accepts a minimal valid value — a legacy node without runsOn decodes to runsOn: null', () => {
    const g = ciGraphFromJson({ prefixes: ['ci'],
      nodes: { ci: { needs: [], activity: { mode: 'all' } } }, workflowName: null });
    expect(g!.nodes.get('ci')).toEqual({ needs: [], activity: { mode: 'all' }, runsOn: null,
      timeoutMinutes: null });
  });

  it('round-trips runsOn candidates and coerces a garbage runsOn to null', () => {
    const g = deriveCiGraph(`
jobs:
  build:
    runs-on: kindash-runner
  ci:
    needs: [build]
    runs-on: ubuntu-latest
`)!;
    const back = ciGraphFromJson(JSON.parse(JSON.stringify(ciGraphToJson(g))))!;
    expect(back.nodes.get('build')!.runsOn).toEqual(['kindash-runner']);
    expect(back.nodes.get('ci')!.runsOn).toEqual(['ubuntu-latest']);
    // tolerant on the new field only: a corrupt runsOn must not reject the row
    const coerced = ciGraphFromJson({ prefixes: ['ci'],
      nodes: { ci: { needs: [], activity: { mode: 'all' }, runsOn: 'kindash-runner' } },
      workflowName: null });
    expect(coerced!.nodes.get('ci')!.runsOn).toBeNull();
  });
});

describe('deriveCiGraph runs-on extraction (issue #34)', () => {
  const runsOnOf = (yaml: string, prefix: string): string[] | null =>
    deriveCiGraph(yaml)!.nodes.get(prefix)!.runsOn;

  it('plain string runs-on → single raw label', () => {
    expect(runsOnOf(`
jobs:
  build:
    runs-on: kindash-runner
  ci:
    needs: [build]
`, 'build')).toEqual(['kindash-runner']);
  });

  it('array runs-on → all raw labels', () => {
    expect(runsOnOf(`
jobs:
  build:
    runs-on: [self-hosted, linux, x64]
  ci:
    needs: [build]
`, 'build')).toEqual(['self-hosted', 'linux', 'x64']);
  });

  it("ternary expression → both branches as candidates (condition literals like 'merge_group' excluded)", () => {
    expect(runsOnOf(`
jobs:
  build:
    runs-on: \${{ github.event_name == 'merge_group' && 'kindash-ondemand-2' || 'kindash-runner' }}
  ci:
    needs: [build]
`, 'build')).toEqual(['kindash-ondemand-2', 'kindash-runner']);
  });

  it('array entry containing a ternary expands inside the array', () => {
    expect(runsOnOf(`
jobs:
  build:
    runs-on: ["self-hosted", "\${{ github.event_name == 'merge_group' && 'kindash-ondemand' || 'kindash-runner' }}"]
  ci:
    needs: [build]
`, 'build')).toEqual(['self-hosted', 'kindash-ondemand', 'kindash-runner']);
  });

  it('unrecognized expression → raw string preserved as the single candidate', () => {
    expect(runsOnOf(`
jobs:
  build:
    runs-on: \${{ matrix.os }}
  ci:
    needs: [build]
`, 'build')).toEqual(['${{ matrix.os }}']);
  });

  it('reusable-workflow job → null (inner runs-on unknowable)', () => {
    expect(runsOnOf(`
jobs:
  build:
    name: build-checks
    uses: ./.github/workflows/build.yml
  ci:
    needs: [build]
`, 'build-checks /')).toBeNull();
  });

  it('reusable-workflow job with an outer runs-on with: input → fallback to the outer labels', () => {
    expect(runsOnOf(`
jobs:
  build:
    name: build-checks
    uses: ./.github/workflows/build.yml
    with:
      runs-on: kindash-runner
  ci:
    needs: [build]
`, 'build-checks /')).toEqual(['kindash-runner']);
  });

  it('job without runs-on → null; degraded rollup-only graph → null', () => {
    expect(runsOnOf('jobs:\n  build: {}\n  ci:\n    needs: [build]\n', 'build')).toBeNull();
    expect(deriveCiGraph('jobs:\n  other: {}\n')!.nodes.get('ci')!.runsOn).toBeNull();
  });

  it('two job keys sharing a display name union their runs-on candidates', () => {
    expect(runsOnOf(`
jobs:
  build-pr:
    name: build
    runs-on: kindash-runner
  build-mg:
    name: build
    runs-on: kindash-ondemand
  ci:
    needs: [build-pr, build-mg]
`, 'build')).toEqual(['kindash-runner', 'kindash-ondemand']);
  });
});

describe('deriveCiGraph timeout-minutes extraction (issue #48 rule 1)', () => {
  const timeoutOf = (yaml: string, prefix: string): number | null =>
    deriveCiGraph(yaml)!.nodes.get(prefix)!.timeoutMinutes;

  it('numeric timeout-minutes is captured per job', () => {
    expect(timeoutOf(`
jobs:
  build:
    runs-on: x
    timeout-minutes: 30
  ci:
    needs: [build]
`, 'build')).toBe(30);
  });

  it('absent timeout-minutes → null (GitHub applies its 360-minute default at runtime)', () => {
    expect(timeoutOf('jobs:\n  build: {}\n  ci:\n    needs: [build]\n', 'build')).toBeNull();
    expect(timeoutOf('jobs:\n  ci: {}\n', 'ci')).toBeNull();
  });

  it('expression / non-numeric / non-positive timeout-minutes → null (unknowable)', () => {
    for (const v of ["${{ inputs.timeout }}", "'15'", '0', '-3', '[5]']) {
      expect(timeoutOf(`
jobs:
  build:
    timeout-minutes: ${v}
  ci:
    needs: [build]
`, 'build')).toBeNull();
    }
  });

  it('degraded rollup-only graph → null', () => {
    expect(deriveCiGraph('jobs:\n  other: {}\n')!.nodes.get('ci')!.timeoutMinutes).toBeNull();
  });

  it('two job keys sharing a display name keep the MINIMUM timeout (the one that cancels first)', () => {
    expect(timeoutOf(`
jobs:
  build-pr:
    name: build
    timeout-minutes: 30
  build-mg:
    name: build
    timeout-minutes: 10
  ci:
    needs: [build-pr, build-mg]
`, 'build')).toBe(10);
    // set + absent → the set one
    expect(timeoutOf(`
jobs:
  build-pr:
    name: build
    timeout-minutes: 30
  build-mg:
    name: build
  ci:
    needs: [build-pr, build-mg]
`, 'build')).toBe(30);
  });

  it('round-trips through ciGraphToJson/FromJson; legacy/corrupt values coerce to null', () => {
    const g = deriveCiGraph(`
jobs:
  build:
    timeout-minutes: 15
  ci:
    needs: [build]
`)!;
    const back = ciGraphFromJson(JSON.parse(JSON.stringify(ciGraphToJson(g))))!;
    expect(back.nodes.get('build')!.timeoutMinutes).toBe(15);
    expect(back.nodes.get('ci')!.timeoutMinutes).toBeNull();
    // tolerant on the new field only — corrupt timeoutMinutes must not reject the row
    const coerced = ciGraphFromJson({ prefixes: ['ci'],
      nodes: { ci: { needs: [], activity: { mode: 'all' }, timeoutMinutes: 'soon' } },
      workflowName: null });
    expect(coerced!.nodes.get('ci')!.timeoutMinutes).toBeNull();
  });
});

describe('fileDefinesJob — does a workflow really define this job?', () => {
  it('true only when the job key is present under jobs:', () => {
    const yaml = 'name: CI\njobs:\n  ci:\n    needs: [build]\n  build:\n    runs-on: x\n';
    expect(fileDefinesJob(yaml, 'ci')).toBe(true);
    expect(fileDefinesJob(yaml, 'build')).toBe(true);
    expect(fileDefinesJob(yaml, 'nope')).toBe(false);
  });
  it('false on a file with no jobs map or unparseable YAML', () => {
    expect(fileDefinesJob('name: just a name\n', 'ci')).toBe(false);
    expect(fileDefinesJob('not: [valid', 'ci')).toBe(false);
  });
});

describe('discoverRollupWorkflow — find the file that owns the rollup job', () => {
  const auto = { path: '.github/workflows/auto-merge.yml', text: 'name: Auto\njobs:\n  enable:\n    runs-on: x\n' };
  const renamed = { path: '.github/workflows/main.yml', text: 'name: CI\njobs:\n  ci:\n    needs: [build]\n  build:\n    runs-on: x\n' };

  it('returns the path + graph of the file defining the rollup job', () => {
    const hit = discoverRollupWorkflow([auto, renamed], 'ci');
    expect(hit?.path).toBe('.github/workflows/main.yml');
    expect(hit?.graph.prefixes).toContain('ci');
  });
  it('skips files that merely parse but do not define the rollup job', () => {
    // auto-merge.yml parses fine and deriveCiGraph would return a rollup-only
    // graph for it — discovery must NOT be fooled into selecting it.
    expect(discoverRollupWorkflow([auto], 'ci')).toBeNull();
  });
  it('honours candidate order for ties (conventional file first)', () => {
    const a = { path: 'a.yml', text: 'jobs:\n  ci:\n    runs-on: x\n' };
    const b = { path: 'b.yml', text: 'jobs:\n  ci:\n    runs-on: x\n' };
    expect(discoverRollupWorkflow([a, b], 'ci')?.path).toBe('a.yml');
  });
  it('returns null when the rollup job id was itself renamed (no file defines it)', () => {
    expect(discoverRollupWorkflow([auto, renamed], 'gate')).toBeNull();
  });
});
