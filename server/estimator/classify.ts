import type { CheckRun, PrSnapshot, StageResult } from '../types';
import type { ProgressResult } from './progress';

export interface DeployInfo {
  hasDeploy: boolean;
  qaLive: boolean | null;     // null = health unknown
  prodLive: boolean | null;
  propagating: boolean;       // squash sha not yet in local clone after fetch
  deployProgress: { percent: number | null; etaSeconds: number | null; overdue: boolean } | null;
}
export interface ClassifyInput {
  pr: PrSnapshot;
  prev: StageResult | null;
  ciProgress: ProgressResult | null;
  queueProgress: { percent: number | null; etaSeconds: number | null; overdue: boolean; failed?: boolean; unmergeable?: boolean } | null;
  deploy: DeployInfo;
  retentionDays: number;
  now: Date;
  /** Per-repo config: canonical names starting with any prefix count as required. */
  requiredCheckPrefixes?: string[];
  /** ci.yml-derived workflow name the prefixes belong to (e.g. `CI`); scopes
   *  prefix matches to checks from that workflow. Null/undefined = no scoping. */
  rollupWorkflowName?: string | null;
}

// Real failure conclusions that park a PR. CANCELLED is excluded — spot-reclaim kills are
// auto-retried in the watched repos; surfacing them as failures is a false alarm.
const FAILURE_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/**
 * Single source of truth for check-name → prefix matching (startsWith semantics):
 * returns the LONGEST prefix the canonical name starts with, or null. Longest-match
 * disambiguates sibling nodes where one is a prefix of another (`build` vs
 * `build-test`) — boolean callers are unaffected.
 */
export function matchingPrefix(name: string, prefixes: Iterable<string>): string | null {
  let best: string | null = null;
  for (const p of prefixes) {
    if (name.startsWith(p) && (best === null || p.length > best.length)) best = p;
  }
  return best;
}

/** True when the canonical check name starts with any configured prefix. */
export function matchesRequiredPrefix(name: string, prefixes?: string[]): boolean {
  return prefixes != null && matchingPrefix(name, prefixes) !== null;
}

/**
 * Workflow-scope predicate for prefix matching: when the rollup workflow is known,
 * a check counts only if it comes from that workflow — or carries no workflow
 * identity at all (old/backfilled data predating the workflowName field; be
 * permissive rather than dropping required checks). No known rollup → everything
 * passes (prefix matching alone, the pre-scoping behavior).
 */
export function workflowScopeAllows(checkWorkflowName: string | null,
  rollupWorkflowName?: string | null): boolean {
  return rollupWorkflowName == null || checkWorkflowName == null
    || checkWorkflowName === rollupWorkflowName;
}

/**
 * A check is required when GitHub marks it isRequired OR (when configured) its
 * canonical name matches a per-repo required prefix AND it belongs to the rollup
 * workflow (workflow scoping stops e.g. `Auto-merge PRs`' `ci-gate` job from
 * startsWith-matching the `ci` prefix). API isRequired counts regardless of
 * workflow. The prefix path covers repos whose only required check materializes
 * late in the run (mid-run all checks read isRequired:false). Fallback-to-all
 * applies only when there are no required marks AND no prefixes configured.
 */
export function requiredChecks(checks: CheckRun[], prefixes?: string[],
  rollupWorkflowName?: string | null): CheckRun[] {
  const prEvent = checks.filter((c) => c.event !== 'merge_group');
  const req = prEvent.filter((c) => c.isRequired
    || (matchesRequiredPrefix(c.name, prefixes)
      && workflowScopeAllows(c.workflowName, rollupWorkflowName)));
  if (req.length) return req;
  return prefixes?.length ? [] : prEvent; // repos with no required signal at all: treat all as required
}

const bare = (stage: StageResult['stage'], substate: string | null): StageResult =>
  ({ stage, substate, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false });

