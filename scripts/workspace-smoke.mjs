#!/usr/bin/env node
// Token-backed boot smoke for the unified workspace (spec 001, step-5 live tier).
// AUTHORED, run-by-the-operator: it needs a RUNNING server (WORKSPACE_IDE=1) and,
// if the instance requires auth, a cookie — inputs not available in the build env.
//
//   WORKSPACE_IDE=1 pnpm start        # in one shell
//   BASE=http://localhost:3000 REPO=cairnea/KinDash \
//   AUTH_COOKIE='auth_token=…' node scripts/workspace-smoke.mjs
//
// Exits 0 if every workspace endpoint responds < 400 with the expected shape; 1 otherwise.
// The pure pass/fail logic (summarize) is unit-tested in
// server/core/__tests__/workspace-smoke.test.ts; the fetch runner is the live part.

/** Pure: given probe results, decide pass/fail + a human summary. Unit-tested. */
export function summarize(results) {
  const failures = results.filter((r) => !r.ok);
  return {
    pass: failures.length === 0,
    total: results.length,
    failed: failures.length,
    lines: results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`),
  };
}

async function probe(name, fn) {
  try { return { name, ...(await fn()) }; }
  catch (e) { return { name, ok: false, detail: e instanceof Error ? e.message : String(e) }; }
}

async function main() {
  const BASE = process.env.BASE ?? 'http://localhost:3000';
  const REPO = process.env.REPO ?? 'cairnea/KinDash';
  const headers = process.env.AUTH_COOKIE ? { cookie: process.env.AUTH_COOKIE } : {};
  const json = async (path, init) => {
    const res = await fetch(`${BASE}/api/workspace${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const q = encodeURIComponent(REPO);

  const results = await Promise.all([
    probe('GET /self (O)', async () => { const r = await json('/self'); return { ok: r.status < 400 && 'status' in r.body, detail: `status=${r.status} health=${r.body.status}` }; }),
    probe('GET /pipeline (C/G)', async () => { const r = await json(`/pipeline?repo=${q}`); return { ok: r.status < 400 && !!r.body.model, detail: `status=${r.status} sha=${r.body.sourceSha ?? '—'}` }; }),
    probe('GET /security (M)', async () => { const r = await json(`/security?repo=${q}`); return { ok: r.status < 400 && Array.isArray(r.body.findings), detail: `status=${r.status} findings=${r.body.findings?.length}` }; }),
    probe('GET /ruleset (I1)', async () => { const r = await json(`/ruleset?repo=${q}`); return { ok: r.status < 400 && 'readable' in r.body, detail: `status=${r.status} readable=${r.body.readable}` }; }),
    probe('GET /forecast (J1)', async () => { const r = await json(`/forecast?repo=${q}`); return { ok: r.status < 400 && 'available' in r.body, detail: `status=${r.status} available=${r.body.available}` }; }),
    probe('GET /budgets (J2/J3)', async () => { const r = await json('/budgets'); return { ok: r.status < 400 && Array.isArray(r.body.gauges), detail: `status=${r.status} gauges=${r.body.gauges?.length}` }; }),
    probe('GET /policy (I2)', async () => { const r = await json(`/policy?repo=${q}`); return { ok: r.status < 400 && Array.isArray(r.body.violations), detail: `status=${r.status}` }; }),
    probe('GET /changelog (L)', async () => { const r = await json(`/changelog?repo=${q}`); return { ok: r.status < 400 && Array.isArray(r.body.changelog), detail: `status=${r.status}` }; }),
    probe('GET /outcomes (H)', async () => { const r = await json(`/outcomes?repo=${q}`); return { ok: r.status < 400 && Array.isArray(r.body.outcomes), detail: `status=${r.status}` }; }),
    probe('POST /simulate (G)', async () => { const r = await json('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: REPO, move: { check: 'ci', fromTierId: 'pr', toTierId: null } }) }); return { ok: r.status < 500, detail: `status=${r.status}` }; }),
    probe('POST /prompt (G)', async () => { const r = await json('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: REPO, finding: { goal: 'cost', check: 'ci', detail: 'smoke' } }) }); return { ok: r.status < 500 && (r.status >= 400 || typeof r.body.prompt === 'string'), detail: `status=${r.status}` }; }),
    probe('POST /plan (N2)', async () => { const r = await json('/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: REPO, moves: [{ check: 'ci', fromTierId: 'pr', toTierId: null }] }) }); return { ok: r.status < 500 && (r.status >= 400 || 'legal' in r.body), detail: `status=${r.status}` }; }),
    probe('POST /quarantine dryRun (K2)', async () => { const r = await json('/quarantine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: REPO, check: 'ci', jobId: 'ci', dryRun: true }) }); return { ok: r.status < 500, detail: `status=${r.status} (409=correctly refused gate)` }; }),
    probe('POST /draft-pr dryRun (FR-026)', async () => { const r = await json('/draft-pr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: REPO, dryRun: true, intent: { kind: 'tier', check: 'ci', jobId: 'ci', fromTierId: 'pr', targetEvent: 'merge_group' } }) }); return { ok: r.status < 500, detail: `status=${r.status}` }; }),
    probe('POST /candidate (Build)', async () => { const r = await json('/candidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: REPO, mutations: [{ op: 'timeout', jobId: 'ci', minutes: 30 }] }) }); return { ok: r.status < 500, detail: `status=${r.status} ok=${r.body.ok} regressed=${r.body.validation?.gatingRegressed}` }; }),
    probe('POST /candidate/raw (hatch)', async () => { const r = await json('/candidate/raw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: REPO, file: 'ci.yml', rawYaml: 'name: CI\non: { pull_request: {}, merge_group: {} }\njobs:\n  ci:\n    name: ci\n    needs: []\n    runs-on: ubuntu-latest\n' }) }); return { ok: r.status < 500 && 'ok' in r.body, detail: `status=${r.status} ok=${r.body.ok} regressed=${r.body.validation?.gatingRegressed}` }; }),
  ]);

  const s = summarize(results);
  for (const line of s.lines) console.log(line);
  console.log(`\nworkspace smoke: ${s.pass ? 'PASS' : 'FAIL'} (${s.total - s.failed}/${s.total})`);
  process.exit(s.pass ? 0 : 1);
}

// run only when invoked directly (so the test can import summarize without executing)
if (import.meta.url === `file://${process.argv[1]}`) main();
