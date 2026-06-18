// A Mutation is a 1:1 description of a structured pipeline edit; applyMutation
// dispatches it to the matching pure renderer. This is the uniform entry point
// the /candidate endpoint (Increment 2) projects a CandidateModel through.
// Increment 1b extends this union with the model-dependent ops (remove, shift-left).
import { renderTimeout, renderRunnerRoute, pinActionSha, addConcurrency, renderShiftLeft, renderRemoveCheck, type EditResult } from './render';

export type Mutation =
  | { op: 'timeout'; jobId: string; minutes: number }
  | { op: 'runner'; jobId: string; runsOn: string }
  | { op: 'pin-action'; usesRef: string; sha: string }
  | { op: 'concurrency'; group: string }
  | { op: 'shift-left'; jobId: string }
  | { op: 'remove'; jobId: string };

export function applyMutation(yamlText: string, m: Mutation): EditResult {
  switch (m.op) {
    case 'timeout': return renderTimeout(yamlText, m.jobId, m.minutes);
    case 'runner': return renderRunnerRoute(yamlText, m.jobId, m.runsOn);
    case 'pin-action': return pinActionSha(yamlText, m.usesRef, m.sha);
    case 'concurrency': return addConcurrency(yamlText, m.group);
    case 'shift-left': return renderShiftLeft(yamlText, m.jobId);
    case 'remove': return renderRemoveCheck(yamlText, m.jobId);
  }
}
