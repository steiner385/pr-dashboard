import { describe, it, expect } from 'vitest';
import {
  lintTimeouts, lintFastGatingJobs, lintWaitDominated, sortFindings, cleanJobName,
  GITHUB_DEFAULT_TIMEOUT_MINUTES, FAST_GATING_MAX_P50_SECS, WAIT_DOMINATED_MIN_SAMPLES,
  type TimeoutLintInput, type FastGatingInput, type WaitDominatedInput, type LintFinding,
} from '../workflow-lint';

describe('cleanJobName', () => {
  it('drops a trailing slash from a reusable-workflow node key', () => {
    expect(cleanJobName('static-checks / ')).toBe('static-checks');
    expect(cleanJobName('fast-checks /')).toBe('fast-checks');
  });
  it('leaves a normal (leaf) job name untouched', () => {
    expect(cleanJobName('build')).toBe('build');
    expect(cleanJobName('static-checks / test: server')).toBe('static-checks / test: server');
  });
});

const job = (jobName: string, timeoutMinutes: number | null, p99Secs: number): TimeoutLintInput =>
  ({ job: jobName, timeoutMinutes, p99Secs });

describe('lintTimeouts', () => {
  it('exports the GitHub job timeout default (360 minutes)', () => {
    expect(GITHUB_DEFAULT_TIMEOUT_MINUTES).toBe(360);
  });

  it('WARN when configured timeout < p99 × 1.2', () => {
    // p99 600s → threshold 720s; timeout 11m = 660s → warn
    const out = lintTimeouts([job('unit-tests', 11, 600)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'timeout', severity: 'warn', job: 'unit-tests',
      observed: 600, configured: 660,
    });
    expect(out[0]!.message).toContain('will timeout-cancel on a slow run');
  });

  it('no WARN at exactly p99 × 1.2 (strict less-than)', () => {
    // p99 600s → threshold 720s; timeout 12m = 720s → ok
    expect(lintTimeouts([job('unit-tests', 12, 600)])).toEqual([]);
  });

  it('null timeout uses the 360-minute GitHub default for the WARN check', () => {
    // p99 20000s → threshold 24000s > 21600s default → warn, configured stays null
    const out = lintTimeouts([job('mega-suite', null, 20_000)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'warn', job: 'mega-suite', configured: null });
    expect(out[0]!.message).toContain('360m');
    // …and a fast job against the default is fine
    expect(lintTimeouts([job('fast', null, 240)])).toEqual([]);
  });

  it('INFO when an EXPLICIT timeout > p99 × 10', () => {
    // timeout 60m = 3600s, p99 240s → 3600 > 2400 → info
    const out = lintTimeouts([job('build', 60, 240)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'timeout', severity: 'info', job: 'build', observed: 240, configured: 3600,
    });
    expect(out[0]!.message).toContain('tighten');
  });

  it('no INFO when the timeout is unset (the default is not a choice to tighten)', () => {
    // default 360m vs p99 240s would trip ×10 — but it was never set
    expect(lintTimeouts([job('build', null, 240)])).toEqual([]);
  });

  it('no INFO at exactly p99 × 10 (strict greater-than)', () => {
    // timeout 40m = 2400s, p99 240s → 2400 === 2400 → ok
    expect(lintTimeouts([job('build', 40, 240)])).toEqual([]);
  });

  it('healthy band (1.2× ≤ timeout ≤ 10×) yields no findings', () => {
    expect(lintTimeouts([job('build', 10, 300)])).toEqual([]); // 600s vs p99 300s = 2×
  });

  it('non-positive p99 is skipped (no observed data to lint against)', () => {
    expect(lintTimeouts([job('build', 1, 0)])).toEqual([]);
    expect(lintTimeouts([job('build', 1, -5)])).toEqual([]);
  });

  it('findings sort warn-first, then by job name', () => {
    const out = lintTimeouts([
      job('z-loose', 600, 60),   // info
      job('b-tight', 1, 600),    // warn
      job('a-tight', 1, 600),    // warn
    ]);
    expect(out.map((f) => `${f.severity}:${f.job}`)).toEqual([
      'warn:a-tight', 'warn:b-tight', 'info:z-loose',
    ]);
  });

  it('messages render minutes for both sides (human-scannable)', () => {
    const out = lintTimeouts([job('build', 60, 240)]);
    expect(out[0]!.message).toMatch(/60m/);
    expect(out[0]!.message).toMatch(/4m/);
  });
});

// ---------------------------------------------------------------------------
// Issue #48 rule 2: fast gating jobs (sub-30s jobs serializing the chain)
// ---------------------------------------------------------------------------

const fast = (jobName: string, p50Secs: number, dependents: string[],
  onCriticalPath = true): FastGatingInput =>
  ({ job: jobName, p50Secs, dependents, onCriticalPath });

