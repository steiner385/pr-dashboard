import { memo } from 'react';
import type { Lane } from '../types';
import { LANE_GLYPH, LANE_WORD } from './laneStatus';

interface Props { lane: Lane; expanded: boolean; onToggle: () => void; }

function CostChip({ lane }: { lane: Lane }) {
  if (!lane.costChip) return null;
  return <span className="spine-cost" aria-hidden="true">${lane.costChip.dollars}·{lane.costChip.days}d</span>;
}

function SpineLaneInner({ lane, expanded, onToggle }: Props) {
  const panelId = `spine-panel-${lane.id}`;
  const glyph = <span className={`spine-glyph s-${lane.status}`} aria-hidden="true">{LANE_GLYPH[lane.status]}</span>;
  const word = LANE_WORD[lane.status];
  const body = (
    <>
      {glyph}
      <span className="spine-title">{lane.title}</span>
      <span className="spine-summary">{lane.summary}</span>
      <CostChip lane={lane} />
      {lane.efficiencyChip && <span className="spine-effic" aria-hidden="true">{lane.efficiencyChip}</span>}
    </>
  );

  if (lane.wiredness === 'not-wired') {
    return <li className="spine-lane not-wired" data-testid={`spine-lane-${lane.id}`}>{body}</li>;
  }

  return (
    <li className="spine-lane" data-testid={`spine-lane-${lane.id}`}>
      <button type="button" className="spine-lane-btn" aria-expanded={expanded} aria-controls={panelId}
        aria-label={`${lane.title} — ${word}: ${lane.summary}`} onClick={onToggle}>
        {body}
        <span className="spine-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {/* Lazy panel body: the panel div (aria-controls target) is always in the
          DOM so the reference resolves (WCAG 4.1.2), but its drill-down content
          only mounts when expanded — a collapsed lane must not leak its PR rows
          into the document (they would duplicate the main list's rows and their
          `pr-{n}` ids, and surface under unrelated tabs/filters). */}
      <div id={panelId} className="spine-panel" hidden={!expanded}>
        {expanded && lane.renderExpanded()}
      </div>
    </li>
  );
}

export const SpineLane = memo(SpineLaneInner);
