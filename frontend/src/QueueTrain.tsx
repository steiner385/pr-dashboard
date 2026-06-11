import type { RepoQueueView, QueueGroupView } from './types';
import { formatDur } from './format';

const MAX_NUMBERS_PER_CAR = 6;

function prLabel(n: number) {
  return `#${n}`;
}

function handlePrLinkClick(e: React.MouseEvent<HTMLAnchorElement>, n: number) {
  e.preventDefault();
  const reduced = typeof window.matchMedia === 'function'
    ? !window.matchMedia('(prefers-reduced-motion: no-preference)').matches
    : true;
  document.getElementById(`pr-${n}`)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
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
  const eta = g.etaSeconds != null ? formatDur(g.etaSeconds) : null;
  const progressText = pct != null ? (eta ? `${pct}% · ~${eta}` : `${pct}%`) : null;
  const tooltip = g.prNumbers.map(prLabel).join(' ');
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

function WaitingCars({ waiting, batchSize }: { waiting: { prNumber: number; position: number }[]; batchSize: number }) {
  if (waiting.length === 0) return null;

  // First car: "next batch" — up to batchSize entries
  const nextBatch = waiting.slice(0, batchSize);
  // Remaining: collapsed into a single "then" car
  const rest = waiting.slice(batchSize);

  return (
    <>
      <div className="car queued" title={nextBatch.map((w) => prLabel(w.prNumber)).join(' ')}>
        <div className="car-header">next batch</div>
        <PrLinks numbers={nextBatch.map((w) => w.prNumber)} className="car-numbers" />
      </div>
      {rest.length > 0 && (
        <div className="car queued" title={rest.map((w) => prLabel(w.prNumber)).join(' ')}>
          <div className="car-header">then</div>
          <span className="car-numbers car-count">{rest.length} more</span>
        </div>
      )}
    </>
  );
}

/** GENUINELY conflicting UNMERGEABLE entries (DIRTY against the base, facing
 *  ejection) get a distinct red car — never folded into a group's car or the
 *  waiting line. Cascade victims render in the amber QueueBlockedCar instead. */
function UnmergeableCar({ numbers }: { numbers: number[] }) {
  if (numbers.length === 0) return null;
  return (
    <div className="car unmergeable" title={numbers.map(prLabel).join(' ')}>
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
  const blockedOn = culprit != null ? ` — blocked behind ${prLabel(culprit)}` : '';
  return (
    <div className="car queue-blocked" title={`${numbers.map(prLabel).join(' ')}${blockedOn}`}>
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
    <div className="queue-train">
      {queue.groups.map((g) => (
        <BuildingCar key={g.oid} g={g} />
      ))}
      <WaitingCars waiting={queue.waiting} batchSize={queue.batchSize} />
      <UnmergeableCar numbers={unmergeable} />
      <QueueBlockedCar numbers={queueBlocked} culprit={queue.unmergeableCulprit ?? null} />
    </div>
  );
}
