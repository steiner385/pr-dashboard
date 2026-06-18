import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { HealthView, fleetRollup } from '../sections/health/HealthView';
import type { DashboardState } from '../types';

function repo(name: string, opts: { prs?: number; main?: string; blocked?: number[] } = {}) {
  return {
    repo: name, hasDeploy: false,
    prs: Array.from({ length: opts.prs ?? 0 }, (_, i) => ({ number: i + 1 })) as never,
    queue: opts.blocked ? ({ groups: [], waiting: [], unmergeable: [], queueBlocked: opts.blocked, unmergeableCulprit: null } as never) : null,
    laneHealth: opts.main ? ({ main: opts.main } as never) : undefined,
  };
}
function state(repos: ReturnType<typeof repo>[]): DashboardState {
  return { generatedAt: '2026-06-17T00:00:00Z', staleSince: null, repos } as unknown as DashboardState;
}

describe('fleetRollup (attention-sort, FR-005)', () => {
  it('orders down → attention → healthy, then busiest first', () => {
    const s = state([
      repo('o/healthy', { prs: 9, main: 'green' }),
      repo('o/down', { prs: 1, main: 'red' }),
      repo('o/amber', { prs: 2, main: 'amber' }),
      repo('o/blocked', { prs: 5, blocked: [101, 102] }),
    ]);
    const order = fleetRollup(s).map((r) => r.repo);
    expect(order[0]).toBe('o/down');
    // both amber and blocked are 'attention'; busier (blocked, 5 PRs) comes before amber (2)
    expect(order.slice(1, 3)).toEqual(['o/blocked', 'o/amber']);
    expect(order[3]).toBe('o/healthy');
  });

  it('classifies a blocked queue as attention with a reason', () => {
    const [row] = fleetRollup(state([repo('o/b', { blocked: [7] })]));
    expect(row.verdict).toBe('attention');
    expect(row.reason).toMatch(/1 queue entry blocked/);
  });
});

describe('HealthView', () => {
  const s = state([repo('o/a', { prs: 3, main: 'green' }), repo('o/b', { main: 'red' })]);

  it('renders the fleet roll-up attention-first and is clickable to focus a repo', () => {
    const onFocusRepo = vi.fn();
    render(<HealthView state={s} connected onFocusRepo={onFocusRepo} />);
    const list = within(screen.getByLabelText('Pipeline fleet')).getAllByRole('listitem');
    expect(list[0]).toHaveTextContent('o/b'); // down first
    fireEvent.click(screen.getByText('o/a'));
    expect(onFocusRepo).toHaveBeenCalledWith('o/a');
  });

  it('fleet rows are keyboard-operable buttons (roadmap 2.2 a11y)', () => {
    const onFocusRepo = vi.fn();
    render(<HealthView state={s} connected onFocusRepo={onFocusRepo} />);
    const btn = screen.getByRole('button', { name: /o\/a/ });
    expect(btn.tagName).toBe('BUTTON');
    btn.focus();
    expect(btn).toHaveFocus(); // tabbable, unlike a bare <li onClick>
    fireEvent.click(btn);
    expect(onFocusRepo).toHaveBeenCalledWith('o/a');
  });

  it('shows a reconnecting notice when the live feed is down (SC-007 liveness)', () => {
    render(<HealthView state={s} connected={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(/reconnecting/i);
  });
});
