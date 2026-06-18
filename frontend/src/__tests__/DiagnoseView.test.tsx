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

  it('shows the blocker for the selected PR and lets you switch PRs', () => {
    render(<DiagnoseView state={s} />);
    // first PR selected by default → its failed build is the blocker
    expect(screen.getByRole('status')).toHaveTextContent(/Blocked by build \(failed\)/);
    fireEvent.click(screen.getByText(/PR 20/));
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing blocking/);
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
});
