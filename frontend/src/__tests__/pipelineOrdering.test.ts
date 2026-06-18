import { describe, it, expect } from 'vitest';
import { attentionSort, splitCohort, deployBreakdown } from '../sections/pipeline/ordering';
import type { PrView } from '../types';

const pr = (number: number, stage: string, substate: string | null = null, overdue = false): PrView =>
  ({ number, stage: { stage, substate, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue } } as unknown as PrView);

describe('attentionSort (running/overdue/failed first, awaiting-prod last)', () => {
  it('ranks failed < running < queued < idle < deploy', () => {
    const out = attentionSort([
      pr(1, 'qa-deploy'),         // deploy
      pr(2, 'ci'),                // running
      pr(3, 'parked', 'ci-failed'), // failed
      pr(4, 'queue'),             // queued
      pr(5, 'parked', 'ready'),   // idle
    ]).map((p) => p.number);
    expect(out).toEqual([3, 2, 4, 5, 1]);
  });

  it('an overdue PR sorts ahead of its non-overdue peers in the same bucket', () => {
    const out = attentionSort([pr(1, 'queue'), pr(2, 'queue', null, true)]).map((p) => p.number);
    expect(out).toEqual([2, 1]);
  });

  it('is stable by PR number within a tier', () => {
    const out = attentionSort([pr(9, 'ci'), pr(3, 'ci'), pr(7, 'ci')]).map((p) => p.number);
    expect(out).toEqual([3, 7, 9]);
  });
});

describe('splitCohort (collapse the awaiting-prod herd, keep the ones that need eyes)', () => {
  it('moves non-overdue awaiting-prod PRs into the cohort and attention-sorts the lead', () => {
    const { lead, cohort } = splitCohort([
      pr(1, 'qa-deploy'), pr(2, 'qa-deploy'),  // herd
      pr(3, 'ci'), pr(4, 'parked', 'ci-failed'),
    ]);
    expect(cohort.map((p) => p.number).sort()).toEqual([1, 2]);
    expect(lead.map((p) => p.number)).toEqual([4, 3]); // failed before running
  });

  it('keeps an OVERDUE awaiting-prod PR in the lead (it needs attention)', () => {
    const { lead, cohort } = splitCohort([pr(1, 'qa-deploy', null, true), pr(2, 'qa-deploy')]);
    expect(lead.map((p) => p.number)).toEqual([1]);
    expect(cohort.map((p) => p.number)).toEqual([2]);
  });
});

describe('deployBreakdown (awaiting-QA vs awaiting-prod must not be lumped)', () => {
  it('separates qa-deploy (awaiting QA) from awaiting-prod', () => {
    const b = deployBreakdown([
      pr(1, 'qa-deploy'), pr(2, 'qa-deploy'), pr(3, 'awaiting-prod'),
    ]);
    expect(b).toEqual({ awaitingQa: 2, awaitingProd: 1 });
  });

  it('is all-zero for a non-deploy set', () => {
    expect(deployBreakdown([pr(1, 'ci'), pr(2, 'queue')])).toEqual({ awaitingQa: 0, awaitingProd: 0 });
  });
});
