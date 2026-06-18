import { describe, it, expect, vi } from 'vitest';
import {
  resolvePromotionTarget, promotionSlug, buildPromotionProposal, openPromotionDraftPr,
} from '../promotion-action';
import type { PromotionCandidate } from '../estimator/promotion-candidates';
import type { GraphqlClient } from '../pr-actions';

const cand = (over: Partial<PromotionCandidate> = {}): PromotionCandidate => ({
  name: 'e2e-merge-gate / e2e: merge-gate (floor + changed)',
  event: 'merge_group',
  currentTier: 'merge queue only',
  suggestedTier: 'every PR push (catch pre-enqueue)',
  realFailures: 3,
  incidents: 2,
  failRatePct: 5.3,
  runsInWindow: 57,
  minutesInWindow: 1820,
  reason: '3 real (non-flaky) failures in 57 runs (5.3%) — caught late',
  ...over,
});

describe('resolvePromotionTarget', () => {
  it('derives the reusable workflow file from the caller prefix', () => {
    expect(resolvePromotionTarget(cand())).toEqual({
      callerJob: 'e2e-merge-gate', workflowFile: '_e2e-merge-gate.yml',
    });
  });
  it('falls back to ci.yml when there is no caller prefix', () => {
    expect(resolvePromotionTarget(cand({ name: 'ci' }))).toEqual({ callerJob: null, workflowFile: 'ci.yml' });
  });
});

describe('promotionSlug', () => {
  it('is a stable filesystem-safe kebab of name + event', () => {
    expect(promotionSlug(cand({ name: 'integration', event: 'push' }))).toBe('integration-push');
  });
});

describe('buildPromotionProposal', () => {
  it('suggests adding pull_request for a merge_group promotion + carries the evidence', () => {
    const p = buildPromotionProposal(cand());
    expect(p.branch).toMatch(/^chore\/promote-/);
    expect(p.path).toMatch(/^docs\/ci-tuning\/promotion-proposals\/.*\.md$/);
    expect(p.doc).toContain('pull_request:');
    expect(p.doc).toContain('3 (non-flaky) in 57 runs (5.3%)');
    expect(p.doc).toContain('1,820 runner-min');
    expect(p.body).toContain('makes **no workflow change**');
    expect(p.title).toContain('promote');
  });
  it('suggests adding merge_group for a push:main promotion', () => {
    const p = buildPromotionProposal(cand({ event: 'push', currentTier: 'every push to main (post-merge)', suggestedTier: 'merge queue (pre-merge gate)' }));
    expect(p.doc).toContain('merge_group:');
    expect(p.doc).toContain('pre-merge gate');
  });
});

describe('openPromotionDraftPr', () => {
  it('branches, commits the doc, and opens a draft PR (in order)', async () => {
    const calls: string[] = [];
    const graphql = vi.fn(async (q: string, vars: Record<string, unknown>) => {
      if (q.includes('defaultBranchRef')) { calls.push('head'); return { repository: { id: 'R1', defaultBranchRef: { name: 'main', target: { oid: 'OID0' } } } }; }
      if (q.includes('createRef')) { calls.push('ref'); expect(vars.name).toBe('refs/heads/chore/promote-' + promotionSlug(cand())); return { createRef: { ref: { name: 'x' } } }; }
      if (q.includes('createCommitOnBranch')) {
        calls.push('commit');
        const additions = vars.additions as { path: string; contents: string }[];
        expect(Buffer.from(additions[0]!.contents, 'base64').toString('utf8')).toContain('Promotion proposal');
        return { createCommitOnBranch: { commit: { oid: 'OID1' } } };
      }
      if (q.includes('createPullRequest')) { calls.push('pr'); return { createPullRequest: { pullRequest: { number: 91, url: 'https://github.com/o/r/pull/91' } } }; }
      throw new Error('unexpected query');
    });
    const res = await openPromotionDraftPr({ graphql } as unknown as GraphqlClient, 'o', 'r', cand());
    expect(calls).toEqual(['head', 'ref', 'commit', 'pr']);
    expect(res).toMatchObject({ number: 91, url: 'https://github.com/o/r/pull/91' });
  });

  it('throws when the repo has no default branch', async () => {
    const graphql = vi.fn(async () => ({ repository: { id: 'R1', defaultBranchRef: null } }));
    await expect(openPromotionDraftPr({ graphql } as unknown as GraphqlClient, 'o', 'r', cand())).rejects.toThrow(/default branch/);
  });
});
