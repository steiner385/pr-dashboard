/** Pure layered (Sugiyama-lite) layout for the CI needs-DAG (issue #74). No
 *  graph-layout deps: assign each node to a layer by its longest path from a
 *  root, order within the layer (critical-path nodes first), and place left to
 *  right. Kept separate from the SVG component so the geometry is unit-testable. */

export interface GraphNodeInput {
  name: string;
  needs: string[];
  durationP50: number | null;
  waitP50: number | null;
  onCriticalPath: boolean;
  slackSecs: number | null;
}

export interface LaidNode extends GraphNodeInput {
  layer: number; row: number; x: number; y: number; w: number; h: number;
}
export interface LaidEdge {
  from: string; to: string;
  x1: number; y1: number; x2: number; y2: number; onCriticalPath: boolean;
}
export interface NeedsLayout { nodes: LaidNode[]; edges: LaidEdge[]; width: number; height: number; }

export const NODE_W = 156;
export const NODE_H = 42;
const COL_GAP = 64;
const ROW_GAP = 14;

export function layoutNeedsGraph(input: GraphNodeInput[]): NeedsLayout {
  const byName = new Map(input.map((n) => [n.name, n]));
  const known = (needs: string[]): string[] => needs.filter((n) => byName.has(n));

  // layer(node) = longest path from a root = 1 + max(layer of known needs).
  // Memoized DFS with a visiting-set cycle guard (a corrupt graph can't hang it).
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (name: string): number => {
    const cached = layer.get(name);
    if (cached != null) return cached;
    if (visiting.has(name)) return 0;             // back-edge → break the cycle
    visiting.add(name);
    const needs = known(byName.get(name)?.needs ?? []);
    const l = needs.length === 0 ? 0 : 1 + Math.max(...needs.map(layerOf));
    visiting.delete(name);
    layer.set(name, l);
    return l;
  };
  for (const n of input) layerOf(n.name);

  // Bucket by layer; within a layer, critical-path nodes first then by name.
  const layers = new Map<number, GraphNodeInput[]>();
  for (const n of input) {
    const l = layer.get(n.name)!;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(n);
  }

  const laid = new Map<string, LaidNode>();
  let maxRows = 0;
  for (const [l, group] of [...layers].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) =>
      Number(b.onCriticalPath) - Number(a.onCriticalPath) || a.name.localeCompare(b.name));
    group.forEach((n, row) => {
      laid.set(n.name, { ...n, layer: l, row, w: NODE_W, h: NODE_H,
        x: l * (NODE_W + COL_GAP), y: row * (NODE_H + ROW_GAP) });
    });
    maxRows = Math.max(maxRows, group.length);
  }

  const edges: LaidEdge[] = [];
  for (const n of input) {
    const to = laid.get(n.name)!;
    for (const need of known(n.needs)) {
      const from = laid.get(need)!;
      edges.push({ from: need, to: n.name,
        x1: from.x + from.w, y1: from.y + from.h / 2,
        x2: to.x, y2: to.y + to.h / 2,
        // a path edge connects two consecutive critical-path nodes; both-on-path
        // is the visual heuristic (the path is a single chain).
        onCriticalPath: from.onCriticalPath && to.onCriticalPath });
    }
  }

  const maxLayer = Math.max(0, ...[...layers.keys()]);
  const width = (maxLayer + 1) * NODE_W + maxLayer * COL_GAP;
  const height = Math.max(NODE_H, maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP);
  return { nodes: [...laid.values()], edges, width, height };
}
