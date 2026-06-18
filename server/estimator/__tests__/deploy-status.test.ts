import { describe, it, expect } from 'vitest';
import { computeRepoDeploy } from '../deploy-status';
import type { HistoryStore } from '../../history';
import type { DeployConfig } from '../../config';

const DC: DeployConfig = {
  environments: [
    { name: 'qa', healthUrl: 'https://qa/health', auto: true, shaKey: 'sha' },
    { name: 'prod', healthUrl: 'https://prod/health', auto: true, shaKey: 'sha' },
  ],
  cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main',
};

const rec = (number: number, qaLiveAt: string | null, prodLiveAt: string | null) => ({
  repo: 'o/r', number, title: `pr ${number}`, url: '', mergedAt: '2026-06-18T00:00:00Z',
  mergeCommitSha: `sha${number}`, createdAt: null, firstGreenAt: null, enqueuedAt: null,
  qaLiveAt, prodLiveAt, mergedBy: null,
});
const hist = (records: ReturnType<typeof rec>[]) =>
  ({ listTrackedMerged: () => records } as unknown as HistoryStore);

describe('computeRepoDeploy awaiting partition (awaiting-QA vs awaiting-prod must not double-count)', () => {
  it('counts a not-yet-QA merge as awaiting QA only — NOT also awaiting prod', () => {
    const s = computeRepoDeploy(hist([rec(1, null, null)]), 'o/r', DC, new Map(), 7, new Date('2026-06-18T01:00:00Z'));
    expect(s.awaitingQa).toBe(1);
    expect(s.awaitingProd).toBe(0); // it's awaiting QA, not prod
  });

  it('counts a QA-live-but-not-prod merge as awaiting prod only', () => {
    const s = computeRepoDeploy(hist([rec(1, '2026-06-18T00:30:00Z', null)]), 'o/r', DC, new Map(), 7, new Date('2026-06-18T01:00:00Z'));
    expect(s.awaitingQa).toBe(0);
    expect(s.awaitingProd).toBe(1);
  });

  it('counts a fully-deployed merge as neither', () => {
    const s = computeRepoDeploy(hist([rec(1, '2026-06-18T00:30:00Z', '2026-06-18T00:45:00Z')]), 'o/r', DC, new Map(), 7, new Date('2026-06-18T01:00:00Z'));
    expect(s.awaitingQa).toBe(0);
    expect(s.awaitingProd).toBe(0);
  });

  it('partitions a mixed set cleanly (1 awaiting QA, 1 awaiting prod, 1 done)', () => {
    const s = computeRepoDeploy(hist([
      rec(1, null, null),                                   // awaiting QA
      rec(2, '2026-06-18T00:30:00Z', null),                 // awaiting prod
      rec(3, '2026-06-18T00:30:00Z', '2026-06-18T00:45:00Z'), // done
    ]), 'o/r', DC, new Map(), 7, new Date('2026-06-18T01:00:00Z'));
    expect(s.awaitingQa).toBe(1);
    expect(s.awaitingProd).toBe(1);
  });
});
