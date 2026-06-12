import type { GithubClient } from './github';
import type { HistoryStore } from './history';
import { buildBackfillQuery } from './queries';
import { mapRollupContexts } from './map';
import { ingestCheckSet } from './poller';
import type { NeedActivePredicate } from './estimator/waits';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function backfillRepo(client: GithubClient, history: HistoryStore,
  repo: string, maxPages = 5,
  needsFor: (canonicalName: string) => string[] | null = () => null,
  activeFor: NeedActivePredicate = () => true,
  graphKeys: readonly string[] | null = null,
  rollupWorkflowName: string | null = null,
  timeoutMinutesFor: (canonicalName: string) => number | null = () => null,
  poolFor: (canonicalName: string) => string[] | null = () => null): Promise<void> {
  const [owner, name] = repo.split('/');
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: any = await client.graphql<any>(buildBackfillQuery(owner, name, cursor));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const hist: any = data.repository?.defaultBranchRef?.target?.history;
    if (!hist) return;
    for (const commit of hist.nodes ?? []) {
      // shared ingestion: completed durations + runner-pickup waits (needs graph permitting)
      ingestCheckSet(history, repo,
        mapRollupContexts(commit?.statusCheckRollup?.contexts?.nodes ?? []),
        needsFor, activeFor, graphKeys, rollupWorkflowName,
        (commit?.oid as string | undefined) ?? null, timeoutMinutesFor, poolFor);
    }
    if (!hist.pageInfo?.hasNextPage) return;
    cursor = hist.pageInfo.endCursor;
  }
}
