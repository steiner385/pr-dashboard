/**
 * Shared tooltip / legend copy (issue #66) — the single source of truth for
 * every "what does this number mean" explanation, extending the
 * TILE_DEFINITIONS pattern (StatusStrip): components render `title`
 * attributes from these entries and the LegendPanel renders the same entries
 * as its deep-dive lists, so the two layers can never drift apart.
 *
 * Tooltips stay `title`-attribute based by design — no tooltip library.
 */

export interface Definition {
  /** Short term as it appears in the UI ('trains/hr'). */
  label: string;
  /** What it means and, for computed figures, how it is computed. */
  text: string;
}

/** `title` string for a definition — the in-place tooltip layer. */
export const defTitle = (d: Definition): string => `${d.label} — ${d.text}`;

/**
 * Every computed headline figure in the Metrics tab + the queue ops strip.
 * Keys are referenced by components as `DEFS.<key>` — a missing key is a
 * compile error, and the definitions test asserts every rendered headline
 * stat carries one of these as its title.
 */
export const METRIC_DEFINITIONS = {
  // ---- queue ops strip (QueueTrain) ----
  queueDepth: { label: 'depth',
    text: 'live merge-queue depth — every entry, including unmergeable/blocked ones' },
  trainsPerHour: { label: 'trains/hr',
    text: 'merge trains completed per hour, from clustered merge timestamps (last 24h)' },
  batchSuccessRate: { label: 'batch success',
    text: 'group builds that merged cleanly: runs / (runs + distinct ejected groups) over the last 7d' },
  ejects24h: { label: 'ejects 24h',
    text: 'distinct merge-group builds ejected from the queue in the last 24h' },
  oldestWait: { label: 'oldest wait',
    text: 'longest current time-in-queue among live entries (enqueued → now)' },

  // ---- duration regressions panel ----
  regressionRule: { label: 'duration regression',
    text: 'a check whose recent 10-run p50 is ≥ 1.5× its prior 20-run p50 AND ≥ +60s; clears below ×1.2. Hourly scan of SUCCESS runs — live state, ignores the window selector' },

  // ---- lead time panel (DORA-lite) ----
  deployFrequency: { label: 'deploy frequency',
    text: 'prod deploys in the window ÷ window days (DORA deployment frequency); counts prod-live events in the window even when the PR merged before it' },
  leadTimeTotal: { label: 'lead time created → prod (p50)',
    text: 'median of created → prod-live over PRs merged in the window that have both timestamps (DORA lead time for changes)' },

  // ---- trends panel ----
  trendCounts: { label: 'open / ci / queue / failed',
    text: 'PR counts by state at the close of the latest bucket (the last sample in each bucket is its closing value)' },

  // ---- runner waits (event-keyed) + runner pools (pool-keyed) ----
  runnerWaitP50: { label: 'p50 wait',
    text: 'median time from a job being queued to a runner picking it up, per trigger event, over the window' },
  poolWaitP50: { label: 'pool p50 wait',
    text: 'median runner-pickup wait keyed by the job’s runs-on pool (an ‘a|b’ pool is a runs-on ternary — the chosen branch isn’t knowable)' },
  starvationRule: { label: 'starvation',
    text: 'a pool starves when its last-hour pickup-wait p90 exceeds max(5min, 4× its own 7-day baseline p90) with ≥5 samples; hysteresis clears below 2× baseline' },

  // ---- concurrency demand panel ----
  concurrencyPeak: { label: 'window peak',
    text: 'highest number of simultaneously-running jobs observed in the window (sweep-line over job start→end intervals; back-to-back jobs do not count as concurrent)' },

  // ---- queue throughput panel ----
  queueMerges: { label: 'merges',
    text: 'PRs merged in the window (vs the previous equal-length window)' },
  queueWaitP50: { label: 'time in queue (p50)',
    text: 'median enqueued → merged time over the window' },
  groupRunP50: { label: 'group run (p50)',
    text: 'median wall-clock of a merge-group CI build over the window' },

  // ---- slowest jobs table ----
  jobP50: { label: 'p50', text: 'median duration over the window' },
  jobP90: { label: 'p90', text: '90th-percentile duration over the window' },
  variability: { label: 'p90/p50',
    text: 'duration variability — how much slower a bad run is than a typical one (>2× highlights erratic jobs)' },
  sampleN: { label: 'n', text: 'number of samples behind the percentiles' },

  // ---- flakiest jobs panel ----
  flakeRate: { label: 'flake rate',
    text: 'flake = a failing run resolved by SUCCESS on the SAME commit (re-run, no new push); rate = flake events ÷ distinct (commit, attempt) runs, min 5 runs' },

  // ---- spot reclaims panel ----
  reclaimEvents: { label: 'reclaim events',
    text: 'a CANCELLED check whose commit later passed the same check at a higher attempt — an infra kill (spot reclaim), not a real verdict' },

  // ---- train killers panel ----
  trainEjects: { label: 'trains ejected',
    text: 'merge-group builds this check failed (and ejected) in the window — one per (group, check)' },
  ejectCost: { label: 'est. cost (train-hours)',
    text: 'approximation: ejects × median group-run duration × batch size — each eject roughly wastes one group build’s wall-clock for every PR riding the train' },

  // ---- critical path panel ----
  cpEndToEnd: { label: 'end-to-end (p50)',
    text: 'expected longest chain through the CI needs-graph, where each job costs its median pickup wait + median duration (last 20 runs — ignores the window selector)' },
  cpStep: { label: 'path step',
    text: 'median pickup wait + median duration of this job (last 20 runs); the chain of these sums is the expected end-to-end time' },
  cpSlack: { label: 'slack',
    text: 'how much this off-path job could grow before it joins the critical path and starts gating the end-to-end time' },

  // ---- workflow lint panel ----
  lintP99: { label: 'p99',
    text: '99th-percentile observed duration over the last 50 runs (min 5 samples)' },
  lintTimeout: { label: 'timeout',
    text: 'the job’s configured timeout-minutes; unset means GitHub’s 6h default' },

  // ---- CI cost panel ----
  costTotalMinutes: { label: 'runner-minutes',
    text: 'total runner occupancy over the window — every job’s start→end span, all conclusions (a failed or cancelled job burned its runner too), attributed to the job’s runs-on pool' },
  costPerMergedPr: { label: 'minutes / merged PR',
    text: 'total runner-minutes ÷ PRs merged in the window — what one merge costs in CI runner time' },
  costRetryBurden: { label: 'retry burden',
    text: 'runner-minutes burned on run_attempt > 1 samples — re-runs after flakes, spot reclaims, or manual retries; pure waste relative to a clean first attempt' },
  costPoolShare: { label: 'pool share',
    text: 'this pool’s runner-minutes (and $, when rates are configured) over the window; an ‘a|b’ pool is a runs-on ternary — the chosen branch isn’t knowable' },
  costInstanceType: { label: 'instance type',
    text: 'display-only instance type for the pool, from the file-only poolMeta config; ‘–’ when unset' },
  costJobMinutes: { label: 'by job',
    text: 'a job’s total runner-minutes over the window (every conclusion, grouped by (job, event)) — top 15 by minutes; $ = minutes × the job’s pool rate (poolMeta > costPerMinute > ‘default’), ‘–’ when the pool is unpriced' },
  costJobSamples: { label: 'n',
    text: 'job rows observed in the window (each completed check run is one sample)' },
  costRunMinutes: { label: 'by run',
    text: 'a workflow run’s total runner-minutes — its jobs grouped by (event, head sha, run number), top 20 by minutes; run numbers only record from new ingestion onward, so this table fills as fresh runs land' },
  costRunJobs: { label: 'jobs',
    text: 'distinct job names in the run (a retried job counts once; its retry minutes still count)' },
  costRunPr: { label: 'PR',
    text: 'best-effort join of the run’s head sha onto a tracked open PR (or queued merge-group head) — ‘–’ when the head is no longer live (older pushes, merged PRs)' },
  prCiCost: { label: 'CI cost this run',
    text: 'elapsed runner-minutes of the current head’s checks (running checks count started → now; foreign-workflow spans excluded). $ prices each check via its runs-on pool (poolMeta > costPerMinute > ‘default’, ÷ podsPerNode); minutes-only when no rates are configured. ‘(partial)’ flags that some checks ran on unpriced pools — the $ undercounts' },
  costActualsActual: { label: 'actual spend',
    text: 'THE number to care about: the real cloud bill — what you actually paid, imported daily from the provider (POST /api/cost/actuals, e.g. an AWS Cost Explorer cron). This is ground truth; every other figure on this card is the dashboard trying to explain it. Scope ‘fleet’ is the whole CI-infra bill (EC2 compute + EC2-Other/EBS/transfer + EKS + VPC/NAT); a pool scope is that pool’s share' },
  costActualsAttributed: { label: 'attributed',
    text: 'how much of the bill the dashboard can pin to specific tracked CI jobs (job minutes × pool $/min) — a bottom-up reconstruction, summed over the full window. It is the ONLY figure that can be sliced per-PR, per-pool, or per-repo, so it powers every “this PR cost $X” number. Usually ≤ actual, but it can run OVER when the per-minute rate over-prices a fixed-capacity fleet (nodes cost the same whether they run 100 or 200 job-minutes) — see coverage. Null until pool rates are set' },
  costActualsCoverage: { label: 'attribution coverage',
    text: 'attributed ÷ actual — a confidence gauge on the breakdown, NOT a dollar amount. Computed over COMPARABLE days only: days since job-tracking began AND fully billed (today’s bill is still settling), so both sides cover the same span — comparing mismatched day-sets is what made attributed look like it beat actual. ~100% = priced jobs explain the bill well. BELOW = the gap is spend no single job owns (idle runner capacity, node boot/teardown, control-plane, unpriced pools; for fleet ~10% is non-compute EC2-Other/EKS/VPC). ABOVE 100% = the per-minute rate is over-pricing the fixed-capacity fleet (relay rate set too high, or the last day or two haven’t finished billing). The per-day column is noisy by nature — read the headline, not a single day' },

  // ---- CI needs graph (issue #74) ----
  needsGraphNodes: { label: 'jobs',
    text: 'number of jobs in the derived needs-DAG for this event. The graph below lays them out by dependency depth (left→right), overlays each job’s observed p50 duration + runner wait, and highlights the critical path (the longest wait+duration chain that gates end-to-end time)' },

  // ---- queue efficiency panel (issue #23) ----
  queueEffRunsPerMerge: { label: 'runs / merge',
    text: 'merge_group CI runs ÷ PRs merged, over the window — how many times the queue rebuilt a batch per PR it actually landed. The headline churn metric: ~0.33 is ideal (serial), and a high value (≈6.5 was observed at batch min=3) means batches keep rebuilding — the gate signal for raising batch size. Counts every merge_group run including re-runs and ejected batches' },
  queueEffAdvisoryNoise: { label: 'advisory-only failures',
    text: 'merge_group runs whose run-level conclusion read FAILED but the required gate (checks matching requiredCheckPrefixes) actually PASSED — i.e. only a non-required advisory job failed. GitHub marks the whole run failed when any job fails, so without this split the run-failure count is unreadable. A high share means advisory jobs should be removed from merge_group' },
  queueEffRequiredFailed: { label: 'required-gate failures',
    text: 'merge_group runs where a REQUIRED check (matching requiredCheckPrefixes) failed — the real gate failures, distinct from advisory noise. Needs requiredCheckPrefixes configured for the repo; without it the required/advisory split can’t be computed and every failure reads as advisory' },
  queueEffAdminBypass: { label: 'admin-bypass rate',
    text: 'fraction of merged PRs NOT merged by the queue bot — i.e. a human/admin merged directly, bypassing the merge queue. Classified by who merged (mergedBy), counting only merges whose merger is known (the metric ramps up as new merges are observed — rows predating the merged_by column are excluded). Sustained >10% is a queue-confidence alarm: people are routing around the queue' },

  // ---- merge velocity panel ----
  velocityMerged: { label: 'merged',
    text: 'PRs merged in the window (vs the previous equal-length window)' },
  mergeToQa: { label: 'merge → QA (p50)',
    text: 'median merged → live-on-QA time over the window (deploy lag)' },
  lifespan: { label: 'avg PR lifespan',
    text: 'mean created → merged age of PRs merged in the window' },

  // ---- ETA calibration panel ----
  calibrationError: { label: 'median ETA error',
    text: 'signed (actual − predicted) ÷ predicted per stage: POSITIVE = stages ran longer than first promised (ETAs optimistic), NEGATIVE = they finished early (pessimistic)' },
  calibrationP90Abs: { label: 'p90 |error|',
    text: '90th percentile of the absolute error % — how wrong the worst ~10% of ETAs were, regardless of direction' },
} as const satisfies Record<string, Definition>;

