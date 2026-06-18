import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { applyMutation, type Mutation } from '../edit/mutation';

const WF = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`;

describe('applyMutation (1:1 mutation → renderer dispatch)', () => {
  it('dispatches each op to its renderer', () => {
    const timeout = applyMutation(WF, { op: 'timeout', jobId: 'a', minutes: 15 });
    expect(timeout.ok).toBe(true);
    if (timeout.ok) expect(parse(timeout.newText).jobs.a['timeout-minutes']).toBe(15);

    const runner = applyMutation(WF, { op: 'runner', jobId: 'a', runsOn: 'self-hosted' });
    expect(runner.ok).toBe(true);
    if (runner.ok) expect(parse(runner.newText).jobs.a['runs-on']).toBe('self-hosted');

    const pin = applyMutation(WF, { op: 'pin-action', usesRef: 'actions/checkout@v4', sha: '1'.repeat(40) });
    expect(pin.ok).toBe(true);
    if (pin.ok) expect(parse(pin.newText).jobs.a.steps[0].uses).toBe(`actions/checkout@${'1'.repeat(40)}`);

    const conc = applyMutation(WF, { op: 'concurrency', group: 'g' });
    expect(conc.ok).toBe(true);
    if (conc.ok) expect(parse(conc.newText).concurrency.group).toBe('g');
  });

  it('propagates a renderer refusal unchanged', () => {
    const r = applyMutation(WF, { op: 'timeout', jobId: 'nope', minutes: 5 });
    expect(r.ok).toBe(false);
  });
});

describe('applyMutation — model-dependent ops (1b)', () => {
  const GUARDED = `on:\n  pull_request:\n  merge_group:\njobs:\n  dead:\n    runs-on: x\n    steps: []\n  heavy:\n    if: \${{ github.event_name == 'merge_group' }}\n    runs-on: x\n    steps: []\n  ci:\n    needs: [dead, heavy]\n    runs-on: x\n    steps: []\n`;

  it('dispatches shift-left (removes the guard)', () => {
    const r = applyMutation(GUARDED, { op: 'shift-left', jobId: 'heavy' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(parse(r.newText).jobs.heavy.if).toBeUndefined();
  });

  it('dispatches remove (deletes the job + cleans needs)', () => {
    const r = applyMutation(GUARDED, { op: 'remove', jobId: 'dead' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const after = parse(r.newText);
      expect(after.jobs.dead).toBeUndefined();
      expect(after.jobs.ci.needs).toEqual(['heavy']);
    }
  });
});
