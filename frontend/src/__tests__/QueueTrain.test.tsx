import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueueTrain } from '../QueueTrain';
import type { RepoQueueView, QueueGroupView } from '../types';

const group = (over: Partial<QueueGroupView>): QueueGroupView => ({
  oid: 'abc123',
  prNumbers: [8943, 8941],
  percent: 80,
  etaSeconds: 120,
  failed: false,
  ...over,
});

describe('QueueTrain', () => {
  it('renders nothing when queue is null', () => {
    const { container } = render(<QueueTrain queue={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when queue has no groups and no waiting entries', () => {
    const queue: RepoQueueView = { groups: [], waiting: [], unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 6 };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a building car for each group with progress bar', () => {
    const queue: RepoQueueView = {
      groups: [
        group({ prNumbers: [8943, 8941, 8939], percent: 80, etaSeconds: 120 }),
        group({ oid: 'def456', prNumbers: [8905, 8902], percent: 30, etaSeconds: 600 }),
      ],
      waiting: [],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    // Two building cars
    const cars = container.querySelectorAll('.car.building');
    expect(cars).toHaveLength(2);
    // Headers present (two building groups each have the header)
    expect(screen.getAllByText('▶ group')).toHaveLength(2);
    // Progress text — ETA is labeled "left" (remaining, not total duration)
    expect(screen.getByText(/80% · ~2m left/)).toBeInTheDocument();
    expect(screen.getByText(/30% · ~10m left/)).toBeInTheDocument();
  });

  it('renders PR number anchor links pointing to #pr-{n} inside building car', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [8943, 8941] })],
      waiting: [],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const links = container.querySelectorAll('.car.building a');
    expect(links).toHaveLength(2);
    expect((links[0] as HTMLAnchorElement).href).toContain('#pr-8943');
    expect((links[1] as HTMLAnchorElement).href).toContain('#pr-8941');
    expect(links[0].textContent).toBe('#8943');
    expect(links[1].textContent).toBe('#8941');
  });

  it('renders a failed building car with red border class + failing label', () => {
    const queue: RepoQueueView = {
      groups: [group({ failed: true, percent: 89, etaSeconds: null })],
      waiting: [],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const failCar = container.querySelector('.car.building.failed');
    expect(failCar).not.toBeNull();
    expect(failCar!.textContent).toContain('✗ failing');
  });

  it('renders building car with no progress bar text when percent is null', () => {
    const queue: RepoQueueView = {
      groups: [group({ percent: null, etaSeconds: null })],
      waiting: [],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.car.building')).not.toBeNull();
    // No percent text rendered
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('waiting: 7 entries with batchSize 6 → next-batch car (6 numbers) + then car (1)', () => {
    const waiting = Array.from({ length: 7 }, (_, i) => ({ prNumber: 8960 - i, position: i + 1 }));
    const queue: RepoQueueView = { groups: [], waiting, unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 6 };
    const { container } = render(<QueueTrain queue={queue} />);
    const dashed = container.querySelectorAll('.car.queued');
    expect(dashed).toHaveLength(2);
    // First = next batch
    expect(dashed[0].textContent).toContain('next batch');
    // Second = then
    expect(dashed[1].textContent).toContain('then');
    // then car shows count of remaining (1)
    expect(dashed[1].textContent).toContain('1 more');
  });

  it('next-batch car shows up to batchSize numbers then +N overflow', () => {
    // 10 waiting, batchSize 4 → first car shows 4, rest in "then" (6)
    const waiting = Array.from({ length: 10 }, (_, i) => ({ prNumber: 8900 + i, position: i + 1 }));
    const queue: RepoQueueView = { groups: [], waiting, unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 4 };
    const { container } = render(<QueueTrain queue={queue} />);
    const dashed = container.querySelectorAll('.car.queued');
    expect(dashed).toHaveLength(2);
    // next batch shows exactly 4 numbers as links, no overflow in this case since batchSize=4
    const nextLinks = dashed[0].querySelectorAll('a');
    expect(nextLinks).toHaveLength(4);
    // "then" car shows 6 remaining
    expect(dashed[1].textContent).toContain('6 more');
  });

  it('next-batch car overflows with +N when batchSize exceeds MAX_NUMBERS_PER_CAR', () => {
    // batchSize=8, 10 waiting → next-batch car slices 8 entries but PrLinks only shows 6 + "+2"
    // "then" car shows 2 more (10 - 8 = 2 remaining)
    const waiting = Array.from({ length: 10 }, (_, i) => ({ prNumber: 9000 + i, position: i + 1 }));
    const queue: RepoQueueView = { groups: [], waiting, unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 8 };
    const { container } = render(<QueueTrain queue={queue} />);
    const dashed = container.querySelectorAll('.car.queued');
    expect(dashed).toHaveLength(2);
    // next-batch car: PrLinks shows max 6 links out of 8 entries, renders "+2" overflow
    const nextLinks = dashed[0].querySelectorAll('a');
    expect(nextLinks).toHaveLength(6);
    expect(dashed[0].textContent).toContain('+2');
    // then car: 10 - 8 = 2 remaining
    expect(dashed[1].textContent).toContain('2 more');
  });

  it('single waiting entry → one next-batch car, no then car', () => {
    const queue: RepoQueueView = {
      groups: [],
      waiting: [{ prNumber: 8960, position: 1 }],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const dashed = container.querySelectorAll('.car.queued');
    expect(dashed).toHaveLength(1);
    expect(dashed[0].textContent).toContain('next batch');
  });

  it('car has title tooltip listing its PR numbers', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [8943, 8941, 8939] })],
      waiting: [],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const car = container.querySelector('.car.building')!;
    const title = car.getAttribute('title');
    expect(title).toContain('#8943');
    expect(title).toContain('#8941');
    expect(title).toContain('#8939');
  });

  it('car with >6 numbers shows +N overflow for the displayed list', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [100, 101, 102, 103, 104, 105, 106, 107] })],
      waiting: [],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const car = container.querySelector('.car.building')!;
    // Max 6 links visible
    const links = car.querySelectorAll('a');
    expect(links).toHaveLength(6);
    // Overflow text "+2"
    expect(car.textContent).toContain('+2');
  });

  it('anchor click calls scrollIntoView and prevents default navigation', () => {
    const mockScrollIntoView = vi.fn();
    const mockGetElementById = vi.spyOn(document, 'getElementById').mockReturnValue({
      scrollIntoView: mockScrollIntoView,
    } as unknown as HTMLElement);

    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [8943] })],
      waiting: [],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    render(<QueueTrain queue={queue} />);
    const link = screen.getByText('#8943');
    fireEvent.click(link);

    expect(mockGetElementById).toHaveBeenCalledWith('pr-8943');
    expect(mockScrollIntoView).toHaveBeenCalledOnce();

    mockGetElementById.mockRestore();
  });

  it('renders the train wrapper with overflow-x scroll class', () => {
    const queue: RepoQueueView = {
      groups: [group({})],
      waiting: [],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const train = container.querySelector('.queue-train');
    expect(train).not.toBeNull();
  });

  it('renders building + waiting cars together', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [8943], percent: 80, etaSeconds: 120 })],
      waiting: [
        { prNumber: 8960, position: 1 },
        { prNumber: 8958, position: 2 },
      ],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.car.building')).not.toBeNull();
    expect(container.querySelector('.car.queued')).not.toBeNull();
  });

  // HEADGREEN: UNMERGEABLE entries get their own distinct car instead of being
  // folded into the covering group's car or rendered as innocuous queued rows.
  it('renders an unmergeable car with ✗ header and anchor links', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [8943] })],
      waiting: [],
      unmergeable: [8878], queueBlocked: [], unmergeableCulprit: 8878,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const car = container.querySelector('.car.unmergeable');
    expect(car).not.toBeNull();
    expect(car!.textContent).toContain('✗ unmergeable');
    const link = car!.querySelector('a') as HTMLAnchorElement;
    expect(link.href).toContain('#pr-8878');
    expect(link.textContent).toBe('#8878');
    // not folded into the building car
    expect(container.querySelector('.car.building')!.textContent).not.toContain('#8878');
  });

  it('unmergeable car caps numbers at 6 with +N overflow and title tooltip', () => {
    const queue: RepoQueueView = {
      groups: [],
      waiting: [],
      unmergeable: [9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007],
      queueBlocked: [], unmergeableCulprit: 9000,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const car = container.querySelector('.car.unmergeable')!;
    expect(car.querySelectorAll('a')).toHaveLength(6);
    expect(car.textContent).toContain('+2');
    expect(car.getAttribute('title')).toContain('#9000');
  });

  it('queue with only unmergeable entries still renders the train', () => {
    const queue: RepoQueueView = {
      groups: [],
      waiting: [],
      unmergeable: [8878], queueBlocked: [], unmergeableCulprit: 8878,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.queue-train')).not.toBeNull();
    expect(container.querySelector('.car.unmergeable')).not.toBeNull();
  });

  it('no unmergeable car when the list is empty', () => {
    const queue: RepoQueueView = {
      groups: [group({})],
      waiting: [],
      unmergeable: [], queueBlocked: [], unmergeableCulprit: null,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.car.unmergeable')).toBeNull();
  });

  // Cascade-unmergeable split: genuine conflicts (DIRTY) ride the red ✗ car;
  // cascade victims (UNMERGEABLE only because of a conflict ahead) get their own
  // amber ⊘ car so they are never told to rebase.
  it('live cascade scenario: red ✗ car for the genuine conflict, amber ⊘ car for the blocked entries', () => {
    const queue: RepoQueueView = {
      groups: [group({ prNumbers: [9338] })],
      waiting: [{ prNumber: 9342, position: 6 }],
      unmergeable: [8878],
      queueBlocked: [9335, 9323, 9337],
      unmergeableCulprit: 8878,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const genuine = container.querySelector('.car.unmergeable')!;
    expect(genuine.textContent).toContain('✗ unmergeable');
    expect(genuine.textContent).toContain('#8878');
    const blocked = container.querySelector('.car.queue-blocked')!;
    expect(blocked).not.toBeNull();
    expect(blocked.textContent).toContain('⊘ blocked behind conflict');
    for (const n of [9335, 9323, 9337]) expect(blocked.textContent).toContain(`#${n}`);
    // cascade victims never appear in the red car, and vice versa
    expect(genuine.textContent).not.toContain('#9335');
    expect(blocked.textContent).not.toContain('#8878');
  });

  it('queue-blocked car links anchor to rows and the tooltip names the culprit', () => {
    const queue: RepoQueueView = {
      groups: [],
      waiting: [],
      unmergeable: [8878],
      queueBlocked: [9335],
      unmergeableCulprit: 8878,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    const blocked = container.querySelector('.car.queue-blocked')!;
    const link = blocked.querySelector('a') as HTMLAnchorElement;
    expect(link.href).toContain('#pr-9335');
    expect(blocked.getAttribute('title')).toContain('#8878');
  });

  it('no queue-blocked car when the list is empty', () => {
    const queue: RepoQueueView = {
      groups: [group({})],
      waiting: [],
      unmergeable: [8878], queueBlocked: [], unmergeableCulprit: 8878,
      batchSize: 6,
    };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.car.queue-blocked')).toBeNull();
  });

  it('tolerates a pre-upgrade payload without queueBlocked/unmergeableCulprit', () => {
    const queue = {
      groups: [group({})],
      waiting: [],
      unmergeable: [8878],
      batchSize: 6,
    } as unknown as RepoQueueView;
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.car.unmergeable')).not.toBeNull();
    expect(container.querySelector('.car.queue-blocked')).toBeNull();
  });

  // ---- in-place tooltips (legend feature) ----

  describe('car title tooltips explain the car type', () => {
    it('building car explains the speculative merge-group build', () => {
      const queue: RepoQueueView = {
        groups: [group({ prNumbers: [9338] })], waiting: [],
        unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 6,
      };
      const { container } = render(<QueueTrain queue={queue} />);
      const title = container.querySelector('.car.building')!.getAttribute('title')!;
      expect(title).toContain('merge group building');
      expect(title).toContain('#9338');
    });

    it('failed building car says the group build failed', () => {
      const queue: RepoQueueView = {
        groups: [group({ prNumbers: [9338], failed: true })], waiting: [],
        unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 6,
      };
      const { container } = render(<QueueTrain queue={queue} />);
      expect(container.querySelector('.car.building.failed')!.getAttribute('title'))
        .toContain('merge group build failed');
    });

    it('waiting cars explain next batch vs further back', () => {
      const queue: RepoQueueView = {
        groups: [], waiting: Array.from({ length: 8 }, (_, i) => ({ prNumber: 9000 + i, position: i + 1 })),
        unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 6,
      };
      const { container } = render(<QueueTrain queue={queue} />);
      const cars = container.querySelectorAll('.car.queued');
      expect(cars[0]!.getAttribute('title')).toContain('next batch');
      expect(cars[1]!.getAttribute('title')).toContain('further back');
    });

    it('unmergeable car advises a rebase; blocked car names the conflict ahead', () => {
      const queue: RepoQueueView = {
        groups: [], waiting: [],
        unmergeable: [8878], queueBlocked: [9335], unmergeableCulprit: 8878, batchSize: 6,
      };
      const { container } = render(<QueueTrain queue={queue} />);
      const red = container.querySelector('.car.unmergeable')!.getAttribute('title')!;
      expect(red).toContain('needs a rebase');
      expect(red).toContain('#8878');
      const amber = container.querySelector('.car.queue-blocked')!.getAttribute('title')!;
      expect(amber).toContain('blocked behind a conflicting entry');
      expect(amber).toContain('#8878');
      expect(amber).toContain('#9335');
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #39: ops header strip
// ---------------------------------------------------------------------------

describe('QueueTrain ops strip (issue #39)', () => {
  const baseQueue: RepoQueueView = {
    groups: [group({})], waiting: [], unmergeable: [], queueBlocked: [],
    unmergeableCulprit: null, batchSize: 6,
    health: { state: 'healthy', detail: 'queue healthy', since: '2026-06-12T10:00:00Z' },
    depth: 3,
    entriesWithWaitSecs: [
      { prNumber: 8943, position: 1, waitSecs: 600 },
      { prNumber: 8941, position: 2, waitSecs: 1800 },
    ],
    trainsPerHour: 1.5,
    batchSuccessRatePct: 80,
    ejects24h: 2,
  };

  it('healthy: green badge with no visible remediation text (tooltip only)', () => {
    const { container } = render(<QueueTrain queue={baseQueue} />);
    const badge = container.querySelector('.ops-health')!;
    expect(badge).toHaveClass('healthy');
    expect(badge).toHaveTextContent('healthy');
    expect(badge).toHaveAttribute('title', 'queue healthy');
    expect(container.querySelector('.ops-remediation')).toBeNull();
  });

  it('shows depth, trains/hr, batch success, ejects, and oldest wait', () => {
    render(<QueueTrain queue={baseQueue} />);
    expect(screen.getByText('depth 3')).toBeInTheDocument();
    expect(screen.getByText('1.5 trains/hr')).toBeInTheDocument();
    expect(screen.getByText('80% batch success')).toBeInTheDocument();
    expect(screen.getByText('2 ejects 24h')).toBeInTheDocument();
    expect(screen.getByText('oldest wait ~30m')).toBeInTheDocument();
  });

  it('cap-backlog: amber badge with the remediation visible AND in the tooltip', () => {
    const detail = 'cap-backlog: demand exceeds runner cap — wait or raise cap';
    const queue = { ...baseQueue,
      health: { state: 'cap-backlog' as const, detail, since: '2026-06-12T10:00:00Z' } };
    const { container } = render(<QueueTrain queue={queue} />);
    const badge = container.querySelector('.ops-health')!;
    expect(badge).toHaveClass('cap-backlog');
    expect(badge).toHaveTextContent('cap backlog');
    expect(badge).toHaveAttribute('title', detail);
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it('dispatch-stall: red badge with the do-NOT-admin-merge remediation visible', () => {
    const detail = 'dispatch-stall: queue recovery needed — do NOT admin-merge';
    const queue = { ...baseQueue,
      health: { state: 'dispatch-stall' as const, detail, since: '2026-06-12T10:00:00Z' } };
    const { container } = render(<QueueTrain queue={queue} />);
    const badge = container.querySelector('.ops-health')!;
    expect(badge).toHaveClass('dispatch-stall');
    expect(badge).toHaveTextContent('DISPATCH STALL');
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it('pre-upgrade payload without health renders no ops strip (train unaffected)', () => {
    const queue: RepoQueueView = { groups: [group({})], waiting: [], unmergeable: [],
      queueBlocked: [], unmergeableCulprit: null, batchSize: 6 };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.queue-ops')).toBeNull();
    expect(container.querySelectorAll('.car.building')).toHaveLength(1);
  });

  it('omits ejects when zero and hides null success rate', () => {
    const queue = { ...baseQueue, ejects24h: 0, batchSuccessRatePct: null };
    render(<QueueTrain queue={queue} />);
    expect(screen.queryByText(/ejects 24h/)).toBeNull();
    expect(screen.queryByText(/batch success/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #40: multi-train ETA on waiting cars
// ---------------------------------------------------------------------------

describe('QueueTrain waiting-car merge ETA (issue #40)', () => {
  it('next-batch car shows the front entry p50/p90 with the full tooltip', () => {
    const queue: RepoQueueView = {
      groups: [], unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 2,
      waiting: [
        { prNumber: 9006, position: 1,
          sim: { p50Secs: 1320, p90Secs: 2460, trainsAhead: 2, assumesEjects: true } },
        { prNumber: 9007, position: 2, sim: null },
        { prNumber: 9008, position: 3,
          sim: { p50Secs: 1920, p90Secs: 3360, trainsAhead: 3, assumesEjects: true } },
      ],
    };
    render(<QueueTrain queue={queue} />);
    const nextEta = screen.getByText('~22m / ~41m p90');
    expect(nextEta).toBeInTheDocument();
    expect(nextEta).toHaveAttribute('title',
      'merges in ~22m (p50) / ~41m (p90, assumes ≤1 eject); 2 trains ahead');
    // "then" car (beyond batchSize) shows the LAST entry's (worst-case) sim
    expect(screen.getByText('~32m / ~56m p90')).toBeInTheDocument();
  });

  it('waiting entries without a sim render no ETA line (pre-upgrade/no samples)', () => {
    const queue: RepoQueueView = {
      groups: [], unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 6,
      waiting: [{ prNumber: 9006, position: 1 }],
    };
    const { container } = render(<QueueTrain queue={queue} />);
    expect(container.querySelector('.car.queued .car-progress')).toBeNull();
  });
});
