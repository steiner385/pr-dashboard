import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../actions/prompt';
import type { DerivedModel } from '../../pipeline-model/derived';

const obs = (runs: number, minutes: number) => ({ ran: runs > 0, runs, realFailures: 0, failRatePct: 0, flakeRatePct: 0, minutes });
const cell = (check: string, tierId: string, runs: boolean, gates: boolean, o: ReturnType<typeof obs> | null, state: string) =>
  ({ check, tierId, intent: { runs, gates, conditional: false }, observed: o, drift: false, state }) as DerivedModel['cells'][number];

const MODEL: DerivedModel = {
  tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }],
  checks: ['e2e', 'build'],
  cells: [
    cell('e2e', 'pr', true, false, obs(300, 9000), 'advisory'),
    cell('build', 'queue', true, true, obs(100, 200), 'gate'),
  ],
  checkMeta: [
    { check: 'e2e', triggers: ['pull_request'], provenance: [{ file: 'e2e.yml', jobId: 'e2e' }], confidence: 'high', isRequiredMergeGate: false },
    { check: 'build', triggers: ['merge_group'], provenance: [{ file: 'ci.yml', jobId: 'build' }], confidence: 'high', isRequiredMergeGate: true },
  ],
};

describe('buildPrompt (server-side, FR-013/FR-016)', () => {
  it('cost prompt names the file+job provenance and the projected effect', () => {
    const p = buildPrompt('o/r', MODEL, { goal: 'cost', check: 'e2e', detail: 'always green, 9000 min/30d', fromTierId: 'pr', toTierId: null });
    expect(p).toMatch(/\.github\/workflows\/e2e\.yml \(job `e2e`\)/);
    expect(p).toMatch(/demote the CI check "e2e"/);
    expect(p).toMatch(/Projected effect: saves 9,000 min/);
    expect(p).toMatch(/Do NOT remove any merge-queue gate/);
  });

  it('drift prompt is investigate-only and warns when the check is a required gate', () => {
    const p = buildPrompt('o/r', MODEL, { goal: 'drift', check: 'build', detail: 'configured to gate but never ran' });
    expect(p).toMatch(/investigate and reconcile CI drift/);
    expect(p).toMatch(/REQUIRED merge gate/);
    expect(p).not.toMatch(/Projected effect/); // no canned simulation for drift
  });

  it('quality prompt shifts left and flags added PR cost', () => {
    const p = buildPrompt('o/r', MODEL, { goal: 'quality', check: 'build', detail: 'real failures caught late', fromTierId: 'queue', toTierId: 'pr' });
    expect(p).toMatch(/shift the CI check "build" left/);
    expect(p).toMatch(/ADDS PR-time cost/);
  });
});
