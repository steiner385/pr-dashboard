import { describe, it, expect } from 'vitest';
import { reconcileRuleset, derivedRequiredGates } from '../model/ruleset';
import type { DerivedModel } from '../../pipeline-model/derived';

const model = (required: string[]): DerivedModel => ({
  tiers: [], checks: required, cells: [],
  checkMeta: ['ci', 'build', 'lint'].map((c) => ({
    check: c, triggers: [], provenance: [{ file: 'ci.yml', jobId: c }], confidence: 'high',
    isRequiredMergeGate: required.includes(c),
  })),
}) as unknown as DerivedModel;

describe('reconcileRuleset (Group I1 / FR-035 / SC-014)', () => {
  it('in sync when derived == live', () => {
    const r = reconcileRuleset(model(['ci', 'build']), ['build', 'ci']);
    expect(r.readable).toBe(true);
    expect(r.inSync).toBe(true);
  });

  it('flags a check the live ruleset requires but the model missed (the dangerous gap)', () => {
    const r = reconcileRuleset(model(['ci']), ['ci', 'build']);
    expect(r.inSync).toBe(false);
    expect(r.missingFromModel).toEqual(['build']);
  });

  it('flags a check the model gates but the ruleset does not enforce', () => {
    const r = reconcileRuleset(model(['ci', 'lint']), ['ci']);
    expect(r.extraInModel).toEqual(['lint']);
    expect(r.inSync).toBe(false);
  });

  it('reports readable:false (NOT in-sync) when the ruleset is unreadable — no silent mismatch', () => {
    const r = reconcileRuleset(model(['ci']), null);
    expect(r.readable).toBe(false);
    expect(r.inSync).toBe(false);
    expect(r.derivedRequired).toEqual(['ci']); // still shows what we DO know statically
  });

  it('derivedRequiredGates extracts + sorts the required set', () => {
    expect(derivedRequiredGates(model(['lint', 'ci']))).toEqual(['ci', 'lint']);
  });
});
