import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MetroTrack, trackState } from '../MetroTrack';
import type { StageResult } from '../types';

const stage = (over: Partial<StageResult>): StageResult => ({
  stage: 'ci', substate: null, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false,
  ...over,
});

const statuses = (s: StageResult, hasDeploy: boolean) => trackState(s, hasDeploy).map((n) => n.status);
const labels = (s: StageResult, hasDeploy: boolean) => trackState(s, hasDeploy).map((n) => n.label);

describe('trackState', () => {
  it('uses 5 labeled nodes for deploy repos and 3 for simple repos', () => {
    expect(labels(stage({}), true)).toEqual(['CI', 'Queue', 'Merged', 'QA', 'Prod']);
    expect(labels(stage({}), false)).toEqual(['CI', 'Queue', 'Merged']);
  });

  it('ci → CI active, rest pending', () => {
    expect(statuses(stage({ stage: 'ci' }), true))
      .toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
    expect(statuses(stage({ stage: 'ci' }), false)).toEqual(['active', 'pending', 'pending']);
  });

  it('ci/retrying → CI active (same as ci)', () => {
    expect(statuses(stage({ stage: 'ci', substate: 'retrying' }), true))
      .toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
  });

  it('parked/draft → CI node parked with substate label', () => {
    const nodes = trackState(stage({ stage: 'parked', substate: 'draft' }), true);
    expect(nodes[0]).toEqual({ label: 'draft', status: 'parked' });
    expect(nodes.slice(1).every((n) => n.status === 'pending')).toBe(true);
  });

  it('parked/conflicting → CI node parked with substate label', () => {
    const nodes = trackState(stage({ stage: 'parked', substate: 'conflicting' }), false);
    expect(nodes[0]).toEqual({ label: 'conflicting', status: 'parked' });
    expect(statuses(stage({ stage: 'parked', substate: 'conflicting' }), false))
      .toEqual(['parked', 'pending', 'pending']);
  });

  it('parked/ci-failed → fail at the CI node (keeps the CI label)', () => {
    const nodes = trackState(stage({ stage: 'parked', substate: 'ci-failed' }), true);
    expect(nodes[0]).toEqual({ label: 'CI', status: 'fail' });
    expect(nodes.slice(1).every((n) => n.status === 'pending')).toBe(true);
  });

  it('ready/armed → CI done, nothing active', () => {
    expect(statuses(stage({ stage: 'ready', substate: 'armed' }), true))
      .toEqual(['done', 'pending', 'pending', 'pending', 'pending']);
  });

  it('ready/idle → CI done, nothing active', () => {
    expect(statuses(stage({ stage: 'ready', substate: 'idle' }), false))
      .toEqual(['done', 'pending', 'pending']);
  });

  it('queue → CI done, Queue active', () => {
    expect(statuses(stage({ stage: 'queue' }), true))
      .toEqual(['done', 'active', 'pending', 'pending', 'pending']);
    expect(statuses(stage({ stage: 'queue' }), false)).toEqual(['done', 'active', 'pending']);
  });

  it('queue/group-failed → fail at the Queue node', () => {
    expect(statuses(stage({ stage: 'queue', substate: 'group-failed' }), true))
      .toEqual(['done', 'fail', 'pending', 'pending', 'pending']);
    expect(statuses(stage({ stage: 'queue', substate: 'group-failed' }), false))
      .toEqual(['done', 'fail', 'pending']);
  });

  it('queue/unmergeable → parked (amber !) at the Queue node, label kept', () => {
    expect(statuses(stage({ stage: 'queue', substate: 'unmergeable' }), true))
      .toEqual(['done', 'parked', 'pending', 'pending', 'pending']);
    expect(statuses(stage({ stage: 'queue', substate: 'unmergeable' }), false))
      .toEqual(['done', 'parked', 'pending']);
    expect(labels(stage({ stage: 'queue', substate: 'unmergeable' }), false))
      .toEqual(['CI', 'Queue', 'Merged']);
  });

  it('queue/queue-blocked (cascade victim) → parked (amber !) at the Queue node, label kept', () => {
    expect(statuses(stage({ stage: 'queue', substate: 'queue-blocked' }), true))
      .toEqual(['done', 'parked', 'pending', 'pending', 'pending']);
    expect(statuses(stage({ stage: 'queue', substate: 'queue-blocked' }), false))
      .toEqual(['done', 'parked', 'pending']);
    expect(labels(stage({ stage: 'queue', substate: 'queue-blocked' }), false))
      .toEqual(['CI', 'Queue', 'Merged']);
  });

  it('merged → all three lifecycle nodes done (terminal on simple repos)', () => {
    expect(statuses(stage({ stage: 'merged' }), false)).toEqual(['done', 'done', 'done']);
    // defensive on deploy repos (classify normally maps merged PRs to qa-deploy/awaiting-prod)
    expect(statuses(stage({ stage: 'merged' }), true))
      .toEqual(['done', 'done', 'done', 'pending', 'pending']);
  });

  it('qa-deploy → QA active (incl. propagating and unknown substates)', () => {
    for (const substate of [null, 'propagating', 'unknown']) {
      expect(statuses(stage({ stage: 'qa-deploy', substate }), true))
        .toEqual(['done', 'done', 'done', 'active', 'pending']);
    }
  });

  it('awaiting-prod → QA done, Prod active', () => {
    expect(statuses(stage({ stage: 'awaiting-prod' }), true))
      .toEqual(['done', 'done', 'done', 'done', 'active']);
  });
});

