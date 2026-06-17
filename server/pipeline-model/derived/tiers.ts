/** A protection tier: a named column in the matrix, mapped to one GHA event. */
export interface TierDef {
  id: string;
  label: string;
  /** The `github.event_name` this tier represents. */
  event: string;
}

/** KinDash's v1 tier ladder (spec §5.2). One event per tier; nightly-vs-weekly
 *  is not event-distinguishable, so a single `schedule` tier for now. */
export const KINDASH_TIERS: TierDef[] = [
  { id: 'pr', label: 'PR', event: 'pull_request' },
  { id: 'queue', label: 'Queue', event: 'merge_group' },
  { id: 'main', label: 'Main', event: 'push' },
  { id: 'nightly', label: 'Nightly', event: 'schedule' },
];

export function tierForEvent(event: string, tiers: TierDef[] = KINDASH_TIERS): TierDef | null {
  return tiers.find((t) => t.event === event) ?? null;
}
