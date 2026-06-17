import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { renderTierAssign } from '../edit/render';

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
