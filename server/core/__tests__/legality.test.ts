import { describe, it, expect } from 'vitest';
import {
  requiredGateChecks, validateTierChange, validateGateChange, detectCycle, validateNeedsChange, gatingRegressed,
} from '../model/legality';
import type { DerivedModel } from '../../pipeline-model/derived';
import type { GatingResult } from '../../pipeline-model/types';

const gr = (names: string[]): GatingResult => ({
  gatingCallerJobs: [], conditionalCallerJobs: [],
  gates: names.map((checkName) => ({ checkName, events: ['merge_group'] })),
});

describe('gatingRegressed (candidate required-gate set must be a superset of baseline)', () => {
  it('no regression when the candidate keeps every baseline gate', () => {
    expect(gatingRegressed(gr(['ci', 'build']), gr(['ci', 'build', 'extra']))).toEqual({ regressed: false, lost: [] });
  });

  it('regression (with the lost names) when a baseline gate disappears', () => {
    expect(gatingRegressed(gr(['ci', 'build']), gr(['ci']))).toEqual({ regressed: true, lost: ['build'] });
  });

  it('reports multiple lost gates sorted', () => {
    expect(gatingRegressed(gr(['ci', 'build', 'e2e']), gr(['ci'])).lost).toEqual(['build', 'e2e']);
  });
});

const obs = (runs: number, minutes: number) => ({ ran: runs > 0, runs, realFailures: 0, failRatePct: 0, flakeRatePct: 0, minutes });
const cell = (check: string, tierId: string, runs: boolean, gates: boolean, o: ReturnType<typeof obs> | null, state: string) =>
  ({ check, tierId, intent: { runs, gates, conditional: false }, observed: o, drift: false, state }) as DerivedModel['cells'][number];

const MODEL: DerivedModel = {
  tiers: [
    { id: 'pr', label: 'PR', event: 'pull_request' },
    { id: 'queue', label: 'Queue', event: 'merge_group' },
    { id: 'main', label: 'Main', event: 'push' },
  ],
  checks: ['build', 'lint'],
  cells: [
    cell('build', 'pr', true, false, obs(100, 200), 'advisory'),
    cell('build', 'queue', true, true, obs(50, 300), 'gate'),   // required merge gate
    cell('build', 'main', false, false, null, 'absent'),
    cell('lint', 'pr', true, false, obs(100, 80), 'advisory'),
    cell('lint', 'queue', false, false, null, 'absent'),
    cell('lint', 'main', false, false, null, 'absent'),
  ],
  checkMeta: [
    { check: 'build', triggers: ['pull_request', 'merge_group'], provenance: [{ file: 'ci.yml', jobId: 'build' }], confidence: 'high', isRequiredMergeGate: true },
    { check: 'lint', triggers: ['pull_request'], provenance: [{ file: 'ci.yml', jobId: 'lint' }], confidence: 'high', isRequiredMergeGate: false },
  ],
};

describe('requiredGateChecks (union binding, FR-035a)', () => {
  it('static-only when no live ruleset', () => {
    expect([...requiredGateChecks(MODEL)]).toEqual(['build']);
  });
  it('unions the live-ruleset required set (catches a statically-missed gate)', () => {
    expect([...requiredGateChecks(MODEL, ['lint', 'extra'])].sort()).toEqual(['build', 'extra', 'lint']);
  });
});

describe('validateTierChange (P1 / FR-012 / FR-035a)', () => {
  it('refuses removing a required merge gate from the queue', () => {
    const v = validateTierChange(MODEL, { check: 'build', fromTierId: 'queue', toTierId: null });
    expect(v.legal).toBe(false);
    expect(v.reason).toBe('required-gate');
  });
  it('refuses moving a required merge gate off the queue', () => {
    expect(validateTierChange(MODEL, { check: 'build', fromTierId: 'queue', toTierId: 'main' }).legal).toBe(false);
  });
  it('allows moving the non-gate PR copy of a required check (queue gate retained)', () => {
    expect(validateTierChange(MODEL, { check: 'build', fromTierId: 'pr', toTierId: null }).legal).toBe(true);
  });
  it('allows moving a non-required check freely', () => {
    expect(validateTierChange(MODEL, { check: 'lint', fromTierId: 'pr', toTierId: null }).legal).toBe(true);
  });
  it('union binding: a live-ruleset-required check is now protected even if static missed it', () => {
    // 'lint' is NOT statically required, but the live ruleset requires it → demoting its only run is refused
    const v = validateTierChange(MODEL, { check: 'lint', fromTierId: 'pr', toTierId: null }, ['lint']);
    expect(v.legal).toBe(false);
    expect(v.reason).toBe('required-gate');
  });
});

describe('validateGateChange (FR-029)', () => {
  it('refuses demoting a required merge gate', () => {
    expect(validateGateChange(MODEL, { check: 'build', tierId: 'queue', gate: false }).legal).toBe(false);
  });
  it('allows promoting (gate:true) and demoting a non-required gate', () => {
    expect(validateGateChange(MODEL, { check: 'lint', tierId: 'queue', gate: true }).legal).toBe(true);
    expect(validateGateChange(MODEL, { check: 'lint', tierId: 'pr', gate: false }).legal).toBe(true);
  });
});

describe('detectCycle (FR-028)', () => {
  it('returns null for an acyclic graph', () => {
    const g = new Map<string, string[]>([['ci', ['build']], ['build', ['static']], ['static', []]]);
    expect(detectCycle(g)).toBeNull();
  });
  it('finds a direct cycle', () => {
    const g = new Map<string, string[]>([['a', ['b']], ['b', ['a']]]);
    const c = detectCycle(g);
    expect(c).not.toBeNull();
    expect(c).toContain('a'); expect(c).toContain('b');
  });
  it('finds an indirect cycle', () => {
    const g = new Map<string, string[]>([['a', ['b']], ['b', ['c']], ['c', ['a']]]);
    expect(detectCycle(g)).not.toBeNull();
  });
});

describe('validateNeedsChange (FR-028)', () => {
  const base = new Map<string, string[]>([['ci', ['build']], ['build', ['static']], ['static', []]]);
  it('allows a safe needs edit', () => {
    expect(validateNeedsChange(base, { jobId: 'ci', addNeeds: ['static'] }).legal).toBe(true);
  });
  it('rejects a needs edit that would create a cycle', () => {
    const v = validateNeedsChange(base, { jobId: 'static', addNeeds: ['ci'] }); // static → ci → build → static
    expect(v.legal).toBe(false);
    expect(v.reason).toBe('cycle');
  });
});
