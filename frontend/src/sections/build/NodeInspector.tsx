// The canvas node inspector (spec visual-editor §2.1 — "click a node → form").
// Keyboard-operable buttons compose structured mutations for the selected check
// into the BuildView mutation stack. This is the accessible authoring path; the
// `if:` predicate builder + runner dropdown are richer follow-ons.
import type { CandidateMutationDto } from '../../shell/workspaceApi';

const DEFAULT_TIMEOUT = 15;

export interface NodeInspectorProps {
  check: string;
  jobId: string;
  needs?: string[];
  onApply: (m: CandidateMutationDto) => void;
}

export function NodeInspector({ check, jobId, needs, onApply }: NodeInspectorProps) {
  return (
    <section className="node-inspector" aria-label={`Edit ${check}`}>
      <h3 className="node-inspector-title">Edit <code>{check}</code></h3>
      {needs && needs.length > 0 && (
        <p className="node-inspector-needs">Depends on (needs): {needs.join(', ')}</p>
      )}
      <div className="node-inspector-ops">
        <button type="button" onClick={() => onApply({ op: 'timeout', jobId, minutes: DEFAULT_TIMEOUT })}>Add timeout</button>
        <button type="button" onClick={() => onApply({ op: 'shift-left', jobId })}>Shift-left</button>
        <button type="button" onClick={() => onApply({ op: 'remove', jobId })}>Remove</button>
      </div>
    </section>
  );
}
