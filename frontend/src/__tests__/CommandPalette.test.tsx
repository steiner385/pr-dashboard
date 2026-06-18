import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette } from '../shell/CommandPalette';

beforeEach(() => { location.hash = ''; });

describe('CommandPalette (controlled — jump to any section or repo)', () => {
  it('renders nothing when closed, the dialog when open', () => {
    const { rerender } = render(<CommandPalette open={false} onClose={vi.fn()} repos={['acme/a']} onFocusRepo={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<CommandPalette open onClose={vi.fn()} repos={['acme/a']} onFocusRepo={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} repos={['acme/a']} onFocusRepo={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('filters commands and navigates to a section on Enter (then closes)', () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} repos={['acme/a']} onFocusRepo={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'insight' } });
    const opts = screen.getAllByRole('option');
    expect(opts.length).toBe(1);
    expect(opts[0]).toHaveTextContent(/Insights/i);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(location.hash).toBe('#insights');
    expect(onClose).toHaveBeenCalled();
  });

  it('focuses a repo when its command is chosen', () => {
    const onFocusRepo = vi.fn();
    render(<CommandPalette open onClose={vi.fn()} repos={['acme/alpha', 'acme/beta']} onFocusRepo={onFocusRepo} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'beta' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onFocusRepo).toHaveBeenCalledWith('acme/beta');
  });
});
