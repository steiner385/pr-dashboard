import { describe, it, expect } from 'vitest';
import { auditWorkflowSecurity } from '../model/security';

describe('auditWorkflowSecurity (Group M / FR-040)', () => {
  it('flags pull_request_target (high confidence)', () => {
    const f = auditWorkflowSecurity('on: { pull_request_target: {} }\njobs: {}\n', 'x.yml');
    expect(f).toContainEqual(expect.objectContaining({ kind: 'pull_request_target', confidence: 'high' }));
  });

  it('flags write-all at workflow level (high) and job level (high)', () => {
    const wf = auditWorkflowSecurity('on: push\npermissions: write-all\njobs:\n  a: { runs-on: x, steps: [] }\n', 'x.yml');
    expect(wf.filter((x) => x.kind === 'broad-permissions' && x.confidence === 'high')).toHaveLength(1);
    const job = auditWorkflowSecurity('on: push\njobs:\n  a: { runs-on: x, permissions: write-all, steps: [] }\n', 'x.yml');
    expect(job).toContainEqual(expect.objectContaining({ kind: 'broad-permissions', jobId: 'a', confidence: 'high' }));
  });

  it('flags a workflow-level write scope as medium (jobs may narrow it)', () => {
    const f = auditWorkflowSecurity('on: push\npermissions: { contents: write, issues: read }\njobs: {}\n', 'x.yml');
    expect(f).toContainEqual(expect.objectContaining({ kind: 'broad-permissions', confidence: 'medium' }));
  });

  it('flags unpinned actions but PASSES a SHA-pinned one', () => {
    const yaml = `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@8f152de45cc393bb48ce5d89d36b731f54556e65
      - uses: ./.github/actions/local
`;
    const f = auditWorkflowSecurity(yaml, 'x.yml');
    const unpinned = f.filter((x) => x.kind === 'unpinned-action');
    expect(unpinned).toHaveLength(1); // only @v4; the SHA + local are fine
    expect(unpinned[0].detail).toMatch(/actions\/checkout@v4/);
  });

  it('marks an interpolated ref as low-confidence unpinned', () => {
    const f = auditWorkflowSecurity('on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: foo/bar@${{ env.REF }}\n', 'x.yml');
    expect(f).toContainEqual(expect.objectContaining({ kind: 'unpinned-action', confidence: 'low' }));
  });

  it('returns nothing for a clean, pinned, least-privilege workflow', () => {
    const yaml = `on: push
permissions: { contents: read }
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@8f152de45cc393bb48ce5d89d36b731f54556e65
`;
    expect(auditWorkflowSecurity(yaml, 'x.yml')).toEqual([]);
  });

  it('is silent (not throwing) on unparseable YAML', () => {
    expect(auditWorkflowSecurity(':::not yaml:::\n  - [', 'x.yml')).toEqual([]);
  });
});
