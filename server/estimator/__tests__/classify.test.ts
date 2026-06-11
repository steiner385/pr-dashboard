import { describe, it, expect } from 'vitest';
import { classify, requiredChecks, matchingPrefix, matchesRequiredPrefix, workflowScopeAllows, type ClassifyInput } from '../classify';
import type { CheckRun, PrSnapshot, StageResult } from '../../types';
import type { ProgressResult } from '../progress';

const NOW = new Date('2026-06-10T12:00:00Z');
const run = (over: Partial<CheckRun>): CheckRun => ({
  name: 'ci', rawName: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS',
  startedAt: '2026-06-10T10:00:00Z', completedAt: '2026-06-10T10:05:00Z',
  event: 'pull_request', workflowName: null, runNumber: null, isRequired: true, url: null, ...over,
});
const pr = (over: Partial<PrSnapshot>): PrSnapshot => ({
  repo: 'acme/widgets', number: 1, title: 't', url: 'u', headSha: 'h',
  isDraft: false, mergeStateStatus: 'CLEAN', mergedAt: null, mergeCommitSha: null,
  autoMergeArmed: false, queue: null, checks: [run({})], ...over,
});
const input = (over: Partial<ClassifyInput>): ClassifyInput => ({
  pr: pr({}), prev: null, ciProgress: null, queueProgress: null,
  deploy: { hasDeploy: false, qaLive: null, prodLive: null, propagating: false, deployProgress: null },
  retentionDays: 7, now: NOW, ...over,
});

describe('requiredChecks', () => {
  it('filters to isRequired non-merge_group checks', () => {
    const out = requiredChecks([
      run({ name: 'ci', isRequired: true }),
      run({ name: 'lighthouse', isRequired: false }),
      run({ name: 'mg', event: 'merge_group', isRequired: true }),
    ]);
    expect(out.map((c) => c.name)).toEqual(['ci']);
  });
  it('falls back to all PR-event checks when none are marked required', () => {
    const out = requiredChecks([run({ name: 'a', isRequired: false }), run({ name: 'b', isRequired: false })]);
    expect(out).toHaveLength(2);
  });

  it('prefix-matched checks count as required even when isRequired is false', () => {
    const out = requiredChecks([
      run({ name: 'fast-checks / ESLint', isRequired: false }),
      run({ name: 'lighthouse', isRequired: false }),
      run({ name: 'ci', isRequired: true }),
    ], ['ci', 'fast-checks /']);
    expect(out.map((c) => c.name).sort()).toEqual(['ci', 'fast-checks / ESLint']);
  });

  it('with prefixes configured there is NO fallback-to-all (advisory-only snapshot → empty)', () => {
    const out = requiredChecks([run({ name: 'lighthouse', isRequired: false })], ['ci']);
    expect(out).toEqual([]);
  });
});

describe('requiredChecks workflow scoping (the ci-gate regression)', () => {
  const prefixes = ['ci', 'fast-checks /'];

  it("ci-gate from 'Auto-merge PRs' prefix-matches 'ci' but is NOT required when the rollup workflow is 'CI'", () => {
    const out = requiredChecks([
      run({ name: 'ci-gate', workflowName: 'Auto-merge PRs', isRequired: false }),
    ], prefixes, 'CI');
    expect(out).toEqual([]);
  });

  it('the same check with workflowName null IS required (permissive for old data)', () => {
    const out = requiredChecks([
      run({ name: 'ci-gate', workflowName: null, isRequired: false }),
    ], prefixes, 'CI');
    expect(out.map((c) => c.name)).toEqual(['ci-gate']);
  });

  it("a check 'ci' from workflow 'CI' is required under the scoped match", () => {
    const out = requiredChecks([
      run({ name: 'ci', workflowName: 'CI', isRequired: false }),
      run({ name: 'ci-gate', workflowName: 'Auto-merge PRs', isRequired: false }),
    ], prefixes, 'CI');
    expect(out.map((c) => c.name)).toEqual(['ci']);
  });

  it('API isRequired counts regardless of workflow', () => {
    const out = requiredChecks([
      run({ name: 'external-gate', workflowName: 'Auto-merge PRs', isRequired: true }),
    ], prefixes, 'CI');
    expect(out.map((c) => c.name)).toEqual(['external-gate']);
  });

  it('no rollup workflow known → prefix matching alone (pre-scoping behavior)', () => {
    const out = requiredChecks([
      run({ name: 'ci-gate', workflowName: 'Auto-merge PRs', isRequired: false }),
    ], prefixes);
    expect(out.map((c) => c.name)).toEqual(['ci-gate']);
  });
});

