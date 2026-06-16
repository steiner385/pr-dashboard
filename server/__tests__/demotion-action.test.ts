import { describe, it, expect, vi } from 'vitest';
import {
  resolveDemotionTarget, demotionSlug, buildDemotionProposal, openDemotionDraftPr,
} from '../demotion-action';
import type { DemotionCandidate } from '../estimator/demotion-candidates';
import type { GraphqlClient } from '../pr-actions';

const cand = (over: Partial<DemotionCandidate> = {}): DemotionCandidate => ({
  name: 'integration-tests / test: integration (shard/3)',
  event: 'pull_request',
  currentTier: 'every PR push',
  suggestedTier: 'merge queue only',
  successRatePct: 99.7,
  runsInWindow: 344,
  minutesInWindow: 3590,
  reason: '343/344 green · ~3590 runner-min in window',
  ...over,
});

describe('resolveDemotionTarget', () => {
  it('derives the reusable workflow file from the caller prefix', () => {
    expect(resolveDemotionTarget(cand())).toEqual({
      callerJob: 'integration-tests', workflowFile: '_integration-tests.yml',
    });
  });
  it('falls back to ci.yml when the check name has no caller prefix', () => {
    expect(resolveDemotionTarget(cand({ name: 'e2e: smoke (advisory)' }))).toEqual({
      callerJob: null, workflowFile: 'ci.yml',
    });
  });
});

describe('demotionSlug', () => {
  it('is a stable filesystem-safe kebab of name + event', () => {
    expect(demotionSlug(cand({ name: 'fast-checks / lint: eslint', event: 'pull_request' })))
      .toBe('fast-checks-lint-eslint-pull-request');
  });
});

describe('buildDemotionProposal', () => {
  it('suggests an if-guard for pull_request demotion and includes the evidence', () => {
    const p = buildDemotionProposal(cand());
    expect(p.branch).toBe('chore/demote-integration-tests-test-integration-shard-3-pull-request');
    expect(p.path).toMatch(/^docs\/ci-tuning\/demotion-proposals\/.*\.md$/);
    expect(p.doc).toContain("github.event_name != 'pull_request'");
    expect(p.doc).toContain('99.7% over 344 runs');
    expect(p.doc).toContain('3,590 runner-min');
    expect(p.body).toContain('makes **no workflow change**');
  });
  it('suggests a nightly schedule for merge_group demotion', () => {
    const p = buildDemotionProposal(cand({ event: 'merge_group', currentTier: 'every merge-queue build', suggestedTier: 'nightly' }));
    expect(p.doc).toContain('cron:');
    expect(p.doc).not.toContain("github.event_name != 'pull_request'");
  });
});

describe('openDemotionDraftPr', () => {
  it('branches, commits the doc, and opens a draft PR (in order)', async () => {
    const calls: string[] = [];
    const graphql = vi.fn(async (q: string, vars: Record<string, unknown>) => {
      if (q.includes('defaultBranchRef')) {
        calls.push('head');
        return { repository: { id: 'R1', defaultBranchRef: { name: 'main', target: { oid: 'OID0' } } } };
      }
      if (q.includes('createRef')) { calls.push('ref'); expect(vars.name).toBe('refs/heads/chore/demote-' + demotionSlug(cand())); return { createRef: { ref: { name: 'x' } } }; }
      if (q.includes('createCommitOnBranch')) {
        calls.push('commit');
        const additions = vars.additions as { path: string; contents: string }[];
        // base64 contents must decode to the proposal doc
        expect(Buffer.from(additions[0]!.contents, 'base64').toString('utf8')).toContain('Demotion proposal');
        expect(vars.oid).toBe('OID0');
        return { createCommitOnBranch: { commit: { oid: 'OID1' } } };
      }
      if (q.includes('createPullRequest')) {
        calls.push('pr');
        expect(vars.head).toBe('chore/demote-' + demotionSlug(cand()));
        return { createPullRequest: { pullRequest: { number: 42, url: 'https://github.com/o/r/pull/42' } } };
      }
      throw new Error('unexpected query');
    });

    const res = await openDemotionDraftPr({ graphql } as unknown as GraphqlClient, 'o', 'r', cand());
    expect(calls).toEqual(['head', 'ref', 'commit', 'pr']);
    expect(res).toEqual({ number: 42, url: 'https://github.com/o/r/pull/42', branch: 'chore/demote-' + demotionSlug(cand()) });
  });

  it('throws when the repo has no default branch', async () => {
    const graphql = vi.fn(async () => ({ repository: { id: 'R1', defaultBranchRef: null } }));
    await expect(openDemotionDraftPr({ graphql } as unknown as GraphqlClient, 'o', 'r', cand())).rejects.toThrow(/default branch/);
  });
});
