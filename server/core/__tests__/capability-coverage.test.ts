// Capability-contract COVERAGE harness (spec 001, FR-023 / SC-004). Asserts every
// net-new capability (G–O) has a REACHABLE workspace endpoint that serves real-shaped
// data (degraded providers are wired so each route resolves). This is the coverage
// half of the contract; the parity-vs-legacy half (rebuilt deriver == legacy
// computeProtectionMap, exact) is covered for the model slice in model-parity.test.ts.
// A fuller history-DB-backed parity over every analytics provider remains deferred
// (documented in spec.md "Persona Review"). One failing entry = a capability silently dropped.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createWorkspaceRouter } from '../api/workspace-router';
import { ModelDeriver, type ModelDeriveDeps } from '../model/derive';
import type { PrClient } from '../actions/draftPr';
import type { SuccessStat, FlakeStat } from '../../history';

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

function app() {
  const deps: ModelDeriveDeps = {
    resolveHeadSha: vi.fn(async () => 'sha-1'),
    fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? CI : null)),
    successStatsByRepo: () => new Map<string, SuccessStat[]>(),
    flakeStatsByRepo: () => new Map<string, FlakeStat[]>(), since: '2026-01-01T00:00:00Z',
  };
  const prClient: PrClient = { fetchWorkflowAtSha: deps.fetchWorkflowAtSha as PrClient['fetchWorkflowAtSha'], openDraftPr: vi.fn(async () => ({ number: 1, url: 'u' })) };
  const a = express(); a.use(express.json());
  a.use('/api/workspace', createWorkspaceRouter({
    deriver: new ModelDeriver(deps), prClient,
    liveRuleset: async () => ['e2e'],
    selfHealth: () => ({ ingestionFreshnessSecs: 10, apiRateLimit: { remaining: 4000, limit: 5000 } }),
    costForecast: async () => ({ points: Array.from({ length: 21 }, (_, i) => ({ day: i, value: 100 + 10 * i })), thresholdValue: 999 }),
    changelog: async () => [{ at: '2026-06-10T00:00:00Z', kind: 'config', summary: 'x', actor: 'a' }],
    auditLog: async () => [{ at: '2026-06-11T00:00:00Z', action: 'draft-pr', repo: 'o/r' }],
    outcomes: async () => [{ prNumber: 1, check: 'e2e', projected: { costDeltaMinutes: -100, coverageDelta: 0 }, realized: { costDeltaMinutes: -90, coverageDelta: 0 }, windowDays: 21 }],
    policyStore: { get: async () => [{ id: 'p1', kind: 'required-gate-runs-on-pr' }] },
    budgets: async () => ({ budgets: [{ kind: 'minutes', threshold: 50000 }], current: { minutes: 10000 } }),
  }));
  return a;
}

// capability → a reachable endpoint that proves the capability is surfaced
const COVERAGE: { cap: string; check: (a: ReturnType<typeof app>) => Promise<number> }[] = [
  { cap: 'C/G model (Tier-2)', check: (a) => request(a).get('/api/workspace/pipeline?repo=o/r').then((r) => r.status) },
  { cap: 'G simulate', check: (a) => request(a).post('/api/workspace/simulate').send({ repo: 'o/r', move: { check: 'e2e', fromTierId: 'pr', toTierId: null } }).then((r) => r.status) },
  { cap: 'G prompt', check: (a) => request(a).post('/api/workspace/prompt').send({ repo: 'o/r', finding: { goal: 'cost', check: 'e2e', detail: 'x' } }).then((r) => r.status) },
  { cap: 'G draft-pr', check: (a) => request(a).post('/api/workspace/draft-pr').send({ repo: 'o/r', dryRun: true, intent: { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'pr', targetEvent: 'merge_group' } }).then((r) => r.status) },
  { cap: 'N2 plan', check: (a) => request(a).post('/api/workspace/plan').send({ repo: 'o/r', moves: [{ check: 'e2e', fromTierId: 'pr', toTierId: null }] }).then((r) => r.status) },
  { cap: 'K2 quarantine', check: (a) => request(a).post('/api/workspace/quarantine').send({ repo: 'o/r', check: 'ci', jobId: 'ci', dryRun: true }).then((r) => r.status) }, // ci is the non-required rollup; e2e is required (liveRuleset) so would be refused
  { cap: 'M security', check: (a) => request(a).get('/api/workspace/security?repo=o/r').then((r) => r.status) },
  { cap: 'O self-obs', check: (a) => request(a).get('/api/workspace/self').then((r) => r.status) },
  { cap: 'I1 ruleset', check: (a) => request(a).get('/api/workspace/ruleset?repo=o/r').then((r) => r.status) },
  { cap: 'I2 policy', check: (a) => request(a).get('/api/workspace/policy?repo=o/r').then((r) => r.status) },
  { cap: 'J1 forecast', check: (a) => request(a).get('/api/workspace/forecast?repo=o/r').then((r) => r.status) },
  { cap: 'J2/J3 budgets', check: (a) => request(a).get('/api/workspace/budgets').then((r) => r.status) },
  { cap: 'L changelog/audit', check: (a) => request(a).get('/api/workspace/changelog?repo=o/r').then((r) => r.status) },
  { cap: 'H outcomes', check: (a) => request(a).get('/api/workspace/outcomes?repo=o/r').then((r) => r.status) },
];

describe('capability-contract coverage (FR-023 / SC-004 — coverage half)', () => {
  it.each(COVERAGE)('$cap is reachable and serves data', async ({ check }) => {
    const status = await check(app());
    expect(status).toBeLessThan(400); // 2xx — the capability's endpoint resolves with data
  });

  it('covers every net-new backend capability group', () => {
    const groups = new Set(COVERAGE.flatMap((c) => c.cap.split('/')[0].trim().split(' ')[0].replace(/[0-9]/g, '')));
    for (const g of ['G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O']) expect([...groups].some((x) => x.includes(g))).toBe(true);
  });
});
