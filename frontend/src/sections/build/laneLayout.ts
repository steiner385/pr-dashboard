// The pipeline canvas's data foundation (spec visual-editor §2.1, Increment 4):
// project the DerivedModel into deterministic tier-lanes, each carrying the checks
// that actually RUN at that tier (from the cell intent), with gating/conditional
// flagged. Pure — testable without the DOM. Intra-tier `needs:` edges are not yet
// serialized on the model (a backend follow-on); this lays out lanes + nodes.
import type { DerivedModelLike } from '../optimize/types';

export interface LaneNode { check: string; gates: boolean; conditional: boolean }
export interface Lane { tierId: string; label: string; event: string; nodes: LaneNode[] }

export function laneLayout(model: DerivedModelLike): Lane[] {
  return model.tiers.map((t) => ({
    tierId: t.id,
    label: t.label,
    event: t.event,
    nodes: model.cells
      .filter((c) => c.tierId === t.id && c.intent.runs)
      .map((c) => ({ check: c.check, gates: c.intent.gates, conditional: c.intent.conditional }))
      .sort((a, b) => a.check.localeCompare(b.check)),
  }));
}
