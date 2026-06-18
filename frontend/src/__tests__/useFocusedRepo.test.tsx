import { renderHook } from '@testing-library/react';
import { useFocusedRepo } from '../shell/useFocusedRepo';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('useFocusedRepo', () => {
  beforeEach(() => localStorage.removeItem('workspace.focusedPipeline'));

  it('controlled: returns the prop and never persists on repo load', () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ repos }) => useFocusedRepo({ controlled: 'o/x', onChange, repos }),
      { initialProps: { repos: [] as string[] } },
    );
    expect(result.current[0]).toBe('o/x');
    rerender({ repos: ['o/a', 'o/b'] }); // repos arrive
    expect(result.current[0]).toBe('o/x');                       // still the controlled value
    expect(localStorage.getItem('workspace.focusedPipeline')).toBeNull(); // adopt effect disabled
    result.current[1]('o/b');
    expect(onChange).toHaveBeenCalledWith('o/b');
  });

  it('uncontrolled: adopts the first repo once repos arrive', () => {
    const { result, rerender } = renderHook(
      ({ repos }) => useFocusedRepo({ repos }),
      { initialProps: { repos: [] as string[] } },
    );
    expect(result.current[0]).toBeNull();
    rerender({ repos: ['o/a', 'o/b'] });
    expect(result.current[0]).toBe('o/a');
  });
});
