import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseScheduledWorkflows, scheduledRunsApiPath, scheduledLaneStatus,
  type ScheduledRun,
} from '../scheduled';
import { HistoryStore } from '../history';

describe('parseScheduledWorkflows', () => {
  const wf = (path: string, text: string) => ({ path, text });

  it('keeps files whose `on:` block has a schedule: key (block form)', () => {
    const files = [
      wf('.github/workflows/nightly.yml', `name: Nightly\non:\n  schedule:\n    - cron: '0 6 * * *'\njobs: {}\n`),
      wf('.github/workflows/ci.yml', `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\njobs: {}\n`),
    ];
    expect(parseScheduledWorkflows(files)).toEqual(['.github/workflows/nightly.yml']);
  });

  it('keeps a file with schedule in a flow/inline `on` mapping', () => {
    const files = [
      wf('.github/workflows/weekly.yml', "on: { schedule: [ { cron: '0 0 * * 0' } ] }\njobs: {}\n"),
    ];
    expect(parseScheduledWorkflows(files)).toEqual(['.github/workflows/weekly.yml']);
  });

  it('excludes workflow_dispatch-only files (manual fires are not scheduled)', () => {
    const files = [
      wf('.github/workflows/manual.yml', 'on:\n  workflow_dispatch:\njobs: {}\n'),
    ];
    expect(parseScheduledWorkflows(files)).toEqual([]);
  });

  it('keeps a multi-trigger file that includes schedule among other events', () => {
    const files = [
      wf('.github/workflows/audit.yml',
        "on:\n  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:\njobs: {}\n"),
    ];
    expect(parseScheduledWorkflows(files)).toEqual(['.github/workflows/audit.yml']);
  });

  it('falls back to a robust scan when YAML is unparseable but has a schedule key under on', () => {
    const files = [
      // deliberately broken YAML (tab indent) — parser throws, regex fallback rescues it
      wf('.github/workflows/broken.yml', 'on:\n\tschedule:\n\t\t- cron: "0 6 * * *"\njunk: [\n'),
    ];
    expect(parseScheduledWorkflows(files)).toEqual(['.github/workflows/broken.yml']);
  });

  it('does not treat a `schedule` key OUTSIDE the on block as a trigger (fallback is on-scoped)', () => {
    const files = [
      wf('.github/workflows/env.yml',
        'on:\n  push:\n    branches: [main]\njobs:\n  build:\n    env:\n      schedule: nightly\n'),
    ];
    expect(parseScheduledWorkflows(files)).toEqual([]);
  });

  it('returns paths sorted and de-duplicated', () => {
    const files = [
      wf('.github/workflows/weekly.yml', "on:\n  schedule:\n    - cron: '0 0 * * 0'\n"),
      wf('.github/workflows/nightly.yml', "on:\n  schedule:\n    - cron: '0 6 * * *'\n"),
    ];
    expect(parseScheduledWorkflows(files)).toEqual([
      '.github/workflows/nightly.yml', '.github/workflows/weekly.yml',
    ]);
  });
});

describe('scheduledRunsApiPath', () => {
  it('builds the per-workflow runs REST path with the file basename as the id', () => {
    expect(scheduledRunsApiPath('cairnea', 'KinDash', 'nightly.yml'))
      .toBe('/repos/cairnea/KinDash/actions/workflows/nightly.yml/runs?per_page=8');
  });
});

