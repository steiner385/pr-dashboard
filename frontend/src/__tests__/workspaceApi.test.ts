import { describe, it, expect, vi } from 'vitest';
import { makeWorkspaceApi } from '../shell/workspaceApi';

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('makeWorkspaceApi', () => {
  it('getPipeline GETs /pipeline with the repo query', async () => {
    const fetchImpl = vi.fn(async () => res(200, { repo: 'o/r', sourceSha: 's', model: { tiers: [], checks: [], cells: [], checkMeta: [] } }));
    const api = makeWorkspaceApi(fetchImpl as unknown as typeof fetch);
    const out = await api.getPipeline('o/r');
    expect(out.sourceSha).toBe('s');
    expect(fetchImpl).toHaveBeenCalledWith('/api/workspace/pipeline?repo=o%2Fr');
  });

  it('simulate POSTs the move and returns the verdict', async () => {
    const fetchImpl = vi.fn(async () => res(200, { legal: false, reason: 'required-gate', note: 'not possible', costDeltaMinutes: 0, direction: 'remove', gatesLost: [], gatesGained: [], estimated: false }));
    const api = makeWorkspaceApi(fetchImpl as unknown as typeof fetch);
    const out = await api.simulate('o/r', { check: 'build', fromTierId: 'queue', toTierId: null });
    expect(out.legal).toBe(false);
    const [, init] = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ repo: 'o/r', move: { check: 'build' } });
  });

  it('draftPrDryRun returns the diff preview', async () => {
    const fetchImpl = vi.fn(async () => res(200, { dryRun: true, diff: '@@ x @@', baseSha: 'abc' }));
    const api = makeWorkspaceApi(fetchImpl as unknown as typeof fetch);
    const out = await api.draftPrDryRun('o/r', { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'pr', targetEvent: 'merge_group' });
    expect(out.diff).toBe('@@ x @@');
    const [, dryInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(dryInit.body as string)).toMatchObject({ dryRun: true });
  });

  it('throws the server error message on a non-2xx (e.g. 409 illegal)', async () => {
    const fetchImpl = vi.fn(async () => res(409, { error: 'required merge gate — cannot remove it' }));
    const api = makeWorkspaceApi(fetchImpl as unknown as typeof fetch);
    await expect(api.draftPrOpen('o/r', { kind: 'tier', check: 'ci', jobId: 'ci', fromTierId: 'queue', targetEvent: 'push' }))
      .rejects.toThrow(/required merge gate/);
  });
});
