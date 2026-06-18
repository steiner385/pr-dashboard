// The requiredCheckPrefixes lever (spec roadmap 4.5). When a repo has no
// requiredCheckPrefixes configured, every failed merge_group run reads as
// advisory noise — real gate failures can't be separated. This suggests a
// starting set of prefixes from the OBSERVED merge_group check names: each
// check's leading distinguishing segment (the reusable-workflow caller before
// " / ", else the top-level job name before ": "), deduped. Prefix-matching is
// inclusive, so the operator refines from here. Pure + dependency-free.

/** Suggest requiredCheckPrefixes from observed merge_group check names. */
export function suggestRequiredPrefixes(checkNames: readonly string[]): string[] {
  const prefixes = new Set<string>();
  for (const name of checkNames) {
    const trimmed = (name ?? '').trim();
    if (!trimmed) continue;
    const slash = trimmed.indexOf(' / ');
    let prefix: string;
    if (slash >= 0) {
      prefix = trimmed.slice(0, slash);
    } else {
      const colon = trimmed.indexOf(': ');
      prefix = colon >= 0 ? trimmed.slice(0, colon) : trimmed;
    }
    prefix = prefix.trim();
    if (prefix) prefixes.add(prefix);
  }
  return [...prefixes].sort();
}
