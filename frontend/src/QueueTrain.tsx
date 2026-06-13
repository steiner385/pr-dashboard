import type { RepoQueueView, QueueGroupView, MergeEtaSimulation, QueueHealthState } from './types';
import { formatDur } from './format';
import { scrollBehavior } from './motion';
import { DEFS, defTitle } from './definitions';

const MAX_NUMBERS_PER_CAR = 6;

function prLabel(n: number) {
  return `#${n}`;
}

function handlePrLinkClick(e: React.MouseEvent<HTMLAnchorElement>, n: number) {
  e.preventDefault();
  document.getElementById(`pr-${n}`)?.scrollIntoView({ behavior: scrollBehavior() });
}

/** Render up to MAX_NUMBERS_PER_CAR links with +N overflow. */
function PrLinks({ numbers, className }: { numbers: number[]; className?: string }) {
  const shown = numbers.slice(0, MAX_NUMBERS_PER_CAR);
  const overflow = numbers.length - shown.length;
  return (
    <span className={className}>
      {shown.map((n, i) => (
        <span key={n}>
          {i > 0 && ' '}
          <a href={`#pr-${n}`} onClick={(e) => handlePrLinkClick(e, n)}>{prLabel(n)}</a>
        </span>
      ))}
      {overflow > 0 && ` +${overflow}`}
    </span>
  );
}

