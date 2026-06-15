# Per-job spot/on-demand runner routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each PR-tier CI job to spot or on-demand runners automatically from the live spot-reclaim rate (cost model + one knob + manual overrides), with the dashboard computing & pushing a `RUNNER_MAP` repo variable that KinDash's ci.yml consumes.

**Architecture:** Hybrid push. The dashboard (`pr-dashboard`) owns the model + data and writes the variable via the gh keyring token; `cairnea/KinDash` only consumes `vars.RUNNER_MAP` in `runs-on`. Inert by default, phased rollout, kill-switch deletes the variable. See spec: `docs/design/2026-06-15-per-job-runner-routing.md`.

**Tech Stack:** TypeScript, Express, better-sqlite3, Vitest, React 18. No new deps.

---

## File structure

**`pr-dashboard` (this repo — the bulk):**
- Create `server/estimator/runner-plan.ts` — pure cost-model optimizer `(jobs, reclaimRate, config) → { map, plan }`. One responsibility: the decision.
- Create `server/estimator/__tests__/runner-plan.test.ts`.
- Create `server/runner-routing.ts` — the stateful controller: projects inputs from cached metrics + history, computes the plan, owns the writer (execFile gh, debounce, hash, startup-reconcile, audit, state). One responsibility: actuation + state.
- Create `server/__tests__/runner-routing.test.ts`.
- Modify `server/config.ts` — add `runnerRouting` to `AppConfig`, defaults in `loadConfig`, a `validateRunnerRoutingPatch`.
- Modify `server/api.ts` — `PUT /api/runner-routing` (writable subset) + `GET /api/runner-plan`.
- Modify `server/__tests__/api.test.ts` — endpoint tests.
- Modify `server/index.ts` — wire the controller into the app + poller.
- Modify `frontend/src/types.ts` — `RunnerPlanResponse` mirror.
- Create `frontend/src/RunnerRouting.tsx` — the panel.
- Create `frontend/src/__tests__/RunnerRouting.test.tsx`.
- Modify `frontend/src/MetricsView.tsx` — mount the panel in the Reliability section.
- Create `server/__tests__/runner-job-keys.contract.test.ts` — the ci.yml drift guard.

**`cairnea/KinDash` (separate repo, separate PR — Phase 1):**
- Modify `.github/workflows/ci.yml` + reusable `_*.yml` — PR-tier `runs-on` reads `vars.RUNNER_MAP` with the triple fallback.

This plan covers the `pr-dashboard` side in detail (Phases 2–3). The KinDash ci.yml change is Phase 1 and is described as its own task block; it lands as an independent no-op PR through KinDash's merge queue.

---

## Shared constants (used across tasks)

`RUNNER_JOB_KEYS` and the key→check-name matcher are the cross-repo contract. Defined once in `runner-plan.ts` and imported everywhere:

```ts
// server/estimator/runner-plan.ts
export const SPOT = 'kindash-arc-spot';
export const ONDEMAND = 'kindash-arc';
export type RunnerLabel = typeof SPOT | typeof ONDEMAND;

/** The PR-tier job keys ci.yml routes. Each maps to a regex over the check NAME
 *  used in history (shards collapse to one key). KEEP IN SYNC with ci.yml. */
export const RUNNER_JOB_KEYS = {
  unit:         /\btest: unit\b/i,
  integration:  /\btest: integration\b/i,
  server:       /\btest: server\b/i,
  tsc:          /\btypes: tsc\b/i,
  build:        /\bbuild: production\b/i,
  'build-test': /\bbuild: test bundle\b/i,
  db:           /\bdb: migrations\b/i,
  eslint:       /\blint: eslint\b/i,
  security:     /\bsecurity: audit\b/i,
} as const;
export type RunnerJobKey = keyof typeof RUNNER_JOB_KEYS;
```

---

# Phase 1 — KinDash ci.yml (separate repo PR, no-op until a map exists)

### Task 0: ci.yml reads `vars.RUNNER_MAP` (cairnea/KinDash)

**Files (in the KinDash checkout / a KinDash PR):**
- Modify: `.github/workflows/ci.yml` — every PR-tier `runs-on`
- Modify: `.github/workflows/_static-checks.yml`, `_integration-tests.yml`, `_build*.yml`, `_db-migrations.yml` — same

- [ ] **Step 1:** For each PR-tier job, replace
  `runs-on: ${{ github.event_name == 'merge_group' && 'kindash-arc' || 'kindash-arc-spot' }}`
  with (using that job's key, e.g. `unit`):
  ```yaml
  runs-on: ${{ github.event_name == 'merge_group' && 'kindash-arc'
               || fromJSON(vars.RUNNER_MAP || '{}')['unit']
               || 'kindash-arc-spot' }}
  ```
  merge_group stays hard-pinned to `kindash-arc`. The key MUST be one of `RUNNER_JOB_KEYS`.

- [ ] **Step 2:** Verify it's a no-op: with no `RUNNER_MAP` variable set, `fromJSON('{}')['unit']` is `null` → falls to `'kindash-arc-spot'` (today's behavior). Confirm via a draft PR: the jobs still land on `kindash-arc-spot`.

