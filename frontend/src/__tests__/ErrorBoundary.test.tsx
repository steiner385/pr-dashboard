import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

function Bomb(): never {
  throw new Error('kaboom from child');
}

beforeEach(() => {
  // React logs caught render errors loudly — keep test output clean while
  // still letting us assert the boundary's own console.error call.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(<ErrorBoundary><p>all good</p></ErrorBoundary>);
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('renders the inline fallback card with the error message when a child throws', () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent(
      'something broke rendering this tab — kaboom from child — try refresh');
  });

  it('preserves console.error reporting of the caught error', () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    const calls = vi.mocked(console.error).mock.calls.flat();
    expect(calls.some((a) => a instanceof Error && a.message === 'kaboom from child')).toBe(true);
  });
});
