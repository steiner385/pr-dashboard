// Wires the workspace IDE/model loop to the REAL GitHub client (spec 001).
// Builds the router's injected deps from the existing client surface — reusing
// the same contents-fetch (restGet) and the draft-PR GraphQL shape proven in
// demotion-action.ts. Kept as a pure adapter so index.ts mounts the router in
// one line; nothing here touches the running server until that mount.
import { ModelDeriver, type ModelDeriveDeps } from '../model/derive';
import type { WorkspaceRouterDeps } from './workspace-router';
import type { PrClient } from '../actions/draftPr';

/** The minimal slice of the existing GitHub client this adapter needs. */
export interface GitHubClientLike {
  graphql<T>(query: string, vars: Record<string, unknown>): Promise<T>;
  restGet<T>(path: string): Promise<T>;
}
/** History-backed observed-stats providers (same ones index.ts feeds computeProtectionMap). */
export interface StatsProviders {
  successStatsByRepo: ModelDeriveDeps['successStatsByRepo'];
  flakeStatsByRepo: ModelDeriveDeps['flakeStatsByRepo'];
  conditionalCallerJobs?: string[];
}

const REPO_HEAD = `query($owner:String!,$repo:String!){
  repository(owner:$owner,name:$repo){ id defaultBranchRef{ name target{ oid } } }
}`;
const CREATE_REF = `mutation($repositoryId:ID!,$name:String!,$oid:GitObjectID!){
  createRef(input:{repositoryId:$repositoryId,name:$name,oid:$oid}){ ref{ name } } }`;
const CREATE_COMMIT = `mutation($branch:CommittableBranch!,$message:CommitMessage!,$additions:[FileAddition!]!,$oid:GitObjectID!){
  createCommitOnBranch(input:{branch:$branch,message:$message,fileChanges:{additions:$additions},expectedHeadOid:$oid}){ commit{ oid } } }`;
const CREATE_PR = `mutation($repositoryId:ID!,$base:String!,$head:String!,$title:String!,$body:String!){
  createPullRequest(input:{repositoryId:$repositoryId,baseRefName:$base,headRefName:$head,title:$title,body:$body,draft:true}){ pullRequest{ number url } } }`;

interface RepoHead { repository: { id: string; defaultBranchRef: { name: string; target: { oid: string } } | null } | null }

async function resolveHead(client: GitHubClientLike, repo: string): Promise<RepoHead['repository']> {
  const [owner, name] = repo.split('/');
  const r = await client.graphql<RepoHead>(REPO_HEAD, { owner, repo: name });
  if (!r.repository?.defaultBranchRef) throw new Error(`cannot resolve default branch for ${repo}`);
  return r.repository;
}

/** Fetch a workflow blob pinned to a commit SHA via the contents API (?ref=sha). */
async function fetchWorkflowAtSha(client: GitHubClientLike, repo: string, name: string, sha: string): Promise<string | null> {
  try {
    const j = await client.restGet<{ content?: string }>(`/repos/${repo}/contents/.github/workflows/${name}?ref=${encodeURIComponent(sha)}`);
    return j.content ? Buffer.from(j.content, 'base64').toString('utf8') : null;
  } catch { return null; }
}

/** Fetch any repo file (root-relative path) pinned to a SHA — the prefixes lever's
 *  `.pr-dashboard.yml` read-merge (roadmap 4.5). Null when the file is absent. */
