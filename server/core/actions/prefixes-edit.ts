// The governed requiredCheckPrefixes edit (spec roadmap 4.5). The lever's act for
// a per-repo config knob is a draft PR that writes requiredCheckPrefixes into the
// repo's `.pr-dashboard.yml` — a single repo file, so the existing single-file
// draft-PR path applies. Pure: read-merge (preserve every other key) + derive the
// merge_group check set from the model; the router wires the read/open clients.
import { parse, stringify } from 'yaml';
import type { DerivedModel } from '../../pipeline-model/derived';

/** Set requiredCheckPrefixes on the repo's `.pr-dashboard.yml`, preserving every
 *  other key (deploy, batchSize, …). `currentYaml` is null/empty for a new file. */
export function mergePrefixesIntoConfig(currentYaml: string | null, prefixes: readonly string[]): string {
  let doc: Record<string, unknown> = {};
  if (currentYaml && currentYaml.trim()) {
    const parsed = parse(currentYaml);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
  }
  doc.requiredCheckPrefixes = [...prefixes];
  return stringify(doc);
}

/** The distinct checks that actually run at the merge_group tier — the source for
 *  the suggested prefixes (these are the gate candidates the queue evaluates). */
export function mergeGroupCheckNames(model: DerivedModel): string[] {
  const mgTier = model.tiers.find((t) => t.event === 'merge_group');
  if (!mgTier) return [];
  const names = new Set<string>();
  for (const c of model.cells) if (c.tierId === mgTier.id && c.intent.runs) names.add(c.check);
  return [...names];
}
