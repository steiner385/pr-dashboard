/**
 * Workflow lint rules that need a static×runtime join (issue #48). Pure
 * module: callers (metrics.ts) resolve graphs/history.
 *
 * Rule 1 — 'timeout': a job's configured `timeout-minutes` checked against its
 * OBSERVED p99 duration (too tight will timeout-cancel; too loose burns hung
 * runners).
 * Rule 2 — 'fast-gating-job': a sub-30s job that other jobs `need` AND that
 * sits on the expected critical path — its runner pickup serializes the chain
 * for almost no work; merging it into its dependents removes a hop.
 * Rule 3 — 'wait-dominated': a job whose median runner-pickup wait exceeds its
 * median duration — the fleet spends more on scheduling it than running it.
 */

/** GitHub's job-level timeout when `timeout-minutes` is absent. */
export const GITHUB_DEFAULT_TIMEOUT_MINUTES = 360;

/** A timeout reads as too tight when it is under p99 × this factor. */
export const TIMEOUT_WARN_FACTOR = 1.2;
/** An EXPLICIT timeout reads as too loose when it exceeds p99 × this factor. */
export const TIMEOUT_INFO_FACTOR = 10;

/** A gating job reads as "fast" (merge candidate) under this p50. */
export const FAST_GATING_MAX_P50_SECS = 30;

/** Minimum samples on BOTH series (waits AND durations) before the
 *  wait-dominated comparison is trusted. */
export const WAIT_DOMINATED_MIN_SAMPLES = 10;

export type LintRuleId = 'timeout' | 'fast-gating-job' | 'wait-dominated';

export interface TimeoutLintInput {
  /** Job (graph node) name. */
  job: string;
  /** Configured `timeout-minutes`; null = unset (the 360m default applies). */
  timeoutMinutes: number | null;
  /** Observed p99 duration, seconds. Non-positive inputs are skipped. */
  p99Secs: number;
}

export interface FastGatingInput {
  /** Job (graph node) name. */
  job: string;
  /** Median observed duration, seconds. Non-positive inputs are skipped. */
  p50Secs: number;
  /** Jobs whose `needs:` include this job (event-active dependents). */
  dependents: string[];
  /** Whether the job sits on the expected critical path. */
  onCriticalPath: boolean;
}

export interface WaitDominatedInput {
  /** Job (graph node) name. */
  job: string;
  /** Median runner-pickup wait, seconds. */
  waitP50Secs: number;
  /** Samples behind waitP50Secs. */
  waitN: number;
  /** Median observed duration, seconds. Non-positive inputs are skipped. */
  durationP50Secs: number;
  /** Samples behind durationP50Secs. */
  durationN: number;
}

export interface LintFinding {
  rule: LintRuleId;
  severity: 'warn' | 'info';
  job: string;
  message: string;
  /** Rule-specific primary observed value, SECONDS: the p99 duration
   *  ('timeout'), the p50 duration ('fast-gating-job'), or the p50 runner
   *  wait ('wait-dominated'). */
  observed: number;
  /** Configured timeout, SECONDS ('timeout' rule only); null = not explicitly
   *  set (GitHub's 360-minute default applied for the warn check) and on
   *  every other rule (nothing is configured — only observed). */
  configured: number | null;
}

/** Compact minutes rendering for messages: `4m`, `90m`, `0.5m` for sub-minute. */
function fmtMins(secs: number): string {
  const m = secs / 60;
  return `${m >= 1 ? Math.round(m) : Math.round(m * 10) / 10}m`;
}

/** Compact seconds-or-minutes rendering: `30s`, `0.5s`, `2m`. */
function fmtSecs(secs: number): string {
  if (secs >= 60) return fmtMins(secs);
  return `${secs >= 1 ? Math.round(secs) : Math.round(secs * 10) / 10}s`;
}

/** Human-readable job name. A reusable-workflow node's key is its prefix —
 *  "static-checks / " — which reads as a dangling slash ("job: static-checks /")
 *  in a recommendation. Drop a trailing " / " so it renders as "static-checks". */
export function cleanJobName(job: string): string {
  return job.replace(/\s*\/\s*$/, '');
}

/** Cross-rule ordering: warn-first, then by job name, then by rule id —
 *  stable however many rules contributed. */