describe('workflowScopeAllows', () => {
  it('passes everything when the rollup workflow is unknown', () => {
    expect(workflowScopeAllows('Auto-merge PRs', null)).toBe(true);
    expect(workflowScopeAllows('Auto-merge PRs', undefined)).toBe(true);
    expect(workflowScopeAllows(null, null)).toBe(true);
  });
  it('permissive for checks without workflow identity', () => {
    expect(workflowScopeAllows(null, 'CI')).toBe(true);
  });
  it('requires equality when both sides are known', () => {
    expect(workflowScopeAllows('CI', 'CI')).toBe(true);
    expect(workflowScopeAllows('Auto-merge PRs', 'CI')).toBe(false);
  });
});

describe('matchingPrefix (shared name→prefix matcher)', () => {
  it('returns the matched prefix for startsWith semantics, null otherwise', () => {
    expect(matchingPrefix('static-checks / TypeScript', ['ci', 'static-checks /'])).toBe('static-checks /');
    expect(matchingPrefix('lighthouse', ['ci', 'static-checks /'])).toBeNull();
    expect(matchingPrefix('anything', [])).toBeNull();
  });

  it('prefers the longest matching prefix (build-test must not resolve to build)', () => {
    expect(matchingPrefix('build-test', ['build', 'build-test'])).toBe('build-test');
    expect(matchingPrefix('build-test', ['build-test', 'build'])).toBe('build-test');
    expect(matchingPrefix('build', ['build', 'build-test'])).toBe('build');
  });

  it('matchesRequiredPrefix delegates to the same semantics', () => {
    expect(matchesRequiredPrefix('static-checks / TypeScript', ['static-checks /'])).toBe(true);
    expect(matchesRequiredPrefix('lighthouse', ['static-checks /'])).toBe(false);
    expect(matchesRequiredPrefix('anything', undefined)).toBe(false);
  });
});

describe('classify with requiredCheckPrefixes', () => {
  const prefixes = ['ci', 'fast-checks /'];

  it('prefix-matched FAILURE parks even though nothing is marked isRequired yet', () => {
    const r = classify(input({
      pr: pr({ checks: [run({ name: 'fast-checks / ESLint', isRequired: false, conclusion: 'FAILURE' })] }),
      requiredCheckPrefixes: prefixes,
    }))!;
    expect(r.stage).toBe('parked');
    expect(r.substate).toBe('ci-failed');
  });

  it('advisory (non-matching) FAILURE does not park — stays ci while required checks run', () => {
    const r = classify(input({
      pr: pr({ checks: [
        run({ name: 'lighthouse', isRequired: false, conclusion: 'FAILURE' }),
        run({ name: 'fast-checks / ESLint', isRequired: false, status: 'IN_PROGRESS', conclusion: null, completedAt: null }),
      ] }),
      requiredCheckPrefixes: prefixes,
    }))!;
    expect(r.stage).toBe('ci');
    expect(r.substate).toBeNull();
  });

  it('a foreign-workflow prefix-matching FAILURE (ci-gate) does not park when the rollup workflow is known', () => {
    const r = classify(input({
      pr: pr({ checks: [
        run({ name: 'ci-gate', workflowName: 'Auto-merge PRs', isRequired: false, conclusion: 'FAILURE' }),
        run({ name: 'fast-checks / ESLint', workflowName: 'CI', isRequired: false, status: 'IN_PROGRESS', conclusion: null, completedAt: null }),
      ] }),
      requiredCheckPrefixes: prefixes,
      rollupWorkflowName: 'CI',
    }))!;
    expect(r.stage).toBe('ci');
    expect(r.substate).toBeNull();
  });
});