async function fetchFileAtSha(client: GitHubClientLike, repo: string, path: string, sha: string): Promise<string | null> {
  try {
    const j = await client.restGet<{ content?: string }>(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(sha)}`);
    return j.content ? Buffer.from(j.content, 'base64').toString('utf8') : null;
  } catch { return null; }
}

/** Open the workspace's draft PR (branch → verified-bot commit → draft PR). */
async function openWorkspaceDraftPr(
  client: GitHubClientLike, uniq: () => string,
  input: { repo: string; baseSha: string; filePath: string; newText: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
  const repository = await resolveHead(client, input.repo);
  const repositoryId = repository!.id;
  const baseRef = repository!.defaultBranchRef!.name;
  const branch = `workspace/ci-edit-${input.baseSha.slice(0, 7)}-${uniq()}`;
  await client.graphql(CREATE_REF, { repositoryId, name: `refs/heads/${branch}`, oid: input.baseSha });
  await client.graphql(CREATE_COMMIT, {
    branch: { repositoryNameWithOwner: input.repo, branchName: branch },
    message: { headline: input.title },
    additions: [{ path: input.filePath, contents: Buffer.from(input.newText, 'utf8').toString('base64') }],
    oid: input.baseSha,
  });
  const pr = await client.graphql<{ createPullRequest: { pullRequest: { number: number; url: string } } }>(
    CREATE_PR, { repositoryId, base: baseRef, head: branch, title: input.title, body: input.body });
  return { number: pr.createPullRequest.pullRequest.number, url: pr.createPullRequest.pullRequest.url };
}

/** Open a multi-file workspace draft PR (one commit, N file additions) — the
 *  Build apply exit (Inc 3b). Same branch→verified-bot-commit→draft-PR path. */
async function openWorkspaceMultiFileDraftPr(
  client: GitHubClientLike, uniq: () => string,
  input: { repo: string; baseSha: string; files: { filePath: string; newText: string }[]; title: string; body: string },
): Promise<{ number: number; url: string }> {
  const repository = await resolveHead(client, input.repo);
  const repositoryId = repository!.id;
  const baseRef = repository!.defaultBranchRef!.name;
  const branch = `workspace/ci-edit-${input.baseSha.slice(0, 7)}-${uniq()}`;
  await client.graphql(CREATE_REF, { repositoryId, name: `refs/heads/${branch}`, oid: input.baseSha });
  await client.graphql(CREATE_COMMIT, {
    branch: { repositoryNameWithOwner: input.repo, branchName: branch },
    message: { headline: input.title },
    additions: input.files.map((f) => ({ path: f.filePath, contents: Buffer.from(f.newText, 'utf8').toString('base64') })),
    oid: input.baseSha,
  });
  const pr = await client.graphql<{ createPullRequest: { pullRequest: { number: number; url: string } } }>(
    CREATE_PR, { repositoryId, base: baseRef, head: branch, title: input.title, body: input.body });
  return { number: pr.createPullRequest.pullRequest.number, url: pr.createPullRequest.pullRequest.url };
}

/** Build the workspace router deps from the real client + history stats. */
export function workspaceDepsFromClient(
  client: GitHubClientLike, stats: StatsProviders,
  opts: { ttlMs?: number; uniq?: () => string; liveRequired?: (repo: string) => Promise<readonly string[]> } = {},
): WorkspaceRouterDeps {
  const uniq = opts.uniq ?? (() => Math.random().toString(36).slice(2, 8));
  const deriver = new ModelDeriver({
    resolveHeadSha: async (repo) => (await resolveHead(client, repo))!.defaultBranchRef!.target.oid,
    fetchWorkflowAtSha: (repo, name, sha) => fetchWorkflowAtSha(client, repo, name, sha),
    successStatsByRepo: stats.successStatsByRepo,
    flakeStatsByRepo: stats.flakeStatsByRepo,
    conditionalCallerJobs: stats.conditionalCallerJobs,
  }, opts.ttlMs);
  const prClient: PrClient = {
    fetchWorkflowAtSha: (repo, name, sha) => fetchWorkflowAtSha(client, repo, name, sha),
    openDraftPr: (i) => openWorkspaceDraftPr(client, uniq, i),
    fetchFileAtSha: (repo, path, sha) => fetchFileAtSha(client, repo, path, sha),
  };
  return {
    deriver, prClient, liveRequired: opts.liveRequired,
    openMultiFileDraftPr: (i) => openWorkspaceMultiFileDraftPr(client, uniq, i),
  };
}
