import { describe, it, expect } from 'vitest';
import { lintTimeouts, GITHUB_DEFAULT_TIMEOUT_MINUTES, type TimeoutLintInput } from '../workflow-lint';

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
