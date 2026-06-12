/**
 * Merge-train estimation from merged-PR timestamps.
 *
 * Why merged_prs and not group_runs: a group_runs row is only recorded when a
 * poll happens to catch a merge group all-completed *before* it leaves the
 * queue — most trains merge and vanish between polls, so counting group_runs
 * undercounts trains badly on a busy queue (observation bias; user-reported
 * 0.1 trains/hr on a queue merging dozens of PRs a day). Merged PRs, by
 * contrast, are durable rows swept from the GitHub search API, so clustering
 * their merge timestamps recovers the true train count: the queue squash-merges
 * a whole train back-to-back, so merges within TRAIN_GAP_MS of each other are
 * one train, and an isolated merge is a train of one.
 */

/** Merges ≤ this far apart (consecutive-gap, inclusive) belong to one train. */
export const TRAIN_GAP_MS = 90_000;

/**
 * Count merge trains by clustering merge timestamps (ms since epoch).
 * Consecutive merges with a gap ≤ `gapMs` chain into a single train;
 * non-finite inputs are ignored; input order is irrelevant.
 */
export function countMergeTrains(timestampsMs: number[], gapMs = TRAIN_GAP_MS): number {
  const sorted = timestampsMs.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  let trains = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gapMs) trains++;
  }
  return trains;
}
