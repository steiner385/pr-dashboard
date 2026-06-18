import { describe, it, expect } from 'vitest';
import { clusterFailures } from '../sections/diagnose/clustering';
import type { DashboardState, PrView, CheckView } from '../types';

const chk = (name: string, conclusion: string | null): CheckView =>
  ({ name, status: 'completed', conclusion, isRequired: true, workflowName: 'CI', elapsedSeconds: 1, expectedSeconds: 1, url: null, expectedLowSeconds: null, expectedHighSeconds: null }) as CheckView;
const pr = (repo: string, number: number, checks: CheckView[]): PrView =>
  ({ repo, number, title: '', url: '', stage: { stage: 'ci', substate: null, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false }, queueAheadCount: null, checks }) as unknown as PrView;
const state = (prs: PrView[]): DashboardState => {
  const byRepo = new Map<string, PrView[]>();
  for (const p of prs) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p]);
  return { generatedAt: '', staleSince: null, repos: [...byRepo].map(([repo, rprs]) => ({ repo, hasDeploy: false, prs: rprs, queue: null })) } as unknown as DashboardState;
};

describe('clusterFailures (Group K3 / FR-038)', () => {
  it('clusters a check failing across ≥ minPrs PRs', () => {
    const s = state([
      pr('o/r', 1, [chk('flaky-e2e', 'failure')]),
      pr('o/r', 2, [chk('flaky-e2e', 'failure'), chk('lint', 'success')]),
      pr('o/r', 3, [chk('flaky-e2e', 'failure')]),
    ]);
    const c = clusterFailures(s, 3);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ check: 'flaky-e2e', prCount: 3, prNumbers: [1, 2, 3] });
  });

  it('ignores a check failing on too few PRs (below threshold)', () => {
    const s = state([pr('o/r', 1, [chk('x', 'failure')]), pr('o/r', 2, [chk('x', 'failure')])]);
    expect(clusterFailures(s, 3)).toHaveLength(0);
    expect(clusterFailures(s, 2)).toHaveLength(1);
  });

  it('reports cross-repo spread and orders most-widespread first', () => {
    const s = state([
      pr('o/a', 1, [chk('build', 'failure'), chk('wide', 'failure')]),
      pr('o/b', 2, [chk('build', 'failure'), chk('wide', 'failure')]),
      pr('o/b', 3, [chk('wide', 'failure')]),
    ]);
    const c = clusterFailures(s, 2);
    expect(c[0].check).toBe('wide'); // 3 PRs > build's 2
    expect(c[0].repos).toEqual(['o/a', 'o/b']);
  });

  it('only counts failed conclusions (success/in-progress excluded)', () => {
    const s = state([pr('o/r', 1, [chk('x', 'success')]), pr('o/r', 2, [chk('x', null)]), pr('o/r', 3, [chk('x', 'failure')])]);
    expect(clusterFailures(s, 2)).toHaveLength(0);
  });
});
