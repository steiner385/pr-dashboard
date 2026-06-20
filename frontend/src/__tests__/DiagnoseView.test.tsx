import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiagnoseView, blockingCheck, prsForDiagnose } from '../sections/diagnose/DiagnoseView';
import type { DashboardState, PrView, CheckView } from '../types';

function check(name: string, o: Partial<CheckView> = {}): CheckView {
  return {
    name, status: 'completed', conclusion: 'success', isRequired: true, workflowName: 'CI',
    elapsedSeconds: 10, expectedSeconds: 10, url: null, expectedLowSeconds: null, expectedHighSeconds: null,
    ...o,
  } as CheckView;
}
function pr(repo: string, number: number, checks: CheckView[]): PrView {
  return {
    repo, number, title: `PR ${number}`, url: '',
    stage: { stage: 'ci', substate: null, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false },
    queueAheadCount: null, checks,
  } as unknown as PrView;
}
function state(prs: PrView[]): DashboardState {
  const byRepo = new Map<string, PrView[]>();
  for (const p of prs) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p]);
  return { generatedAt: '', staleSince: null, repos: [...byRepo].map(([repo, rprs]) => ({ repo, hasDeploy: false, prs: rprs, queue: null })) } as unknown as DashboardState;
}

describe('blockingCheck (pure)', () => {
  it('prefers a failed required check', () => {
    const b = blockingCheck(pr('o/r', 1, [check('lint'), check('build', { conclusion: 'failure' })]));
    expect(b).toMatchObject({ why: 'failed', check: { name: 'build' } });
  });
  it('falls back to a still-running check when none failed', () => {
    const b = blockingCheck(pr('o/r', 1, [check('lint'), check('e2e', { status: 'in_progress', conclusion: null })]));
    expect(b).toMatchObject({ why: 'running', check: { name: 'e2e' } });
  });
  it('returns null when everything is green', () => {
    expect(blockingCheck(pr('o/r', 1, [check('lint'), check('build')]))).toBeNull();
  });
  it('prefers a REAL failure over a flaky one and labels flake (roadmap 5.5)', () => {
    const b = blockingCheck(pr('o/r', 1, [
      check('flaky-e2e', { conclusion: 'failure', likelyFlake: true }),
      check('real-build', { conclusion: 'failure', likelyFlake: false }),
    ]));
    expect(b).toMatchObject({ check: { name: 'real-build' }, flaky: false });
  });
  it('labels a lone flaky failure as flaky', () => {
    const b = blockingCheck(pr('o/r', 1, [check('flaky-e2e', { conclusion: 'failure', likelyFlake: true })]));
    expect(b).toMatchObject({ check: { name: 'flaky-e2e' }, flaky: true });
  });
});

describe('prsForDiagnose', () => {
  it('puts the focused repo first', () => {
    const s = state([pr('o/a', 1, []), pr('o/b', 2, [])]);
    expect(prsForDiagnose(s, 'o/b')[0].repo).toBe('o/b');
  });
});