export function classify(i: ClassifyInput): StageResult | null {
  const { pr, prev, now } = i;

  if (pr.mergedAt) {
    const ageDays = (now.getTime() - Date.parse(pr.mergedAt)) / 86400_000;
    if (ageDays > i.retentionDays) return null;
    if (!i.deploy.hasDeploy) return bare('merged', null);
    if (i.deploy.prodLive) return null; // live on prod → off the board
    if (i.deploy.qaLive) return bare('awaiting-prod', null);
    if (i.deploy.propagating) return bare('qa-deploy', 'propagating');
    if (i.deploy.qaLive === null) return bare('qa-deploy', 'unknown');
    const p = i.deploy.deployProgress;
    return { stage: 'qa-deploy', substate: null, percent: p?.percent ?? null,
      etaSeconds: p?.etaSeconds ?? null, etaRangeSeconds: null, overdue: p?.overdue ?? false };
  }

  if (pr.queue) {
    const q = i.queueProgress;
    // UNMERGEABLE = facing ejection. Either signal suffices: the queue-entries
    // fetch (q.unmergeable) or the PR's own snapshot — they refresh on different
    // cadences and either can lag the other. No percent/eta: waiting-line math is
    // meaningless for an entry about to be ejected.
    //
    // GitHub marks queue entries UNMERGEABLE *positionally*: one genuinely
    // conflicting entry poisons the speculative merge of every entry behind it.
    // Split on the PR's OWN mergeStateStatus — only DIRTY (conflicts with the
    // base) is a genuine "needs rebase"; everything else (CLEAN/BLOCKED/
    // UNSTABLE/UNKNOWN/null) is a cascade victim that will revalidate once the
    // conflicting entry ahead is ejected.
    if (q?.unmergeable || pr.queue.state === 'UNMERGEABLE') {
      return bare('queue', pr.mergeStateStatus === 'DIRTY' ? 'unmergeable' : 'queue-blocked');
    }
    const substate = q?.failed ? 'group-failed' : null;
    return { stage: 'queue', substate, percent: q?.percent ?? null,
      etaSeconds: q?.etaSeconds ?? null, etaRangeSeconds: null, overdue: q?.overdue ?? false };
  }

  if (pr.isDraft) return bare('parked', 'draft');

  const req = requiredChecks(pr.checks, i.requiredCheckPrefixes, i.rollupWorkflowName);

  // Real failures park the PR
  if (req.some((c) => c.status === 'COMPLETED' && FAILURE_CONCLUSIONS.has(c.conclusion ?? ''))) {
    return bare('parked', 'ci-failed');
  }

  // CANCELLED required checks (with no real failure above) mean spot-reclaim auto-retry is
  // in progress — surface as ci/retrying rather than parking the PR
  if (req.some((c) => c.status === 'COMPLETED' && c.conclusion === 'CANCELLED')) {
    const p = i.ciProgress;
    return { stage: 'ci', substate: 'retrying', percent: p?.percent ?? null,
      etaSeconds: p?.etaSeconds ?? null, etaRangeSeconds: p?.etaRangeSeconds ?? null, overdue: p?.overdue ?? false };
  }

  if (req.some((c) => c.status !== 'COMPLETED')) {
    const p = i.ciProgress;
    return { stage: 'ci', substate: null, percent: p?.percent ?? null,
      etaSeconds: p?.etaSeconds ?? null, etaRangeSeconds: p?.etaRangeSeconds ?? null, overdue: p?.overdue ?? false };
  }

  // All visible required checks are done — but trust ciProgress if it says more checks are
  // coming or still running (prevents empty/partial rollups from classifying as ready too soon)
  if (i.ciProgress && i.ciProgress.percent < 100) {
    const p = i.ciProgress;
    return { stage: 'ci', substate: null, percent: p.percent,
      etaSeconds: p.etaSeconds, etaRangeSeconds: p.etaRangeSeconds, overdue: p.overdue };
  }

  if (pr.mergeStateStatus === 'DIRTY') return bare('parked', 'conflicting');
  // UNKNOWN mergeability: hold previous stage for the recompute window.
  // First-sighting UNKNOWN with no prev lands ready/idle deliberately.
  if (pr.mergeStateStatus === 'UNKNOWN' && prev) return { ...prev };
  return bare('ready', pr.autoMergeArmed ? 'armed' : 'idle');
}
