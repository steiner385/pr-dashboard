import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createWorkspaceRouter } from '../api/workspace-router';
import { ModelDeriver, type ModelDeriveDeps } from '../model/derive';
import type { PrClient } from '../actions/draftPr';
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

let openDraftPr: ReturnType<typeof vi.fn>;
function app(headSeq?: string[]) {
  const heads = headSeq ?? ['sha-1'];
  let i = 0;
  const deps: ModelDeriveDeps = {
    resolveHeadSha: vi.fn(async () => heads[Math.min(i++, heads.length - 1)]),
    fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? CI : null)),
    successStatsByRepo: () => new Map<string, SuccessStat[]>(),
    flakeStatsByRepo: () => new Map<string, FlakeStat[]>(),
    since: '2026-01-01T00:00:00Z',
  };
  const deriver = new ModelDeriver(deps);
  openDraftPr = vi.fn(async () => ({ number: 7, url: 'https://github.com/o/r/pull/7' }));
  const prClient: PrClient = {
    fetchWorkflowAtSha: deps.fetchWorkflowAtSha as unknown as PrClient['fetchWorkflowAtSha'],
    openDraftPr: openDraftPr as unknown as PrClient['openDraftPr'],
  };
  const a = express();
  a.use(express.json());
  a.use('/api/workspace', createWorkspaceRouter({ deriver, prClient }));
  return a;
}

