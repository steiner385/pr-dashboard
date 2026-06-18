import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDashboard } from '../useDashboard';
import type { DashboardState } from '../types';

// Minimal EventSource mock installed on globalThis (test-file-scoped)
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: { data: string }) => void) {
    (this.listeners[type] ??= []).push(fn);
  }

  fireOpen() { this.onopen?.(); }
  fireMessage(data: string) { this.onmessage?.({ data }); }
  fireNamed(type: string, data: string) { for (const fn of this.listeners[type] ?? []) fn({ data }); }
  fireError() { this.onerror?.(); }
  close() {}
}

// Web Notification mock (jsdom has none) — instances record constructor calls.
class MockNotification {
  static permission: NotificationPermission = 'granted';
  static instances: { title: string; opts?: { body?: string } }[] = [];
  static requestPermission = vi.fn(async () => MockNotification.permission);
  constructor(title: string, opts?: { body?: string }) {
    MockNotification.instances.push({ title, opts });
  }
}

const SAMPLE_STATE: DashboardState = {
  generatedAt: '2026-06-10T12:00:00Z', staleSince: null, repos: [],
};

beforeEach(() => {
  MockEventSource.instances = [];
  MockNotification.instances = [];
  MockNotification.permission = 'granted';
  MockNotification.requestPermission = vi.fn(async () => MockNotification.permission);
  localStorage.removeItem('prdash.notifications');
  // Install on globalThis so new EventSource(...) in useDashboard picks it up
  Object.defineProperty(globalThis, 'EventSource', {
    value: MockEventSource,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'Notification', {
    value: MockNotification,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDashboard', () => {
  it('starts disconnected before any event', () => {
    const { result } = renderHook(() => useDashboard());
    expect(result.current.connected).toBe(false);
    expect(result.current.state).toBeNull();
  });

  it('connected becomes true on onopen', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireOpen(); });
    expect(result.current.connected).toBe(true);
  });

  it('connected becomes true + state updates on first message', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireMessage(JSON.stringify(SAMPLE_STATE)); });
    expect(result.current.connected).toBe(true);
    expect(result.current.state?.generatedAt).toBe('2026-06-10T12:00:00Z');
  });

  it('connected becomes false on onerror', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireOpen(); });
    expect(result.current.connected).toBe(true);
    act(() => { MockEventSource.instances[0]!.fireError(); });
    expect(result.current.connected).toBe(false);
  });

  it('state is retained after onerror (last known data stays visible)', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireMessage(JSON.stringify(SAMPLE_STATE)); });
    act(() => { MockEventSource.instances[0]!.fireError(); });
    expect(result.current.state).not.toBeNull();
  });
});

describe('useDashboard staleness (roadmap 5.6 — feed stalled while socket open)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is not stale immediately after a frame', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireMessage(JSON.stringify(SAMPLE_STATE)); });
    expect(result.current.stale).toBe(false);
  });

  it('goes stale when no frame arrives for the staleness window (socket still up)', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireMessage(JSON.stringify(SAMPLE_STATE)); });
    act(() => { vi.advanceTimersByTime(91_000); });
    expect(result.current.stale).toBe(true);
    expect(result.current.connected).toBe(true); // still connected — just no fresh data
  });

  it('clears stale when a fresh frame arrives', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireMessage(JSON.stringify(SAMPLE_STATE)); });
    act(() => { vi.advanceTimersByTime(91_000); });
    expect(result.current.stale).toBe(true);
    act(() => { MockEventSource.instances[0]!.fireMessage(JSON.stringify(SAMPLE_STATE)); });
    expect(result.current.stale).toBe(false);
  });
});

