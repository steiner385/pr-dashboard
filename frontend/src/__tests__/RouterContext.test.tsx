import { renderHook, act } from '@testing-library/react';
import { RouterProvider, useSectionRoute } from '../embed/RouterContext';

afterEach(() => { history.pushState({}, '', '/'); location.hash = ''; });

it('throws without a provider', () => {
  expect(() => renderHook(() => useSectionRoute())).toThrow(/RouterProvider/);
});

it('path mode pushes state and never touches the hash', () => {
  history.pushState({}, '', '/console/ci/health');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    <RouterProvider mode="path" basename="/console/ci">{children}</RouterProvider>;
  const { result } = renderHook(() => useSectionRoute(), { wrapper });
  expect(result.current.active).toBe('health');
  act(() => result.current.go('diagnose'));
  expect(location.pathname).toBe('/console/ci/diagnose');
  expect(location.hash).toBe('');
  expect(result.current.active).toBe('diagnose');
});

it('exposes isPending (idle false) and still navigates under the transition (#181)', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    <RouterProvider mode="hash">{children}</RouterProvider>;
  const { result } = renderHook(() => useSectionRoute(), { wrapper });
  expect(typeof result.current.isPending).toBe('boolean');
  expect(result.current.isPending).toBe(false);    // idle
  act(() => result.current.go('diagnose'));
  expect(result.current.active).toBe('diagnose');   // transition flushed by act()
  expect(result.current.isPending).toBe(false);     // settled
});

it('hash mode reads + writes the hash (standalone behavior)', () => {
  location.hash = '#pipeline';
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    <RouterProvider mode="hash">{children}</RouterProvider>;
  const { result } = renderHook(() => useSectionRoute(), { wrapper });
  expect(result.current.active).toBe('pipeline');
  act(() => result.current.go('insights'));
  expect(location.hash).toBe('#insights');
});