- [ ] **Step 3:** Open the KinDash PR (normal merge-queue path). This is independently safe — it changes nothing until the dashboard pushes a map. Commit message: `ci: route PR-tier runs-on through vars.RUNNER_MAP (no-op fallback to spot)`.

> The `pr-dashboard` work below (Phases 2–3) proceeds in parallel; it has no effect on CI until both this PR is merged AND the writer is enabled.

---

# Phase 2 — Dashboard optimizer + API + UI (read-only, `enabled=false`)

### Task 1: Pure cost-model optimizer (`runner-plan.ts`)

**Files:**
- Create: `server/estimator/runner-plan.ts`
- Test: `server/estimator/__tests__/runner-plan.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { computeRunnerPlan, SPOT, ONDEMAND } from '../runner-plan';

const cfg = { shedThresholdMinutes: 1, overrides: {} as Record<string, 'spot' | 'ondemand'> };

describe('computeRunnerPlan', () => {
  it('routes everything to spot when the reclaim rate is 0 (healthy spot)', () => {
    const { map, plan } = computeRunnerPlan(
      [{ key: 'unit', p90Secs: 480 }, { key: 'eslint', p90Secs: 30 }], 0, cfg);
    expect(plan.every((r) => r.decision === SPOT)).toBe(true);
    expect(map).toEqual({}); // only non-default (on-demand) entries are emitted
  });

  it('null reclaim rate is treated as 0 (assume healthy)', () => {
    const { plan } = computeRunnerPlan([{ key: 'unit', p90Secs: 480 }], null, cfg);
    expect(plan[0]!.decision).toBe(SPOT);
  });

  it('sheds the longest jobs first as the rate climbs (cost model)', () => {
    // rate 0.09 (9%), threshold 1 min: cutoff = 1/0.09 = 11.1 min → 8min unit stays, 12min flips
    const { plan } = computeRunnerPlan(
      [{ key: 'unit', p90Secs: 8 * 60 }, { key: 'integration', p90Secs: 12 * 60 }], 0.09, cfg);
    expect(plan.find((r) => r.key === 'unit')!.decision).toBe(SPOT);
    expect(plan.find((r) => r.key === 'integration')!.decision).toBe(ONDEMAND);
  });

  it('decision is on-demand exactly at the boundary (>=)', () => {
    // 0.1 rate × 600s = 60s = 1.0 min === threshold → on-demand
    const { plan } = computeRunnerPlan([{ key: 'unit', p90Secs: 600 }], 0.1, cfg);
    expect(plan[0]!.decision).toBe(ONDEMAND);
  });

  it('a manual override beats the auto decision and is marked source=override', () => {
    const { map, plan } = computeRunnerPlan([{ key: 'unit', p90Secs: 8 * 60 }], 0.0,
      { shedThresholdMinutes: 1, overrides: { unit: 'ondemand' } });
    const row = plan.find((r) => r.key === 'unit')!;
    expect(row.decision).toBe(ONDEMAND);
    expect(row.source).toBe('override');
    expect(map.unit).toBe(ONDEMAND);
  });

  it('omits cold-start jobs (no p90) from the map and marks them collecting', () => {
    const { map, plan } = computeRunnerPlan([{ key: 'unit', p90Secs: null }], 0.5, cfg);
    expect(map.unit).toBeUndefined();
    expect(plan[0]!.decision).toBe(SPOT);
    expect(plan[0]!.collecting).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/estimator/__tests__/runner-plan.test.ts`
Expected: FAIL — `computeRunnerPlan` not exported.

- [ ] **Step 3: Implement `runner-plan.ts`** (append below the constants from "Shared constants")