export function sortFindings(findings: LintFinding[]): LintFinding[] {
  return [...findings].sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1)
    || a.job.localeCompare(b.job)
    || a.rule.localeCompare(b.rule));
}

/**
 * Rule 1 — timeout calibration:
 *  - WARN when the effective timeout (configured, else GitHub's 360m default)
 *    is under p99 × 1.2: a slow-but-normal run will be timeout-cancelled.
 *  - INFO when an EXPLICITLY configured timeout exceeds p99 × 10: a hung run
 *    burns the runner ~10× longer than any healthy run before failing
 *    ("timeout 60m vs p99 4m — tighten to fail fast"). The unset default is
 *    never flagged loose — it wasn't a choice.
 * Findings sort warn-first, then by job name.
 */
export function lintTimeouts(inputs: TimeoutLintInput[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const { job, timeoutMinutes, p99Secs } of inputs) {
    if (!(p99Secs > 0)) continue; // no observed tail to lint against
    const configured = timeoutMinutes != null ? timeoutMinutes * 60 : null;
    const effective = configured ?? GITHUB_DEFAULT_TIMEOUT_MINUTES * 60;
    if (effective < p99Secs * TIMEOUT_WARN_FACTOR) {
      const lhs = configured != null
        ? `timeout ${fmtMins(configured)}`
        : `no timeout-minutes (GitHub default ${GITHUB_DEFAULT_TIMEOUT_MINUTES}m)`;
      out.push({
        rule: 'timeout', severity: 'warn', job,
        message: `${lhs} vs p99 ${fmtMins(p99Secs)} — will timeout-cancel on a slow run`,
        observed: p99Secs, configured,
      });
    } else if (configured != null && configured > p99Secs * TIMEOUT_INFO_FACTOR) {
      out.push({
        rule: 'timeout', severity: 'info', job,
        message: `timeout ${fmtMins(configured)} vs p99 ${fmtMins(p99Secs)} — tighten to fail fast`,
        observed: p99Secs, configured,
      });
    }
  }
  return sortFindings(out);
}

/**
 * Rule 2 — fast gating jobs: a job with p50 < 30s that at least one other job
 * `needs` AND that sits on the expected critical path. Every gating hop costs
 * a runner pickup; a sub-30s job pays that tax for almost no work — folding
 * it into its dependents (a shared step/composite action) removes the hop.
 * INFO only: this is a structure suggestion, never a correctness problem.
 */
export function lintFastGatingJobs(inputs: FastGatingInput[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const { job, p50Secs, dependents, onCriticalPath } of inputs) {
    if (!(p50Secs > 0) || p50Secs >= FAST_GATING_MAX_P50_SECS) continue;
    if (!onCriticalPath || dependents.length === 0) continue;
    out.push({
      rule: 'fast-gating-job', severity: 'info', job,
      message: `p50 ${fmtSecs(p50Secs)} gates ${dependents.map(cleanJobName).join(', ')}; `
        + 'consider merging into dependents',
      observed: p50Secs, configured: null,
    });
  }
  return sortFindings(out);
}

/**
 * Rule 3 — wait-dominated jobs: median runner-pickup wait exceeds the median
 * duration (≥10 samples on both series — thin medians are noise). The fleet
 * spends more scheduling the job than running it: batch it with another job
 * on the same runner, or move it to a less contended pool. INFO only.
 */
export function lintWaitDominated(inputs: WaitDominatedInput[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const { job, waitP50Secs, waitN, durationP50Secs, durationN } of inputs) {
    if (!(durationP50Secs > 0)) continue; // nothing observed to compare against
    if (waitN < WAIT_DOMINATED_MIN_SAMPLES || durationN < WAIT_DOMINATED_MIN_SAMPLES) continue;
    if (!(waitP50Secs > durationP50Secs)) continue;
    out.push({
      rule: 'wait-dominated', severity: 'info', job,
      message: `wait p50 ${fmtSecs(waitP50Secs)} vs run p50 ${fmtSecs(durationP50Secs)} — `
        + 'waits longer for a runner than it runs; batch with another job or move pools',
      observed: waitP50Secs, configured: null,
    });
  }
  return sortFindings(out);
}