describe('classify', () => {
  it('running required checks → ci with progress', () => {
    const prog: ProgressResult = { percent: 52, etaSeconds: 300, etaRangeSeconds: null, overdue: false, failed: false };
    const r = classify(input({
      pr: pr({ checks: [run({ status: 'IN_PROGRESS', conclusion: null, completedAt: null })] }),
      ciProgress: prog,
    }))!;
    expect(r.stage).toBe('ci');
    expect(r.percent).toBe(52);
    expect(r.etaSeconds).toBe(300);
  });

  it('required failure → parked/ci-failed (even with others running)', () => {
    const r = classify(input({
      pr: pr({ checks: [run({ conclusion: 'FAILURE' }), run({ name: 'b', status: 'IN_PROGRESS', conclusion: null })] }),
    }))!;
    expect(r.stage).toBe('parked');
    expect(r.substate).toBe('ci-failed');
  });

  it('draft → parked/draft; DIRTY → parked/conflicting', () => {
    expect(classify(input({ pr: pr({ isDraft: true }) }))!.substate).toBe('draft');
    expect(classify(input({ pr: pr({ mergeStateStatus: 'DIRTY' }) }))!.substate).toBe('conflicting');
  });

  it('UNKNOWN mergeability keeps the previous stage', () => {
    const prev: StageResult = { stage: 'ready', substate: 'idle', percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false };
    const r = classify(input({ pr: pr({ mergeStateStatus: 'UNKNOWN' }), prev }))!;
    expect(r).toEqual(prev);
  });

  it('green + armed → ready/armed; green idle → ready/idle', () => {
    expect(classify(input({ pr: pr({ autoMergeArmed: true }) }))!.substate).toBe('armed');
    expect(classify(input({}))!.substate).toBe('idle');
  });

  it('queue entry → queue with queueProgress', () => {
    const r = classify(input({
      pr: pr({ queue: { position: 3, state: 'QUEUED', enqueuedAt: null, groupHeadOid: null } }),
      queueProgress: { percent: null, etaSeconds: 720, overdue: false },
    }))!;
    expect(r.stage).toBe('queue');
    expect(r.etaSeconds).toBe(720);
  });

  it('merged, no deploy config → merged; drops after retention', () => {
    expect(classify(input({ pr: pr({ mergedAt: '2026-06-09T12:00:00Z' }) }))!.stage).toBe('merged');
    expect(classify(input({ pr: pr({ mergedAt: '2026-06-01T12:00:00Z' }) }))).toBeNull();
  });

  it('merged deploy-repo lifecycle: deploying → propagating → awaiting-prod → drop on prod', () => {
    const merged = pr({ mergedAt: '2026-06-10T11:00:00Z' });
    const base = { hasDeploy: true, qaLive: false, prodLive: false, propagating: false,
      deployProgress: { percent: 40, etaSeconds: 180, overdue: false } };
    expect(classify(input({ pr: merged, deploy: base }))!.stage).toBe('qa-deploy');
    expect(classify(input({ pr: merged, deploy: { ...base, propagating: true } }))!.substate).toBe('propagating');
    expect(classify(input({ pr: merged, deploy: { ...base, qaLive: true } }))!.stage).toBe('awaiting-prod');
    expect(classify(input({ pr: merged, deploy: { ...base, qaLive: true, prodLive: true } }))).toBeNull();
    expect(classify(input({ pr: merged, deploy: { ...base, qaLive: null } }))!.substate).toBe('unknown');
  });

  // Item 4 — CI-done trust guard
  it('empty checks array + ciProgress {percent:5} → stage ci (rollup not settled yet)', () => {
    const ciProg: ProgressResult = { percent: 5, etaSeconds: 600, etaRangeSeconds: null, overdue: false, failed: false };
    const r = classify(input({
      pr: pr({ checks: [] }),
      ciProgress: ciProg,
    }))!;
    expect(r.stage).toBe('ci');
    expect(r.percent).toBe(5);
  });

  it('all visible required checks complete + ciProgress {percent:60} → still stage ci', () => {
    const ciProg: ProgressResult = { percent: 60, etaSeconds: 200, etaRangeSeconds: null, overdue: false, failed: false };
    const r = classify(input({
      pr: pr({ checks: [run({ status: 'COMPLETED', conclusion: 'SUCCESS' })] }),
      ciProgress: ciProg,
    }))!;
    expect(r.stage).toBe('ci');
    expect(r.percent).toBe(60);
  });

  // Item 5 — CANCELLED is not a park; it becomes ci/retrying
  it('CANCELLED required check (no failure) → ci/retrying, not parked', () => {
    const r = classify(input({
      pr: pr({ checks: [run({ status: 'COMPLETED', conclusion: 'CANCELLED' })] }),
    }))!;
    expect(r.stage).toBe('ci');
    expect(r.substate).toBe('retrying');
  });

  it('CANCELLED + FAILURE → still parked/ci-failed (failure wins)', () => {
    const r = classify(input({
      pr: pr({ checks: [
        run({ name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' }),
        run({ name: 'b', status: 'COMPLETED', conclusion: 'FAILURE' }),
      ]}),
    }))!;
    expect(r.stage).toBe('parked');
    expect(r.substate).toBe('ci-failed');
  });

  // Item 6 — queue group failure surfaced
  it('queue stage + queueProgress.failed → stage queue/group-failed', () => {
    const r = classify(input({
      pr: pr({ queue: { position: 2, state: 'AWAITING_CHECKS', enqueuedAt: null, groupHeadOid: 'g1' } }),
      queueProgress: { percent: 40, etaSeconds: 300, overdue: false, failed: true },
    }))!;
    expect(r.stage).toBe('queue');
    expect(r.substate).toBe('group-failed');
  });

  it('queue stage + queueProgress.failed=false → no group-failed substate', () => {
    const r = classify(input({
      pr: pr({ queue: { position: 1, state: 'QUEUED', enqueuedAt: null, groupHeadOid: null } }),
      queueProgress: { percent: null, etaSeconds: 900, overdue: false, failed: false },
    }))!;
    expect(r.stage).toBe('queue');
    expect(r.substate).toBeNull();
  });

  // HEADGREEN: UNMERGEABLE queue entries face ejection — surface them instead of
  // rendering an innocuous queued row with waiting-line math. GitHub marks queue
  // entries UNMERGEABLE *positionally* (one genuine conflict poisons every
  // speculative merge behind it), so the substate splits on the PR's OWN
  // mergeStateStatus: DIRTY = genuine conflict, anything else = cascade victim.
  it('queueProgress.unmergeable + DIRTY snapshot → queue/unmergeable (genuine) with no percent/eta', () => {
    const r = classify(input({
      pr: pr({ mergeStateStatus: 'DIRTY',
        queue: { position: 1, state: 'UNMERGEABLE', enqueuedAt: null, groupHeadOid: 'staleOid' } }),
      queueProgress: { percent: null, etaSeconds: null, overdue: false, failed: false, unmergeable: true },
    }))!;
    expect(r.stage).toBe('queue');
    expect(r.substate).toBe('unmergeable');
    expect(r.percent).toBeNull();
    expect(r.etaSeconds).toBeNull();
  });

  it('snapshot queue state UNMERGEABLE + DIRTY → unmergeable even when queueProgress lags (stale entries)', () => {
    const r = classify(input({
      pr: pr({ mergeStateStatus: 'DIRTY',
        queue: { position: 1, state: 'UNMERGEABLE', enqueuedAt: null, groupHeadOid: null } }),
      // stale waiting-line math from an older queue fetch must not leak through
      queueProgress: { percent: null, etaSeconds: 1800, overdue: false, failed: false },
    }))!;
    expect(r.stage).toBe('queue');
    expect(r.substate).toBe('unmergeable');
    expect(r.etaSeconds).toBeNull();
  });

  // Cascade victims: queue entry UNMERGEABLE but the PR itself does not conflict
  // with the base — a conflicting entry ahead poisoned its speculative merge.
  for (const mss of ['CLEAN', 'BLOCKED', 'UNSTABLE', 'UNKNOWN', null]) {
    it(`queueProgress.unmergeable + ${mss ?? 'null'} snapshot → queue/queue-blocked (cascade), no percent/eta`, () => {
      const r = classify(input({
        pr: pr({ mergeStateStatus: mss,
          queue: { position: 2, state: 'UNMERGEABLE', enqueuedAt: null, groupHeadOid: 'staleOid' } }),
        queueProgress: { percent: null, etaSeconds: null, overdue: false, failed: false, unmergeable: true },
      }))!;
      expect(r.stage).toBe('queue');
      expect(r.substate).toBe('queue-blocked');
      expect(r.percent).toBeNull();
      expect(r.etaSeconds).toBeNull();
    });
  }

  it('snapshot queue state UNMERGEABLE + non-DIRTY → queue-blocked when queueProgress lags too', () => {
    const r = classify(input({
      pr: pr({ mergeStateStatus: 'CLEAN',
        queue: { position: 2, state: 'UNMERGEABLE', enqueuedAt: null, groupHeadOid: null } }),
      queueProgress: { percent: null, etaSeconds: 1800, overdue: false, failed: false },
    }))!;
    expect(r.stage).toBe('queue');
    expect(r.substate).toBe('queue-blocked');
    expect(r.etaSeconds).toBeNull();
  });

  // Item 7 — UNKNOWN-hold returns a copy (not same reference)
  it('UNKNOWN mergeability returns a copy of prev (not same object reference)', () => {
    const prev: StageResult = { stage: 'ready', substate: 'idle', percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false };
    const r = classify(input({ pr: pr({ mergeStateStatus: 'UNKNOWN' }), prev }))!;
    expect(r).toEqual(prev);
    expect(r).not.toBe(prev); // must be a copy, not the same reference
  });

  // Item 12 — empty-checks case (covered by item 4a, made explicit)
  it('empty checks, no ciProgress → ready/idle (no checks means fully complete)', () => {
    const r = classify(input({ pr: pr({ checks: [] }) }))!;
    // No ciProgress hint → no pending checks → falls through to ready
    expect(r.stage).toBe('ready');
    expect(r.substate).toBe('idle');
  });
});
