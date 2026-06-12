/** Compact duration: `45s`, `4m`, `1h 5m`. */
export function formatDur(secs: number): string {
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  if (secs >= 60) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs)}s`;
}

/** Compact local onset time for duration-regression badges (issue #41):
 *  weekday style ('Tue 14:00') within the last 7 days, date style
 *  ('Jun 10, 14:00') beyond. Unparseable input passes through. */
export function formatSince(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const withinWeek = Math.abs(now.getTime() - d.getTime()) < 7 * 86400_000;
  return d.toLocaleString(undefined, withinWeek
    ? { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatEta(etaSeconds: number | null, range: [number, number] | null, overdue: boolean): string {
  if (overdue) return 'overdue';
  if (etaSeconds == null) return '';
  if (etaSeconds === 0) return 'done';
  if (range && range[1] > range[0]) {
    const lo = Math.round(range[0] / 60), hi = Math.round(range[1] / 60);
    if (lo !== hi) return `~${lo}–${hi}m left`;
  }
  return `~${formatDur(etaSeconds)} left`;
}

export const STAGE_LABEL: Record<string, string> = {
  ci: 'CI running', queue: 'Merge queue', 'qa-deploy': 'QA deploying',
  'awaiting-prod': 'On QA — awaiting prod', merged: 'Merged', ready: 'Ready', parked: 'Parked',
};

export function stageLabel(stage: string, substate: string | null): string {
  if (substate === 'ci-failed') return 'CI failed';
  if (substate === 'conflicting') return 'Conflicting';
  if (substate === 'draft') return 'Draft';
  if (substate === 'armed') return 'Ready — auto-merge armed';
  if (substate === 'idle') return 'Ready';
  if (substate === 'propagating') return 'Merged — propagating';
  if (substate === 'unknown') return 'Deploy state unknown';
  if (substate === 'retrying') return 'CI retrying';
  if (substate === 'group-failed') return 'Queue group failed';
  if (substate === 'unmergeable') return 'Queue — unmergeable';
  if (substate === 'queue-blocked') return 'Queue — blocked behind conflict';
  return STAGE_LABEL[stage] ?? stage;
}