describe('DiagnoseView', () => {
  const s = state([
    pr('o/a', 10, [check('build', { conclusion: 'failure' })]),
    pr('o/b', 20, [check('build')]),
  ]);

  it('wraps the PR list + detail in a master-detail split (#186)', () => {
    const { container } = render(<DiagnoseView state={s} />);
    const split = container.querySelector('.diagnose-split');
    expect(split).not.toBeNull();
    expect(split!.querySelector('.diagnose-pr-list')).not.toBeNull();   // master
    expect(split!.querySelector('.diagnose-detail')).not.toBeNull();    // detail (first PR selected)
  });

  it('shows the blocker for the selected PR and lets you switch PRs', () => {
    render(<DiagnoseView state={s} />);
    // first PR selected by default → its failed build is the blocker
    // diagnose-blocker updates on discrete user click → role="status" is correct
    expect(screen.getByRole('status')).toHaveTextContent(/build failed and is blocking this PR/);
    fireEvent.click(screen.getByText(/PR 20/));
    expect(screen.getByRole('status')).toHaveTextContent(/nothing blocking/i);
  });

  it('renders an empty state with no PRs', () => {
    render(<DiagnoseView state={state([])} />);
    expect(screen.getByText(/no open prs/i)).toBeInTheDocument();
  });

  it('surfaces an auto-remediation proposal for a flaky required gate (roadmap 5.5)', () => {
    const flaky = state([
      pr('o/a', 1, [check('flaky-e2e', { conclusion: 'failure', likelyFlake: true })]),
      pr('o/a', 2, [check('flaky-e2e', { conclusion: 'failure', likelyFlake: true })]),
    ]);
    render(<DiagnoseView state={flaky} />);
    const card = screen.getByRole('region', { name: /auto-remediation proposals/i });
    expect(card).toHaveTextContent(/flaky-e2e/);
    expect(card).toHaveTextContent(/2\/2/);
    expect(card).toHaveTextContent(/Quarantine 48h/);
  });

  it('shows NO remediation card when there is nothing to remediate', () => {
    render(<DiagnoseView state={s} />); // build fails on one PR, not flaky
    expect(screen.queryByRole('region', { name: /auto-remediation proposals/i })).not.toBeInTheDocument();
  });

  it('suppresses the remediation proposal for an already-quarantined check (roadmap 4.5)', async () => {
    const flaky = state([
      pr('o/a', 1, [check('flaky-e2e', { conclusion: 'failure', likelyFlake: true })]),
      pr('o/a', 2, [check('flaky-e2e', { conclusion: 'failure', likelyFlake: true })]),
    ]);
    const api = { quarantines: vi.fn(async () => ({ repo: 'o/a', quarantines: [{ check: 'flaky-e2e', until: '2026-12-01T00:00:00Z', reason: 'q' }] })) } as unknown as import('../shell/workspaceApi').WorkspaceApi;
    render(<DiagnoseView state={flaky} focusedRepo="o/a" api={api} />);
    // wait for the quarantine fetch to resolve and the card to disappear
    await waitFor(() => expect(screen.queryByRole('region', { name: /auto-remediation proposals/i })).not.toBeInTheDocument());
    expect(api.quarantines).toHaveBeenCalledWith('o/a');
  });

  it('PR-list rows are keyboard-operable buttons (roadmap 2.2 a11y)', () => {
    render(<DiagnoseView state={s} />);
    const rows = screen.getAllByRole('button').filter((b) => /#\d+/.test(b.textContent ?? ''));
    expect(rows.length).toBeGreaterThan(0);
    rows[0].focus();
    expect(rows[0]).toHaveFocus(); // tabbable
  });

  it('a11y(#171): queue-incidents section is role=region, not role=status (labeled content, not a live announcement)', () => {
    // 5 PRs with the same failing check → clusterFailures(3) produces a cluster → failure-clusters renders.
    // Patching the repo queue with an unmergeable culprit → queueIncidents produces an incident → queue-incidents renders.
    const basePrs = [
      pr('o/a', 1, [check('build', { conclusion: 'failure' })]),
      pr('o/a', 2, [check('build', { conclusion: 'failure' })]),
      pr('o/a', 3, [check('build', { conclusion: 'failure' })]),
      pr('o/a', 4, [check('build', { conclusion: 'failure' })]),
      pr('o/a', 5, [check('build', { conclusion: 'failure' })]),
    ];
    const baseState = state(basePrs);
    // Patch the repo to include a stalled queue so queue-incidents renders
    const stalledState = {
      ...baseState,
      repos: baseState.repos.map((r) =>
        r.repo === 'o/a'
          ? { ...r, queue: { size: 5, unmergeable: [1], unmergeableCulprit: 1, queueBlocked: [2, 3], locked: false, lockedSince: null } }
          : r,
      ),
    } as typeof baseState;
    render(<DiagnoseView state={stalledState} />);
    // Both sections must be present — if either is missing the test should fail loudly (not vacuously pass)
    expect(screen.getByRole('region', { name: /queue incidents/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /failure clusters/i })).toBeInTheDocument();
    // They must be regions (labeled content), not status live-regions
    expect(screen.getByRole('region', { name: /queue incidents/i })).not.toHaveAttribute('role', 'status');
    expect(screen.getByRole('region', { name: /failure clusters/i })).not.toHaveAttribute('role', 'status');
  });
});
