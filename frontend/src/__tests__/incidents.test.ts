import { describe, it, expect } from 'vitest';
import { queueIncidents } from '../sections/diagnose/incidents';
import type { DashboardState } from '../types';

const state = (repos: { repo: string; queue?: { unmergeable?: number[]; queueBlocked?: number[]; unmergeableCulprit?: number | null } }[]): DashboardState =>
  ({ generatedAt: '', staleSince: null, repos: repos.map((r) => ({
    repo: r.repo, hasDeploy: false, prs: [],
    queue: r.queue ? { groups: [], waiting: [], unmergeable: r.queue.unmergeable ?? [], queueBlocked: r.queue.queueBlocked ?? [], unmergeableCulprit: r.queue.unmergeableCulprit ?? null } : null,
  })) }) as unknown as DashboardState;

describe('queueIncidents (Group K1 / FR-038)', () => {
  it('emits a playbook naming the culprit + the do-not-rebase guidance for cascade-blocked PRs', () => {
    const inc = queueIncidents(state([{ repo: 'o/r', queue: { unmergeableCulprit: 42, queueBlocked: [43, 44] } }]));
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ repo: 'o/r', culprit: 42, blockedCount: 2 });
    expect(inc[0].steps[0]).toMatch(/#42.*rebase/);
    expect(inc[0].steps[1]).toMatch(/do NOT rebase/);
  });

  it('falls back to the first unmergeable when no explicit culprit', () => {
    const inc = queueIncidents(state([{ repo: 'o/r', queue: { unmergeable: [7, 9] } }]));
    expect(inc[0].culprit).toBe(7);
  });

  it('no incident for a healthy queue or a repo without a queue', () => {
    expect(queueIncidents(state([{ repo: 'o/r', queue: {} }, { repo: 'o/x' }]))).toEqual([]);
  });
});