export type MetricDefinitionKey = keyof typeof METRIC_DEFINITIONS;

/** Shorthand used by components: `title={defTitle(DEFS.trainsPerHour)}`. */
export const DEFS = METRIC_DEFINITIONS;

/**
 * The Delivery spine's 5-state lane vocabulary (spec §16). Each glyph mirrors
 * the live `LANE_GLYPH` rendering so the legend and the rail can't drift; the
 * LegendPanel renders these as the "Delivery spine" deep-dive section.
 */
export const LANE_STATE_DEFINITIONS = {
  laneGreen: { label: '● green', text: 'stage healthy — nothing to do' },
  laneAmber: { label: '◐ watch', text: 'working but slow/degraded — needs attention, not broken' },
  laneRed: { label: '✗ red', text: 'broken here — the thing to look at' },
  laneBlind: { label: '◌ blind', text: 'wired but no signal (no data / source down) — never read as green' },
  laneIdle: { label: '· idle', text: 'nothing happening, and that is normal' },
} as const satisfies Record<string, Definition>;

/**
 * Row sub-line vocabulary (PrRow's muted status line) — `match` recognizes the
 * term inside a rendered sub line so the row can carry the right tooltip;
 * the LegendPanel lists the same entries verbatim.
 */
export const SUBLINE_TERMS: { term: string; text: string; match: RegExp }[] = [
  { term: 'group N%', match: /\bgroup \d+%/,
    text: 'progress of the merge-group build (never the head-commit PR checks)' },
  { term: 'behind N', match: /\bbehind \d+/,
    text: 'number of queue entries ahead of this PR' },
  { term: 'queue blocked — conflict ahead (#n)', match: /queue blocked — conflict ahead/,
    text: 'a conflicting entry ahead poisons this PR’s speculative merge — rebasing won’t help; it revalidates once #n is ejected' },
  { term: 'unmergeable — needs rebase', match: /unmergeable — needs rebase/,
    text: 'genuinely conflicts with the base branch — facing ejection from the queue until rebased' },
  { term: 'retrying', match: /retrying/,
    text: 'CI is re-running after a failed attempt on the same commit' },
  { term: 'overdue', match: /overdue/,
    text: 'running longer than its expected duration' },
  { term: 'waiting for runners (N jobs)', match: /waiting for runners \(\d+ jobs?\)/,
    text: 'jobs are queued but no CI runner has picked them up yet' },
  { term: 'N% (ci)', match: /^\d+%|· \d+%/,
    text: 'progress of the head-commit CI run: completed required checks weighted by their typical durations' },
];

