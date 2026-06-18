import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { renderTierAssign, renderQuarantine, renderTimeout, renderRunnerRoute, pinActionSha, addConcurrency, renderShiftLeft, renderRemoveCheck } from '../edit/render';

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

describe('renderRunnerRoute (change runs-on)', () => {
  it('replaces runs-on for a job and round-trips, nothing else changed', () => {
    const r = renderRunnerRoute(WF, 'lint', 'self-hosted');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = parse(WF), after = parse(r.newText);
    expect(after.jobs.lint['runs-on']).toBe('self-hosted');
    expect(before.jobs.lint['runs-on']).toBe('ubuntu-latest');
    expect(after.jobs.lint.steps).toEqual(before.jobs.lint.steps);
    expect(after.jobs.guarded).toEqual(before.jobs.guarded);
    expect(r.diff).toMatch(/runs-on → self-hosted/);
  });

  it('refuses when runs-on is a matrix/expression (cannot route safely)', () => {
    const wf = `on: push\njobs:\n  a:\n    runs-on: \${{ matrix.os }}\n    steps: []\n`;
    const r = renderRunnerRoute(wf, 'a', 'self-hosted');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/expression|matrix/);
  });

  it('refuses a job with no runs-on (e.g. a `uses:` caller)', () => {
    const wf = `on: push\njobs:\n  a:\n    uses: ./.github/workflows/_x.yml\n`;
    expect(renderRunnerRoute(wf, 'a', 'self-hosted').ok).toBe(false);
  });

  it('refuses a missing job', () => {
    expect(renderRunnerRoute(WF, 'nope', 'self-hosted').ok).toBe(false);
  });
});

describe('pinActionSha (pin a uses: ref to a SHA)', () => {
  const WFA = `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo hi\n`;
  const SHA = '1'.repeat(40);

  it('replaces the ref with the SHA and keeps the tag as a comment; round-trips', () => {
    const r = pinActionSha(WFA, 'actions/checkout@v4', SHA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newText).toContain(`uses: actions/checkout@${SHA}  # v4`);
    const after = parse(r.newText);
    expect(after.jobs.a.steps[0].uses).toBe(`actions/checkout@${SHA}`);
    expect(after.jobs.a.steps[1]).toEqual({ run: 'echo hi' });
    expect(r.diff).toMatch(/pin actions\/checkout/);
  });

  it('refuses a non-40-char SHA', () => {
    expect(pinActionSha(WFA, 'actions/checkout@v4', 'deadbeef').ok).toBe(false);
  });

  it('refuses a ref that is already a SHA', () => {
    const wf = WFA.replace('@v4', `@${SHA}`);
    expect(pinActionSha(wf, `actions/checkout@${SHA}`, '2'.repeat(40)).ok).toBe(false);
  });

  it('refuses when the uses: line is absent', () => {
    expect(pinActionSha(WFA, 'actions/setup-node@v4', SHA).ok).toBe(false);
  });
});

describe('addConcurrency (workflow-level concurrency block)', () => {
  it('inserts a concurrency block before jobs: and round-trips', () => {
    const r = addConcurrency(WF, '${{ github.workflow }}-${{ github.ref }}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = parse(WF), after = parse(r.newText);
    expect(after.concurrency.group).toBe('${{ github.workflow }}-${{ github.ref }}');
    expect(after.concurrency['cancel-in-progress']).toBe(true);
    expect(after.jobs).toEqual(before.jobs); // jobs untouched
    expect(after.on).toEqual(before.on);
    expect(r.diff).toMatch(/add workflow concurrency/);
  });

  it('refuses a workflow that already declares concurrency', () => {
    const wf = `name: CI\nconcurrency:\n  group: x\non: push\njobs:\n  a:\n    runs-on: x\n    steps: []\n`;
    const r = addConcurrency(wf, 'y');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already declares .*concurrency/);
  });

  it('refuses text with no top-level jobs:', () => {
    expect(addConcurrency(`on: push\n`, 'x').ok).toBe(false);
  });
});

describe('renderShiftLeft (relax a simple event guard — inverse of G2)', () => {
  const GUARDED = `on:\n  pull_request:\n  merge_group:\njobs:\n  heavy:\n    if: \${{ github.event_name == 'merge_group' }}\n    runs-on: x\n    steps: []\n`;

  it('removes the simple event-guard if: and round-trips (job now has no if:)', () => {
    const r = renderShiftLeft(GUARDED, 'heavy');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = parse(r.newText);
    expect(after.jobs.heavy.if).toBeUndefined();
    expect(after.jobs.heavy['runs-on']).toBe('x');
    expect(r.diff).toMatch(/shift left/);
  });

  it('refuses a job with no if: (already shifts left)', () => {
    const wf = `on: push\njobs:\n  a:\n    runs-on: x\n    steps: []\n`;
    expect(renderShiftLeft(wf, 'a').ok).toBe(false);
  });

  it('refuses an if: that is not a simple event guard (refuse-not-merge)', () => {
    const wf = `on: push\njobs:\n  a:\n    if: \${{ github.event_name == 'merge_group' && needs.x.result == 'success' }}\n    runs-on: x\n    steps: []\n`;
    const r = renderShiftLeft(wf, 'a');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not a simple event guard/);
  });

  it('refuses a missing job', () => {
    expect(renderShiftLeft(GUARDED, 'nope').ok).toBe(false);
  });
});

describe('renderRemoveCheck (delete a job + clean needs)', () => {
  const WF3 = `on: push\njobs:\n  build:\n    runs-on: x\n    steps: []\n  dead:\n    runs-on: x\n    steps: []\n  ci:\n    needs: [build, dead]\n    runs-on: x\n    steps: []\n`;

  it('removes the job and strips it from an inline needs array; round-trips', () => {
    const r = renderRemoveCheck(WF3, 'dead');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = parse(r.newText);
    expect(after.jobs.dead).toBeUndefined();
    expect(after.jobs.ci.needs).toEqual(['build']);
    expect(after.jobs.build).toBeTruthy();
    expect(r.diff).toMatch(/remove job dead/);
  });

  it('strips a block-list needs item', () => {
    const wf = `on: push\njobs:\n  dead:\n    runs-on: x\n    steps: []\n  ci:\n    needs:\n      - build\n      - dead\n    runs-on: x\n    steps: []\n`;
    const r = renderRemoveCheck(wf, 'dead');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parse(r.newText).jobs.ci.needs).toEqual(['build']);
  });

  it('drops a scalar `needs: dead` line entirely', () => {
    const wf = `on: push\njobs:\n  dead:\n    runs-on: x\n    steps: []\n  ci:\n    needs: dead\n    runs-on: x\n    steps: []\n`;
    const r = renderRemoveCheck(wf, 'dead');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parse(r.newText).jobs.ci.needs).toBeUndefined();
  });

  it('refuses a missing job', () => {
    expect(renderRemoveCheck(WF3, 'nope').ok).toBe(false);
  });
});
