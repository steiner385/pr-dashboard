import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpineLane } from '../SpineLane';
import type { Lane } from '../../types';

const lane = (p: Partial<Lane>): Lane => ({
  id: 'queue', title: 'Merge queue', status: 'amber', summary: '2 trains · ~11m left',
  wiredness: 'wired', gating: true, glyphPosition: 'dot',
  renderExpanded: () => <div data-testid="panel">detail</div>, ...p,
});

describe('SpineLane', () => {
  it('renders status word + summary in the accessible name (color-independent)', () => {
    render(<SpineLane lane={lane({})} expanded={false} onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: /Merge queue.*watch.*2 trains/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
  it('keeps the panel element in the DOM (hidden) so aria-controls always resolves; body is lazy', () => {
    render(<SpineLane lane={lane({})} expanded={false} onToggle={() => {}} />);
    const btn = screen.getByRole('button');
    const panelId = btn.getAttribute('aria-controls')!;
    const panel = document.getElementById(panelId)!;
    // panel element resolves (WCAG 4.1.2) and is hidden while collapsed…
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('hidden');
    // …but the drill-down body is not mounted until the lane is expanded
    expect(screen.queryByTestId('panel')).toBeNull();
  });
  it('mounts the panel body when expanded', () => {
    render(<SpineLane lane={lane({})} expanded onToggle={() => {}} />);
    expect(screen.getByTestId('panel')).toBeInTheDocument();
  });
  it('toggles on click', () => {
    const onToggle = vi.fn();
    render(<SpineLane lane={lane({})} expanded={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
  it('a not-wired lane is not a button and exposes no expand', () => {
    render(<SpineLane lane={lane({ wiredness: 'not-wired', summary: 'not wired — no deploy envs' })}
      expanded={false} onToggle={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('spine-lane-queue')).toBeInTheDocument();
  });
});
