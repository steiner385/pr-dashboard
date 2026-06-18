// Canonical CI/CD notification event-type registry — the SINGLE source of truth
// shared by the server (notifier detection + config validation) and the frontend
// (per-event config toggles + event typing). Adding a type here updates both
// surfaces at once; a per-surface copy would silently drift (a new server event
// type the frontend's config map doesn't know about, or vice-versa).
//
// Lives at the repo root so both toolchains resolve it: tsc via the single root
// tsconfig (`include` lists `shared`), and Vite/Rollup bundles it like any import.

export const NOTIFICATION_EVENT_TYPES = [
  'ci-failed', 'group-failed', 'queue-blocked', 'ready', 'overdue', 'prod-live',
  'queue-stalled', 'duration-regression', 'runner-starvation', 'budget-breach',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/** Event types plus 'digest' (issue #51) — the daily summary frame, gated by
 *  `notifications.digest.enabled` rather than the per-event toggles. */
export type NotificationKind = NotificationEventType | 'digest';
