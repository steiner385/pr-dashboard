import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Waterfall, waterfallSegments } from '../Waterfall';
import type { PrTimeline } from '../types';

/** Full spine: created 08:00 → green 09:00 → enqueued 09:30 → merged 10:00
 *  → qa 10:20 → prod 12:20 (total 4h20m). */
const FULL: PrTimeline = {
  createdAt: '2026-06-10T08:00:00Z',
  firstGreenAt: '2026-06-10T09:00:00Z',
  enqueuedAt: '2026-06-10T09:30:00Z',
  mergedAt: '2026-06-10T10:00:00Z',
  qaLiveAt: '2026-06-10T10:20:00Z',
  prodLiveAt: '2026-06-10T12:20:00Z',
};

describe('waterfallSegments', () => {
  it('builds all five segments from a complete timeline, pipeline order', () => {
    const segs = waterfallSegments(FULL);
    expect(segs.map((s) => s.id)).toEqual(
      ['toFirstGreen', 'greenToEnqueued', 'queue', 'qaDeploy', 'awaitingProd']);
    expect(segs.map((s) => (s.endMs - s.startMs) / 60_000)).toEqual([60, 30, 30, 20, 120]);
  });

  it('omits segments with a missing endpoint — no fabrication', () => {
    // no firstGreenAt: toFirstGreen AND greenToEnqueued both lack an endpoint
    const segs = waterfallSegments({ ...FULL, firstGreenAt: null });
    expect(segs.map((s) => s.id)).toEqual(['queue', 'qaDeploy', 'awaitingProd']);
  });

  it('PR merged outside the queue (no enqueuedAt) keeps the deploy segments', () => {
    const segs = waterfallSegments({ ...FULL, enqueuedAt: null });
    expect(segs.map((s) => s.id)).toEqual(['toFirstGreen', 'qaDeploy', 'awaitingProd']);
  });

  it('drops unparseable and negative-duration pairs', () => {
    expect(waterfallSegments({ ...FULL, createdAt: 'garbage' }).map((s) => s.id))
      .toEqual(['greenToEnqueued', 'queue', 'qaDeploy', 'awaitingProd']);
    // qaLiveAt after prodLiveAt (clock skew) → awaitingProd omitted, qaDeploy kept
    expect(waterfallSegments({ ...FULL, prodLiveAt: '2026-06-10T10:00:00Z' }).map((s) => s.id))
      .toEqual(['toFirstGreen', 'greenToEnqueued', 'queue', 'qaDeploy']);
  });
});

describe('Waterfall', () => {
  it('renders one bar per present segment with duration labels and tooltips', () => {
    const { container, getByTestId } = render(<Waterfall timeline={FULL} />);
    expect(container.querySelectorAll('[data-testid^="waterfall-seg-"]').length).toBe(5);
    const queue = getByTestId('waterfall-seg-queue');
    expect(queue.querySelector('title')!.textContent).toContain('queue');
    expect(queue.querySelector('title')!.textContent).toContain('30m');
    // per-row duration label
    expect(getByTestId('waterfall-dur-awaitingProd').textContent).toBe('2h');
  });

  it('bars share one time scale (queue and greenToEnqueued have equal widths; awaitingProd is 4×)', () => {
    const { getByTestId } = render(<Waterfall timeline={FULL} />);
    const w = (id: string) =>
      Number(getByTestId(`waterfall-seg-${id}`).querySelector('rect')!.getAttribute('width'));
    expect(w('queue')).toBeCloseTo(w('greenToEnqueued'), 5);
    expect(w('awaitingProd')).toBeCloseTo(w('queue') * 4, 5);
  });

  it('uses the lead-time panel legend colors', () => {
    const { getByTestId } = render(<Waterfall timeline={FULL} />);
    expect(getByTestId('waterfall-seg-queue').querySelector('rect')!.getAttribute('fill'))
      .toBe('var(--purple)');
    expect(getByTestId('waterfall-seg-qaDeploy').querySelector('rect')!.getAttribute('fill'))
      .toBe('var(--done)');
  });

  it('renders hour/minute axis labels on the shared scale', () => {
    const { container } = render(<Waterfall timeline={FULL} />);
    const text = container.textContent!;
    expect(text).toContain('0m');       // axis origin
    expect(text).toContain('4h 20m');   // total span
  });

  it('renders nothing when no segment has both endpoints', () => {
    const { container } = render(<Waterfall timeline={{
      createdAt: null, firstGreenAt: null, enqueuedAt: null,
      mergedAt: '2026-06-10T10:00:00Z', qaLiveAt: null, prodLiveAt: null,
    }} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('Waterfall — a11y: enriched aria-label with actual segment data (#173)', () => {
  it('svg aria-label includes each segment name and formatted duration', () => {
    const { container } = render(<Waterfall timeline={FULL} />);
    const svg = container.querySelector('svg')!;
    const label = svg.getAttribute('aria-label')!;
    // Must include segment names
    expect(label).toContain('to first green');
    expect(label).toContain('queue');
    // Must include formatted durations
    expect(label).toContain('1h');    // toFirstGreen is 60m = 1h
    expect(label).toContain('30m');   // greenToEnqueued and queue are each 30m
  });

  it('svg aria-label has a descriptive prefix, not just the generic placeholder', () => {
    const { container } = render(<Waterfall timeline={FULL} />);
    const svg = container.querySelector('svg')!;
    const label = svg.getAttribute('aria-label')!;
    // Should have a lead-in that names what this chart is
    expect(label.toLowerCase()).toContain('waterfall');
  });

  it('svg aria-label reflects only present segments (partial timeline)', () => {
    const partial = { ...FULL, enqueuedAt: null, qaLiveAt: null, prodLiveAt: null };
    const { container } = render(<Waterfall timeline={partial} />);
    const svg = container.querySelector('svg')!;
    const label = svg.getAttribute('aria-label')!;
    // toFirstGreen is present
    expect(label).toContain('to first green');
    // queue/qaDeploy/awaitingProd are absent — their segment labels must not appear
    expect(label).not.toContain('queue');
    expect(label).not.toContain('QA deploy');
  });
});
