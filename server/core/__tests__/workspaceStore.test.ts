import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../store/workspaceStore';
import type { AppliedChange } from '../analytics/outcomes';

let s: WorkspaceStore;
beforeEach(() => { s = new WorkspaceStore(':memory:'); });
afterEach(() => s.close());

const change = (pr: number): AppliedChange => ({
  prNumber: pr, check: 'e2e', projected: { costDeltaMinutes: -1000, coverageDelta: 0 },
  realized: { costDeltaMinutes: -950, coverageDelta: 0 }, windowDays: 21,
});

describe('WorkspaceStore (durable persistence — in-memory SQLite)', () => {
  it('round-trips applied changes (Group H ledger) scoped by repo', () => {
    s.recordAppliedChange('o/r', change(1));
    s.recordAppliedChange('o/r', change(2));
    s.recordAppliedChange('o/other', change(3));
    const got = s.appliedChanges('o/r');
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ prNumber: expect.any(Number), check: 'e2e', projected: { costDeltaMinutes: -1000 }, realized: { costDeltaMinutes: -950 } });
  });

  it('upserts an applied change (re-recording the same PR/check updates realized)', () => {
    s.recordAppliedChange('o/r', change(1));
    s.recordAppliedChange('o/r', { ...change(1), realized: { costDeltaMinutes: -500, coverageDelta: 0 } });
    const got = s.appliedChanges('o/r');
    expect(got).toHaveLength(1);
    expect(got[0].realized.costDeltaMinutes).toBe(-500);
  });

  it('appends + reads the action audit newest-first with a limit (Group L2)', () => {
    s.recordAction({ at: '2026-06-01T00:00:00Z', repo: 'o/r', action: 'draft-pr', target: 'e2e', result: 'opened #5' });
    s.recordAction({ at: '2026-06-02T00:00:00Z', repo: 'o/r', action: 'quarantine', target: 'lint' });
    const log = s.auditLog('o/r');
    expect(log[0].action).toBe('quarantine'); // newest first
    expect(log[0].result).toBeUndefined();
    expect(s.auditLog('o/r', 1)).toHaveLength(1);
  });

  it('persists + reads declarative policies (Group I2)', () => {
    expect(s.getPolicies('o/r')).toEqual([]);
    s.putPolicies('o/r', [{ id: 'p1', kind: 'no-flaky-required-gate', maxFlakePct: 5 }]);
    expect(s.getPolicies('o/r')).toEqual([{ id: 'p1', kind: 'no-flaky-required-gate', maxFlakePct: 5 }]);
    s.putPolicies('o/r', []); // overwrite
    expect(s.getPolicies('o/r')).toEqual([]);
  });

  it('persists + reads budget thresholds scope-keyed (Group J2/J3)', () => {
    expect(s.getBudgets()).toEqual([]); // default 'fleet' scope, none set
    s.putBudgets('fleet', [{ kind: 'minutes', threshold: 50000, unit: 'min' }, { kind: 'cost', threshold: 100, unit: 'USD' }]);
    expect(s.getBudgets('fleet')).toHaveLength(2);
    expect(s.getBudgets('fleet')[0]).toMatchObject({ kind: 'minutes', threshold: 50000 });
  });

  it('survives a reopen (real on-disk durability)', () => {
    // os.tmpdir() always exists (portable across local + CI); a bare `/tmp/tmp`
    // path does not, which failed CI when CLAUDE_JOB_DIR was unset.
    const path = join(tmpdir(), `ws-store-${Math.floor(Math.random() * 1e9)}.db`);
    const a = new WorkspaceStore(path);
    a.putPolicies('o/r', [{ id: 'p1', kind: 'required-gate-runs-on-pr' }]);
    a.close();
    const b = new WorkspaceStore(path);
    expect(b.getPolicies('o/r')).toHaveLength(1);
    b.close();
  });
});