/** Tooltip for a rendered sub line: the definitions of every recognized term,
 *  newline-joined; undefined when nothing matches (no empty tooltips). */
export function subLineTitle(sub: string): string | undefined {
  const hits = SUBLINE_TERMS.filter((t) => t.match.test(sub))
    .map((t) => `${t.term} — ${t.text}`);
  return hits.length ? hits.join('\n') : undefined;
}

/** Settings source-tag attribution (SettingsPanel + legend). */
export const SOURCE_DEFINITIONS: Record<'override' | 'in-repo' | 'derived' | 'default', Definition> = {
  override: { label: 'override',
    text: 'set in this instance’s config file (config.json repos./deploy. entry) — wins over everything' },
  'in-repo': { label: 'in-repo',
    text: 'from the repo’s .pr-dashboard.yml — the repo ships its own dashboard settings' },
  derived: { label: 'derived',
    text: 'computed from the repo’s ci.yml needs-graph (no one configured it)' },
  default: { label: 'default',
    text: 'built-in default — nothing configured anywhere' },
};

/** Metrics window / bucket controls. */
export const CONTROL_DEFINITIONS = {
  window: { label: 'window',
    text: 'how far back the stats and charts look; headline deltas compare against the equal-length window before it' },
  bucketHour: { label: 'hourly',
    text: 'one chart point per hour — available for windows up to 7d (longer windows clamp to daily)' },
  bucketDay: { label: 'daily', text: 'one chart point per day' },
  refresh: { label: 'refresh',
    text: 'refetch the metrics for the current window (metrics are computed on request, not streamed)' },
} as const satisfies Record<string, Definition>;
