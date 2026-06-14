import { describe, it, expect } from 'vitest';
import { prCiLane } from '../lanes/prCiLane';
import { mergeQueueLane } from '../lanes/mergeQueueLane';
import { mainLane } from '../lanes/mainLane';
import { deployLane } from '../lanes/deployLane';
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
