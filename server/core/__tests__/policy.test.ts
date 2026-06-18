import { describe, it, expect } from 'vitest';
import { evaluatePolicies, type PolicyRule } from '../analytics/policy';
import type { DerivedModel } from '../../pipeline-model/derived';

const obs = (flakeRatePct: number) => ({ ran: true, runs: 50, realFailures: 0, failRatePct: 0, flakeRatePct, minutes: 100 });
const cell = (check: string, tierId: string, runs: boolean, gates: boolean, flake = 0): DerivedModel['cells'][number] =>
  ({ check, tierId, intent: { runs, gates, conditional: false }, observed: runs ? obs(flake) : null, drift: false, state: gates ? 'gate' : runs ? 'advisory' : 'absent' }) as DerivedModel['cells'][number];

const MODEL: DerivedModel = {
  tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }, { id: 'main', label: 'Main', event: 'push' }],
  checks: ['build', 'e2e', 'redundant'],
  cells: [
    cell('build', 'queue', true, true, 2),                       // required gate, queue-only, low flake
    cell('e2e', 'pr', true, false, 12), cell('e2e', 'queue', true, true, 12), // required gate, flaky 12%, runs on PR
    cell('redundant', 'pr', true, true), cell('redundant', 'queue', true, true), cell('redundant', 'main', true, true), // gates at 3 tiers
  ],
  checkMeta: [
    { check: 'build', triggers: [], provenance: [{ file: 'ci.yml', jobId: 'build' }], confidence: 'high', isRequiredMergeGate: true },
    { check: 'e2e', triggers: [], provenance: [{ file: 'ci.yml', jobId: 'e2e' }], confidence: 'high', isRequiredMergeGate: true },
    { check: 'redundant', triggers: [], provenance: [{ file: 'ci.yml', jobId: 'redundant' }], confidence: 'high', isRequiredMergeGate: false },
  ],
} as unknown as DerivedModel;

describe('evaluatePolicies (Group I2 / FR-036)', () => {
  it('max-tiers-per-check flags a check gating at too many tiers', () => {
    const v = evaluatePolicies(MODEL, [{ id: 'r1', kind: 'max-tiers-per-check', max: 2 }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ ruleId: 'r1', check: 'redundant' });
  });

  it('no-flaky-required-gate flags a flaky required gate (and not a clean one)', () => {
    const v = evaluatePolicies(MODEL, [{ id: 'r2', kind: 'no-flaky-required-gate', maxFlakePct: 5 }]);
    expect(v.map((x) => x.check)).toEqual(['e2e']); // 12% > 5; build is 2%
  });

  it('required-gate-runs-on-pr flags a required gate that only runs in the queue (caught late)', () => {
    const v = evaluatePolicies(MODEL, [{ id: 'r3', kind: 'required-gate-runs-on-pr' }]);
    expect(v.map((x) => x.check)).toEqual(['build']); // build is queue-only; e2e runs on PR
  });

  it('honors the union required set (a live-ruleset-required check is policy-checked too)', () => {
    const v = evaluatePolicies(MODEL, [{ id: 'r3', kind: 'required-gate-runs-on-pr' }], ['redundant']);
    // redundant runs on PR, so still no new violation; build remains the only one
    expect(v.map((x) => x.check)).toEqual(['build']);
  });

  it('no rules → no violations', () => {
    expect(evaluatePolicies(MODEL, [])).toEqual([]);
  });
});
