import { describe, it, expect, vi } from 'vitest';
import { applyCandidate, type OpenMultiFile } from '../actions/applyCandidate';
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
const deps = (head = 'sha-1'): ModelDeriveDeps => ({
  resolveHeadSha: vi.fn(async () => head),
  fetchWorkflowAtSha: vi.fn(async (_r: string, n: string) => (n === 'ci.yml' ? CI : null)),
  successStatsByRepo: () => new Map(), flakeStatsByRepo: () => new Map(), since: '2026-01-01T00:00:00Z',
});
const fetchAt = (file: string) => Promise.resolve(file === 'ci.yml' ? CI : null);
const opener = (): OpenMultiFile => vi.fn(async () => ({ number: 7, url: 'https://example/pr/7' }));

describe('applyCandidate', () => {
  it('opens a multi-file draft PR for a clean candidate (HEAD unchanged)', async () => {
    const d = new ModelDeriver(deps());
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    const open = opener();
    const res = await applyCandidate(d, fetchAt, open, baseline, [{ op: 'timeout', jobId: 'e2e', minutes: 10 }]);
    expect(res).toEqual({ ok: true, number: 7, url: 'https://example/pr/7' });
    const arg = (open as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.files[0].filePath).toBe('.github/workflows/ci.yml');
    expect(arg.files[0].newText).toContain('timeout-minutes: 10');
  });

  it('refuses (no PR) when the candidate drops a required gate', async () => {
    const d = new ModelDeriver(deps());
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    const open = opener();
    const res = await applyCandidate(d, fetchAt, open, baseline, [{ op: 'remove', jobId: 'e2e' }]);
    expect(res.ok).toBe(false);
    if (!res.ok && !res.stale) expect(res.reason).toMatch(/required gate/);
    expect(open).not.toHaveBeenCalled();
  });

  it('signals stale when HEAD has drifted (optimistic concurrency)', async () => {
    // deriver derived at sha-1, but resolveHeadSha now returns sha-2
    const d = new ModelDeriver({ ...deps('sha-2') });
    const baseline = (await d.deriveAtSha('o/r', 'sha-1'))!;
    const open = opener();
    const res = await applyCandidate(d, fetchAt, open, baseline, [{ op: 'timeout', jobId: 'e2e', minutes: 10 }]);
    expect(res).toEqual({ ok: false, stale: true, headSha: 'sha-2' });
    expect(open).not.toHaveBeenCalled();
  });
});
