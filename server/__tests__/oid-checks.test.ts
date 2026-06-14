import { describe, it, expect } from 'vitest';
import { splitOidChecks } from '../oid-checks';
import type { CheckRun } from '../types';

const chk = (name: string, event: string, runDatabaseId: number | null = null): CheckRun => ({
  name, rawName: name, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null, completedAt: null,
  event, workflowName: 'CI', runNumber: null, runDatabaseId, runAttempt: null, isRequired: false, url: null,
});

describe('splitOidChecks', () => {
  it('partitions a mixed-event OID into merge_group vs push', () => {
    const out = splitOidChecks([chk('ci', 'merge_group', 5), chk('accessibility / axe', 'push', 9)]);
    expect(out.mergeGroup.map((c) => c.name)).toEqual(['ci']);
    expect(out.push.map((c) => c.name)).toEqual(['accessibility / axe']);
  });

  it('keeps only the latest merge_group run when an OID was re-queued', () => {
    const out = splitOidChecks([
      chk('ci', 'merge_group', 10), chk('build', 'merge_group', 10),
      chk('ci', 'merge_group', 20),
    ]);
    expect(out.mergeGroup.map((c) => c.runDatabaseId)).toEqual([20]);
  });

  it('keeps all merge_group checks when run ids are absent (legacy data)', () => {
    const out = splitOidChecks([chk('ci', 'merge_group'), chk('build', 'merge_group')]);
    expect(out.mergeGroup).toHaveLength(2);
  });

  it('ignores unrelated events and tolerates empty input', () => {
    expect(splitOidChecks([chk('x', 'pull_request')])).toEqual({ mergeGroup: [], push: [] });
    expect(splitOidChecks([])).toEqual({ mergeGroup: [], push: [] });
  });
});
