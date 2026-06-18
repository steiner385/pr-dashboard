// CI security & supply-chain auditor (spec 001, Group M / FR-040). Pure, parse-
// based, per-finding CONFIDENCE (the architect review flagged real blind spots:
// permissions inherit workflow→job, unpinned detection can't see through reusable
// workflows / interpolated refs). So findings are advisory with stated confidence,
// never "100% correct" — see SC-016 ("100% scanned with per-finding confidence").
import { parse } from 'yaml';

export type SecurityKind = 'pull_request_target' | 'broad-permissions' | 'unpinned-action';
export interface SecurityFinding {
  file: string; jobId?: string; kind: SecurityKind; detail: string;
  confidence: 'high' | 'medium' | 'low';
}

const SHA40 = /^[0-9a-f]{40}$/i;

/** Is a `uses:` ref pinned to a full commit SHA? (local paths/reusable are exempt) */
function isPinned(uses: string): boolean {
  if (uses.startsWith('./') || uses.startsWith('.\\')) return true; // local/reusable workflow
  if (uses.includes('${{')) return false;                           // interpolated — can't verify → treat unpinned
  const at = uses.lastIndexOf('@');
  if (at < 0) return false;
  return SHA40.test(uses.slice(at + 1));
}

function hasWriteScope(perms: unknown): 'all' | 'some' | null {
  if (perms === 'write-all') return 'all';
  if (perms && typeof perms === 'object') {
    const vals = Object.values(perms as Record<string, unknown>);
    if (vals.some((v) => v === 'write')) return 'some';
  }
  return null;
}

/** Audit one workflow file's YAML text. Returns findings (empty = clean to the
 *  extent statically visible). `file` is the bare filename for provenance. */
export function auditWorkflowSecurity(yamlText: string, file: string): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  let doc: Record<string, unknown>;
  try { doc = (parse(yamlText) ?? {}) as Record<string, unknown>; }
  catch { return out; } // unparseable → nothing to assert (the deriver flags low-confidence elsewhere)

  // 1. pull_request_target (high confidence — it's a literal trigger key)
  const on = doc.on;
  const onKeys = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
  if (onKeys.includes('pull_request_target')) {
    out.push({ file, kind: 'pull_request_target', confidence: 'high',
      detail: 'workflow triggers on pull_request_target — runs with write token + secrets on fork PRs' });
  }

  // 2. broad permissions — workflow level (medium: job-level may narrow it) + write-all (high)
  const top = hasWriteScope(doc.permissions);
  if (top === 'all') out.push({ file, kind: 'broad-permissions', confidence: 'high', detail: 'permissions: write-all at workflow level' });
  else if (top === 'some') out.push({ file, kind: 'broad-permissions', confidence: 'medium', detail: 'workflow-level write permission(s) — jobs inherit unless narrowed' });

  // 3. unpinned actions + per-job permission scan
  const jobs = (doc.jobs && typeof doc.jobs === 'object') ? doc.jobs as Record<string, Record<string, unknown>> : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    const jobPerm = hasWriteScope(job?.permissions);
    if (jobPerm === 'all') out.push({ file, jobId, kind: 'broad-permissions', confidence: 'high', detail: `job "${jobId}" sets permissions: write-all` });
    const steps = Array.isArray(job?.steps) ? job.steps as Record<string, unknown>[] : [];
    for (const step of steps) {
      const uses = step?.uses;
      if (typeof uses === 'string' && !isPinned(uses)) {
        out.push({ file, jobId, kind: 'unpinned-action', confidence: uses.includes('${{') ? 'low' : 'medium',
          detail: `action "${uses}" is not pinned to a commit SHA` });
      }
    }
  }
  return out;
}
