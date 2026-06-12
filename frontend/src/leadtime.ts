import type { LeadTimeSegmentId } from './types';

/** Lead-time segment display metadata (issue #44), pipeline order — mirrors
 *  the server's LEAD_TIME_SEGMENTS ids. Single source of truth for the
 *  Metrics lead-time panel, the per-PR waterfall (issue #50), and the segment
 *  tooltips (issue #66), so colors and copy always agree. `desc` names the
 *  two timeline waypoints the segment is measured between. */
export const LEAD_TIME_SEGMENTS: { id: LeadTimeSegmentId; label: string; color: string; desc: string }[] = [
  { id: 'toFirstGreen', label: 'to first green', color: 'var(--accent)',
    desc: 'PR created → its checks first all green' },
  { id: 'greenToEnqueued', label: 'green → enqueued', color: 'var(--amber)',
    desc: 'checks green → entered the merge queue (review + arming lag)' },
  { id: 'queue', label: 'queue', color: 'var(--purple)',
    desc: 'entered the merge queue → merged' },
  { id: 'qaDeploy', label: 'QA deploy', color: 'var(--done)',
    desc: 'merged → live on QA' },
  { id: 'awaitingProd', label: 'awaiting prod', color: 'var(--fail)',
    desc: 'live on QA → live on production (manual deploy lag)' },
];