describe('scheduledLaneStatus', () => {
  const run = (over: Partial<ScheduledRun> = {}): ScheduledRun => ({
    workflow: 'nightly.yml', conclusion: 'success', status: 'completed',
    createdAt: '2026-06-13T06:00:00Z', htmlUrl: 'https://x/1', ...over,
  });

  it('is idle when there are no scheduled workflows at all', () => {
    expect(scheduledLaneStatus([], { discovered: 0 }).status).toBe('idle');
  });

  it('is blind when workflows are discovered but no runs are recorded yet', () => {
    const out = scheduledLaneStatus([], { discovered: 2 });
    expect(out.status).toBe('blind');
    expect(out.summary).toMatch(/no runs/i);
  });

  it('is red when the latest run of ANY workflow has a failing conclusion', () => {
    const runs = [
      run({ workflow: 'nightly.yml', conclusion: 'success' }),
      run({ workflow: 'weekly.yml', conclusion: 'failure' }),
    ];
    expect(scheduledLaneStatus(runs, { discovered: 2 }).status).toBe('red');
  });

  it('treats TIMED_OUT / STARTUP_FAILURE as failing (FAILING_CONCLUSIONS, case-insensitive)', () => {
    expect(scheduledLaneStatus([run({ conclusion: 'timed_out' })], { discovered: 1 }).status).toBe('red');
    expect(scheduledLaneStatus([run({ conclusion: 'startup_failure' })], { discovered: 1 }).status).toBe('red');
  });

  it('is green when every latest run is SUCCESS', () => {
    const runs = [
      run({ workflow: 'nightly.yml', conclusion: 'success' }),
      run({ workflow: 'weekly.yml', conclusion: 'success' }),
    ];
    const out = scheduledLaneStatus(runs, { discovered: 2 });
    expect(out.status).toBe('green');
  });

  it('is amber for in-progress / cancelled / neutral latest runs (not failing, not all-green)', () => {
    expect(scheduledLaneStatus([run({ conclusion: null, status: 'in_progress' })], { discovered: 1 }).status).toBe('amber');
    expect(scheduledLaneStatus([run({ conclusion: 'cancelled' })], { discovered: 1 }).status).toBe('amber');
    expect(scheduledLaneStatus([run({ conclusion: 'neutral' })], { discovered: 1 }).status).toBe('amber');
  });

  it('CANCELLED is NOT failing — it never reds the lane', () => {
    const runs = [run({ workflow: 'a.yml', conclusion: 'success' }), run({ workflow: 'b.yml', conclusion: 'cancelled' })];
    expect(scheduledLaneStatus(runs, { discovered: 2 }).status).toBe('amber');
  });
});

describe('HistoryStore scheduled_runs', () => {
  let h: HistoryStore;
  beforeEach(() => { h = new HistoryStore(':memory:'); });

  const rec = (over: Partial<Parameters<HistoryStore['recordScheduledRun']>[0]> = {}) =>
    h.recordScheduledRun({
      repo: 'cairnea/KinDash', workflow: 'nightly.yml', runId: 1, runAttempt: 1,
      runNumber: 10, conclusion: 'success', status: 'completed',
      createdAt: '2026-06-13T06:00:00Z', htmlUrl: 'https://x/1',
      observedAt: '2026-06-13T06:30:00Z', ...over,
    });

  it('upserts on (repo, workflow, run_id, run_attempt) — a re-poll overwrites conclusion', () => {
    rec({ conclusion: null, status: 'in_progress' });
    rec({ conclusion: 'success', status: 'completed' });
    const latest = h.latestScheduledRuns('cairnea/KinDash');
    expect(latest).toHaveLength(1);
    expect(latest[0].conclusion).toBe('success');
  });

  it('latestScheduledRuns returns the newest run per workflow', () => {
    rec({ workflow: 'nightly.yml', runId: 1, runNumber: 10, createdAt: '2026-06-12T06:00:00Z', conclusion: 'failure' });
    rec({ workflow: 'nightly.yml', runId: 2, runNumber: 11, createdAt: '2026-06-13T06:00:00Z', conclusion: 'success' });
    rec({ workflow: 'weekly.yml', runId: 3, runNumber: 5, createdAt: '2026-06-13T00:00:00Z', conclusion: 'success' });
    const latest = h.latestScheduledRuns('cairnea/KinDash');
    expect(latest).toHaveLength(2);
    const nightly = latest.find((r) => r.workflow === 'nightly.yml')!;
    expect(nightly.conclusion).toBe('success'); // newest by created_at, not the older failure
    expect(latest.map((r) => r.workflow).sort()).toEqual(['nightly.yml', 'weekly.yml']);
  });

  it('excludes runs older than sinceDays', () => {
    rec({ workflow: 'nightly.yml', runId: 1, createdAt: '2026-05-01T06:00:00Z' }); // ~6 weeks old
    expect(h.latestScheduledRuns('cairnea/KinDash', 14, new Date('2026-06-13T12:00:00Z'))).toHaveLength(0);
  });

  it('scopes by repo', () => {
    rec({ repo: 'cairnea/KinDash' });
    rec({ repo: 'other/repo', workflow: 'nightly.yml', runId: 99 });
    expect(h.latestScheduledRuns('cairnea/KinDash', 14, new Date('2026-06-13T12:00:00Z'))).toHaveLength(1);
  });
});
