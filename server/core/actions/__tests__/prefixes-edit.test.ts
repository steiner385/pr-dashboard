import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { mergePrefixesIntoConfig, mergeGroupCheckNames } from '../prefixes-edit';
import type { DerivedModel } from '../../../pipeline-model/derived';

describe('mergePrefixesIntoConfig (roadmap 4.5 — governed .pr-dashboard.yml edit)', () => {
  it('sets requiredCheckPrefixes on an empty/absent config', () => {
    const out = mergePrefixesIntoConfig(null, ['build', 'static-checks']);
    expect(parse(out)).toEqual({ requiredCheckPrefixes: ['build', 'static-checks'] });
  });

  it('PRESERVES other keys (deploy, batchSize) while setting the prefixes', () => {
    const current = 'batchSize: 6\ndeploy:\n  environments:\n    - name: prod\n      healthUrl: https://x/health\n';
    const out = mergePrefixesIntoConfig(current, ['build']);
    const parsed = parse(out);
    expect(parsed.batchSize).toBe(6);
    expect(parsed.deploy.environments[0].name).toBe('prod');
    expect(parsed.requiredCheckPrefixes).toEqual(['build']);
  });

  it('OVERWRITES an existing requiredCheckPrefixes value', () => {
    const out = mergePrefixesIntoConfig('requiredCheckPrefixes: [old]\nbatchSize: 4\n', ['new-a', 'new-b']);
    const parsed = parse(out);
    expect(parsed.requiredCheckPrefixes).toEqual(['new-a', 'new-b']);
    expect(parsed.batchSize).toBe(4);
  });
});

describe('mergeGroupCheckNames (model → the checks that run at merge_group)', () => {
  const cell = (check: string, tierId: string, runs: boolean) =>
    ({ check, tierId, intent: { runs, gates: false, conditional: false }, observed: null, drift: false, state: 'advisory' }) as DerivedModel['cells'][number];
  const model = {
    tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }],
    checks: ['build', 'lint', 'nightly'],
    cells: [
      cell('build', 'queue', true), cell('lint', 'queue', true),
      cell('nightly', 'queue', false), // configured but not running at merge_group
      cell('build', 'pr', true),
    ],
    checkMeta: [],
  } as unknown as DerivedModel;

  it('returns the distinct checks that actually run at the merge_group tier', () => {
    expect(mergeGroupCheckNames(model).sort()).toEqual(['build', 'lint']);
  });
});
