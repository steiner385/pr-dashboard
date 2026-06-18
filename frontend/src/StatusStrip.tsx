import type { PrView } from './types';

export type Bucket = 'running' | 'queued' | 'deploy' | 'failed' | 'idle';

/** Map a PrView to its status bucket. */
export function bucketPr(pr: PrView): Bucket {
  const { stage, substate } = pr.stage;
  if (stage === 'ci') return 'running';
  if (stage === 'queue') {
    if (substate === 'group-failed') return 'failed';
    return 'queued';
  }
  // qa-deploy / awaiting-prod only exist for repos with deploy environments;
  // bare 'merged' is the retention-window stage for repos WITHOUT deploys and
  // must not inflate the deploy ("Awaiting prod") tile.
  if (stage === 'qa-deploy' || stage === 'awaiting-prod') return 'deploy';
  if (stage === 'parked') {
    if (substate === 'ci-failed') return 'failed';
    return 'idle';
  }
  // ready + merged + any other parked substate
  return 'idle';
}

/** Is the PR failed? The single source of truth — derived from bucketPr so the
 *  status-strip tile, the repo summary, and the pipeline header can never
 *  disagree about what "failed" means. */
export function isFailedPr(pr: PrView): boolean {
  return bucketPr(pr) === 'failed';
}

/** Is the PR moving through an active pipeline stage (CI → queue → QA deploy)?
 *  Excludes awaiting-prod (waiting, not working) and parked/ready/merged. Shared
 *  so the legacy summary and the workspace pipeline header classify identically. */
export function isActivePr(pr: PrView): boolean {
  const { stage } = pr.stage;
  return stage === 'ci' || stage === 'queue' || stage === 'qa-deploy';
}

interface TileConfig { bucket: Bucket; label: string; cssClass: string; title: string; }

/** One-line bucket definitions — surfaced as the tile tooltip and reused by the
 *  legend panel so the two can never drift apart. */
export const TILE_DEFINITIONS: TileConfig[] = [
  { bucket: 'running', label: 'CI running',     cssClass: 'tile-running',
    title: 'CI running on the head commit' },
  { bucket: 'queued',  label: 'In queue',        cssClass: 'tile-queued',
    title: 'In the merge queue — building or waiting for a slot' },
  { bucket: 'deploy',  label: 'Awaiting prod',   cssClass: 'tile-deploy',
    title: 'Merged — deploying to QA or awaiting production deploy' },
  { bucket: 'failed',  label: 'Failed',          cssClass: 'tile-failed',
    title: 'CI failed or the merge-group build failed' },
  { bucket: 'idle',    label: 'Ready / other',   cssClass: 'tile-idle',
    title: 'Ready, draft, conflicting, or recently merged — nothing running' },
];

const TILES = TILE_DEFINITIONS;

interface StatusStripProps {
  prs: PrView[];
  activeFilter: Bucket | null;
  onFilter: (bucket: Bucket | null) => void;
  /** false in kiosk mode (issue #20): tiles render as plain glanceable divs
   *  instead of filter buttons. */
  interactive?: boolean;
}

export function StatusStrip({ prs, activeFilter, onFilter, interactive = true }: StatusStripProps) {
  const counts = new Map<Bucket, number>();
  for (const p of prs) {
    const b = bucketPr(p);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }

  return (
    <div className="status-strip" role="group" aria-label="Status overview">
      {TILES.map(({ bucket, label, cssClass, title }) => {
        const count = counts.get(bucket) ?? 0;
        if (!interactive) {
          // read-only tile: same look, no filter affordance (empty buckets
          // dim via .zero, mirroring the disabled button state)
          return (
            <div key={bucket}
              className={`status-tile ${cssClass}${count === 0 ? ' zero' : ''}`}
              title={title}>
              <b>{count}</b>
              <span>{label}</span>
            </div>
          );
        }
        const isActive = activeFilter === bucket;
        const disabled = count === 0 && !isActive;
        return (
          <button
            key={bucket}
            type="button"
            className={`status-tile ${cssClass}${isActive ? ' active' : ''}`}
            /* tooltip doubles as the accessible description; the visible
               count + label stays the accessible name */
            title={title}
            aria-pressed={isActive}
            disabled={disabled}
            onClick={() => onFilter(isActive ? null : bucket)}
          >
            <b>{count}</b>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
