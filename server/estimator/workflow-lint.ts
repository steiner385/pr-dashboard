/**
 * Workflow lint rules that need a static×runtime join (issue #48). Rule 1:
 * timeout calibration — a job's configured `timeout-minutes` checked against
 * its OBSERVED p99 duration. Pure module: callers resolve graphs/history.
 *
 * Further #48 rules (short gating jobs, repeated setup blocks, unconsumed
 * artifact edges) ship incrementally and will join this file.
 */

/** GitHub's job-level timeout when `timeout-minutes` is absent. */
export const GITHUB_DEFAULT_TIMEOUT_MINUTES = 360;

/** A timeout reads as too tight when it is under p99 × this factor. */
export const TIMEOUT_WARN_FACTOR = 1.2;
/** An EXPLICIT timeout reads as too loose when it exceeds p99 × this factor. */
export const TIMEOUT_INFO_FACTOR = 10;

export interface TimeoutLintInput {
  /** Job (graph node) name. */
  job: string;
  /** Configured `timeout-minutes`; null = unset (the 360m default applies). */
  timeoutMinutes: number | null;
  /** Observed p99 duration, seconds. Non-positive inputs are skipped. */
  p99Secs: number;
}

export interface LintFinding {
  rule: 'timeout';
  severity: 'warn' | 'info';
  job: string;
  message: string;
  /** Observed p99 duration, seconds. */
  observed: number;
  /** Configured timeout, SECONDS; null = not explicitly set (GitHub's
   *  360-minute default applied for the warn check). */
  configured: number | null;
}

/** Compact minutes rendering for messages: `4m`, `90m`, `0.5m` for sub-minute. */
function fmtMins(secs: number): string {
  const m = secs / 60;
  return `${m >= 1 ? Math.round(m) : Math.round(m * 10) / 10}m`;
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
  return out.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1)
    || a.job.localeCompare(b.job));
}
