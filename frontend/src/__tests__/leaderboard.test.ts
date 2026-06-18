import { describe, it, expect } from 'vitest';
import { fleetLeaderboard } from '../sections/health/leaderboard';
import type { DashboardState } from '../types';

const state = (repos: { repo: string; flaky?: number; prs?: number }[]): DashboardState =>
  ({ generatedAt: '', staleSince: null, repos: repos.map((r) => ({
    repo: r.repo, hasDeploy: false, prs: Array.from({ length: r.prs ?? 0 }, () => ({})), queue: null,
    flake: r.flaky != null ? { topChecks: [], flakyCount: r.flaky } : undefined,
  })) }) as unknown as DashboardState;

describe('fleetLeaderboard (Group N1 / FR-041)', () => {
  it('ranks flakiest-first, then busiest', () => {
    const rows = fleetLeaderboard(state([
      { repo: 'o/calm', flaky: 0, prs: 9 },
      { repo: 'o/flaky', flaky: 7, prs: 1 },
      { repo: 'o/mid', flaky: 2, prs: 5 },
    ]));
    expect(rows.map((r) => r.repo)).toEqual(['o/flaky', 'o/mid', 'o/calm']);
  });

  it('tolerates missing flake data (treated as 0) and tie-breaks by PRs then name', () => {
    const rows = fleetLeaderboard(state([{ repo: 'o/b', prs: 2 }, { repo: 'o/a', prs: 5 }]));
    expect(rows.map((r) => r.repo)).toEqual(['o/a', 'o/b']); // both 0 flaky → busier first
    expect(rows[0].flakyChecks).toBe(0);
  });
});
