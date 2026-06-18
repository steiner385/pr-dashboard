import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette } from '../shell/CommandPalette';

beforeEach(() => { location.hash = ''; });

describe('CommandPalette (⌘K — jump to any section or repo)', () => {
  it('opens on Cmd/Ctrl-K and closes on Escape', () => {
    render(<CommandPalette repos={['acme/a', 'acme/b']} onFocusRepo={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('filters commands and navigates to a section on Enter', () => {
    render(<CommandPalette repos={['acme/a']} onFocusRepo={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'insight' } });
    const opts = screen.getAllByRole('option');
    expect(opts.length).toBe(1);
    expect(opts[0]).toHaveTextContent(/Insights/i);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(location.hash).toBe('#insights');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // closes after run
  });

  it('focuses a repo when its command is chosen', () => {
    const onFocusRepo = vi.fn();
    render(<CommandPalette repos={['acme/alpha', 'acme/beta']} onFocusRepo={onFocusRepo} />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'beta' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onFocusRepo).toHaveBeenCalledWith('acme/beta');
  });
});
