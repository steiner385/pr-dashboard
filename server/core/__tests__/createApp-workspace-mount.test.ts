import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import { createApp } from '../../api';
import { createWorkspaceRouter } from '../api/workspace-router';
import { ModelDeriver, type ModelDeriveDeps } from '../model/derive';
import type { PrClient } from '../actions/draftPr';
import type { SuccessStat, FlakeStat } from '../../history';

const CI = `name: CI
on: { pull_request: {}, merge_group: {} }
jobs:
  e2e: { runs-on: ubuntu-latest, steps: [{ run: pnpm e2e }] }
`;

function workspaceRouter() {
  const deps: ModelDeriveDeps = {
    resolveHeadSha: vi.fn(async () => 'sha-1'),
    fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? CI : null)),
    successStatsByRepo: () => new Map<string, SuccessStat[]>(),
    flakeStatsByRepo: () => new Map<string, FlakeStat[]>(),
    since: '2026-01-01T00:00:00Z',
  };
  const prClient: PrClient = { fetchWorkflowAtSha: deps.fetchWorkflowAtSha as PrClient['fetchWorkflowAtSha'], openDraftPr: vi.fn() as unknown as PrClient['openDraftPr'] };
  return createWorkspaceRouter({ deriver: new ModelDeriver(deps), prClient });
}

function baseOpts() {
  return { getState: () => ({} as never), bus: new EventEmitter() };
}

describe('createApp workspace mount (strangler-fig flag)', () => {
  it('mounts /api/workspace when the router is provided', async () => {
    const app = createApp({ ...baseOpts(), workspaceRouter: workspaceRouter() });
    const res = await request(app).get('/api/workspace/pipeline?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.sourceSha).toBe('sha-1');
  });

  it('does NOT mount the route when the router is absent (flag off — app unchanged)', async () => {
    const app = createApp(baseOpts());
    expect((await request(app).get('/api/workspace/pipeline?repo=o/r')).status).toBe(404);
  });

  it('same-origin guard gates the mutating POST routes', async () => {
    const app = createApp({ ...baseOpts(), workspaceRouter: workspaceRouter() });
    const res = await request(app).post('/api/workspace/simulate')
      .set('sec-fetch-site', 'cross-site')
      .send({ repo: 'o/r', move: { check: 'e2e', fromTierId: 'pr', toTierId: null } });
    expect(res.status).toBe(403);
  });
});
