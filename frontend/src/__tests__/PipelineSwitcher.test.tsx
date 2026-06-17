import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { PipelineSwitcher, filterRepos, useFocusedPipeline } from '../shell/PipelineSwitcher';

const REPOS = ['cairnea/KinDash', 'cairnea/infra', 'steiner385/pr-dashboard'];

describe('filterRepos (pure)', () => {
  it('case-insensitive substring filter', () => {
    expect(filterRepos(REPOS, 'kind', null)).toEqual(['cairnea/KinDash']);
    expect(filterRepos(REPOS, 'cairnea', null)).toHaveLength(2);
  });
  it('sorts the focused repo first', () => {
    expect(filterRepos(REPOS, '', 'cairnea/infra')[0]).toBe('cairnea/infra');
  });
  it('empty query returns all', () => {
    expect(filterRepos(REPOS, '', null)).toHaveLength(3);
  });
});

describe('useFocusedPipeline (sticky focus)', () => {
  beforeEach(() => localStorage.clear());
  it('defaults to the first repo when nothing stored', () => {
    const { result } = renderHook(() => useFocusedPipeline(REPOS));
    expect(result.current[0]).toBe('cairnea/KinDash');
  });
  it('persists a focus choice to localStorage', () => {
    const { result } = renderHook(() => useFocusedPipeline(REPOS));
    act(() => result.current[1]('cairnea/infra'));
    expect(result.current[0]).toBe('cairnea/infra');
    expect(localStorage.getItem('workspace.focusedPipeline')).toBe('cairnea/infra');
  });
  it('restores a persisted focus on mount', () => {
    localStorage.setItem('workspace.focusedPipeline', 'steiner385/pr-dashboard');
    const { result } = renderHook(() => useFocusedPipeline(REPOS));
    expect(result.current[0]).toBe('steiner385/pr-dashboard');
  });
});

describe('PipelineSwitcher', () => {
  it('shows the focused pipeline and opens a filterable list', () => {
    const onFocus = vi.fn();
    render(<PipelineSwitcher repos={REPOS} focused="cairnea/KinDash" onFocus={onFocus} />);
    expect(screen.getByText('cairnea/KinDash')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /cairnea\/KinDash/ }));
    fireEvent.change(screen.getByLabelText('Filter pipelines'), { target: { value: 'infra' } });
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent('cairnea/infra');
  });
  it('selecting a pipeline fires onFocus', () => {
    const onFocus = vi.fn();
    render(<PipelineSwitcher repos={REPOS} focused="cairnea/KinDash" onFocus={onFocus} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('cairnea/infra'));
    expect(onFocus).toHaveBeenCalledWith('cairnea/infra');
  });
});
