import { describe, it, expect, vi } from 'vitest';
import { workspaceDepsFromClient, type GitHubClientLike } from '../api/wire';
import type { SuccessStat, FlakeStat } from '../../history';

const CI = `name: CI
on: { pull_request: {}, merge_group: {} }
jobs:
  e2e: { runs-on: ubuntu-latest, steps: [{ run: pnpm e2e }] }
`;
const stats = { successStatsByRepo: () => new Map<string, SuccessStat[]>(), flakeStatsByRepo: () => new Map<string, FlakeStat[]>() };

type FakeClient = GitHubClientLike & { graphql: ReturnType<typeof vi.fn>; restGet: ReturnType<typeof vi.fn> };
function fakeClient(): FakeClient {
  const graphql = vi.fn(async (q: string) => {
    if (q.includes('defaultBranchRef')) return { repository: { id: 'R_1', defaultBranchRef: { name: 'main', target: { oid: 'headsha' } } } };
    if (q.includes('createPullRequest')) return { createPullRequest: { pullRequest: { number: 99, url: 'https://github.com/o/r/pull/99' } } };
    return {};
  });
  const restGet = vi.fn(async (_path: string) => ({ content: Buffer.from(CI, 'utf8').toString('base64') }));
  return { graphql, restGet } as unknown as FakeClient;
}

describe('workspaceDepsFromClient (real-client wire adapter)', () => {
  it('resolveHeadSha returns the default-branch oid', async () => {
    const c = fakeClient();
    const deps = workspaceDepsFromClient(c, stats);
    const pinned = await deps.deriver.deriveAtHead('o/r');
    expect(pinned?.sourceSha).toBe('headsha');
    expect(pinned?.model.checks).toContain('e2e');
  });

  it('fetchWorkflowAtSha base64-decodes contents and pins the ref', async () => {
    const c = fakeClient();
    const deps = workspaceDepsFromClient(c, stats);
    await deps.deriver.deriveAtSha('o/r', 'pinnedsha');
    expect(c.restGet).toHaveBeenCalledWith(expect.stringContaining('ref=pinnedsha'));
    expect(c.restGet).toHaveBeenCalledWith(expect.stringContaining('/repos/o/r/contents/.github/workflows/ci.yml'));
  });

  it('openDraftPr branches, commits base64, and opens a DRAFT PR', async () => {
    const c = fakeClient();
    const deps = workspaceDepsFromClient(c, stats, { uniq: () => 'abc123' });
    const out = await deps.prClient.openDraftPr({
      repo: 'o/r', baseSha: 'headsha', filePath: '.github/workflows/ci.yml',
      newText: 'edited', title: 'ci: adjust', body: 'body',
    });
    expect(out).toEqual({ number: 99, url: 'https://github.com/o/r/pull/99' });
    // createRef carried the unique branch name + base oid
    const refCall = c.graphql.mock.calls.find((a) => String(a[0]).includes('createRef'));
    expect(refCall?.[1]).toMatchObject({ name: 'refs/heads/workspace/ci-edit-headsha-abc123', oid: 'headsha' });
    // commit carried base64 of the new text
    const commitCall = c.graphql.mock.calls.find((a) => String(a[0]).includes('createCommitOnBranch'));
    expect((commitCall?.[1] as any).additions[0].contents).toBe(Buffer.from('edited', 'utf8').toString('base64'));
    // PR mutation requests draft:true (it's in the query text)
    const prCall = c.graphql.mock.calls.find((a) => String(a[0]).includes('createPullRequest'));
    expect(String(prCall?.[0])).toMatch(/draft:true/);
  });

  it('fetchWorkflowAtSha returns null on a fetch error (missing file)', async () => {
    const c = fakeClient();
    c.restGet.mockRejectedValueOnce(new Error('404'));
    const deps = workspaceDepsFromClient(c, stats);
    const pinned = await deps.deriver.deriveAtSha('o/r', 's'); // ci.yml fetch throws → null → no model
    expect(pinned).toBeNull();
  });
});
