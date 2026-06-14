import { describe, it, expect } from 'vitest';
import { layoutNeedsGraph, type GraphNodeInput } from '../needsLayout';

const node = (name: string, needs: string[], over: Partial<GraphNodeInput> = {}): GraphNodeInput => ({
  name, needs, durationP50: 60, waitP50: 0, onCriticalPath: false, slackSecs: null, ...over });

describe('layoutNeedsGraph', () => {
  it('assigns layers by longest path from a root (diamond)', () => {
    // a → b → d ; a → c → d
    const L = layoutNeedsGraph([
      node('a', []), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c']),
    ]);
    const layer = Object.fromEntries(L.nodes.map((n) => [n.name, n.layer]));
    expect(layer).toEqual({ a: 0, b: 1, c: 1, d: 2 });
  });

  it('drops edges to unknown needs and never hangs on a cycle', () => {
    const L = layoutNeedsGraph([
      node('a', ['ghost']),     // unknown need dropped → a is a root
      node('b', ['a', 'b']),    // self-reference: cycle guard must not hang
    ]);
    expect(L.nodes.find((n) => n.name === 'a')!.layer).toBe(0);
    expect(L.edges.some((e) => e.from === 'ghost')).toBe(false);
    expect(L.nodes).toHaveLength(2);
  });

  it('emits one edge per known need, left→right, flagging cp edges when both ends are on-path', () => {
    const L = layoutNeedsGraph([
      node('a', [], { onCriticalPath: true }),
      node('b', ['a'], { onCriticalPath: true }),
      node('c', ['a'], { onCriticalPath: false }),
    ]);
    expect(L.edges.find((e) => e.from === 'a' && e.to === 'b')!.onCriticalPath).toBe(true);
    expect(L.edges.find((e) => e.from === 'a' && e.to === 'c')!.onCriticalPath).toBe(false);
    expect(L.nodes.find((n) => n.name === 'b')!.x)
      .toBeGreaterThan(L.nodes.find((n) => n.name === 'a')!.x);   // dependent is to the right
  });

  it('orders critical-path nodes first within a layer', () => {
    const L = layoutNeedsGraph([
      node('a', []),
      node('z-cp', ['a'], { onCriticalPath: true }),  // sorts after 'b' by name…
      node('b', ['a'], { onCriticalPath: false }),
    ]);
    expect(L.nodes.find((n) => n.name === 'z-cp')!.row).toBe(0);   // …but cp wins the top row
    expect(L.nodes.find((n) => n.name === 'b')!.row).toBe(1);
  });
});
