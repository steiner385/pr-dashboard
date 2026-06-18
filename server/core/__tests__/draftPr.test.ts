import { describe, it, expect, vi } from 'vitest';
import { prepareDraftEdit, openDraftPr, type PrClient, type TierAssignIntent } from '../actions/draftPr';
import { ModelDeriver, type ModelDeriveDeps } from '../model/derive';
import type { SuccessStat, FlakeStat } from '../../history';

const CI = `name: CI
on:
  pull_request:
  merge_group:
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps: [{ run: pnpm e2e }]
  ci:
    name: ci
    needs: [e2e]
    runs-on: ubuntu-latest
`;

function deriverWith(head: string): { deriver: ModelDeriver; deps: ModelDeriveDeps } {
  const deps: ModelDeriveDeps = {
    resolveHeadSha: vi.fn(async () => head),
    fetchWorkflowAtSha: vi.fn(async (_r, name) => (name === 'ci.yml' ? CI : null)),
    successStatsByRepo: () => new Map<string, SuccessStat[]>(),
    flakeStatsByRepo: () => new Map<string, FlakeStat[]>(),
    since: '2026-01-01T00:00:00Z',
  };
  return { deriver: new ModelDeriver(deps), deps };
}
function client(headFetch = CI): PrClient {
  return {
    fetchWorkflowAtSha: vi.fn(async (_r, name) => (name === 'ci.yml' ? headFetch : null)),
    openDraftPr: vi.fn(async () => ({ number: 42, url: 'https://github.com/o/r/pull/42' })),
  };
}
const intent: TierAssignIntent = { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'pr', targetEvent: 'merge_group' };

describe('prepareDraftEdit (FR-026 phase 1)', () => {
  it('derives @HEAD, renders the edit, and returns the pinned base SHA', async () => {
    const { deriver } = deriverWith('sha-HEAD');
    const r = await prepareDraftEdit(deriver, client(), 'o/r', intent);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.baseSha).toBe('sha-HEAD');
    expect(r.prepared.filePath).toBe('.github/workflows/ci.yml');
    expect(r.prepared.newText).toMatch(/event_name == 'merge_group'/);
  });

  it('refuses an illegal change (re-validated on the fresh model)', async () => {
    const { deriver } = deriverWith('sha-HEAD');
    // e2e is the required merge gate (gates at the queue tier); moving it off the
    // queue must be refused on the freshly-derived model (FR-033).
    const bad: TierAssignIntent = { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'queue', targetEvent: 'push' };
    const r = await prepareDraftEdit(deriver, client(), 'o/r', bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/required merge gate/);
  });
});

describe('openDraftPr (FR-026 phase 2 — optimistic concurrency)', () => {
  it('opens a draft PR when HEAD has not moved', async () => {
    const { deriver } = deriverWith('sha-1');
    const prep = await prepareDraftEdit(deriver, client(), 'o/r', intent);
    if (!prep.ok) throw new Error('prep failed');
    const c = client();
    const r = await openDraftPr(deriver, c, prep.prepared, 'e2e');
    expect(r).toEqual({ opened: true, number: 42, url: 'https://github.com/o/r/pull/42' });
    expect(c.openDraftPr).toHaveBeenCalledOnce();
  });

  it('aborts and signals stale when HEAD drifts between prepare and open (never opens against an unseen base)', async () => {
    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn().mockResolvedValueOnce('sha-1').mockResolvedValue('sha-2'), // moves after prepare
      fetchWorkflowAtSha: vi.fn(async (_r, name) => (name === 'ci.yml' ? CI : null)),
      successStatsByRepo: () => new Map(), flakeStatsByRepo: () => new Map(), since: '2026-01-01T00:00:00Z',
    };
    const deriver = new ModelDeriver(deps);
    const prep = await prepareDraftEdit(deriver, client(), 'o/r', intent);
    if (!prep.ok) throw new Error('prep failed');
    const c = client();
    const r = await openDraftPr(deriver, c, prep.prepared, 'e2e');
    expect(r).toEqual({ opened: false, stale: true, headSha: 'sha-2' });
    expect(c.openDraftPr).not.toHaveBeenCalled(); // crucial: no PR opened against the drifted base
  });
});
