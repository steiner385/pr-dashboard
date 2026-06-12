/**
 * Critical-path analysis over the derived needs DAG (issue #42).
 *
 * v1 computes the SINGLE expected path from per-node medians — node weight =
 * median runner-pickup wait + median duration — via the standard CPM
 * topological longest-path, plus per-node slack for everything off the path
 * ("bats-tests could grow 11m before mattering"). Per-run historical
 * attribution (which path each ACTUAL run took, on-path probability per node)
 * is a v2: it needs per-run joined timelines, not just medians.
 *
 * Pure module: callers (metrics.ts) resolve graphs and history reads; this
 * file only does graph math.
 */

export interface CriticalPathNodeInput {
  /** Graph node name (the derived display-name prefix). */
  name: string;
  /** Names of prerequisite nodes. Edges to names absent from the input are
   *  ignored (e.g. needs on jobs filtered out by event activity). */
  needs: string[];
  /** Median observed duration, seconds. Null = no data → weighs 0 (the node
   *  stays traversable so the chain through it is preserved). */
  durationP50: number | null;
  /** Median runner-pickup wait, seconds. Null = no data → weighs 0. */
  waitP50: number | null;
}

export interface CriticalPathStep {
  name: string;
  /** Median duration in seconds (0 when unobserved). */
  durationP50: number;
  /** Median pickup wait in seconds (0 when unobserved). */
  waitP50: number;
}

export interface CriticalPathResult {
  /** Expected end-to-end wall clock: the longest (wait+duration) chain, seconds. */
  endToEndP50Secs: number;
  /** The expected critical path, root → sink. */
  path: CriticalPathStep[];
  /** Every node NOT on the path with its CPM slack (how many seconds it could
   *  grow before joining the path), ascending slack — lowest slack first. */
  offPath: { name: string; slackSecs: number }[];
}

/** Node weight: unobserved wait/duration reads as 0. */
const weightOf = (n: CriticalPathNodeInput): number => (n.waitP50 ?? 0) + (n.durationP50 ?? 0);

/**
 * Standard CPM forward/backward pass. Returns null for an empty input or a
 * cyclic graph (a needs cycle can't be topologically ordered — GitHub would
 * reject the workflow, but a corrupt persisted graph must not throw here).
 */
export function computeCriticalPath(nodes: CriticalPathNodeInput[]): CriticalPathResult | null {
  if (nodes.length === 0) return null;
  const byName = new Map(nodes.map((n) => [n.name, n]));

  // Kahn topological order over the known-edge subgraph (unknown needs ignored).
  const needsOf = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    const known = n.needs.filter((d) => d !== n.name && byName.has(d));
    needsOf.set(n.name, known);
    for (const d of known) dependents.set(d, [...(dependents.get(d) ?? []), n.name]);
  }
  const indegree = new Map(nodes.map((n) => [n.name, needsOf.get(n.name)!.length]));
  const ready = nodes.filter((n) => indegree.get(n.name) === 0).map((n) => n.name);
  const order: string[] = [];
  while (ready.length) {
    const name = ready.shift()!;
    order.push(name);
    for (const dep of dependents.get(name) ?? []) {
      const left = indegree.get(dep)! - 1;
      indegree.set(dep, left);
      if (left === 0) ready.push(dep);
    }
  }
  if (order.length !== nodes.length) return null; // cycle

  // Forward pass: earliest finish = own weight + max over needs' earliest finish.
  const earliestFinish = new Map<string, number>();
  for (const name of order) {
    const upstream = Math.max(0, ...needsOf.get(name)!.map((d) => earliestFinish.get(d)!));
    earliestFinish.set(name, upstream + weightOf(byName.get(name)!));
  }
  const endToEndP50Secs = Math.max(...earliestFinish.values());

  // Backward pass: latest finish = min over dependents of (their LF − their
  // weight); sinks finish at the project end. Slack = LF − EF.
  const latestFinish = new Map<string, number>();
  for (const name of [...order].reverse()) {
    const deps = dependents.get(name) ?? [];
    latestFinish.set(name, deps.length === 0 ? endToEndP50Secs
      : Math.min(...deps.map((d) => latestFinish.get(d)! - weightOf(byName.get(d)!))));
  }

  // The expected path: backtrack from the deepest sink through the need with
  // the max earliest finish. Name-ascending tie-breaks keep the output stable
  // across runs (Map iteration order is insertion order, not guaranteed input).
  const argmax = (names: string[]): string => names.reduce((best, n) => {
    const diff = earliestFinish.get(n)! - earliestFinish.get(best)!;
    return diff > 0 || (diff === 0 && n < best) ? n : best;
  });
  const pathNames: string[] = [];
  let cursor: string | null = argmax([...earliestFinish.keys()]);
  while (cursor != null) {
    pathNames.unshift(cursor);
    const needs: string[] = needsOf.get(cursor)!;
    cursor = needs.length ? argmax(needs) : null;
  }
  const onPath = new Set(pathNames);

  return {
    endToEndP50Secs,
    path: pathNames.map((name) => {
      const n = byName.get(name)!;
      return { name, durationP50: n.durationP50 ?? 0, waitP50: n.waitP50 ?? 0 };
    }),
    offPath: nodes
      .filter((n) => !onPath.has(n.name))
      .map((n) => ({ name: n.name, slackSecs: latestFinish.get(n.name)! - earliestFinish.get(n.name)! }))
      .sort((a, b) => a.slackSecs - b.slackSecs || a.name.localeCompare(b.name)),
  };
}
