import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeInspector } from '../sections/build/NodeInspector';

describe('NodeInspector (click-a-node form — keyboard-operable)', () => {
  it('shows the selected check and composes a timeout mutation', () => {
    const onApply = vi.fn();
    render(<NodeInspector check="e2e" jobId="e2e" onApply={onApply} />);
    expect(screen.getByText(/e2e/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add timeout/i }));
    expect(onApply).toHaveBeenCalledWith({ op: 'timeout', jobId: 'e2e', minutes: 15 });
  });

  it('composes shift-left and remove', () => {
    const onApply = vi.fn();
    render(<NodeInspector check="lint" jobId="lint" onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /shift-left/i }));
    expect(onApply).toHaveBeenCalledWith({ op: 'shift-left', jobId: 'lint' });
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(onApply).toHaveBeenCalledWith({ op: 'remove', jobId: 'lint' });
  });
});