describe('lintFastGatingJobs', () => {
  it('exports the 30s threshold', () => {
    expect(FAST_GATING_MAX_P50_SECS).toBe(30);
  });

  it('INFO when p50 < 30s, ≥1 dependent, and on the critical path', () => {
    const out = lintFastGatingJobs([fast('prepare', 12, ['build', 'unit-tests'])]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'fast-gating-job', severity: 'info', job: 'prepare',
      observed: 12, configured: null,
    });
    expect(out[0]!.message).toBe(
      'p50 12s gates build, unit-tests; consider merging into dependents');
  });

  it('cleans trailing slashes from reusable-workflow dependents in the message', () => {
    const out = lintFastGatingJobs([fast('prepare', 12, ['static-checks / ', 'fast-checks /', 'ci'])]);
    expect(out[0]!.message).toBe(
      'p50 12s gates static-checks, fast-checks, ci; consider merging into dependents');
  });

  it('no finding at exactly 30s (strict less-than)', () => {
    expect(lintFastGatingJobs([fast('prepare', 30, ['build'])])).toEqual([]);
    expect(lintFastGatingJobs([fast('prepare', 29.9, ['build'])])).toHaveLength(1);
  });

  it('no finding without dependents (a fast sink gates nothing)', () => {
    expect(lintFastGatingJobs([fast('ci', 10, [])])).toEqual([]);
  });

  it('no finding off the critical path (it does not serialize anything)', () => {
    expect(lintFastGatingJobs([fast('prepare', 10, ['build'], false)])).toEqual([]);
  });

  it('non-positive p50 is skipped (no observed data)', () => {
    expect(lintFastGatingJobs([fast('prepare', 0, ['build'])])).toEqual([]);
    expect(lintFastGatingJobs([fast('prepare', -5, ['build'])])).toEqual([]);
  });

  it('sub-second p50s render one decimal', () => {
    const out = lintFastGatingJobs([fast('stamp', 0.5, ['build'])]);
    expect(out[0]!.message).toContain('p50 0.5s');
  });
});

// ---------------------------------------------------------------------------
// Issue #48 rule 3: wait-dominated jobs (queue longer for a runner than they run)
// ---------------------------------------------------------------------------

const wd = (jobName: string, waitP50Secs: number, durationP50Secs: number,
  waitN = 20, durationN = 20): WaitDominatedInput =>
  ({ job: jobName, waitP50Secs, waitN, durationP50Secs, durationN });

describe('lintWaitDominated', () => {
  it('exports the 10-sample minimum', () => {
    expect(WAIT_DOMINATED_MIN_SAMPLES).toBe(10);
  });

  it('INFO when runner-wait p50 exceeds duration p50 with enough samples', () => {
    const out = lintWaitDominated([wd('tiny-check', 120, 30)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'wait-dominated', severity: 'info', job: 'tiny-check',
      observed: 120, configured: null,
    });
    expect(out[0]!.message).toContain('wait p50 2m vs run p50 30s');
    expect(out[0]!.message).toContain(
      'waits longer for a runner than it runs; batch with another job or move pools');
  });

  it('no finding when wait equals or undercuts the duration (strict greater-than)', () => {
    expect(lintWaitDominated([wd('a', 30, 30)])).toEqual([]);
    expect(lintWaitDominated([wd('b', 29, 30)])).toEqual([]);
  });

  it('requires ≥10 samples on BOTH series', () => {
    expect(lintWaitDominated([wd('thin-waits', 120, 30, 9, 20)])).toEqual([]);
    expect(lintWaitDominated([wd('thin-durs', 120, 30, 20, 9)])).toEqual([]);
    expect(lintWaitDominated([wd('ok', 120, 30, 10, 10)])).toHaveLength(1);
  });

  it('non-positive durations are skipped (nothing observed to compare against)', () => {
    expect(lintWaitDominated([wd('broken', 120, 0)])).toEqual([]);
  });
});

describe('sortFindings (cross-rule ordering)', () => {
  it('sorts warn-first, then by job, then by rule id', () => {
    const f = (rule: LintFinding['rule'], severity: LintFinding['severity'],
      jobName: string): LintFinding =>
      ({ rule, severity, job: jobName, message: '', observed: 1, configured: null });
    const out = sortFindings([
      f('wait-dominated', 'info', 'b'),
      f('timeout', 'warn', 'z'),
      f('timeout', 'info', 'b'),
      f('fast-gating-job', 'info', 'a'),
    ]);
    expect(out.map((x) => `${x.severity}:${x.job}:${x.rule}`)).toEqual([
      'warn:z:timeout',
      'info:a:fast-gating-job',
      'info:b:timeout',
      'info:b:wait-dominated',
    ]);
  });
});
