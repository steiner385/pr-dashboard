import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { renderTierAssign, renderQuarantine, renderTimeout, renderRunnerRoute, pinActionSha, addConcurrency } from '../edit/render';

const WF = `name: CI
on:
  pull_request:
  merge_group:
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm lint
  guarded:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

describe('renderTierAssign (G2 edit-renderer)', () => {
  it('adds an `if:` event guard to a job with no condition', () => {
    const r = renderTierAssign(WF, 'lint', 'merge_group');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.addedLine).toBe("    if: ${{ github.event_name == 'merge_group' }}");
    expect(r.newText).toMatch(/  lint:\n {4}if: \$\{\{ github\.event_name == 'merge_group' \}\}\n {4}runs-on/);
    expect(r.diff).toMatch(/restrict to merge_group/);
  });

  it('refuses a job that already has an `if:`', () => {
    const r = renderTierAssign(WF, 'guarded', 'merge_group');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already has an `if:`/);
  });

  it('refuses when the job is absent', () => {
    expect(renderTierAssign(WF, 'nope', 'merge_group').ok).toBe(false);
  });

  // The branch-protection-safety test the architect mandated: render → PARSE the
  // result → assert (a) it's still valid YAML, (b) ONLY the intended change landed,
  // (c) every other job is byte-identical.
  it('YAML round-trip: result parses, the guard lands on the target job, and nothing else changes', () => {
    const r = renderTierAssign(WF, 'lint', 'merge_group');
    if (!r.ok) throw new Error('expected ok');

    const before = parse(WF);
    const after = parse(r.newText); // (a) still valid YAML — would throw otherwise
    expect(after).toBeTruthy();

    // (b) only the target job gained the intended `if:`
    expect(after.jobs.lint.if).toBe("${{ github.event_name == 'merge_group' }}");
    expect(before.jobs.lint.if).toBeUndefined();

    // (c) everything else is structurally identical (steps, the other job, triggers)
    expect(after.jobs.lint.steps).toEqual(before.jobs.lint.steps);
    expect(after.jobs.lint['runs-on']).toBe(before.jobs.lint['runs-on']);
    expect(after.jobs.guarded).toEqual(before.jobs.guarded);
    expect(after.on).toEqual(before.on);
    expect(after.name).toBe(before.name);
  });
});

describe('renderQuarantine (K2 edit-renderer)', () => {
  it('adds continue-on-error: true to a flaky job (valid YAML round-trip)', () => {
    const r = renderQuarantine(WF, 'lint');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = parse(r.newText);
    expect(after.jobs.lint['continue-on-error']).toBe(true);
    expect(after.jobs.guarded).toEqual(parse(WF).jobs.guarded); // other job untouched
    expect(r.diff).toMatch(/quarantine \(flaky\)/);
  });

  it('refuses a job that already has continue-on-error', () => {
    const wf = WF + '      continue-on-error: true\n';
    const withCoe = `on: push\njobs:\n  a:\n    continue-on-error: false\n    runs-on: x\n    steps: []\n`;
    const r = renderQuarantine(withCoe, 'a');
    expect(r.ok).toBe(false);
    void wf;
  });

  it('refuses a missing job', () => {
    expect(renderQuarantine(WF, 'nope').ok).toBe(false);
  });
});

describe('renderTimeout (add timeout-minutes)', () => {
  it('adds timeout-minutes to a job and round-trips to valid YAML, nothing else changed', () => {
    const r = renderTimeout(WF, 'lint', 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.addedLine).toBe('    timeout-minutes: 10');
    const before = parse(WF), after = parse(r.newText);
    expect(after.jobs.lint['timeout-minutes']).toBe(10);
    expect(before.jobs.lint['timeout-minutes']).toBeUndefined();
    expect(after.jobs.lint.steps).toEqual(before.jobs.lint.steps);
    expect(after.jobs.guarded).toEqual(before.jobs.guarded);
    expect(r.diff).toMatch(/timeout 10m/);
  });

  it('refuses a job that already has timeout-minutes', () => {
    const wf = `on: push\njobs:\n  a:\n    timeout-minutes: 5\n    runs-on: x\n    steps: []\n`;
    const r = renderTimeout(wf, 'a', 10);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already (sets|has) .*timeout-minutes/);
  });

  it('refuses a missing job', () => {
    expect(renderTimeout(WF, 'nope', 10).ok).toBe(false);
  });
});
