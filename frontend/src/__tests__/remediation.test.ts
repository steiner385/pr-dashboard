import { describe, it, expect } from 'vitest';
import { remediationProposals } from '../sections/diagnose/remediation';
import type { DashboardState, PrView, CheckView } from '../types';

const chk = (name: string, conclusion: string | null, opts: Partial<CheckView> = {}): CheckView =>
  ({ name, status: 'completed', conclusion, isRequired: true, likelyFlake: false, workflowName: 'CI',
    elapsedSeconds: 1, expectedSeconds: 1, url: null, expectedLowSeconds: null, expectedHighSeconds: null, ...opts }) as CheckView;
const pr = (repo: string, number: number, checks: CheckView[]): PrView =>
  ({ repo, number, title: '', url: '', stage: { stage: 'ci', substate: null, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false }, queueAheadCount: null, checks }) as unknown as PrView;
const state = (prs: PrView[]): DashboardState => {
  const byRepo = new Map<string, PrView[]>();
  for (const p of prs) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p]);
  return { generatedAt: '', staleSince: null, repos: [...byRepo].map(([repo, rprs]) => ({ repo, hasDeploy: false, prs: rprs, queue: null })) } as unknown as DashboardState;
};

describe('remediationProposals (roadmap 5.5 — auto-remediation proposals)', () => {
  it('proposes quarantine for a required gate failing as a likely flake across PRs', () => {
    const s = state([
      pr('o/r', 1, [chk('flaky-e2e', 'failure', { likelyFlake: true })]),
      pr('o/r', 2, [chk('flaky-e2e', 'failure', { likelyFlake: true })]),
      pr('o/r', 3, [chk('flaky-e2e', 'failure', { likelyFlake: true })]),
    ]);
    const props = remediationProposals(s);
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ check: 'flaky-e2e', blockedPrCount: 3, flakeCount: 3, isRequired: true });
    expect(props[0].rationale).toMatch(/3\/3/);
    expect(props[0].action).toMatch(/[Qq]uarantine/);
  });

  it('does NOT propose quarantine for a check that is genuinely failing (not flaky)', () => {
    const s = state([
      pr('o/r', 1, [chk('real-fail', 'failure', { likelyFlake: false })]),
      pr('o/r', 2, [chk('real-fail', 'failure', { likelyFlake: false })]),
      pr('o/r', 3, [chk('real-fail', 'failure', { likelyFlake: false })]),
    ]);
    expect(remediationProposals(s)).toHaveLength(0);
  });

  it('does NOT propose quarantine for a NON-required flaky check (can just be ignored)', () => {
    const s = state([
      pr('o/r', 1, [chk('advisory-flake', 'failure', { likelyFlake: true, isRequired: false })]),
      pr('o/r', 2, [chk('advisory-flake', 'failure', { likelyFlake: true, isRequired: false })]),
    ]);
    expect(remediationProposals(s)).toHaveLength(0);
  });

  it('requires a majority of the failures to look flaky (mixed → no proposal)', () => {
    const s = state([
      pr('o/r', 1, [chk('mixed', 'failure', { likelyFlake: true })]),
      pr('o/r', 2, [chk('mixed', 'failure', { likelyFlake: false })]),
      pr('o/r', 3, [chk('mixed', 'failure', { likelyFlake: false })]),
    ]);
    expect(remediationProposals(s)).toHaveLength(0); // 1/3 flaky — likely a real failure
  });

  it('needs at least 2 blocked PRs (a single flake is noise, not a pattern)', () => {
    const s = state([pr('o/r', 1, [chk('one', 'failure', { likelyFlake: true })])]);
    expect(remediationProposals(s)).toHaveLength(0);
  });

  it('suppresses a check that is already quarantined (closes the WS4.5↔5.5 loop)', () => {
    const s = state([
      pr('o/r', 1, [chk('flaky-e2e', 'failure', { likelyFlake: true })]),
      pr('o/r', 2, [chk('flaky-e2e', 'failure', { likelyFlake: true })]),
    ]);
    expect(remediationProposals(s)).toHaveLength(1);
    expect(remediationProposals(s, 2, new Set(['flaky-e2e']))).toHaveLength(0); // already quarantined → no re-propose
  });

  it('ranks by blast radius (most PRs blocked first) and reports cross-repo spread', () => {
    const s = state([
      pr('o/a', 1, [chk('small', 'failure', { likelyFlake: true }), chk('big', 'failure', { likelyFlake: true })]),
      pr('o/a', 2, [chk('small', 'failure', { likelyFlake: true }), chk('big', 'failure', { likelyFlake: true })]),
      pr('o/b', 3, [chk('big', 'failure', { likelyFlake: true })]),
    ]);
    const props = remediationProposals(s);
    expect(props.map((p) => p.check)).toEqual(['big', 'small']); // big blocks 3 > small's 2
    expect(props[0].repos).toEqual(['o/a', 'o/b']);
  });
});
