// Read-only pipeline DAG lanes (spec visual-editor §2.1, Increment 4 — first
// sub-step: layout → nodes). Lanes are protection tiers (columns); nodes are the
// checks that run there. Gating is shown COLOR-INDEPENDENTLY (the word is in the
// accessible name, never color alone — sibling spec §16 a11y). Drag-to-retier, the
// node inspector, and `needs:` edges are the next sub-steps.
import { useLayoutEffect, useRef, useState } from 'react';
import type { Lane, LaneNode } from './laneLayout';
// Strip raw `${{ … }}` GitHub-expression templates from the displayed node name +
// aria-label (shared with ModelView/Optimize) — display only; node.check stays the
// key for refs, test ids, and onSelect.
import { stripCheckTemplate } from '../../protectionModel';

function gatingWord(n: LaneNode): string {
  if (n.gates) return 'gate';
  if (n.conditional) return 'conditional';
  return 'advisory';
}

interface NodeProps {
  tierId: string; node: LaneNode; onSelect?: (check: string) => void; selected?: boolean; isDep?: boolean;
  nodeRef?: (check: string, el: HTMLElement | null) => void;
}

function CanvasNode({ tierId, node, onSelect, selected, isDep, nodeRef }: NodeProps) {
  const word = gatingWord(node);
  const cls = node.gates ? 'gate' : node.conditional ? 'conditional' : 'advisory';
  // The needs-DAG edge is shown by marking dependency nodes — color-independently:
  // the relationship is named in the accessible label, not signalled by colour alone.
  const depCls = isDep ? ' dep-highlight' : '';
  const depLabel = isDep ? ' — dependency of the selected check' : '';
  const display = stripCheckTemplate(node.check);
  const inner = (<>
    <span className="canvas-node-name">{display}</span>
    <span className="canvas-node-gate" aria-hidden="true">{word}</span>
  </>);
  // Keyboard-operable button is the accessible baseline (drag is a later enhancement).
  if (onSelect) {
    return (
      <li>
        <button type="button" ref={(el) => nodeRef?.(node.check, el)}
          className={`canvas-node n-${cls}${selected ? ' selected' : ''}${depCls}`}
          data-testid={`node-${tierId}-${node.check}`} aria-pressed={!!selected}
          aria-label={`${display} — ${word}${depLabel}`} onClick={() => onSelect(node.check)}>{inner}</button>
      </li>
    );
  }
  return (
    <li ref={(el) => nodeRef?.(node.check, el)} className={`canvas-node n-${cls}${depCls}`}
      data-testid={`node-${tierId}-${node.check}`} aria-label={`${display} — ${word}${depLabel}`}>{inner}</li>
  );
}

interface Edge { from: string; to: string; x1: number; y1: number; x2: number; y2: number }

export function PipelineCanvas({ lanes, onSelect, selected, highlightDeps }:
  { lanes: Lane[]; onSelect?: (check: string) => void; selected?: string; highlightDeps?: ReadonlySet<string> }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<Edge[]>([]);
  const setNodeRef = (check: string, el: HTMLElement | null) => {
    if (el) nodeEls.current.set(check, el); else nodeEls.current.delete(check);
  };

  // Draw literal needs-DAG arrows from each dependency to the selected node
  // (only the selected node's edges — drawing all of them would be spaghetti on a
  // 30+ node graph). Positions are measured relative to the canvas after layout.
  const depsKey = highlightDeps ? [...highlightDeps].sort().join('|') : '';
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!selected || !highlightDeps || highlightDeps.size === 0 || !wrap) { setEdges([]); return; }
    const target = nodeEls.current.get(selected);
    if (!target) { setEdges([]); return; }
    const w = wrap.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const tx = t.left - w.left + t.width / 2, ty = t.top - w.top + t.height / 2;
    const next: Edge[] = [];
    for (const dep of highlightDeps) {
      const el = nodeEls.current.get(dep);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      next.push({ from: dep, to: selected, x1: r.left - w.left + r.width / 2, y1: r.top - w.top + r.height / 2, x2: tx, y2: ty });
    }
    setEdges(next);
  }, [selected, depsKey, lanes]);

  const total = lanes.reduce((n, l) => n + l.nodes.length, 0);
  if (total === 0) return <div className="pipeline-canvas empty" role="status">No checks to lay out yet.</div>;
  return (
    <div className="pipeline-canvas" data-testid="pipeline-canvas" ref={wrapRef} role="group" aria-label="Pipeline lanes">
      <svg className="canvas-edges" aria-hidden="true">
        <defs>
          <marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--accent, #6af)" />
          </marker>
        </defs>
        {edges.map((e) => (
          <line key={`${e.from}->${e.to}`} data-edge={`${e.from}->${e.to}`}
            x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} markerEnd="url(#dag-arrow)" />
        ))}
      </svg>
      {lanes.map((lane) => (
        <section key={lane.tierId} className="canvas-lane" data-testid={`lane-${lane.tierId}`} aria-label={`${lane.label} tier`}>
          <header className="canvas-lane-head">
            <span className="canvas-lane-label">{lane.label}</span>
            <span className="canvas-lane-event">{lane.event}</span>
          </header>
          <ul className="canvas-lane-nodes" role="list">
            {lane.nodes.map((n) => <CanvasNode key={n.check} tierId={lane.tierId} node={n} nodeRef={setNodeRef}
              onSelect={onSelect} selected={selected === n.check} isDep={highlightDeps?.has(n.check) && selected !== n.check} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}
