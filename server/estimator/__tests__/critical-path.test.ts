import { describe, it, expect } from 'vitest';
import { computeCriticalPath, type CriticalPathNodeInput } from '../critical-path';

/** Shorthand node builder. */
const n = (name: string, needs: string[], durationP50: number | null,
  waitP50: number | null = null): CriticalPathNodeInput =>
  ({ name, needs, durationP50, waitP50 });

describe('computeCriticalPath', () => {
  it('returns null for empty input', () => {
    expect(computeCriticalPath([])).toBeNull();
  });

  it('single node: path is the node, end-to-end is wait + duration', () => {
    const r = computeCriticalPath([n('build', [], 100, 20)]);
    expect(r).not.toBeNull();
    expect(r!.endToEndP50Secs).toBe(120);
    expect(r!.path).toEqual([{ name: 'build', durationP50: 100, waitP50: 20 }]);
    expect(r!.offPath).toEqual([]);
  });

  it('diamond DAG: longest path wins, slack on the short branch', () => {
    // build(120) → unit(630) → ci(10)  = 760  (critical)
    // build(120) → bats(70)  → ci(10)  = 200
    const r = computeCriticalPath([
      n('build', [], 100, 20),
      n('unit', ['build'], 600, 30),
      n('bats', ['build'], 60, 10),
      n('ci', ['unit', 'bats'], 5, 5),
    ])!;
    expect(r.endToEndP50Secs).toBe(760);
    expect(r.path.map((s) => s.name)).toEqual(['build', 'unit', 'ci']);
    // bats: earliest finish 120+70=190, latest finish 760-10=750 → slack 560
    expect(r.offPath).toEqual([{ name: 'bats', slackSecs: 560 }]);
  });

  it('path steps carry the node duration and wait separately', () => {
    const r = computeCriticalPath([
      n('build', [], 100, 20),
      n('unit', ['build'], 600, 30),
      n('ci', ['unit'], 5, 5),
    ])!;
    expect(r.path).toEqual([
      { name: 'build', durationP50: 100, waitP50: 20 },
      { name: 'unit', durationP50: 600, waitP50: 30 },
      { name: 'ci', durationP50: 5, waitP50: 5 },
    ]);
  });

  it('null duration/wait read as 0 (node is transparent, still traversable)', () => {
    const r = computeCriticalPath([
      n('build', [], null, null),
      n('unit', ['build'], 600, null),
      n('ci', ['unit'], null, null),
    ])!;
    expect(r.endToEndP50Secs).toBe(600);
    expect(r.path.map((s) => s.name)).toEqual(['build', 'unit', 'ci']);
    expect(r.path[0]).toEqual({ name: 'build', durationP50: 0, waitP50: 0 });
  });

  it('edges to unknown node names are ignored', () => {
    const r = computeCriticalPath([
      n('unit', ['not-in-input'], 600, null),
      n('ci', ['unit'], 10, null),
    ])!;
    expect(r.endToEndP50Secs).toBe(610);
    expect(r.path.map((s) => s.name)).toEqual(['unit', 'ci']);
  });

  it('cycle returns null', () => {
    expect(computeCriticalPath([
      n('a', ['b'], 10, null),
      n('b', ['a'], 10, null),
    ])).toBeNull();
  });

  it('disconnected node lands in offPath with slack = endToEnd − its finish', () => {
    const r = computeCriticalPath([
      n('long', [], 1000, null),
      n('lonely', [], 100, null),
    ])!;
    expect(r.endToEndP50Secs).toBe(1000);
    expect(r.path.map((s) => s.name)).toEqual(['long']);
    expect(r.offPath).toEqual([{ name: 'lonely', slackSecs: 900 }]);
  });

  it('offPath is sorted by ascending slack (lowest slack = most at risk first)', () => {
    const r = computeCriticalPath([
      n('build', [], 100, null),
      n('main', ['build'], 900, null),
      n('close', ['build'], 800, null),   // slack 100
      n('far', ['build'], 200, null),     // slack 700
      n('ci', ['main', 'close', 'far'], 10, null),
    ])!;
    expect(r.path.map((s) => s.name)).toEqual(['build', 'main', 'ci']);
    expect(r.offPath).toEqual([
      { name: 'close', slackSecs: 100 },
      { name: 'far', slackSecs: 700 },
    ]);
  });

  it('two parallel chains: every node of the losing chain gets the same slack', () => {
    // a1(300) → a2(300)  = 600 (critical)
    // b1(100) → b2(100)  = 200 → both slack 400
    const r = computeCriticalPath([
      n('a1', [], 300, null), n('a2', ['a1'], 300, null),
      n('b1', [], 100, null), n('b2', ['b1'], 100, null),
    ])!;
    expect(r.endToEndP50Secs).toBe(600);
    expect(r.path.map((s) => s.name)).toEqual(['a1', 'a2']);
    expect(r.offPath).toEqual([
      { name: 'b1', slackSecs: 400 },
      { name: 'b2', slackSecs: 400 },
    ]);
  });

  it('deterministic tie-break: equal-length branches pick by name', () => {
    const r1 = computeCriticalPath([
      n('build', [], 100, null),
      n('z-branch', ['build'], 500, null),
      n('a-branch', ['build'], 500, null),
      n('ci', ['z-branch', 'a-branch'], 10, null),
    ])!;
    expect(r1.path.map((s) => s.name)).toEqual(['build', 'a-branch', 'ci']);
    // ties report 0 slack for the unchosen twin (it could not grow at all)
    expect(r1.offPath).toEqual([{ name: 'z-branch', slackSecs: 0 }]);
  });
});
