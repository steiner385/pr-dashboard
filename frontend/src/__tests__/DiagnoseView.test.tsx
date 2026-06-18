import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('PR-list rows are keyboard-operable buttons (roadmap 2.2 a11y)', () => {
    render(<DiagnoseView state={s} />);
    const rows = screen.getAllByRole('button').filter((b) => /#\d+/.test(b.textContent ?? ''));
    expect(rows.length).toBeGreaterThan(0);
    rows[0].focus();
    expect(rows[0]).toHaveFocus(); // tabbable
  });
});
