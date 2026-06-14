import { describe, it, expect } from 'vitest';
import { prCiLane } from '../lanes/prCiLane';
import { mergeQueueLane } from '../lanes/mergeQueueLane';
import { mainLane } from '../lanes/mainLane';
import { deployLane } from '../lanes/deployLane';
import { costLane } from '../lanes/costLane';
import { scheduledLane } from '../lanes/scheduledLane';
import type { DashboardState } from '../../types';

const repo = (over: object) => ({ repo: 'acme/widgets', hasDeploy: false, prs: [], queue: null, ...over });

describe('prCiLane', () => {
  it('is idle with no PRs, red when a required check failed', () => {
    expect(prCiLane([repo({})] as unknown as DashboardState['repos']).status).toBe('idle');
    const withFail = [repo({ prs: [{ number: 1, stage: { stage: 'ci', substate: 'ci-failed' } }] })];
    expect(prCiLane(withFail as unknown as DashboardState['repos']).status).toBe('red');
  });
});

describe('mergeQueueLane', () => {
  it('maps QueueHealthState; empty queue → idle', () => {
    expect(mergeQueueLane([repo({ queue: null })] as unknown as DashboardState['repos']).status).toBe('idle');
    const stall = [repo({ queue: { groups: [], waiting: [], health: { state: 'dispatch-stall' } } })];
    expect(mergeQueueLane(stall as unknown as DashboardState['repos']).status).toBe('red');
    const backlog = [repo({ queue: { groups: [{}], waiting: [], health: { state: 'cap-backlog' } } })];
    expect(mergeQueueLane(backlog as unknown as DashboardState['repos']).status).toBe('amber');
  });
});

describe('mainLane', () => {
  it('reads status from repo.laneHealth.main; blind when absent', () => {
    expect(mainLane([{ repo: 'r', laneHealth: { main: 'red' } }] as unknown as DashboardState['repos']).status).toBe('red');
    expect(mainLane([{ repo: 'r' }] as unknown as DashboardState['repos']).status).toBe('blind');
  });
  it('takes the worst across repos', () => {
    const repos = [{ repo: 'a', laneHealth: { main: 'green' } }, { repo: 'b', laneHealth: { main: 'red' } }];
    expect(mainLane(repos as unknown as DashboardState['repos']).status).toBe('red');
  });
});

describe('deployLane', () => {
  const dep = (over: object) => repo({ deploy: { envs: [], awaitingQa: 0, awaitingProd: 0, ...over } });

  it('is not-wired/blind when no repo has a deploy field', () => {
    const out = deployLane([repo({})] as unknown as DashboardState['repos']);
    expect(out.status).toBe('blind');
    expect(out.summary).toMatch(/not wired/i);
  });

  it('is blind when no env across repos is reachable', () => {
    const repos = [dep({ envs: [{ name: 'qa', liveSha: null, reachable: false }] })];
    expect(deployLane(repos as unknown as DashboardState['repos']).status).toBe('blind');
  });

  it('is green when at least one env is reachable, and surfaces sha + awaiting counts', () => {
    const repos = [dep({
      envs: [{ name: 'qa', liveSha: 'a1b2c3d4', reachable: true },
        { name: 'prod', liveSha: 'd4e5f6a7', reachable: true }],
      awaitingProd: 2,
    })];
    const out = deployLane(repos as unknown as DashboardState['repos']);
    expect(out.status).toBe('green');
    expect(out.summary).toMatch(/a1b2c3/);
    expect(out.summary).toMatch(/d4e5f6/);
    expect(out.summary).toMatch(/2 awaiting prod/);
  });

  it('never returns red or amber', () => {
    const repos = [dep({ envs: [{ name: 'qa', liveSha: 's', reachable: true }], awaitingProd: 99 })];
    const out = deployLane(repos as unknown as DashboardState['repos']);
    expect(['green', 'blind']).toContain(out.status);
  });
});

