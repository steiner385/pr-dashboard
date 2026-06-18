import { describe, it, expect, vi } from 'vitest';
import { ModelDeriver, type ModelDeriveDeps } from '../model/derive';
import type { SuccessStat, FlakeStat } from '../../history';

const CI = `
on:
  pull_request:
  merge_group:
jobs:
  build:
    name: "build: production"
    needs: [static]
    runs-on: ubuntu-latest
  static:
    uses: ./.github/workflows/_static.yml
  ci:
    name: ci
    needs: [build, static]
    runs-on: ubuntu-latest
`;
const STATIC = `
on: { workflow_call: {} }
jobs:
  unit:
    name: "test: unit"
    runs-on: ubuntu-latest
`;

function makeDeps(overrides: Partial<ModelDeriveDeps> = {}): ModelDeriveDeps {
  return {
    resolveHeadSha: vi.fn(async () => 'sha-HEAD'),
    fetchWorkflowAtSha: vi.fn(async (_repo, name, _sha) =>
      name === 'ci.yml' ? CI : name === '_static.yml' ? STATIC : null),
    successStatsByRepo: () => new Map<string, SuccessStat[]>(),
    flakeStatsByRepo: () => new Map<string, FlakeStat[]>(),
    since: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ModelDeriver (Tier-2 SHA-pinned deriver)', () => {
  it('derives a model pinned to the requested SHA', async () => {
    const d = new ModelDeriver(makeDeps());
    const pinned = await d.deriveAtSha('o/r', 'sha-123');
    expect(pinned).not.toBeNull();
    expect(pinned!.sourceSha).toBe('sha-123');
    expect(pinned!.model.checks).toContain('build: production'); // direct job → no caller prefix
    expect(pinned!.model.checks).toContain('static / test: unit'); // uses: caller → leaf expanded
    expect(pinned!.model.cells.length).toBeGreaterThan(0);
  });

  it('fetches workflow blobs AT the pinned SHA (passes the ref through)', async () => {
    const deps = makeDeps();
    const d = new ModelDeriver(deps);
    await d.deriveAtSha('o/r', 'sha-XYZ');
    expect(deps.fetchWorkflowAtSha).toHaveBeenCalledWith('o/r', 'ci.yml', 'sha-XYZ');
    expect(deps.fetchWorkflowAtSha).toHaveBeenCalledWith('o/r', '_static.yml', 'sha-XYZ');
  });

  it('caches by (repo, sha) — a second derive at the same SHA does not refetch', async () => {
    const deps = makeDeps();
    const d = new ModelDeriver(deps);
    await d.deriveAtSha('o/r', 'sha-1');
    const callsAfterFirst = (deps.fetchWorkflowAtSha as ReturnType<typeof vi.fn>).mock.calls.length;
    await d.deriveAtSha('o/r', 'sha-1');
    expect((deps.fetchWorkflowAtSha as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
    // a different SHA DOES refetch
    await d.deriveAtSha('o/r', 'sha-2');
    expect((deps.fetchWorkflowAtSha as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('deriveAtHead resolves HEAD then pins to it', async () => {
    const deps = makeDeps({ resolveHeadSha: vi.fn(async () => 'sha-HEAD-9') });
    const d = new ModelDeriver(deps);
    const pinned = await d.deriveAtHead('o/r');
    expect(pinned!.sourceSha).toBe('sha-HEAD-9');
  });

  it('checkPin reports current=false when HEAD has drifted (FR-026 optimistic concurrency)', async () => {
    const deps = makeDeps({ resolveHeadSha: vi.fn(async () => 'sha-NEW') });
    const d = new ModelDeriver(deps);
    const r = await d.checkPin('o/r', 'sha-OLD');
    expect(r).toEqual({ current: false, headSha: 'sha-NEW' });
    const r2 = await d.checkPin('o/r', 'sha-NEW');
    expect(r2.current).toBe(true);
  });

  it('returns null when no derivable ci.yml at the SHA', async () => {
    const d = new ModelDeriver(makeDeps({ fetchWorkflowAtSha: vi.fn(async () => null) }));
    expect(await d.deriveAtSha('o/r', 'sha-x')).toBeNull();
  });

  it('cacheStats tracks hits/misses/hitRate (Group O)', async () => {
    const d = new ModelDeriver(makeDeps());
    await d.deriveAtSha('o/r', 'sha-1'); // miss
    await d.deriveAtSha('o/r', 'sha-1'); // hit
    await d.deriveAtSha('o/r', 'sha-2'); // miss
    const s = d.cacheStats();
    expect(s).toMatchObject({ hits: 1, misses: 2, size: 2 });
    expect(s.hitRate).toBeCloseTo(1 / 3);
  });

  it('invalidate drops cached entries for a repo', async () => {
    const deps = makeDeps();
    const d = new ModelDeriver(deps);
    await d.deriveAtSha('o/r', 'sha-1');
    const before = (deps.fetchWorkflowAtSha as ReturnType<typeof vi.fn>).mock.calls.length;
    d.invalidate('o/r');
    await d.deriveAtSha('o/r', 'sha-1'); // must refetch after invalidation
    expect((deps.fetchWorkflowAtSha as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
  });
});

describe('deriveWithOverrides (candidate re-derivation from mutated YAML)', () => {
  const CI_E2E = `name: CI\non: { pull_request: {}, merge_group: {} }\njobs:\n  e2e:\n    runs-on: ubuntu-latest\n    steps: [{ run: pnpm e2e }]\n  ci:\n    name: ci\n    needs: [e2e]\n    runs-on: ubuntu-latest\n`;
  const odeps = (): ModelDeriveDeps => ({
    resolveHeadSha: vi.fn(async () => 'sha-1'),
    fetchWorkflowAtSha: vi.fn(async (_r: string, n: string) => (n === 'ci.yml' ? CI_E2E : null)),
    successStatsByRepo: () => new Map(), flakeStatsByRepo: () => new Map(), since: '2026-01-01T00:00:00Z',
  });

  it('uses the override text for the named file and re-derives', async () => {
    const d = new ModelDeriver(odeps());
    const mutated = CI_E2E.replace('  e2e:\n    runs-on: ubuntu-latest', '  e2e:\n    timeout-minutes: 10\n    runs-on: ubuntu-latest');
    const model = await d.deriveWithOverrides('o/r', 'sha-1', { 'ci.yml': mutated });
    expect(model).not.toBeNull();
    expect(model!.checks).toContain('e2e');
  });

  it('returns null when ci.yml cannot be derived (override empty + none fetched)', async () => {
    const d = new ModelDeriver({ ...odeps(), fetchWorkflowAtSha: vi.fn(async () => null) });
    expect(await d.deriveWithOverrides('o/r', 'sha-1', {})).toBeNull();
  });
});
