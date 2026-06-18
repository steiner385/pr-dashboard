// Tier-1 of the unified-workspace data spine (spec 001, FR-024 / research D3): the
// live snapshot store. Holds the latest streamed DashboardState frame and notifies
// subscribers on change — the single live source the Health/Diagnose/kiosk surfaces
// read, fed by the ingest poller. Decouples the live tier from the on-demand (Tier-2)
// and cached (Tier-3) tiers so a heavy analysis never blocks the live view (P5/SC-007).
// Generic + pure (no I/O) — index.ts feeds it from the poller; tests use it directly.

export type Unsubscribe = () => void;

export class LiveSnapshotStore<T> {
  private snapshot: T | null = null;
  private at = 0;
  private subs = new Set<(s: T) => void>();

  constructor(private now: () => number = () => Date.now()) {}

  /** Replace the live snapshot and notify subscribers (latest-wins). */
  set(s: T): void {
    this.snapshot = s;
    this.at = this.now();
    for (const cb of [...this.subs]) { try { cb(s); } catch { /* one bad listener can't wedge the tier */ } }
  }

  /** The latest snapshot, or null before the first frame. */
  get(): T | null { return this.snapshot; }

  /** Epoch ms of the last set() (0 before any frame) — feeds self-obs freshness. */
  updatedAt(): number { return this.at; }

  /** Subscribe to frames; returns an unsubscribe. A subscriber that throws does
   *  not break the fan-out to the others (one bad listener can't wedge the tier). */
  subscribe(cb: (s: T) => void): Unsubscribe {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }

  /** Live subscriber count (for diagnostics/tests). */
  subscriberCount(): number { return this.subs.size; }
}
