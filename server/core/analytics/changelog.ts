// Pipeline changelog + action audit (spec 001, Group L / FR-039). Pure formatters
// over (a) CI config-change rows — the existing `config_changes` history — and
// (b) the tool's own action log (draft PRs / prompts it produced). The audit log
// is a TRUST artifact (what did this tool do to my repos?) so it must outlive the
// rolling telemetry retention — callers persist it separately (see review I-4).
export interface ChangelogRow { at: string; kind: string; summary: string; actor?: string }
export interface ChangelogEntry { at: string; kind: string; summary: string; actor: string }

export interface AuditRow { at: string; action: string; repo: string; target?: string; result?: string }
export interface AuditEntry extends AuditRow { actor: 'workspace' }

/** Newest-first, de-duplicated (same at+summary), capped. */
export function buildChangelog(rows: readonly ChangelogRow[], limit = 50): ChangelogEntry[] {
  const seen = new Set<string>();
  const out: ChangelogEntry[] = [];
  for (const r of [...rows].sort((a, b) => b.at.localeCompare(a.at))) {
    const key = `${r.at}|${r.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at: r.at, kind: r.kind, summary: r.summary, actor: r.actor ?? 'unknown' });
    if (out.length >= limit) break;
  }
  return out;
}

/** The tool's action audit log, newest-first. Every entry is attributed to the
 *  workspace itself (it records what the tool suggested/opened). */
export function buildAuditLog(rows: readonly AuditRow[], limit = 100): AuditEntry[] {
  return [...rows]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((r) => ({ ...r, actor: 'workspace' as const }));
}