```ts
export interface RunnerJobInput { key: string; p90Secs: number | null; }
export interface RunnerPlanConfig {
  shedThresholdMinutes: number;
  overrides: Record<string, 'spot' | 'ondemand'>;
}
export interface PlanRow {
  key: string; p90Secs: number | null; scoreMinutes: number;
  decision: RunnerLabel; reason: string; source: 'auto' | 'override'; collecting: boolean;
}
export interface RunnerPlan { map: Record<string, RunnerLabel>; plan: PlanRow[]; }

/** Cost model: a job sheds to on-demand when a reclaim would be expected to waste
 *  >= shedThreshold minutes of it. reclaimRate is a FRACTION (0..1); null = 0. */
export function computeRunnerPlan(
  jobs: RunnerJobInput[], reclaimRate: number | null, cfg: RunnerPlanConfig): RunnerPlan {
  const rate = reclaimRate == null || !Number.isFinite(reclaimRate) ? 0 : Math.max(0, reclaimRate);
  const map: Record<string, RunnerLabel> = {};
  const plan: PlanRow[] = jobs.map((j) => {
    const override = cfg.overrides[j.key];
    if (override === 'spot' || override === 'ondemand') {
      const decision = override === 'ondemand' ? ONDEMAND : SPOT;
      if (decision === ONDEMAND) map[j.key] = ONDEMAND;
      return { key: j.key, p90Secs: j.p90Secs, scoreMinutes: 0, decision,
        reason: `manual override → ${override}`, source: 'override', collecting: j.p90Secs == null };
    }
    if (j.p90Secs == null) {
      return { key: j.key, p90Secs: null, scoreMinutes: 0, decision: SPOT,
        reason: 'no duration history yet — staying on spot', source: 'auto', collecting: true };
    }
    const scoreMinutes = (rate * j.p90Secs) / 60;
    const onDemand = scoreMinutes >= cfg.shedThresholdMinutes;
    if (onDemand) map[j.key] = ONDEMAND;
    return { key: j.key, p90Secs: j.p90Secs, scoreMinutes: Math.round(scoreMinutes * 100) / 100,
      decision: onDemand ? ONDEMAND : SPOT,
      reason: onDemand
        ? `${scoreMinutes.toFixed(1)} expected-rework-min ≥ ${cfg.shedThresholdMinutes} → on-demand`
        : `${scoreMinutes.toFixed(1)} expected-rework-min < ${cfg.shedThresholdMinutes} → spot`,
      source: 'auto', collecting: false };
  });
  return { map, plan };
}

/** Canonical (sorted-key) JSON for change-detection hashing. */
export function canonicalMap(map: Record<string, RunnerLabel>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/estimator/__tests__/runner-plan.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/estimator/runner-plan.ts server/estimator/__tests__/runner-plan.test.ts
git commit -m "feat(runner-routing): pure cost-model optimizer (computeRunnerPlan)"
```

---

### Task 2: Config schema + validation

**Files:**
- Modify: `server/config.ts` (`AppConfig` ~line 118; `loadConfig` ~line 548; new `validateRunnerRoutingPatch`)
- Test: `server/__tests__/config.test.ts` (add a describe block; create the file if absent)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { validateRunnerRoutingPatch } from '../config';

