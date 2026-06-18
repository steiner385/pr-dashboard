// Collapse sharded check fan-out (roadmap 2.3) — a matrix/list shouldn't show 8
// near-identical "… (shard n/8)" rows. Pure: groups checks sharing a base into one
// shard group (≥2 members), passing everything else through as a single. Reused by
// the Model matrix and the WS3 Model&Edit merge.

/** Matches a trailing shard suffix: "(shard 1/8)", "(shard 1 of 8)", or "(1/2)". */
const SHARD = /\s*\((?:shard\s+)?\d+\s*(?:\/|of)\s*\d+\)\s*$/i;

export type ShardRow = { kind: 'single'; check: string } | { kind: 'shard'; base: string; members: string[] };

function baseOf(check: string): string | null {
  return SHARD.test(check) ? check.replace(SHARD, '').trim() : null;
}

export function groupShards(checks: string[]): ShardRow[] {
  const out: ShardRow[] = [];
  const groups = new Map<string, number>(); // base → index in `out`
  for (const check of checks) {
    const base = baseOf(check);
    if (base == null) { out.push({ kind: 'single', check }); continue; }
    const at = groups.get(base);
    if (at == null) {
      groups.set(base, out.length);
      out.push({ kind: 'shard', base, members: [check] });
    } else {
      (out[at] as { members: string[] }).members.push(check);
    }
  }
  // a lone shard isn't worth a group — demote it to a single
  return out.map((r) => (r.kind === 'shard' && r.members.length === 1 ? { kind: 'single', check: r.members[0] } : r));
}