function BuildingCar({ g }: { g: QueueGroupView }) {
  const pct = g.percent;
  // g.etaSeconds is the REMAINING time (p50 − elapsed, max over required checks),
  // not the train's total duration — label it "left" so it can't read as a total.
  const eta = g.etaSeconds != null ? formatDur(g.etaSeconds) : null;
  const progressText = pct != null ? (eta ? `${pct}% · ~${eta} left` : `${pct}%`) : null;
  const nums = g.prNumbers.map(prLabel).join(' ');
  const tooltip = g.failed
    ? `merge group build failed — the queue re-batches without the culprit: ${nums}`
    : `merge group building — speculative merge of these PRs is running the full CI suite: ${nums}`;
  return (
    <div
      className={`car building${g.failed ? ' failed' : ''}`}
      title={tooltip}
    >
      <div className="car-header">{g.failed ? '✗ failing' : '▶ group'}</div>
      <PrLinks numbers={g.prNumbers} className="car-numbers" />
      {!g.failed && pct != null && (
        <div className="car-pct">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {!g.failed && progressText && (
        <div className="car-progress">{progressText}</div>
      )}
    </div>
  );
}

/** `~22m / ~41m p90` — the multi-train ETA range (issue #40); null-safe. */
function simText(sim: MergeEtaSimulation | null | undefined): string | null {
  if (!sim) return null;
  return `~${formatDur(sim.p50Secs)} / ~${formatDur(sim.p90Secs)} p90`;
}

function simTooltip(sim: MergeEtaSimulation): string {
  const ejects = sim.assumesEjects ? ', assumes ≤1 eject' : '';
  const trains = `${sim.trainsAhead} train${sim.trainsAhead === 1 ? '' : 's'} ahead`;
  return `merges in ~${formatDur(sim.p50Secs)} (p50) / ~${formatDur(sim.p90Secs)} (p90${ejects}); ${trains}`;
}

function WaitingCars({ waiting, batchSize }: { waiting: { prNumber: number; position: number; sim?: MergeEtaSimulation | null }[]; batchSize: number }) {
  if (waiting.length === 0) return null;

  // First car: "next batch" — up to batchSize entries
  const nextBatch = waiting.slice(0, batchSize);
  // Remaining: collapsed into a single "then" car
  const rest = waiting.slice(batchSize);
  // multi-train ETA (issue #40): the front entry speaks for the next batch;
  // the LAST entry (worst case) speaks for the collapsed "then" car
  const nextSim = simText(nextBatch[0]?.sim);
  const restSim = simText(rest[rest.length - 1]?.sim);

  return (
    <>
      <div className="car queued"
        title={`waiting — next batch to start building when a slot frees: ${nextBatch.map((w) => prLabel(w.prNumber)).join(' ')}`}>
        <div className="car-header">next batch</div>
        <PrLinks numbers={nextBatch.map((w) => w.prNumber)} className="car-numbers" />
        {nextSim && (
          <div className="car-progress" title={simTooltip(nextBatch[0]!.sim!)}>{nextSim}</div>
        )}
      </div>
      {rest.length > 0 && (
        <div className="car queued"
          title={`waiting further back in the queue: ${rest.map((w) => prLabel(w.prNumber)).join(' ')}`}>
          <div className="car-header">then</div>
          <span className="car-numbers car-count">{rest.length} more</span>
          {restSim && (
            <div className="car-progress" title={simTooltip(rest[rest.length - 1]!.sim!)}>{restSim}</div>
          )}
        </div>
      )}
    </>
  );
}

// ---- ops header strip (issue #39) ------------------------------------------

const HEALTH_LABELS: Record<QueueHealthState, string> = {
  healthy: 'healthy',
  'cap-backlog': 'cap backlog',
  'dispatch-stall': 'DISPATCH STALL',
};

/** Compact operator strip above the train: health badge (remediation as
 *  tooltip + visible text when not healthy), depth, trains/hr, batch success
 *  rate, oldest wait. Hidden entirely on pre-upgrade payloads (no `health`). */
function OpsStrip({ queue }: { queue: RepoQueueView }) {
  const health = queue.health;
  if (!health) return null;
  const oldest = (queue.entriesWithWaitSecs ?? [])
    .reduce<number | null>((acc, e) => Math.max(acc ?? 0, e.waitSecs), null);
  return (
    <div className="queue-ops">
      <span className={`ops-health ${health.state}`} title={health.detail}>
        ● {HEALTH_LABELS[health.state] ?? health.state}
      </span>
      {health.state !== 'healthy' && (
        <span className="ops-remediation">{health.detail}</span>
      )}
      <span className="ops-stat" title={defTitle(DEFS.queueDepth)}>depth {queue.depth ?? 0}</span>
      {queue.trainsPerHour != null && (
        <span className="ops-stat" title={defTitle(DEFS.trainsPerHour)}>
          {queue.trainsPerHour.toFixed(1)} trains/hr</span>
      )}
      {queue.batchSuccessRatePct != null && (
        <span className="ops-stat" title={defTitle(DEFS.batchSuccessRate)}>
          {queue.batchSuccessRatePct}% batch success</span>
      )}
      {(queue.ejects24h ?? 0) > 0 && (
        <span className="ops-stat" title={defTitle(DEFS.ejects24h)}>
          {queue.ejects24h} eject{queue.ejects24h === 1 ? '' : 's'} 24h</span>
      )}
      {oldest != null && (
        <span className="ops-stat" title={defTitle(DEFS.oldestWait)}>
          oldest wait ~{formatDur(oldest)}</span>
      )}
    </div>
  );
}

/** GENUINELY conflicting UNMERGEABLE entries (DIRTY against the base, facing
 *  ejection) get a distinct red car — never folded into a group's car or the
 *  waiting line. Cascade victims render in the amber QueueBlockedCar instead. */
function UnmergeableCar({ numbers }: { numbers: number[] }) {
  if (numbers.length === 0) return null;
  return (
    <div className="car unmergeable"
      title={`conflicts with the base branch — needs a rebase, facing ejection from the queue: ${numbers.map(prLabel).join(' ')}`}>
      <div className="car-header">✗ unmergeable</div>
      <PrLinks numbers={numbers} className="car-numbers" />
    </div>
  );
}

/** Cascade-UNMERGEABLE entries: GitHub marks queue entries UNMERGEABLE
 *  positionally, so one genuine conflict poisons every entry behind it. These
 *  don't conflict with the base themselves — amber, not red, and no rebase
 *  advice; they revalidate once the culprit is ejected. */
function QueueBlockedCar({ numbers, culprit }: { numbers: number[]; culprit: number | null }) {
  if (numbers.length === 0) return null;
  const blockedOn = culprit != null ? ` (${prLabel(culprit)})` : '';
  return (
    <div className="car queue-blocked"
      title={`blocked behind a conflicting entry ahead${blockedOn} — not conflicting themselves; they revalidate once it is ejected: ${numbers.map(prLabel).join(' ')}`}>
      <div className="car-header">⊘ blocked behind conflict</div>
      <PrLinks numbers={numbers} className="car-numbers" />
    </div>
  );
}

export function QueueTrain({ queue }: { queue: RepoQueueView | null }) {
  if (!queue) return null;
  // tolerate a pre-upgrade server payload
  const unmergeable = queue.unmergeable ?? [];
  const queueBlocked = queue.queueBlocked ?? [];
  if (queue.groups.length === 0 && queue.waiting.length === 0
    && unmergeable.length === 0 && queueBlocked.length === 0) return null;

  return (
    <div className="queue-section">
      <OpsStrip queue={queue} />
      <div className="queue-train">
        {queue.groups.map((g) => (
          <BuildingCar key={g.oid} g={g} />
        ))}
        <WaitingCars waiting={queue.waiting} batchSize={queue.batchSize} />
        <UnmergeableCar numbers={unmergeable} />
        <QueueBlockedCar numbers={queueBlocked} culprit={queue.unmergeableCulprit ?? null} />
      </div>
    </div>
  );
}
