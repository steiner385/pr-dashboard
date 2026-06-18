// server/pipeline-model/__tests__/kindash-golden.contract.test.ts
//
// Golden contract test — keystone exit gate (spec §11).
// Verifies the new multi-file parser (deriveStaticGraph + gatingClosure) agrees
// with production reality (deriveCiGraph on live cairnea/KinDash ci.yml), AND
// additionally resolves the reusable-workflow leaves the production single-file
// parser leaves opaque.
//
// When gh is unreachable (CI environment without KinDash repo access), the test
// skips with a console.warn and passes trivially — same pattern as
// server/__tests__/runner-job-keys.contract.test.ts.
//
// For the exit gate to count, it MUST produce a non-trivial pass (no console.warn)
// when run on a machine with gh authed to cairnea/KinDash.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { deriveStaticGraph } from '../derive-static';
import { gatingClosure } from '../gating';
import { deriveCiGraph } from '../../required-checks';

/** Fetch one cairnea/KinDash workflow file; null when gh is unreachable → skip. */
function wf(name: string): string | null {
  try {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    const b64 = execFileSync(
      'gh',
      ['api', `repos/cairnea/KinDash/contents/.github/workflows/${name}`, '--jq', '.content'],
      { env, encoding: 'utf8' },
    );
    return Buffer.from(b64.trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** List the reusable `_*.yml` workflow basenames referenced by ci.yml's `uses:`. */
function reusableRefs(ciYaml: string): string[] {
  return [
    ...new Set(
      [...ciYaml.matchAll(/uses:\s*\.\/\.github\/workflows\/(_[a-z0-9-]+\.yml)/gi)].map(
        (m) => m[1]!,
      ),
    ),
  ];
}

/**
 * Normalize a production CiGraph prefix (display-name format) to the caller job-id
 * format used by deriveStaticGraph / gatingClosure.
 *
 * Production deriveCiGraph emits prefixes like:
 *   "setup: changed-scope"   → job-id "changed-scope"
 *   "static-checks /"        → job-id "static-checks"
 *   "build /"                → job-id "build"
 *   "setup: prepare"         → job-id "prepare"
 *
 * Rules (applied in order):
 *   1. Strip trailing " /" (reusable-workflow caller suffix).
 *   2. Strip a leading "word(s): " label prefix (e.g. "setup: ").
 *
 * Bridge production display-name prefixes (e.g. "setup: changed-scope", "static-checks /")
 * to the new parser's job-ids. ASSUMES the job KEY equals the display-name suffix after
 * stripping a "<label>: " prefix and a trailing " /". If a future KinDash rename breaks
 * that, this test fails LOUDLY (a required prefix won't map to any job-id) — which is the
 * intended sentinel, not a silent pass.
 */
function normalizePrefix(prefix: string): string {
  return prefix
    .replace(/ \/$/, '')        // strip trailing " /"
    .replace(/^[^:]+:\s*/, '')  // strip leading "label: " prefix (with or without space)
    .trim();
}

describe('KinDash golden model (keystone exit gate)', () => {
  it(
    'multi-file gating closure agrees with the production single-file deriveCiGraph, and resolves reusable leaves',
    () => {
      const ci = wf('ci.yml');
      if (ci == null) {
        console.warn('skipped — gh/ci.yml unreachable');
        return;
      }

      // Fetch all reusable workflow files referenced from ci.yml.
      const files: Record<string, string> = { 'ci.yml': ci };
      for (const name of reusableRefs(ci)) {
        const text = wf(name);
        if (text) files[name] = text;
      }
      // A PARTIAL fetch (ci.yml ok but a reusable throttled — e.g. gh rate-limit
      // under parallel suite load) yields an incomplete graph; can't assert, skip.
      if (reusableRefs(ci).some((n) => !(n in files))) {
        console.warn('skipped — partial workflow fetch (gh throttled?)'); return;
      }

      // Build the new multi-file graph + gating closure.
      const graph = deriveStaticGraph(files);
      const res = gatingClosure(graph, 'ci');
      const ourCallers = new Set([...res.gatingCallerJobs, ...res.conditionalCallerJobs]);

      // ── Assertion (a): No gate is lost ─────────────────────────────────────────
      // Every production CiGraph prefix (the required caller set trusted by the
      // shipped code), except the rollup "ci" itself, must map to a caller job
      // present in our closure.  We normalize production's display-name format to
      // the job-id format our parser uses (see normalizePrefix above).
      const prod = deriveCiGraph(ci, 'ci');
      expect(prod, 'deriveCiGraph returned null').not.toBeNull();
      const prodPrefixes = prod!.prefixes.filter((p) => p !== 'ci');
      // deriveCiGraph reports gates by their check DISPLAY NAME; the new parser reports
      // caller JOB IDs. These agree when name == id, but a job whose `name:` differs from
      // its id (e.g. validate-e2e-floor → "lint: e2e floor manifest") only matches on the
      // check name. Accept a prod gate if it matches EITHER a caller job id OR a gating
      // check-name (both normalized the same way) — the same gate, two representations.
      const ourGateNames = new Set(res.gates.map((g) => normalizePrefix(g.checkName)));
      const missing = prodPrefixes
        .map((p) => ({ prefix: p, jobId: normalizePrefix(p) }))
        .filter(({ jobId }) => !ourCallers.has(jobId) && !ourGateNames.has(jobId));
      expect(
        missing.map((m) => m.prefix),
        `caller job(s) the new parser failed to gate: ${missing.map((m) => `"${m.prefix}" → "${m.jobId}"`).join(', ')}`,
      ).toEqual([]);

      // ── Assertion (b): Reusable leaves are expanded ────────────────────────────
      // At least one gating check name must contain " / " — a caller→callee leaf
      // that the single-file deriveCiGraph leaves opaque as e.g. "static-checks /".
      const leafGates = res.gates.filter((g) => g.checkName.includes(' / '));
      expect(
        leafGates.length,
        'expected reusable-workflow leaves to be expanded (found none with " / " in checkName)',
      ).toBeGreaterThan(0);

      // ── Assertion (c): Known heavy gate is on merge_group ─────────────────────
      // "build / build: production" should gate on merge_group (sanity check that
      // the events are being propagated correctly through the reusable expansion).
      const buildProd = res.gates.find((g) => /build: production/i.test(g.checkName));
      expect(buildProd, 'expected a gate matching /build: production/i').toBeDefined();
      expect(buildProd?.events).toContain('merge_group');
    },
    // ~16 sequential gh fetches; the 5s default times out under parallel suite load.
    30_000,
  );
});
