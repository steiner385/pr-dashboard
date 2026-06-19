/**
 * useFocusTrap — TDD tests (write-red → implement-green)
 *
 * Covers:
 *  1. Focus moves into container on activate
 *  2. Esc calls onClose
 *  3. Return focus on deactivate (via returnFocusRef)
 *  4. Tab on last focusable → wraps to first
 *  5. Shift-Tab on first focusable → wraps to last
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';

// ---- minimal test harness ---------------------------------------------------

interface TrapHostProps {
  active: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Renders a dialog-like div with two focusable children and wires up useFocusTrap. */
function TrapHost({ active, onClose, returnFocusRef }: TrapHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, active, { onClose, returnFocusRef });
  return (
    <div ref={containerRef} data-testid="container" tabIndex={-1}>
      <button data-testid="btn-first">First</button>
      <button data-testid="btn-last">Last</button>
    </div>
  );
}

/** Host with a SINGLE focusable child (edge-case: wrapping first = last). */
function TrapHostSingle({ active, onClose }: TrapHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, active, { onClose });
  return (
    <div ref={containerRef} data-testid="container" tabIndex={-1}>
      <button data-testid="btn-only">Only</button>
    </div>
  );
}

/** Host with no focusable children — container itself should receive focus. */
function TrapHostEmpty({ active, onClose }: TrapHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, active, { onClose });
  return (
    <div ref={containerRef} data-testid="container" tabIndex={-1} />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================

describe('useFocusTrap', () => {
  // 1. Focus moves into container on activate
  it('moves focus to the first focusable element when activated', async () => {
    const { getByTestId } = render(<TrapHost active={true} onClose={() => {}} />);
    const first = getByTestId('btn-first');
    await waitFor(() => {
      expect(document.activeElement).toBe(first);
    });
  });

  it('falls back to focusing the container itself when there are no focusable children', async () => {
    const { getByTestId } = render(<TrapHostEmpty active={true} onClose={() => {}} />);
    const container = getByTestId('container');
    await waitFor(() => {
      expect(document.activeElement).toBe(container);
    });
  });

  it('does NOT move focus when inactive', () => {
    const { getByTestId } = render(<TrapHost active={false} onClose={() => {}} />);
    const container = getByTestId('container');
    expect(document.activeElement).not.toBe(container);
    expect(document.activeElement).not.toBe(getByTestId('btn-first'));
  });

  // 2. Esc calls onClose
  it('calls onClose when Escape is pressed while active', () => {
    const onClose = vi.fn();
    render(<TrapHost active={true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose for Escape when inactive', () => {
    const onClose = vi.fn();
    render(<TrapHost active={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  // 3. Return focus on deactivate
  it('returns focus to returnFocusRef.current when deactivated', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const returnFocusRef = { current: trigger };

    const { rerender } = render(
      <TrapHost active={true} onClose={() => {}} returnFocusRef={returnFocusRef} />,
    );
    // Deactivate
    rerender(<TrapHost active={false} onClose={() => {}} returnFocusRef={returnFocusRef} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('returns focus to returnFocusRef on unmount', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const returnFocusRef = { current: trigger };

    const { unmount } = render(
      <TrapHost active={true} onClose={() => {}} returnFocusRef={returnFocusRef} />,
    );
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('returns focus to previousFocusElement when returnFocusRef is absent', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(<TrapHost active={true} onClose={() => {}} />);
    // At this point focus has moved into the container. Deactivate:
    rerender(<TrapHost active={false} onClose={() => {}} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  // 4. Tab on last focusable → wraps to first
  it('Tab on the last focusable element wraps focus to the first', () => {
    const { getByTestId } = render(<TrapHost active={true} onClose={() => {}} />);
    const first = getByTestId('btn-first');
    const last = getByTestId('btn-last');

    last.focus();
    expect(document.activeElement).toBe(last);

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tabEvent);

    expect(document.activeElement).toBe(first);
  });

  it('Tab in the middle (not on last) does NOT wrap focus', () => {
    const { getByTestId } = render(<TrapHost active={true} onClose={() => {}} />);
    const first = getByTestId('btn-first');

    first.focus();
    expect(document.activeElement).toBe(first);

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tabEvent);

    // Focus should remain on first (not moved by the trap; would naturally move to last on real Tab)
    expect(document.activeElement).toBe(first);
  });

  // 5. Shift-Tab on first focusable → wraps to last
  it('Shift-Tab on the first focusable element wraps focus to the last', () => {
    const { getByTestId } = render(<TrapHost active={true} onClose={() => {}} />);
    const first = getByTestId('btn-first');
    const last = getByTestId('btn-last');

    first.focus();
    expect(document.activeElement).toBe(first);

    const shiftTabEvent = new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    });
    document.dispatchEvent(shiftTabEvent);

    expect(document.activeElement).toBe(last);
  });

  it('Shift-Tab on the last element (not first) does NOT wrap focus', () => {
    const { getByTestId } = render(<TrapHost active={true} onClose={() => {}} />);
    const last = getByTestId('btn-last');

    last.focus();

    const shiftTabEvent = new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    });
    document.dispatchEvent(shiftTabEvent);

    // Focus stays on last (trap only wraps when on first, for shift-tab)
    expect(document.activeElement).toBe(last);
  });

  // Edge case: single focusable child — wrapping stays on that same element
  it('Tab on the only focusable element wraps back to itself', () => {
    const { getByTestId } = render(<TrapHostSingle active={true} onClose={() => {}} />);
    const only = getByTestId('btn-only');

    only.focus();
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tabEvent);

    expect(document.activeElement).toBe(only);
  });
});