describe('workspace-router (integration, contracts/api.md)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /pipeline returns the SHA-pinned model', async () => {
    const res = await request(app()).get('/api/workspace/pipeline?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.sourceSha).toBe('sha-1');
    expect(res.body.model.checks).toContain('e2e');
  });

  it('400 on a malformed repo', async () => {
    expect((await request(app()).get('/api/workspace/pipeline?repo=bad')).status).toBe(400);
  });

  it('POST /simulate returns a legality-bound projection', async () => {
    const res = await request(app()).post('/api/workspace/simulate')
      .send({ repo: 'o/r', move: { check: 'e2e', fromTierId: 'queue', toTierId: null } });
    expect(res.status).toBe(200);
    expect(res.body.legal).toBe(false); // e2e is the required merge gate
    expect(res.body.reason).toBe('required-gate');
  });

  it('POST /draft-pr dryRun returns a diff preview without opening a PR', async () => {
    const res = await request(app()).post('/api/workspace/draft-pr')
      .send({ repo: 'o/r', dryRun: true, intent: { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'pr', targetEvent: 'merge_group' } });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.diff).toMatch(/merge_group/);
    expect(openDraftPr).not.toHaveBeenCalled();
  });

  it('POST /draft-pr (dryRun:false) opens a draft PR when HEAD is stable', async () => {
    const res = await request(app()).post('/api/workspace/draft-pr')
      .send({ repo: 'o/r', dryRun: false, intent: { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'pr', targetEvent: 'merge_group' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ opened: true, number: 7, url: 'https://github.com/o/r/pull/7' });
  });

  it('POST /draft-pr 409s an illegal intent (required-gate)', async () => {
    const res = await request(app()).post('/api/workspace/draft-pr')
      .send({ repo: 'o/r', dryRun: false, intent: { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'queue', targetEvent: 'push' } });
    expect(res.status).toBe(409);
  });

  it('GET /changelog returns config timeline + action audit from injected providers (Group L)', async () => {
    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn(async () => 'sha-1'), fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? CI : null)),
      successStatsByRepo: () => new Map<string, SuccessStat[]>(), flakeStatsByRepo: () => new Map<string, FlakeStat[]>(), since: '2026-01-01T00:00:00Z',
    };
    const a = express(); a.use(express.json());
    a.use('/api/workspace', createWorkspaceRouter({
      deriver: new ModelDeriver(deps),
      prClient: { fetchWorkflowAtSha: deps.fetchWorkflowAtSha as PrClient['fetchWorkflowAtSha'], openDraftPr: vi.fn() as unknown as PrClient['openDraftPr'] },
      changelog: async () => [{ at: '2026-06-10T00:00:00Z', kind: 'config', summary: 'retention 7→30d', actor: 'tony' }],
      auditLog: async () => [{ at: '2026-06-11T00:00:00Z', action: 'draft-pr', repo: 'o/r', target: 'e2e', result: 'opened #5' }],
    }));
    const res = await request(a).get('/api/workspace/changelog?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.changelog[0].summary).toBe('retention 7→30d');
    expect(res.body.audit[0]).toMatchObject({ action: 'draft-pr', actor: 'workspace' });
  });

  it('GET /changelog degrades to empty arrays with no providers', async () => {
    const res = await request(app()).get('/api/workspace/changelog?repo=o/r');
    expect(res.body).toMatchObject({ changelog: [], audit: [] });
  });

  it('GET /outcomes attributes projected-vs-realized from an injected ledger (Group H)', async () => {
    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn(async () => 'sha-1'), fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? CI : null)),
      successStatsByRepo: () => new Map<string, SuccessStat[]>(), flakeStatsByRepo: () => new Map<string, FlakeStat[]>(), since: '2026-01-01T00:00:00Z',
    };
    const a = express(); a.use(express.json());
    a.use('/api/workspace', createWorkspaceRouter({
      deriver: new ModelDeriver(deps),
      prClient: { fetchWorkflowAtSha: deps.fetchWorkflowAtSha as PrClient['fetchWorkflowAtSha'], openDraftPr: vi.fn() as unknown as PrClient['openDraftPr'] },
      outcomes: async () => [{ prNumber: 5, check: 'e2e', projected: { costDeltaMinutes: -1000, coverageDelta: 0 }, realized: { costDeltaMinutes: -980, coverageDelta: 0 }, windowDays: 21 }],
    }));
    const res = await request(a).get('/api/workspace/outcomes?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.outcomes[0].costAccuracy).toBeGreaterThan(0.9);
    expect(res.body.outcomes[0].caveat).toMatch(/confounded/);
    expect(res.body.accuracy).toMatchObject({ count: 1, recommenderUsable: false });
  });

  it('GET /forecast degrades to available:false when no cost series is wired', async () => {
    const res = await request(app()).get('/api/workspace/forecast?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it('GET /forecast projects days-to-threshold from an injected series (Group J1)', async () => {
    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn(async () => 'sha-1'), fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? CI : null)),
      successStatsByRepo: () => new Map<string, SuccessStat[]>(), flakeStatsByRepo: () => new Map<string, FlakeStat[]>(), since: '2026-01-01T00:00:00Z',
    };
    const a = express(); a.use(express.json());
    a.use('/api/workspace', createWorkspaceRouter({
      deriver: new ModelDeriver(deps),
      prClient: { fetchWorkflowAtSha: deps.fetchWorkflowAtSha as PrClient['fetchWorkflowAtSha'], openDraftPr: vi.fn() as unknown as PrClient['openDraftPr'] },
      costForecast: async () => ({ points: Array.from({ length: 30 }, (_, i) => ({ day: i, value: 100 + 10 * i })), thresholdValue: 500, unit: 'minutes' }),
    }));
    const res = await request(a).get('/api/workspace/forecast?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.daysToThreshold).toBe(11);
    expect(res.body.confidence).toBe('high');
  });

  it('GET /ruleset degrades to readable:false when no ruleset reader is wired (no silent mismatch)', async () => {
    const res = await request(app()).get('/api/workspace/ruleset?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.readable).toBe(false);
    expect(res.body.inSync).toBe(false);
  });

  it('GET /ruleset reconciles against an injected live ruleset (Group I1)', async () => {
    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn(async () => 'sha-1'),
      fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? CI : null)),
      successStatsByRepo: () => new Map<string, SuccessStat[]>(),
      flakeStatsByRepo: () => new Map<string, FlakeStat[]>(), since: '2026-01-01T00:00:00Z',
    };
    const deriver = new ModelDeriver(deps);
    const prClient: PrClient = { fetchWorkflowAtSha: deps.fetchWorkflowAtSha as PrClient['fetchWorkflowAtSha'], openDraftPr: vi.fn() as unknown as PrClient['openDraftPr'] };
    // the live ruleset requires a check the static model doesn't flag → missingFromModel
    const a = express(); a.use(express.json());
    a.use('/api/workspace', createWorkspaceRouter({ deriver, prClient, liveRuleset: async () => ['totally-required-check'] }));
    const res = await request(a).get('/api/workspace/ruleset?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.readable).toBe(true);
    expect(res.body.missingFromModel).toContain('totally-required-check');
  });

  it('GET /policy evaluates authored rules against the model (Group I2)', async () => {
    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn(async () => 'sha-1'), fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? CI : null)),
      successStatsByRepo: () => new Map<string, SuccessStat[]>(), flakeStatsByRepo: () => new Map<string, FlakeStat[]>(), since: '2026-01-01T00:00:00Z',
    };
    const a = express(); a.use(express.json());
    a.use('/api/workspace', createWorkspaceRouter({
      deriver: new ModelDeriver(deps),
      prClient: { fetchWorkflowAtSha: deps.fetchWorkflowAtSha as PrClient['fetchWorkflowAtSha'], openDraftPr: vi.fn() as unknown as PrClient['openDraftPr'] },
      policyStore: { get: async () => [{ id: 'p1', kind: 'required-gate-runs-on-pr' }] },
    }));
    const res = await request(a).get('/api/workspace/policy?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(1);
    expect(Array.isArray(res.body.violations)).toBe(true); // e2e is the queue-only required gate in CI
  });

  it('PUT /policy 501s when the store is read-only', async () => {
    const res = await request(app()).put('/api/workspace/policy?repo=o/r').send({ rules: [] });
    expect(res.status).toBe(501);
  });

  it('POST /plan composites a multi-move simulation (N2)', async () => {
    const res = await request(app()).post('/api/workspace/plan')
      .send({ repo: 'o/r', moves: [{ check: 'e2e', fromTierId: 'pr', toTierId: 'queue' }] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('combinedCostDeltaMinutes');
    expect(res.body).toHaveProperty('legal');
  });

  it('POST /plan 400s without moves', async () => {
    expect((await request(app()).post('/api/workspace/plan').send({ repo: 'o/r' })).status).toBe(400);
  });

  it('POST /quarantine refuses a required merge gate (FR-038) and dry-runs a non-gate', async () => {
    const QCI = `name: CI
on: { pull_request: {}, merge_group: {} }
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm e2e
  lint:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: pnpm lint
  ci:
    name: ci
    needs: [e2e]
    runs-on: ubuntu-latest
`;
    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn(async () => 'sha-1'), fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? QCI : null)),
      successStatsByRepo: () => new Map<string, SuccessStat[]>(), flakeStatsByRepo: () => new Map<string, FlakeStat[]>(), since: '2026-01-01T00:00:00Z',
    };
    const a = express(); a.use(express.json());
    a.use('/api/workspace', createWorkspaceRouter({
      deriver: new ModelDeriver(deps),
      prClient: { fetchWorkflowAtSha: deps.fetchWorkflowAtSha as PrClient['fetchWorkflowAtSha'], openDraftPr: vi.fn() as unknown as PrClient['openDraftPr'] },
    }));
    // e2e is the required merge gate → refused
    const bad = await request(a).post('/api/workspace/quarantine').send({ repo: 'o/r', check: 'e2e', jobId: 'e2e', dryRun: true });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatch(/required merge gate/);
    // lint is PR-only advisory → quarantine dry-run returns a diff
    const ok = await request(a).post('/api/workspace/quarantine').send({ repo: 'o/r', check: 'lint', jobId: 'lint', dryRun: true });
    expect(ok.status).toBe(200);
    expect(ok.body.diff).toMatch(/continue-on-error/);
  });

  it('GET /self reports tool health incl. derivation-cache stats (Group O)', async () => {
    const res = await request(app()).get('/api/workspace/self');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok'); // no selfHealth dep → nulls → ok
    expect(res.body.derivationCache).toMatchObject({ hits: expect.any(Number), misses: expect.any(Number) });
  });

  it('GET /security audits the model workflow files and reports findings + confidence', async () => {
    const VULN = `name: CI
on: { pull_request: {}, pull_request_target: {}, merge_group: {} }
jobs:
  e2e: { runs-on: ubuntu-latest, steps: [{ uses: actions/checkout@v4 }] }
  ci: { name: ci, needs: [e2e], runs-on: ubuntu-latest }
`;
    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn(async () => 'sha-1'),
      fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? VULN : null)),
      successStatsByRepo: () => new Map<string, SuccessStat[]>(),
      flakeStatsByRepo: () => new Map<string, FlakeStat[]>(), since: '2026-01-01T00:00:00Z',
    };
    const deriver = new ModelDeriver(deps);
    const prClient: PrClient = { fetchWorkflowAtSha: deps.fetchWorkflowAtSha as PrClient['fetchWorkflowAtSha'], openDraftPr: vi.fn() as unknown as PrClient['openDraftPr'] };
    const a = express(); a.use(express.json()); a.use('/api/workspace', createWorkspaceRouter({ deriver, prClient }));
    const res = await request(a).get('/api/workspace/security?repo=o/r');
    expect(res.status).toBe(200);
    const kinds = res.body.findings.map((f: { kind: string }) => f.kind);
    expect(kinds).toContain('pull_request_target');
    expect(kinds).toContain('unpinned-action');
    expect(res.body.scannedFiles).toBeGreaterThan(0);
  });

  it('POST /draft-pr 409s with headSha when HEAD drifts (FR-026)', async () => {
    const res = await request(app(['sha-1', 'sha-2'])).post('/api/workspace/draft-pr')
      .send({ repo: 'o/r', dryRun: false, intent: { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'pr', targetEvent: 'merge_group' } });
    expect(res.status).toBe(409);
    expect(res.body.headSha).toBe('sha-2');
    expect(openDraftPr).not.toHaveBeenCalled();
  });
});
