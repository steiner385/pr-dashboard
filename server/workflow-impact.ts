import type { CiGraph } from './required-checks';

/**
 * Workflow-change impact annotation (issue #49): human-readable summary of how
 * a PR's head-blob ci.yml derivation differs from the repo's current
 * main-derived graph. Catches the stale-workflow / bogus-required-check
 * failure mode at review time instead of merge time.
 */
export interface WorkflowImpact {
  /** Human lines, e.g. `+ android-smoke joins the merge_group gate`. */
  summary: string[];
}

const fmtTimeout = (m: number | null): string => (m == null ? 'unset' : `${m}m`);

/**
 * Diff two derived CI graphs (base = current main, head = the PR's blob).
 * Reports, in order:
 *  - jobs joining / leaving the rollup closure (the merge_group gate)
 *  - the required-check set size delta when the closure size changed
 *  - `timeout-minutes` changes on jobs present in both closures
 * Returns null when nothing changed — the caller renders no card.
 */
export function diffCiGraphs(base: CiGraph, head: CiGraph): WorkflowImpact | null {
  const summary: string[] = [];
  const basePrefixes = new Set(base.prefixes);
  const headPrefixes = new Set(head.prefixes);
  for (const p of head.prefixes) {
    if (!basePrefixes.has(p)) summary.push(`+ ${p} joins the merge_group gate`);
  }
  for (const p of base.prefixes) {
    if (!headPrefixes.has(p)) summary.push(`− ${p} leaves the merge_group gate`);
  }
  if (headPrefixes.size !== basePrefixes.size) {
    const delta = headPrefixes.size - basePrefixes.size;
    summary.push(`required-check set ${delta > 0 ? 'grows' : 'shrinks'} by ${Math.abs(delta)}: `
      + `${basePrefixes.size} → ${headPrefixes.size} checks`);
  }
  for (const [prefix, headNode] of head.nodes) {
    const baseNode = base.nodes.get(prefix);
    if (!baseNode) continue; // joins-the-gate line already covers it
    if (baseNode.timeoutMinutes !== headNode.timeoutMinutes) {
      summary.push(`${prefix} timeout-minutes ${fmtTimeout(baseNode.timeoutMinutes)} → ${fmtTimeout(headNode.timeoutMinutes)}`);
    }
  }
  return summary.length ? { summary } : null;
}
