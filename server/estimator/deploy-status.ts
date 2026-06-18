import type { HistoryStore } from '../history';
import type { DeployConfig } from '../config';

/** Per-repo deploy snapshot attached to DashboardState.repos[] (Deploy lane,
 *  Spec 2). Advisory only — the lane is gating:false and never reds the rollup. */
export interface RepoDeployStatus {
  envs: { name: string; liveSha: string | null; reachable: boolean }[];
  /** Merged PRs (in retention) not yet observed live in that env. */
  awaitingQa: number;
  awaitingProd: number;
  /** The QA→prod progression chain with SHA supersession (roadmap 4.4c). */
  chain: DeployChain;
}

export type DeployStage = 'merged' | 'qa' | 'prod';
export interface DeployChainEntry {
  prNumber: number;
  sha: string | null;
  mergedAt: string;
  /** The furthest deploy stage this merge has reached. */
  stage: DeployStage;
  qaLiveAt: string | null;
  prodLiveAt: string | null;
  /** A newer merge reached prod first — this SHA was rolled up into that deploy
   *  and won't go live on its own (SHA supersession). */
  superseded: boolean;
}
export interface DeployChain {
  /** Recent merges, newest first, capped to the chain limit. */
  entries: DeployChainEntry[];
  /** The newest merge still flowing toward prod (not yet prod, not superseded). */
  inFlight: DeployChainEntry | null;
  /** How many in-window merges were superseded before reaching prod. */
  supersededCount: number;
}

type ChainInput = { number: number; mergeCommitSha: string | null;
  mergedAt: string; qaLiveAt: string | null; prodLiveAt: string | null };

/**
 * Model the QA→prod deploy chain (roadmap 4.4c). Each merge is placed at the
 * furthest stage it reached (merged → qa → prod); a merge still awaiting prod is
 * SUPERSEDED once a strictly newer merge has already gone live on prod — the
 * pipeline only advances the latest SHA, so the older one was rolled up and will
 * never deploy on its own. The front-runner (newest, still flowing) is in-flight.
 */
export function deployChain(merged: readonly ChainInput[], limit = 8): DeployChain {
  const sorted = [...merged].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)); // newest first
  const newestProd = sorted.find((m) => m.prodLiveAt != null) ?? null;
  const entries: DeployChainEntry[] = sorted.slice(0, limit).map((m) => {
    const stage: DeployStage = m.prodLiveAt != null ? 'prod' : m.qaLiveAt != null ? 'qa' : 'merged';
    const superseded = m.prodLiveAt == null && newestProd != null && newestProd.mergedAt > m.mergedAt;
    return { prNumber: m.number, sha: m.mergeCommitSha, mergedAt: m.mergedAt, stage,
      qaLiveAt: m.qaLiveAt, prodLiveAt: m.prodLiveAt, superseded };
  });
  const inFlight = entries.find((e) => e.stage !== 'prod' && !e.superseded) ?? null;
  const supersededCount = entries.filter((e) => e.superseded).length;
  return { entries, inFlight, supersededCount };
}

/** Pure projection — called ONCE per deploy cycle and cached on the Poller
 *  (spec §15: never a per-buildState SQLite read). `envShas` is keyed
 *  `${repo}/${env.name}` and populated by the deploy cycle's health() call. */
export function computeRepoDeploy(
  history: HistoryStore,
  repo: string,
  dc: DeployConfig,
  envShas: Map<string, string | null>,
  retentionDays: number,
  now: Date,
): RepoDeployStatus {
  const envs = dc.environments.map((env) => {
    const liveSha = envShas.get(`${repo}/${env.name}`) ?? null;
    return { name: env.name, liveSha, reachable: liveSha != null };
  });
  // Partition the merged-but-not-fully-deployed set by where each SHA actually
  // sits, so a PR awaiting QA isn't ALSO counted as awaiting prod (the two
  // metrics must be disjoint): prod-live → done; QA-live-only → awaiting prod;
  // neither → awaiting QA.
  let awaitingQa = 0;
  let awaitingProd = 0;
  const repoMerged: ChainInput[] = [];
  for (const rec of history.listTrackedMerged(retentionDays, now)) {
    if (rec.repo !== repo) continue;
    if (rec.prodLiveAt != null) { /* fully deployed — counts toward neither */ }
    else if (rec.qaLiveAt != null) awaitingProd += 1; // on QA, awaiting prod
    else awaitingQa += 1;                              // not yet on QA
    repoMerged.push({ number: rec.number, mergeCommitSha: rec.mergeCommitSha,
      mergedAt: rec.mergedAt, qaLiveAt: rec.qaLiveAt, prodLiveAt: rec.prodLiveAt });
  }
  return { envs, awaitingQa, awaitingProd, chain: deployChain(repoMerged) };
}
