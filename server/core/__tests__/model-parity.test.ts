// Capability-contract PARITY (spec 001, FR-023 / SC-004 — parity half, model slice).
// The rebuilt model tier (ModelDeriver) must produce output IDENTICAL to the legacy
// engine (computeProtectionMap) for the same inputs — the protection matrix, the
// required-gate set, and cell states are DISCRETE SAFETY outputs, so the comparator
// is EXACT (zero tolerance), per the architect review. ModelDeriver wraps the engine
// today, so this is exact-by-construction; the test is the regression guard that keeps
// it that way (any future divergence in the deriver fails here).
import { describe, it, expect, vi } from 'vitest';
import { computeProtectionMap } from '../../protection-map';
import { ModelDeriver, type ModelDeriveDeps } from '../model/derive';
import type { SuccessStat, FlakeStat } from '../../history';

const CI = `name: CI
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
const fetchWorkflow = async (_r: string, name: string) =>
  name === 'ci.yml' ? CI : name === '_static.yml' ? STATIC : null;
const successStatsByRepo = () => new Map<string, SuccessStat[]>();
const flakeStatsByRepo = () => new Map<string, FlakeStat[]>();
const SINCE = '2026-01-01T00:00:00Z';

describe('model parity: rebuilt deriver == legacy engine (FR-023 parity, exact)', () => {
  it('produces a DerivedModel identical to computeProtectionMap for the same inputs', async () => {
    const legacy = await computeProtectionMap('o/r', SINCE, { fetchWorkflow, successStatsByRepo, flakeStatsByRepo });

    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn(async () => 'sha'),
      fetchWorkflowAtSha: (_r, name) => fetchWorkflow(_r, name),
      successStatsByRepo, flakeStatsByRepo, since: SINCE,
    };
    const pinned = await new ModelDeriver(deps).deriveAtSha('o/r', 'sha');

    expect(pinned).not.toBeNull();
    // EXACT equality — these are discrete safety outputs, not heuristic numerics
    expect(pinned!.model).toEqual(legacy);
  });

  it('the required-merge-gate set matches exactly (the safety-critical slice)', async () => {
    const legacy = await computeProtectionMap('o/r', SINCE, { fetchWorkflow, successStatsByRepo, flakeStatsByRepo });
    const deps: ModelDeriveDeps = {
      resolveHeadSha: vi.fn(async () => 'sha'), fetchWorkflowAtSha: (_r, name) => fetchWorkflow(_r, name),
      successStatsByRepo, flakeStatsByRepo, since: SINCE,
    };
    const pinned = await new ModelDeriver(deps).deriveAtSha('o/r', 'sha');
    const req = (m: typeof legacy) => (m!.checkMeta ?? []).filter((x) => x.isRequiredMergeGate).map((x) => x.check).sort();
    expect(req(pinned!.model)).toEqual(req(legacy));
  });
});
