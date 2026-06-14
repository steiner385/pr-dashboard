import { useMemo, useState } from 'react';
import { layoutNeedsGraph, type GraphNodeInput } from './needsLayout';

/** Interactive needs-DAG (issue #74): a pure-SVG layered graph of the CI
 *  workflow's `needs:` edges, overlaying each node's observed p50 duration +
 *  runner wait, with the critical path highlighted. Hovering/focusing a node
 *  dims everything not incident to it. Responsive via viewBox (scales to its
 *  container; readable on mobile). */
export function NeedsGraph({ nodes, formatDur }: {
  nodes: GraphNodeInput[];
  formatDur: (secs: number) => string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const layout = useMemo(() => layoutNeedsGraph(nodes), [nodes]);
  const pad = 10;

  // A node is "lit" when nothing is hovered, it IS the hovered node, or it's a
  // direct neighbor (edge incident to the hovered node).
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of layout.edges) {
      (m.get(e.from) ?? m.set(e.from, new Set()).get(e.from)!).add(e.to);
      (m.get(e.to) ?? m.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
    return m;
  }, [layout.edges]);
  const lit = (name: string) =>
    active == null || active === name || !!neighbors.get(active)?.has(name);
  const edgeLit = (from: string, to: string) =>
    active == null || active === from || active === to;

  const trunc = (s: string) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);

  return (
    <svg className="needs-graph"
      viewBox={`${-pad} ${-pad} ${layout.width + 2 * pad} ${layout.height + 2 * pad}`}
      role="img" aria-label="CI needs graph — nodes are jobs, edges are needs dependencies, the critical path is highlighted">
      <defs>
        <marker id="ng-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" className="ng-arrow-head" />
        </marker>
      </defs>
      {layout.edges.map((e, i) => (
        <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
          markerEnd="url(#ng-arrow)"
          className={`ng-edge${e.onCriticalPath ? ' cp' : ''}${edgeLit(e.from, e.to) ? '' : ' dim'}`} />
      ))}
      {layout.nodes.map((n) => {
        const detail = `${n.name}\n`
          + (n.durationP50 != null ? `run ${formatDur(n.durationP50)}` : 'no duration data')
          + (n.waitP50 ? ` · wait ${formatDur(n.waitP50)}` : '')
          + (n.onCriticalPath ? ' · on critical path'
            : n.slackSecs != null ? ` · slack ${formatDur(n.slackSecs)}` : '');
        return (
          <g key={n.name}
            className={`ng-node${n.onCriticalPath ? ' cp' : ''}${lit(n.name) ? '' : ' dim'}`}
            data-testid={`ng-node-${n.name}`}
            tabIndex={0} role="group" aria-label={detail.replace('\n', ': ')}
            onMouseEnter={() => setActive(n.name)} onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(n.name)} onBlur={() => setActive(null)}>
            <title>{detail}</title>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={5} className="ng-rect" />
            <text x={n.x + 9} y={n.y + 17} className="ng-name">{trunc(n.name)}</text>
            <text x={n.x + 9} y={n.y + 32} className="ng-metric">
              {n.durationP50 != null ? formatDur(n.durationP50) : '—'}
              {n.waitP50 ? ` +${formatDur(n.waitP50)} wait` : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