describe('MetroTrack', () => {
  it('renders the active node with a bold stage label and compact ETA beneath (ci)', () => {
    const { container } = render(
      <MetroTrack stage={stage({ stage: 'ci', percent: 55, etaSeconds: 360 })} hasDeploy />,
    );
    const active = container.querySelector('.node.active')!;
    expect(active).not.toBeNull();
    expect(active.querySelector('.node-label')!.textContent).toBe('CI');
    expect(active.querySelector('.node-eta')!.textContent).toBe('~6m');
  });

  it('only the active node carries the active (pulse) class', () => {
    const { container } = render(
      <MetroTrack stage={stage({ stage: 'ci', percent: 55 })} hasDeploy />,
    );
    expect(container.querySelectorAll('.node.active')).toHaveLength(1);
    expect(container.querySelectorAll('.node')).toHaveLength(5);
  });

  it('renders a ✗ fail node at Queue for queue/group-failed', () => {
    const { container } = render(
      <MetroTrack stage={stage({ stage: 'queue', substate: 'group-failed' })} hasDeploy />,
    );
    const fail = container.querySelector('.node.fail')!;
    expect(fail.querySelector('.c')!.textContent).toBe('✗');
    expect(fail.querySelector('.node-label')!.textContent).toBe('Queue');
    expect(container.querySelector('.node.active')).toBeNull();
  });

  it('renders an amber ! parked node at Queue for queue/unmergeable', () => {
    const { container } = render(
      <MetroTrack stage={stage({ stage: 'queue', substate: 'unmergeable' })} hasDeploy />,
    );
    const parked = container.querySelector('.node.parked')!;
    expect(parked.querySelector('.c')!.textContent).toBe('!');
    expect(parked.querySelector('.node-label')!.textContent).toBe('Queue');
    expect(container.querySelector('.node.active')).toBeNull();
  });

  it('renders an amber ! parked node labeled with the substate', () => {
    const { container } = render(
      <MetroTrack stage={stage({ stage: 'parked', substate: 'draft' })} hasDeploy />,
    );
    const parked = container.querySelector('.node.parked')!;
    expect(parked.querySelector('.c')!.textContent).toBe('!');
    expect(parked.querySelector('.node-label')!.textContent).toBe('draft');
  });

  it('fills the segment after the active node proportionally to stage percent', () => {
    const { container } = render(
      <MetroTrack stage={stage({ stage: 'ci', percent: 65 })} hasDeploy />,
    );
    const part = container.querySelector('.seg.part') as HTMLElement;
    expect(part).not.toBeNull();
    expect(part.style.background).toContain('65%');
  });

  it('renders done segments after done nodes and plain segments elsewhere', () => {
    const { container } = render(
      <MetroTrack stage={stage({ stage: 'queue', percent: null })} hasDeploy />,
    );
    const segs = container.querySelectorAll('.seg');
    expect(segs).toHaveLength(4);
    expect(segs[0]!.className).toContain('done');   // after done CI node
    expect(segs[1]!.className).not.toContain('done'); // after active Queue node, no percent
    expect(segs[1]!.className).not.toContain('part');
  });

  it('exposes a stage-position aria-label sized to the track', () => {
    const { container } = render(<MetroTrack stage={stage({ stage: 'queue' })} hasDeploy />);
    expect(container.querySelector('.track')!.getAttribute('aria-label')).toBe('stage 2 of 5');
  });

  it('does not show a node ETA when overdue or when ETA is missing', () => {
    const { container } = render(
      <MetroTrack stage={stage({ stage: 'ci', etaSeconds: 300, overdue: true })} hasDeploy />,
    );
    expect(container.querySelector('.node-eta')).toBeNull();
  });
});