describe('useDashboard browser notifications (issue #19)', () => {
  // Display text is server-rendered (ev.rendered) — the single source of truth.
  const EV = { repo: 'acme/widgets', prNumber: 7, title: 'fix: the thing',
    type: 'ci-failed', detail: 'a required check failed',
    rendered: { title: 'acme/widgets#7 CI failed', body: 'fix: the thing — a required check failed' } };

  it('starts with the bell off and reports support', () => {
    const { result } = renderHook(() => useDashboard());
    expect(result.current.notifySupported).toBe(true);
    expect(result.current.notifyEnabled).toBe(false);
  });

  it('toggleNotify with granted permission enables and persists to localStorage', async () => {
    const { result } = renderHook(() => useDashboard());
    await act(async () => { result.current.toggleNotify(); });
    expect(result.current.notifyEnabled).toBe(true);
    expect(localStorage.getItem('prdash.notifications')).toBe('true');
    await act(async () => { result.current.toggleNotify(); });
    expect(result.current.notifyEnabled).toBe(false);
    expect(localStorage.getItem('prdash.notifications')).toBe('false');
  });

  it('requests permission when default, enabling only on grant', async () => {
    MockNotification.permission = 'default';
    MockNotification.requestPermission = vi.fn(async () => {
      MockNotification.permission = 'granted';
      return 'granted' as NotificationPermission;
    });
    const { result } = renderHook(() => useDashboard());
    await act(async () => { result.current.toggleNotify(); });
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(result.current.notifyEnabled).toBe(true);
  });

  it('a denied permission keeps the bell off without requesting again', async () => {
    MockNotification.permission = 'denied';
    const { result } = renderHook(() => useDashboard());
    await act(async () => { result.current.toggleNotify(); });
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    expect(result.current.notifyEnabled).toBe(false);
  });

  it('restores the bell from localStorage when permission is still granted', () => {
    localStorage.setItem('prdash.notifications', 'true');
    const { result } = renderHook(() => useDashboard());
    expect(result.current.notifyEnabled).toBe(true);
  });

  it('does NOT restore the bell when permission was revoked', () => {
    localStorage.setItem('prdash.notifications', 'true');
    MockNotification.permission = 'default';
    const { result } = renderHook(() => useDashboard());
    expect(result.current.notifyEnabled).toBe(false);
  });

  it('shows the server-rendered title/body verbatim when enabled', async () => {
    const { result } = renderHook(() => useDashboard());
    await act(async () => { result.current.toggleNotify(); });
    act(() => { MockEventSource.instances[0]!.fireNamed('notification', JSON.stringify(EV)); });
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]!.title).toBe('acme/widgets#7 CI failed');
    expect(MockNotification.instances[0]!.opts?.body).toBe('fix: the thing \u2014 a required check failed');
  });

  it('displays the rendered strings as-is for a repo-level event (server owns the subject rule)', async () => {
    const { result } = renderHook(() => useDashboard());
    await act(async () => { result.current.toggleNotify(); });
    act(() => { MockEventSource.instances[0]!.fireNamed('notification', JSON.stringify({
      repo: 'acme/widgets', prNumber: 0, title: 'build-test', type: 'duration-regression',
      detail: 'p50 4m \u2192 10m', rendered: { title: 'acme/widgets duration regression', body: 'build-test \u2014 p50 4m \u2192 10m' } })); });
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]!.title).toBe('acme/widgets duration regression');
    expect(MockNotification.instances[0]!.title).not.toContain('#0');
    expect(MockNotification.instances[0]!.opts?.body).toContain('build-test');
  });

  it('skips an event with no server-rendered text (pre-upgrade frame) rather than re-deriving', async () => {
    const { result } = renderHook(() => useDashboard());
    await act(async () => { result.current.toggleNotify(); });
    const { rendered, ...noRendered } = EV;
    act(() => { MockEventSource.instances[0]!.fireNamed('notification', JSON.stringify(noRendered)); });
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('no Web Notification while the bell is off', () => {
    renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireNamed('notification', JSON.stringify(EV)); });
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('no Web Notification when permission was revoked after enabling', async () => {
    const { result } = renderHook(() => useDashboard());
    await act(async () => { result.current.toggleNotify(); });
    MockNotification.permission = 'default'; // user revoked in browser settings
    act(() => { MockEventSource.instances[0]!.fireNamed('notification', JSON.stringify(EV)); });
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('a malformed notification frame is ignored without crashing', async () => {
    const { result } = renderHook(() => useDashboard());
    await act(async () => { result.current.toggleNotify(); });
    expect(() => {
      act(() => { MockEventSource.instances[0]!.fireNamed('notification', 'not json'); });
    }).not.toThrow();
    expect(MockNotification.instances).toHaveLength(0);
  });
});
