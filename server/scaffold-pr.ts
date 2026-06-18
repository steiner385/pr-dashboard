/**
 * Shared scaffold-draft-PR orchestration — the single GraphQL path both the
 * demotion (demotion-action.ts) and promotion (promotion-action.ts) levers use
 * to open a proposal-doc PR. Branch off the default branch, commit one markdown
 * doc via createCommitOnBranch (a verified bot commit — no local git), open a
 * DRAFT PR. Extracting it keeps the two levers from drifting on the GraphQL shape.
 */
import type { GraphqlClient } from './pr-actions';

/** A ready-to-open proposal: where it lands + the doc/title/body to commit. */
export interface ScaffoldProposal {
  slug: string;
  branch: string;
  path: string;
  title: string;
  /** Markdown committed to `path`. */
  doc: string;
  /** PR body. */
  body: string;
}

export interface DraftPrResult { number: number; url: string; branch: string; }

interface RepoHead {
  repository: { id: string; defaultBranchRef: { name: string; target: { oid: string } } | null } | null;
}
const REPO_HEAD = `query($owner:String!,$repo:String!){
  repository(owner:$owner,name:$repo){ id defaultBranchRef{ name target{ oid } } }
}`;
const CREATE_REF = `mutation($repositoryId:ID!,$name:String!,$oid:GitObjectID!){
  createRef(input:{repositoryId:$repositoryId,name:$name,oid:$oid}){ ref{ name } }
}`;
const CREATE_COMMIT = `mutation($branch:CommittableBranch!,$message:CommitMessage!,$additions:[FileAddition!]!,$oid:GitObjectID!){
  createCommitOnBranch(input:{branch:$branch,message:$message,
    fileChanges:{additions:$additions},expectedHeadOid:$oid}){ commit{ oid } }
}`;
const CREATE_PR = `mutation($repositoryId:ID!,$base:String!,$head:String!,$title:String!,$body:String!){
  createPullRequest(input:{repositoryId:$repositoryId,baseRefName:$base,headRefName:$head,
    title:$title,body:$body,draft:true}){ pullRequest{ number url } }
}`;

/**
 * Open the draft proposal PR. Throws on the first failed mutation (the API layer
 * maps it to an HTTP error).
 */
export async function openScaffoldDraftPr(
  client: GraphqlClient, owner: string, repo: string, proposal: ScaffoldProposal,
): Promise<DraftPrResult> {
  const head = await client.graphql<RepoHead>(REPO_HEAD, { owner, repo });
  const repository = head.repository;
  if (!repository || !repository.defaultBranchRef) {
    throw new Error(`cannot resolve default branch for ${owner}/${repo}`);
  }
  const repositoryId = repository.id;
  const baseRef = repository.defaultBranchRef.name;
  const baseOid = repository.defaultBranchRef.target.oid;

  await client.graphql(CREATE_REF, { repositoryId, name: `refs/heads/${proposal.branch}`, oid: baseOid });
  await client.graphql(CREATE_COMMIT, {
    branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: proposal.branch },
    message: { headline: proposal.title },
    additions: [{ path: proposal.path, contents: Buffer.from(proposal.doc, 'utf8').toString('base64') }],
    oid: baseOid,
  });
  const pr = await client.graphql<{ createPullRequest: { pullRequest: { number: number; url: string } } }>(
    CREATE_PR, { repositoryId, base: baseRef, head: proposal.branch, title: proposal.title, body: proposal.body },
  );
  return { number: pr.createPullRequest.pullRequest.number, url: pr.createPullRequest.pullRequest.url, branch: proposal.branch };
}
