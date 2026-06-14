import { describe, it, expect } from 'vitest';
import { prCiLane } from '../lanes/prCiLane';
import { mergeQueueLane } from '../lanes/mergeQueueLane';
import { mainLane } from '../lanes/mainLane';
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
