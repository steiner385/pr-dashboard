import { describe, it, expect, vi } from 'vitest';
import { projectCandidate } from '../model/candidate';
import { ModelDeriver, type ModelDeriveDeps } from '../model/derive';

const CI = `name: CI
on: { pull_request: {}, merge_group: {} }
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps: [{ run: pnpm e2e }]
  ci:
    name: ci
    needs: [e2e]
    runs-on: ubuntu-latest
`;
const deps = (): ModelDeriveDeps => ({
  resolveHeadSha: vi.fn(async () => 'sha-1'),
  fetchWorkflowAtSha: vi.fn(async (_r: string, n: string) => (n === 'ci.yml' ? CI : null)),
  successStatsByRepo: () => new Map(), flakeStatsByRepo: () => new Map(), since: '2026-01-01T00:00:00Z',
});
const fetchAt = (file: string) => Promise.resolve(file === 'ci.yml' ? CI : null);

describe('projectCandidate', () => {
  it('applies a timeout mutation and returns a clean candidate (no gating regression)', async () => {
    const d = new ModelDeriver(deps());
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    const res = await projectCandidate(d, fetchAt, baseline, [{ op: 'timeout', jobId: 'e2e', minutes: 10 }]);
    expect(res.ok).toBe(true);
    expect(res.files.map((f) => f.file)).toEqual(['ci.yml']);
    expect(res.validation.gatingRegressed).toBe(false);
    expect(res.model).not.toBeNull();
  });

  it('flags gatingRegressed when a mutation drops a required gate (remove e2e)', async () => {
    const d = new ModelDeriver(deps());
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    const res = await projectCandidate(d, fetchAt, baseline, [{ op: 'remove', jobId: 'e2e' }]);
    expect(res.ok).toBe(true);
    expect(res.validation.gatingRegressed).toBe(true);
    expect(res.validation.lostGates).toContain('e2e');
  });

  it('refuses (ok:false) when a renderer refuses (missing job)', async () => {
    const d = new ModelDeriver(deps());
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    const res = await projectCandidate(d, fetchAt, baseline, [{ op: 'timeout', jobId: 'nope', minutes: 10 }]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/locate job|cannot resolve|nope/);
  });

  it('refuses pin-action (documented follow-on)', async () => {
    const d = new ModelDeriver(deps());
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    const res = await projectCandidate(d, fetchAt, baseline, [{ op: 'pin-action', usesRef: 'actions/checkout@v4', sha: '1'.repeat(40) }]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/pin-action/);
  });
});

describe('projectRawYaml (escape hatch)', () => {
  it('re-derives from an edited file and reports no regression for a benign edit', async () => {
    const { projectRawYaml } = await import('../model/candidate');
    const d = new ModelDeriver(deps());
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    const edited = CI.replace('    runs-on: ubuntu-latest\n    steps: [{ run: pnpm e2e }]', '    runs-on: ubuntu-latest\n    timeout-minutes: 12\n    steps: [{ run: pnpm e2e }]');
    const res = await projectRawYaml(d, baseline, 'ci.yml', edited);
    expect(res.ok).toBe(true);
    expect(res.validation.gatingRegressed).toBe(false);
  });

  it('flags gatingRegressed when the edit removes a required gate job', async () => {
    const { projectRawYaml } = await import('../model/candidate');
    const d = new ModelDeriver(deps());
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    // remove the e2e job and its needs entry
    const edited = `name: CI\non: { pull_request: {}, merge_group: {} }\njobs:\n  ci:\n    name: ci\n    needs: []\n    runs-on: ubuntu-latest\n`;
    const res = await projectRawYaml(d, baseline, 'ci.yml', edited);
    expect(res.ok).toBe(true);
    expect(res.validation.gatingRegressed).toBe(true);
    expect(res.validation.lostGates).toContain('e2e');
  });

  it('refuses a file that is not part of the pipeline (allowlist)', async () => {
    const { projectRawYaml } = await import('../model/candidate');
    const d = new ModelDeriver(deps());
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    const res = await projectRawYaml(d, baseline, 'evil.yml', 'jobs: {}');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not a workflow file/);
  });
});