describe('validateRunnerRoutingPatch', () => {
  it('accepts the writable subset', () => {
    const v = validateRunnerRoutingPatch({ enabled: true, shedThresholdMinutes: 2,
      overrides: { unit: 'ondemand' } });
    expect(v.ok).toBe(true);
  });
  it('rejects a non-positive or NaN threshold', () => {
    expect(validateRunnerRoutingPatch({ shedThresholdMinutes: 0 }).ok).toBe(false);
    expect(validateRunnerRoutingPatch({ shedThresholdMinutes: -1 }).ok).toBe(false);
  });
  it('rejects an invalid override value', () => {
    expect(validateRunnerRoutingPatch({ overrides: { unit: 'on-demand' } }).ok).toBe(false);
  });
  it('rejects file-only keys in the PUT patch (targetRepo, reclaimWindow)', () => {
    expect(validateRunnerRoutingPatch({ targetRepo: 'evil/repo' }).ok).toBe(false);
    expect(validateRunnerRoutingPatch({ reclaimWindow: '99d' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/__tests__/config.test.ts -t validateRunnerRoutingPatch`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `server/config.ts`**

Add to `AppConfig`:
```ts
runnerRouting: {
  enabled: boolean;                 // PUT-writable; default false
  shedThresholdMinutes: number;     // PUT-writable; default 1.0
  overrides: Record<string, 'spot' | 'ondemand'>; // PUT-writable
  reclaimWindow: string;            // FILE-ONLY; default '24h' (a supported metrics window)
  targetRepo: string;               // FILE-ONLY; default 'cairnea/KinDash'
};
```
In `loadConfig`, default the block (mirror the existing `webhooks`/`notifications` defaulting), validating each field; a malformed block falls back to the defaults above. Add:
```ts
const RUNNER_ROUTING_WRITABLE = ['enabled', 'shedThresholdMinutes', 'overrides'] as const;
const RUNNER_ROUTING_TARGET_ALLOWLIST = ['cairnea/KinDash'];

export interface RunnerRoutingValidation { ok: boolean; errors: string[]; }
export function validateRunnerRoutingPatch(body: unknown): RunnerRoutingValidation {
  const errors: string[] = [];
  if (typeof body !== 'object' || body === null) return { ok: false, errors: ['not an object'] };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!(RUNNER_ROUTING_WRITABLE as readonly string[]).includes(k)) errors.push(`file-only or unknown key: ${k}`);
  }
  if ('enabled' in b && typeof b.enabled !== 'boolean') errors.push('enabled must be boolean');
  if ('shedThresholdMinutes' in b) {
    const n = b.shedThresholdMinutes;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) errors.push('shedThresholdMinutes must be a positive finite number');
  }
  if ('overrides' in b) {
    const o = b.overrides;
    if (typeof o !== 'object' || o === null) errors.push('overrides must be an object');
    else for (const [k, v] of Object.entries(o)) if (v !== 'spot' && v !== 'ondemand') errors.push(`override ${k} must be 'spot' or 'ondemand'`);
  }
  return { ok: errors.length === 0, errors };
}
```
(`targetRepo` validity against `RUNNER_ROUTING_TARGET_ALLOWLIST` is enforced in `loadConfig`, since it's file-only.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/__tests__/config.test.ts -t validateRunnerRoutingPatch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/__tests__/config.test.ts
git commit -m "feat(runner-routing): config schema + validateRunnerRoutingPatch (writable vs file-only tiers)"
```

---

### Task 3: The routing controller (inputs + writer state machine)

**Files:**
- Create: `server/runner-routing.ts`
- Test: `server/__tests__/runner-routing.test.ts`

The controller is constructed with injectable seams so it's testable without GitHub or a real clock:
```ts
export interface RoutingDeps {
  config: () => AppConfig['runnerRouting'];
  // projected inputs (from cached metrics + history) — caller supplies, no SQLite here:
  inputs: () => { jobs: RunnerJobInput[]; reclaimRate: number | null };
  // variable I/O (gh execFile in prod; fakes in tests):
  readVar: () => Promise<string | null>;
  writeVar: (json: string) => Promise<void>;
  deleteVar: () => Promise<void>;
  now: () => number;          // injectable clock
  audit: (entry: object) => void;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import { RunnerRoutingController } from '../runner-routing';

const baseCfg = { enabled: true, shedThresholdMinutes: 1, overrides: {}, reclaimWindow: '24h', targetRepo: 'cairnea/KinDash' };
function make(over = {}, cfgOver = {}) {
  const writeVar = vi.fn().mockResolvedValue(undefined);
  const deleteVar = vi.fn().mockResolvedValue(undefined);
  let t = 0;
  const ctl = new RunnerRoutingController({
    config: () => ({ ...baseCfg, ...cfgOver }),
    inputs: () => ({ jobs: [{ key: 'integration', p90Secs: 12 * 60 }], reclaimRate: 0.09 }),
    readVar: vi.fn().mockResolvedValue(null),
    writeVar, deleteVar, now: () => t, audit: vi.fn(), ...over,
  });
  return { ctl, writeVar, deleteVar, setTime: (v: number) => { t = v; } };
}

describe('RunnerRoutingController', () => {
  it('pushes the map on first tick when enabled and the map changed', async () => {
    const { ctl, writeVar } = make();
    await ctl.tick();
    expect(writeVar).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeVar.mock.calls[0][0])).toEqual({ integration: 'kindash-arc' });
  });

  it('does not re-push an unchanged map (canonical hash compare)', async () => {
    const { ctl, writeVar } = make();
    await ctl.tick();
    await ctl.tick();
    expect(writeVar).toHaveBeenCalledTimes(1);
  });

  it('respects the min re-push interval even when the map changes', async () => {
    let jobs = [{ key: 'integration', p90Secs: 12 * 60 }];
    const { ctl, writeVar, setTime } = make({ inputs: () => ({ jobs, reclaimRate: 0.09 }) });
    await ctl.tick();                       // t=0 push #1
    jobs = [{ key: 'integration', p90Secs: 12 * 60 }, { key: 'unit', p90Secs: 12 * 60 }];
    setTime(60_000); await ctl.tick();      // 1 min later — within 5-min floor → no push
    expect(writeVar).toHaveBeenCalledTimes(1);
    setTime(6 * 60_000); await ctl.tick();  // 6 min — allowed
    expect(writeVar).toHaveBeenCalledTimes(2);
  });

  it('deletes the variable and never writes when disabled', async () => {
    const { ctl, writeVar, deleteVar } = make({}, { enabled: false });
    await ctl.tick();
    expect(writeVar).not.toHaveBeenCalled();
    expect(deleteVar).toHaveBeenCalledTimes(1);
  });

  it('records lastError when a push fails and exposes it in getState()', async () => {
    const { ctl } = make({ writeVar: vi.fn().mockRejectedValue(new Error('rate limited')) });
    await ctl.tick();
    expect(ctl.getState().lastError).toMatch(/rate limited/);
    expect(ctl.getState().lastVerifiedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/__tests__/runner-routing.test.ts`
Expected: FAIL — `RunnerRoutingController` not found.

- [ ] **Step 3: Implement `server/runner-routing.ts`**

```ts
import { computeRunnerPlan, canonicalMap, type RunnerPlan } from './estimator/runner-plan';
import type { AppConfig } from './config';
import type { RunnerJobInput } from './estimator/runner-plan';

const MIN_REPUSH_MS = 5 * 60_000;

export interface RoutingDeps { /* as defined above */ }

export interface RoutingState {
  enabled: boolean; lastPushedAt: number | null; lastPushedHash: string | null;
  lastVerifiedAt: number | null; lastError: string | null; plan: RunnerPlan['plan']; shedCount: number;
}

export class RunnerRoutingController {
  private state: RoutingState = { enabled: false, lastPushedAt: null, lastPushedHash: null,
    lastVerifiedAt: null, lastError: null, plan: [], shedCount: 0 };
  private inFlight: Promise<void> | null = null;

  constructor(private deps: RoutingDeps) {}

  /** Read the live variable once so a restart reconciles instead of trusting a stale hash. */
  async init(): Promise<void> {
    try { this.state.lastPushedHash = await this.deps.readVar() ?? null; } catch { /* leave null */ }
  }

  getState(): RoutingState & { plan: RunnerPlan['plan'] } { return { ...this.state }; }
  getMapForApi(): RunnerPlan { return this.compute(); }

  private compute(): RunnerPlan {
    const cfg = this.deps.config();
    const { jobs, reclaimRate } = this.deps.inputs();
    return computeRunnerPlan(jobs, reclaimRate, { shedThresholdMinutes: cfg.shedThresholdMinutes, overrides: cfg.overrides });
  }

  /** One poll-cycle step. Serialized: never two in flight. */
  async tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const cfg = this.deps.config();
    const { map, plan } = this.compute();
    this.state.plan = plan;
    this.state.shedCount = Object.keys(map).length;
    this.state.enabled = cfg.enabled;

    if (!cfg.enabled) {
      if (this.state.lastPushedHash !== null) {
        try { await this.deps.deleteVar(); this.state.lastPushedHash = null;
          this.state.lastVerifiedAt = this.deps.now(); this.state.lastError = null;
          this.deps.audit({ at: this.deps.now(), action: 'delete' });
        } catch (e) { this.state.lastError = e instanceof Error ? e.message : String(e); }
      } else {
        // still ensure a known-deleted baseline once
        try { await this.deps.deleteVar(); } catch { /* already absent */ }
        this.state.lastPushedHash = null;
      }
      return;
    }

    const hash = canonicalMap(map);
    if (hash === this.state.lastPushedHash) return;             // unchanged
    const now = this.deps.now();
    if (this.state.lastPushedAt != null && now - this.state.lastPushedAt < MIN_REPUSH_MS) return; // debounce floor

    try {
      await this.deps.writeVar(canonicalMap(map));
      this.state.lastPushedHash = hash; this.state.lastPushedAt = now;
      this.state.lastVerifiedAt = now; this.state.lastError = null;
      this.deps.audit({ at: now, action: 'write', map, reclaimRate: this.deps.inputs().reclaimRate,
        shedThresholdMinutes: cfg.shedThresholdMinutes });
    } catch (e) {
      this.state.lastError = e instanceof Error ? e.message : String(e);
      this.state.lastVerifiedAt = null;
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/__tests__/runner-routing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/runner-routing.ts server/__tests__/runner-routing.test.ts
git commit -m "feat(runner-routing): controller (compute + push state machine, debounce, kill-switch, errors)"
```

---

### Task 4: gh variable I/O (execFile) + input projection — wired in index.ts

**Files:**
- Modify: `server/index.ts` (construct the controller; provide `readVar`/`writeVar`/`deleteVar` via `execFile`; project inputs from the poller's cached metrics + `history.expected`)
- Modify: `server/poller.ts` (expose a cached reclaim rate + a per-key p90 projection; reuse the `costSummaryCache` throttle pattern at `poller.ts:475/2042`)

- [ ] **Step 1: Add the cached reclaim rate to the poller** (mirror `refreshCostSummary` / `costSummaryAt`)

In `server/poller.ts`, add fields next to `costSummaryCache`:
```ts
private reclaimRateCache: number | null = null;   // fraction, null = no spot jobs
private reclaimRateAt = 0;
```
Add a method that recomputes from history no more than every `COST_SUMMARY_INTERVAL_MS`, over the configured `reclaimWindow`, reusing the existing reclaim computation (the `reclaims[].spot.ratePct` logic in `metrics.ts`). Expose:
```ts
runnerRoutingInputs(repo: string): { jobs: RunnerJobInput[]; reclaimRate: number | null } {
  // reclaimRate: cached spot.ratePct / 100 (null when no spot jobs ran)
  // jobs: for each RUNNER_JOB_KEYS entry, find matching check names (event 'pull_request')
  //       via history.expectedSet/recentDurationSamples and take p90 across matching shards;
  //       p90Secs = null when no samples (cold start).
}
```
Implementation detail for `jobs`: for each key/regex in `RUNNER_JOB_KEYS`, collect samples from the checks whose name matches (event `'pull_request'`) and compute the p90 (reuse the same percentile helper `metrics.ts` uses). No new unthrottled full-table scan per tick — compute alongside the throttled reclaim recompute and cache the `jobs` array too.

- [ ] **Step 2: Wire the controller in `server/index.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RunnerRoutingController } from './runner-routing';
const pexec = promisify(execFile);

function ghEnv() { const env = { ...process.env }; delete env.GITHUB_TOKEN; delete env.GH_TOKEN; return env; }
const repoArg = () => config.runnerRouting.targetRepo;

const routing = new RunnerRoutingController({
  config: () => config.runnerRouting,
  inputs: () => poller.runnerRoutingInputs(config.runnerRouting.targetRepo),
  readVar: async () => {
    try { const { stdout } = await pexec('gh', ['variable', 'get', 'RUNNER_MAP', '--repo', repoArg()], { env: ghEnv() });
      return stdout.trim() || null; } catch { return null; } // absent → null
  },
  writeVar: async (json) => { await pexec('gh', ['variable', 'set', 'RUNNER_MAP', '--repo', repoArg(), '--body', json], { env: ghEnv() }); },
  deleteVar: async () => { try { await pexec('gh', ['variable', 'delete', 'RUNNER_MAP', '--repo', repoArg()], { env: ghEnv() }); } catch { /* already absent */ } },
  now: () => Date.now(),
  audit: (entry) => appendRunnerAudit(entry), // append a line to logs/runner-map.jsonl
});
await routing.init();
// call routing.tick() at the end of each poll cycle (after metrics refresh):
poller.on('cycle', () => { void routing.tick(); });
```
`appendRunnerAudit` appends JSON lines to `logs/runner-map.jsonl` (create `logs/` if missing).

- [ ] **Step 3: Pass the controller into `createApp`** (for the endpoints in Task 5) by extending the `createApp` opts with `runnerRouting?: { state: () => RoutingState & {...}; plan: () => RunnerPlan; applyConfig: (patch) => void }`.

- [ ] **Step 4: Manual smoke (no test — integration glue)**

Run: `pnpm build && node dist/server/index.js` against a dev config with `runnerRouting.enabled=false`; confirm startup logs no errors and `gh variable get` is reachable (or absent → null). With `enabled=false` it must NOT write.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts server/poller.ts
git commit -m "feat(runner-routing): wire controller (gh execFile var I/O, cached reclaim+p90 inputs, audit log)"
```

---

### Task 5: API endpoints (`GET /api/runner-plan`, `PUT /api/runner-routing`)

**Files:**
- Modify: `server/api.ts` (after the `PUT /api/config` block ~line 306)
- Test: `server/__tests__/api.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('runner routing endpoints', () => {
  const plan = { map: { integration: 'kindash-arc' }, plan: [{ key: 'integration', decision: 'kindash-arc', source: 'auto' }] };
  const state = { enabled: false, lastPushedAt: null, lastPushedHash: null, lastVerifiedAt: null,
    lastError: null, plan: plan.plan, shedCount: 1 };
  const deps = () => ({ runnerRouting: { state: () => state, plan: () => plan, applyConfig: vi.fn() } });

  it('GET /api/runner-plan returns plan + map + state', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), ...deps() });
    const res = await request(app).get('/api/runner-plan');
    expect(res.status).toBe(200);
    expect(res.body.map).toEqual({ integration: 'kindash-arc' });
    expect(res.body.shedCount).toBe(1);
    expect(res.body).toHaveProperty('lastError', null);
  });

  it('PUT /api/runner-routing accepts the writable subset', async () => {
    const d = deps();
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), ...d });
    const res = await request(app).put('/api/runner-routing').send({ shedThresholdMinutes: 2 });
    expect(res.status).toBe(200);
    expect(d.runnerRouting.applyConfig).toHaveBeenCalledWith({ shedThresholdMinutes: 2 });
  });

  it('PUT /api/runner-routing 400s on a file-only key', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter(), ...deps() });
    const res = await request(app).put('/api/runner-routing').send({ targetRepo: 'evil/repo' });
    expect(res.status).toBe(400);
  });

  it('is absent (404) when no runnerRouting capability is wired', async () => {
    const app = createApp({ getState: () => STATE, bus: new EventEmitter() });
    expect((await request(app).get('/api/runner-plan')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/__tests__/api.test.ts -t "runner routing"`
Expected: FAIL.

- [ ] **Step 3: Implement in `server/api.ts`**

Extend `createApp` opts:
```ts
runnerRouting?: {
  state: () => RoutingState;
  plan: () => RunnerPlan;
  applyConfig: (patch: Record<string, unknown>) => void;
};
```
Add (origin-guarded like the others; import `validateRunnerRoutingPatch`):
```ts
if (opts.runnerRouting) {
  const rr = opts.runnerRouting;
  app.get('/api/runner-plan', (_req, res) => {
    const s = rr.state(); const { map, plan } = rr.plan();
    res.json({ plan, map, enabled: s.enabled, shedCount: s.shedCount,
      lastPushedAt: s.lastPushedAt, lastPushedHash: s.lastPushedHash,
      lastVerifiedAt: s.lastVerifiedAt, lastError: s.lastError });
  });
  app.put('/api/runner-routing', originGuard, (req, res) => {
    const v = validateRunnerRoutingPatch(req.body);
    if (!v.ok) { res.status(400).json({ error: 'invalid runner-routing patch', errors: v.errors }); return; }
    try { rr.applyConfig(req.body as Record<string, unknown>); } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); return; }
    res.json({ applied: Object.keys(req.body as object) });
  });
}
```
In `server/index.ts`, supply the capability: `state: () => routing.getState()`, `plan: () => routing.getMapForApi()`, `applyConfig: (patch) => { config = writeRunnerRoutingPatch(cfgPath, patch); poller.reconfigure(config); }` (a small writer that merges only the writable subset into `runnerRouting` and persists; reuse the `writeConfigPatch` nested-merge approach).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/__tests__/api.test.ts -t "runner routing"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/api.ts server/index.ts server/__tests__/api.test.ts
git commit -m "feat(runner-routing): GET /api/runner-plan + PUT /api/runner-routing endpoints"
```

---

### Task 6: Job-key drift guard (contract test)

**Files:**
- Create: `server/__tests__/runner-job-keys.contract.test.ts`

- [ ] **Step 1: Write the test** (reads the live ci.yml via gh; skips offline)

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { RUNNER_JOB_KEYS } from '../estimator/runner-plan';

function ciYml(): string | null {
  try { const env = { ...process.env }; delete env.GITHUB_TOKEN; delete env.GH_TOKEN;
    const b64 = execFileSync('gh', ['api', 'repos/cairnea/KinDash/contents/.github/workflows/ci.yml', '--jq', '.content'], { env, encoding: 'utf8' });
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch { return null; }
}

describe('RUNNER_JOB_KEYS contract with ci.yml', () => {
  it('every key ci.yml references in fromJSON(vars.RUNNER_MAP) is in RUNNER_JOB_KEYS', () => {
    const yml = ciYml();
    if (yml == null) { console.warn('skipped — gh/ci.yml unreachable'); return; }
    const used = [...yml.matchAll(/fromJSON\(vars\.RUNNER_MAP[^)]*\)\['([^']+)'\]/g)].map((m) => m[1]!);
    const known = new Set(Object.keys(RUNNER_JOB_KEYS));
    const unknown = [...new Set(used)].filter((k) => !known.has(k));
    expect(unknown, `ci.yml uses keys not in RUNNER_JOB_KEYS: ${unknown.join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run server/__tests__/runner-job-keys.contract.test.ts`
Expected: PASS (or a clear skip if gh is unreachable; FAIL listing any drifted key).

- [ ] **Step 3: Commit**

```bash
git add server/__tests__/runner-job-keys.contract.test.ts
git commit -m "test(runner-routing): ci.yml job-key drift guard"
```

---

### Task 7: The "Runner routing" UI panel

**Files:**
- Modify: `frontend/src/types.ts` (add `RunnerPlanResponse`)
- Create: `frontend/src/RunnerRouting.tsx`
- Modify: `frontend/src/MetricsView.tsx` (mount in the Reliability section)
- Modify: `frontend/src/styles.css` (add new control selectors to the shared `:focus-visible` rule; `.runner-*` styles)
- Test: `frontend/src/__tests__/RunnerRouting.test.tsx`

A11y requirements (the bar the app just set — non-negotiable):
- `shedThreshold`: `<label htmlFor>` + native input + `aria-valuetext` with the unit; ends labeled **Reliability ↔ Cost**.
- per-job override: **three-state** — two `aria-pressed` buttons (force spot / force on-demand) + a "clear (auto)" button; each with a per-job `aria-label`.
- enable/kill switch: `aria-pressed` + `aria-label` encoding the effect.
- per-job decision: **text/icon, never color alone**; reuse `.source-tag`/`.source-override` pills for auto-vs-override.
- push-status line: `role="status"` live region; **failed** state has a non-color prefix ("Push failed:").
- job list wrapped in a labeled `role="group"`; cold-start rows show "collecting".
- every new interactive control added to the shared `:focus-visible` selector in `styles.css`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RunnerRouting } from '../RunnerRouting';

const planResp = {
  enabled: false, shedCount: 1, lastError: null, lastPushedAt: null, lastVerifiedAt: null, lastPushedHash: null,
  map: { integration: 'kindash-arc' },
  plan: [
    { key: 'unit', p90Secs: 480, scoreMinutes: 0.7, decision: 'kindash-arc-spot', source: 'auto', reason: 'spot', collecting: false },
    { key: 'integration', p90Secs: 720, scoreMinutes: 1.1, decision: 'kindash-arc', source: 'auto', reason: 'on-demand', collecting: false },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('RunnerRouting panel', () => {
  it('renders each job with a non-color decision label and aria-pressed override controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => planResp }));
    render(<RunnerRouting />);
    await screen.findByText('integration');
    // decision conveyed as text
    expect(screen.getByTestId('runner-decision-integration').textContent).toMatch(/on-demand/i);
    // three-state override present
    expect(screen.getByTestId('override-integration-ondemand')).toHaveAttribute('aria-pressed');
    expect(screen.getByTestId('override-integration-spot')).toBeInTheDocument();
    expect(screen.getByTestId('override-integration-auto')).toBeInTheDocument();
  });

  it('PUTs an override and re-fetches the plan', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => planResp })       // initial GET
      .mockResolvedValueOnce({ ok: true, json: async () => ({ applied: ['overrides'] }) }) // PUT
      .mockResolvedValueOnce({ ok: true, json: async () => planResp });      // re-GET
    vi.stubGlobal('fetch', fetchMock);
    render(<RunnerRouting />);
    fireEvent.click(await screen.findByTestId('override-unit-ondemand'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/runner-routing', expect.objectContaining({ method: 'PUT' })));
  });

  it('shows a non-color failure prefix when lastError is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...planResp, lastError: 'rate limited' }) }));
    render(<RunnerRouting />);
    expect((await screen.findByTestId('runner-push-status')).textContent).toMatch(/Push failed:/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run frontend/src/__tests__/RunnerRouting.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `frontend/src/RunnerRouting.tsx`**

Component: on mount `fetch('/api/runner-plan')` → state; render a labeled `role="group"` job list (each row: key, p90, `data-testid="runner-decision-<key>"` text "spot"/"on-demand", `.source-tag` pill, three `aria-pressed` override buttons `data-testid="override-<key>-{spot|ondemand|auto}"`); the `shedThreshold` labeled input; the enable/kill `aria-pressed` switch; a `role="status"` `data-testid="runner-push-status"` line that renders `Push failed: <lastError>` when `lastError`, else "last pushed …". Override click → `PUT /api/runner-routing` with `{ overrides: { [key]: 'ondemand'|'spot' } }` (or delete the key for auto via the merged config) → re-`fetch('/api/runner-plan')`. Knob change → `PUT { shedThresholdMinutes }` → re-fetch. Use semantic tokens (`--accent`, `--done`, `--fail`, `--muted`).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run frontend/src/__tests__/RunnerRouting.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Mount in MetricsView + focus-visible CSS**

In `frontend/src/MetricsView.tsx`, add a `<Panel id="metrics-runner-routing" title="Runner routing" section="reliability" empty={false}><RunnerRouting /></Panel>` in the Reliability group. In `styles.css`, append the new control classes (`.runner-override`, `.runner-enable`, `#shed-threshold`) to the shared `:focus-visible` selector block, and add `.runner-*` styles using tokens.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/RunnerRouting.tsx frontend/src/__tests__/RunnerRouting.test.tsx frontend/src/types.ts frontend/src/MetricsView.tsx frontend/src/styles.css
git commit -m "feat(runner-routing): Runner routing UI panel (a11y: labeled knob, aria-pressed 3-state override, role=status)"
```

---

### Task 8: Full-suite gate + read-only verification

- [ ] **Step 1:** `pnpm vitest run` → all green (incl. new suites). Expected: PASS.
- [ ] **Step 2:** `npx tsc --noEmit -p tsconfig.json` → `TSC=0`.
- [ ] **Step 3:** `pnpm build` → clean.
- [ ] **Step 4:** Restart the service; with `runnerRouting.enabled=false`, open the dashboard → Metrics → Reliability → "Runner routing": confirm the plan renders (read-only), and confirm via `logs/runner-map.jsonl` + `gh variable get RUNNER_MAP --repo cairnea/KinDash` that **no variable was written** (inert by default).
- [ ] **Step 5: Commit** any fixups. Open the `pr-dashboard` PR (phases 2 done, `enabled=false`).

---

# Phase 3 — Enable (the reversible flip)

### Task 9: Go-live

- [ ] **Step 1:** Confirm the KinDash ci.yml PR (Task 0) is merged.
- [ ] **Step 2:** Observe the read-only plan in the UI across a normal day + a reclaim spike; sanity-check the `shedThreshold` produces sensible assignments.
- [ ] **Step 3:** Set `runnerRouting.enabled=true` (Settings/kill-switch). The writer pushes `RUNNER_MAP`. Verify `gh variable get RUNNER_MAP --repo cairnea/KinDash` matches the plan and that a subsequent PR run routes the flipped jobs to on-demand.
- [ ] **Step 4:** Verify the kill switch: flip `enabled=false` → variable deleted → next PR run all-spot.

---

## Self-review

**Spec coverage:** cost model + knob (Task 1) ✓; reclaimRate units/null + p90 reuse + cold-start + cached/throttled inputs (Tasks 1, 4) ✓; canonical hash + debounce + startup reconcile + serialized + kill-switch + audit + enabled-gates-all-writes (Task 3, 4) ✓; execFile-not-shell (Task 4) ✓; config trust tiers + validation (Task 2) ✓; API plan-vs-live state machine (Task 5) ✓; job-key drift guard (Task 6) ✓; UI a11y bar + three-state override + shed-count + knob direction (Task 7) ✓; ci.yml triple fallback + merge_group invariant (Task 0) ✓; phased inert-by-default rollout (Phases 1/2/3) ✓. Deferred-minor items (PAT, Storybook, plan-change log, shed-cap, dangling-override cleanup) intentionally out of scope per spec.

**Placeholder scan:** no TBD/TODO; every code step shows code; the one integration-glue step (Task 4 Step 1, the poller p90 projection) is specified by method + behavior rather than full code because it threads through existing private poller internals the implementer must read — its contract (`runnerRoutingInputs → {jobs, reclaimRate}`) and constraints (throttled, no per-tick scan, p90 via matching check names, null on cold start) are fully pinned.

**Type consistency:** `RunnerLabel`/`SPOT`/`ONDEMAND`, `RunnerJobInput {key,p90Secs}`, `PlanRow {key,p90Secs,scoreMinutes,decision,reason,source,collecting}`, `RunnerPlan {map,plan}`, `RoutingState {enabled,lastPushedAt,lastPushedHash,lastVerifiedAt,lastError,plan,shedCount}`, `RUNNER_JOB_KEYS`, `canonicalMap` — names consistent across Tasks 1, 3, 4, 5, 7.