describe('costLane', () => {
  const cost = (over: object): DashboardState['cost'] => ({
    totalDollars: 152, days: 7, retryWastePct: 8,
    byStage: [
      { stage: 'pr', dollars: 60, minutes: 600 },
      { stage: 'queue', dollars: 38, minutes: 380 },
      { stage: 'main', dollars: 24, minutes: 240 },
      { stage: 'scheduled', dollars: 30, minutes: 300 },
    ],
    ...over,
  });

  it('is blind/not-wired when cost is absent', () => {
    const out = costLane(undefined);
    expect(out.status).toBe('blind');
    expect(out.summary).toMatch(/no rates/i);
  });

  it('is blind/not-wired when every stage dollar is null (minutes-only mode)', () => {
    const out = costLane(cost({
      totalDollars: null, retryWastePct: null,
      byStage: [
        { stage: 'pr', dollars: null, minutes: 600 },
        { stage: 'queue', dollars: null, minutes: 380 },
        { stage: 'main', dollars: null, minutes: 240 },
        { stage: 'scheduled', dollars: null, minutes: 300 },
      ],
    }));
    expect(out.status).toBe('blind');
    expect(out.summary).toMatch(/no rates/i);
  });

  it('is green with a total + per-stage percent split when priced', () => {
    const out = costLane(cost({}));
    expect(out.status).toBe('green');
    expect(out.summary).toMatch(/\$152·7d/);
    expect(out.summary).toMatch(/PR 39%/);     // 60/152 ≈ 39%
    expect(out.summary).toMatch(/queue 25%/);  // 38/152 = 25%
    expect(out.summary).toMatch(/main 16%/);   // 24/152 ≈ 16%
    expect(out.summary).toMatch(/nightly 20%/);// 30/152 ≈ 20%
  });

  it('never returns red or amber', () => {
    expect(['green', 'blind']).toContain(costLane(cost({})).status);
    expect(['green', 'blind']).toContain(costLane(undefined).status);
  });
});

describe('scheduledLane', () => {
  const run = (workflow: string, conclusion: string | null, over: object = {}) =>
    ({ workflow, conclusion, status: conclusion ? 'completed' : 'in_progress',
      createdAt: '2026-06-13T06:00:00Z', htmlUrl: `https://x/${workflow}`, ...over });
  const sched = (over: object) => repo({ scheduled: { runs: [], discovered: 0, ...over } });

  it('is idle when no repo has scheduled workflows', () => {
    expect(scheduledLane([repo({})] as unknown as DashboardState['repos']).status).toBe('idle');
  });

  it('is blind when workflows are discovered but no runs are recorded', () => {
    const out = scheduledLane([sched({ discovered: 4, runs: [] })] as unknown as DashboardState['repos']);
    expect(out.status).toBe('blind');
    expect(out.summary).toMatch(/no runs/i);
  });

  it('is red when the latest run of ANY workflow failed', () => {
    const out = scheduledLane([sched({
      discovered: 2, runs: [run('nightly.yml', 'success'), run('weekly.yml', 'failure')],
    })] as unknown as DashboardState['repos']);
    expect(out.status).toBe('red');
    expect(out.summary).toMatch(/nightly/);
    expect(out.summary).toMatch(/✗/);
  });

  it('is green when every latest run is SUCCESS, with a glyph summary', () => {
    const out = scheduledLane([sched({
      discovered: 2, runs: [run('nightly.yml', 'success'), run('weekly.yml', 'success')],
    })] as unknown as DashboardState['repos']);
    expect(out.status).toBe('green');
    expect(out.summary).toMatch(/✓/);
  });

  it('is amber for in-progress / cancelled latest runs (not failing, not all green)', () => {
    expect(scheduledLane([sched({ discovered: 1, runs: [run('a.yml', null)] })] as unknown as DashboardState['repos']).status).toBe('amber');
    expect(scheduledLane([sched({ discovered: 1, runs: [run('a.yml', 'cancelled')] })] as unknown as DashboardState['repos']).status).toBe('amber');
  });

  it('aggregates across repos — one failing repo reds the lane', () => {
    const repos = [
      sched({ discovered: 1, runs: [run('nightly.yml', 'success')] }),
      { ...sched({ discovered: 1, runs: [run('weekly.yml', 'timed_out')] }), repo: 'b/b' },
    ];
    expect(scheduledLane(repos as unknown as DashboardState['repos']).status).toBe('red');
  });

  it('CANCELLED never reds the lane', () => {
    const out = scheduledLane([sched({
      discovered: 2, runs: [run('a.yml', 'success'), run('b.yml', 'cancelled')],
    })] as unknown as DashboardState['repos']);
    expect(['amber']).toContain(out.status);
  });
});
