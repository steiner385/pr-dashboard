import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardState, NotificationEvent, NotificationEventType } from './types';

// ---- browser notifications (issue #19) ----
// Opt-in Web Notifications for the named `notification` SSE frames. No service
// worker is involved: the tab must be open (even backgrounded) to receive them.

const LS_NOTIFY_KEY = 'prdash.notifications';

const NOTIFY_LABELS: Record<NotificationEventType, string> = {
  'ci-failed': 'CI failed',
  'group-failed': 'merge-queue group failed',
  'queue-blocked': 'queue blocked',
  ready: 'ready to merge',
  overdue: 'overdue',
  'prod-live': 'live on prod',
  'queue-stalled': 'merge queue STALLED',
  'duration-regression': 'duration regression',
  'runner-starvation': 'runner pool starving',
};

/** Repo-level event types carry prNumber 0 — render the repo, never "repo#0". */
const REPO_LEVEL_TYPES = new Set<NotificationEventType>(
  ['queue-stalled', 'duration-regression', 'runner-starvation']);

function notifySupported(): boolean {
  return typeof Notification !== 'undefined';
}

function readNotifyPref(): boolean {
  try { return localStorage.getItem(LS_NOTIFY_KEY) === 'true'; } catch { return false; }
}

function writeNotifyPref(v: boolean): void {
  try { localStorage.setItem(LS_NOTIFY_KEY, String(v)); } catch { /* private mode — ignore */ }
}

/** Frames arrive once per poll cycle; if none lands within this window while the
 *  socket is still open, the feed has stalled (poller hung / GitHub throttled) —
 *  a distinct state from a dropped connection. */
const STALE_AFTER_MS = 90_000;

export interface DashboardHook {
  state: DashboardState | null;
  connected: boolean;
  /** Connected but no fresh frame within STALE_AFTER_MS — the data on screen is
   *  aging even though the socket is up. Drives the spine's three-state indicator. */
  stale: boolean;
  /** Whether this browser supports Web Notifications (bell hidden otherwise). */
  notifySupported: boolean;
  /** Bell state: notifications are shown only when true AND permission granted. */
  notifyEnabled: boolean;
  /** Toggle the bell; turning it on requests Notification permission if needed. */
  toggleNotify: () => void;
}

export function useDashboard(): DashboardHook {
  const [state, setState] = useState<DashboardState | null>(null);
  const [connected, setConnected] = useState(false);
  const [stale, setStale] = useState(false);
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supported = notifySupported();
  // restore the persisted bell only while permission is still granted — a
  // revoked permission would otherwise show an on-bell that does nothing
  const [notifyEnabled, setNotifyEnabled] = useState(() =>
    supported && readNotifyPref() && Notification.permission === 'granted');
  const notifyEnabledRef = useRef(notifyEnabled);
  notifyEnabledRef.current = notifyEnabled;

  useEffect(() => {
    // No initial fetch: the SSE endpoint sends a full state frame on connect,
    // and a parallel fetch can race it and overwrite fresher data.
    // Each frame resets the staleness watchdog; if the timer fires first, the feed
    // has gone quiet while the socket stayed open → stale (not disconnected).
    const armStale = () => {
      if (staleTimer.current) clearTimeout(staleTimer.current);
      staleTimer.current = setTimeout(() => setStale(true), STALE_AFTER_MS);
    };
    const onFrame = (data: string) => { setConnected(true); setStale(false); armStale(); setState(JSON.parse(data) as DashboardState); };
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => onFrame(e.data);
    es.onerror = () => setConnected(false);
    // Named `notification` frames (issue #19) — never delivered to onmessage.
    es.addEventListener('notification', (e: MessageEvent) => {
      if (!notifyEnabledRef.current) return;
      if (!notifySupported() || Notification.permission !== 'granted') return;
      try {
        const ev = JSON.parse(e.data as string) as NotificationEvent;
        if (ev.type === 'digest') {
          // pre-rendered daily summary (issue #51): subject in title, body in detail
          new Notification(ev.title, { body: ev.detail, tag: 'digest' });
          return;
        }
        // repo-level events carry prNumber 0 — never show "#0"
        const subject = REPO_LEVEL_TYPES.has(ev.type) ? ev.repo : `${ev.repo}#${ev.prNumber}`;
        new Notification(`${subject} ${NOTIFY_LABELS[ev.type] ?? ev.type}`, {
          body: ev.detail ? `${ev.title} — ${ev.detail}` : ev.title,
          // tag collapses repeats of the same (PR, event) if the server restarts
          tag: `${ev.repo}#${ev.prNumber}|${ev.type}`,
        });
      } catch { /* malformed frame — ignore */ }
    });
    return () => { es.close(); if (staleTimer.current) clearTimeout(staleTimer.current); };
  }, []);

  const toggleNotify = useCallback(() => {
    if (!notifySupported()) return;
    if (notifyEnabledRef.current) {
      setNotifyEnabled(false);
      writeNotifyPref(false);
      return;
    }
    const enable = () => { setNotifyEnabled(true); writeNotifyPref(true); };
    if (Notification.permission === 'granted') { enable(); return; }
    if (Notification.permission === 'denied') return; // browser-level block — bell stays off
    void Notification.requestPermission().then((p) => { if (p === 'granted') enable(); });
  }, []);

  return { state, connected, stale, notifySupported: supported, notifyEnabled, toggleNotify };
}
