// frontend/src/__tests__/PrDashboard.test.tsx
import { render } from '@testing-library/react';
import { PrDashboard } from '../embed';

// Reuse the MockEventSource pattern (see useDashboard.test.tsx).
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string; onopen: any = null; onmessage: any = null; onerror: any = null;
  constructor(url: string) { this.url = url; MockEventSource.instances.push(this); }
  addEventListener() {} close() {}
}
beforeEach(() => {
  MockEventSource.instances = [];
  history.pushState({}, '', '/console/ci/health');
  Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, writable: true, configurable: true });
});
afterEach(() => { history.pushState({}, '', '/'); location.hash = ''; });

it('mounts and opens the SSE at the injected apiBase', () => {
  render(<PrDashboard apiBase="/api/ci" basename="/console/ci" />);
  expect(MockEventSource.instances[0].url).toBe('/api/ci/events');
});

it('renders no banner/navigation/main landmark', () => {
  const { container } = render(<PrDashboard apiBase="/api/ci" basename="/console/ci" />);
  expect(container.querySelector('[role="banner"]')).toBeNull();
  expect(container.querySelector('[role="navigation"]')).toBeNull();
  expect(container.querySelector('[role="main"]')).toBeNull();
});

it('wraps content in .prdash-root and does not style document.body', () => {
  const before = document.body.getAttribute('style');
  const { container } = render(<PrDashboard apiBase="/api/ci" />);
  expect(container.querySelector('.prdash-root')).not.toBeNull();
  expect(document.body.getAttribute('style')).toBe(before);
});

it('binds no global ⌘K keydown handler', () => {
  const add = vi.spyOn(window, 'addEventListener');
  render(<PrDashboard apiBase="/api/ci" />);
  const keydownCalls = add.mock.calls.filter(([type]) => type === 'keydown');
  expect(keydownCalls).toHaveLength(0);
  add.mockRestore();
});
