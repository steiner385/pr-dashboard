// Queue-stall incident playbook (spec 001, Group K1 / FR-038). Pure: detect a
// stalled merge queue from the live state (a conflicting culprit blocking entries
// behind it) and emit GUIDED recovery steps grounded in how the queue actually
// behaves — the cascade-blocked PRs clear once the culprit leaves; they must NOT
// be told to rebase (a known footgun). A playbook + buttons, not a stateful engine.
import type { DashboardState } from '../../types';

export interface QueueIncident {
  repo: string;
  culprit: number | null;     // the front-most genuine conflict blocking the queue
  blockedCount: number;       // cascade-blocked entries behind it
  steps: string[];
}

export function queueIncidents(state: DashboardState): QueueIncident[] {
  const out: QueueIncident[] = [];
  for (const r of state.repos) {
    const q = r.queue;
    if (!q) continue;
    const culprit = q.unmergeableCulprit ?? (q.unmergeable.length ? q.unmergeable[0] : null);
    const blockedCount = q.queueBlocked?.length ?? 0;
    if (culprit == null && blockedCount === 0) continue; // queue healthy
    const steps: string[] = [];
    if (culprit != null) {
      steps.push(`PR #${culprit} is conflicting with the base (DIRTY) and is blocking the queue — rebase #${culprit} against the base branch.`);
    }
    if (blockedCount > 0) {
      steps.push(`${blockedCount} PR${blockedCount === 1 ? '' : 's'} behind it ${blockedCount === 1 ? 'is' : 'are'} cascade-blocked — do NOT rebase ${blockedCount === 1 ? 'it' : 'them'}; ${blockedCount === 1 ? 'it' : 'they'} will clear automatically once the culprit merges or leaves the queue.`);
    }
    steps.push('If the queue is still wedged after the culprit clears, dequeue + re-arm auto-merge on the head candidate.');
    out.push({ repo: r.repo, culprit, blockedCount, steps });
  }
  return out;
}
