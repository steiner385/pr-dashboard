import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { OptimizeView } from '../sections/optimize/OptimizeView';
import type { WorkspaceApi } from '../shell/workspaceApi';
import type { DerivedModelLike } from '../sections/optimize/types';

const MODEL: DerivedModelLike = {
  tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }],
  checks: ['e2e', 'build'],
  cells: [
    { check: 'e2e', tierId: 'pr', intent: { runs: true, gates: false, conditional: false }, observed: { runs: 100, minutes: 5000, realFailures: 0, flakeRatePct: 0 }, state: 'advisory' },
    { check: 'build', tierId: 'queue', intent: { runs: true, gates: true, conditional: false }, observed: null, state: 'gate' },
  ],
  checkMeta: [
    { check: 'e2e', isRequiredMergeGate: false, provenance: [{ file: 'e2e.yml', jobId: 'e2e' }] },
    { check: 'build', isRequiredMergeGate: true, provenance: [{ file: 'ci.yml', jobId: 'build' }] },
  ],
};

function fakeApi(over: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    getPipeline: vi.fn(async () => ({ repo: 'o/r', sourceSha: 's', model: MODEL })),
    simulate: vi.fn(async (_r, m) => m.check === 'build'
      ? { legal: false, reason: 'required-gate', note: 'not possible — required merge gate', costDeltaMinutes: 0, direction: 'remove', gatesLost: [], gatesGained: [], estimated: false }
      : { legal: true, note: 'saves 5,000 min', costDeltaMinutes: -5000, direction: 'remove', gatesLost: [], gatesGained: [], estimated: false }),
    prompt: vi.fn(async () => ({ prompt: 'do the thing' })),
    draftPrDryRun: vi.fn(async () => ({ dryRun: true as const, diff: '@@ e2e → merge_group @@', baseSha: 'abc' })),
    draftPrOpen: vi.fn(async () => ({ opened: true as const, number: 5, url: 'u' })),
    security: vi.fn(async () => ({ repo: 'o/r', sourceSha: 's', scannedFiles: 0, findings: [] })),
    self: vi.fn(async () => ({ ingestionFreshnessSecs: 0, derivationCache: { hits: 0, misses: 0, hitRate: 0, size: 0 }, apiRateLimit: null, status: 'ok' as const, reasons: [] })),
    ruleset: vi.fn(async () => ({ readable: true, derivedRequired: [], liveRequired: [], missingFromModel: [], extraInModel: [], inSync: true })),
    forecast: vi.fn(async () => ({ available: false })),
    changelog: vi.fn(async () => ({ changelog: [], audit: [] })),
    outcomes: vi.fn(async () => ({ outcomes: [], accuracy: { count: 0, meanCostAccuracy: 0, directionHitRate: 0, recommenderUsable: false } })),
    budgets: vi.fn(async () => ({ gauges: [], alerts: [] })),
    policy: vi.fn(async () => ({ rules: [], violations: [] })),
    quarantineDryRun: vi.fn(async (_r: string, check: string) => {
      if (check === 'build') throw new Error('"build" is a required merge gate — cannot quarantine it');
      return { dryRun: true as const, diff: '@@ e2e quarantine — continue-on-error @@', baseSha: 'abc' };
    }),
    quarantines: vi.fn(async (repo: string) => ({ repo, quarantines: [] })),
    prefixesDryRun: vi.fn(async () => ({ dryRun: true as const, file: '.pr-dashboard.yml', prefixes: ['build'], newText: 'requiredCheckPrefixes:\n  - build\n', baseSha: 's' })),
    prefixesOpen: vi.fn(async () => ({ opened: true as const, number: 1, url: 'u', prefixes: ['build'] })),
    plan: vi.fn(async (_r: string, moves: { check: string }[]) => ({
      combinedCostDeltaMinutes: -5000, legal: !moves.some((m) => m.check === 'build'),
      reason: moves.some((m) => m.check === 'build') ? 'build: required-gate' : undefined, results: [],
    })),
    candidate: vi.fn(async () => ({ ok: true, baseSha: 's', files: [], validation: { gatingRegressed: false, lostGates: [], lowConfidence: false }, model: null })),
    candidateApply: vi.fn(async () => ({ ok: true as const, number: 1, url: 'u' })),
    candidateRaw: vi.fn(async () => ({ ok: true, baseSha: 's', files: [], validation: { gatingRegressed: false, lostGates: [], lowConfidence: false }, model: null })),
    ...over,
  };
}

describe('OptimizeView (US4 — drives /api/workspace loop)', () => {
  it('loads the model and lists checks', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    expect((await screen.findAllByText('e2e')).length).toBeGreaterThan(0);
    expect(screen.getByText('build')).toBeInTheDocument();
  });

  it('simulating a legal demote shows the saving + offers a draft-PR preview', async () => {
    const api = fakeApi();
    render(<OptimizeView repo="o/r" api={api} />);
    fireEvent.click((await screen.findAllByText('Simulate demote'))[0]); // e2e
    expect(await screen.findByText(/saves 5,000 min/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Preview draft PR'));
    expect(await screen.findByLabelText('draft PR diff')).toHaveTextContent('e2e → merge_group');
  });

  it('flags a low-confidence projection as scaffold-only (roadmap 4.2)', async () => {
    const api = fakeApi({
      simulate: vi.fn(async () => ({
        legal: true, note: 'saves 30 min · low confidence', costDeltaMinutes: -30,
        direction: 'remove', gatesLost: [], gatesGained: [], estimated: false, confidence: 'low' as const,
      })),
    });
    render(<OptimizeView repo="o/r" api={api} />);
    fireEvent.click((await screen.findAllByText('Simulate demote'))[0]);
    expect(await screen.findByText(/review scaffold, not a structured apply/)).toBeInTheDocument();
  });

  it('a legal demote offers a Claude Code prompt that surfaces the generated text (FR-013/016)', async () => {
    const api = fakeApi({ prompt: vi.fn(async () => ({ prompt: 'In o/r, demote the CI check "e2e"…' })) });
    render(<OptimizeView repo="o/r" api={api} />);
    fireEvent.click((await screen.findAllByText('Simulate demote'))[0]); // e2e (legal)
    await screen.findByText(/saves 5,000 min/);
    fireEvent.click(screen.getByText('Copy Claude Code prompt'));
    expect(await screen.findByLabelText('claude code prompt')).toHaveTextContent('In o/r, demote the CI check');
    expect(api.prompt).toHaveBeenCalledWith('o/r', expect.objectContaining({ goal: 'cost', check: 'e2e', fromTierId: 'pr' }));
  });

  it('does not offer a Claude Code prompt for a blocked required-gate demote', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    const buttons = await screen.findAllByText('Simulate demote');
    fireEvent.click(buttons[1]); // build (required gate)
    await screen.findByText(/not possible — required merge gate/);
    expect(screen.queryByText('Copy Claude Code prompt')).not.toBeInTheDocument();
  });

  it('a required-gate demote is shown as blocked (no preview button)', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    const buttons = await screen.findAllByText('Simulate demote');
    fireEvent.click(buttons[1]); // build (required gate)
    expect(await screen.findByText(/not possible — required merge gate/)).toBeInTheDocument();
    expect(screen.queryByText('Preview draft PR')).not.toBeInTheDocument();
  });

  it('quarantine (K2): previews the diff for a flaky non-gate', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    const btns = await screen.findAllByText('Quarantine (flaky)');
    fireEvent.click(btns[0]); // e2e (not a required gate)
    expect(await screen.findByLabelText('quarantine diff')).toHaveTextContent('continue-on-error');
  });

  it('quarantine (K2): shows the server refusal for a required merge gate (FR-038)', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    const btns = await screen.findAllByText('Quarantine (flaky)');
    fireEvent.click(btns[1]); // build (required gate)
    expect(await screen.findByText(/Can’t quarantine build/)).toHaveTextContent(/required merge gate/);
  });

  it('multi-change planning (N2): composites selected demotes and shows the combined saving', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    const checkboxes = await screen.findAllByLabelText(/Add .* to plan/);
    fireEvent.click(checkboxes[0]); // e2e
    fireEvent.click(screen.getByText(/Simulate plan \(1 change\)/));
    expect(await screen.findByText(/Plan is safe — combined saves 5,000 min/)).toBeInTheDocument();
  });

  it('multi-change planning (N2): surfaces a blocked composite plan', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    const checkboxes = await screen.findAllByLabelText(/Add .* to plan/);
    fireEvent.click(checkboxes[1]); // build (required gate)
    fireEvent.click(screen.getByText(/Simulate plan/));
    expect(await screen.findByText(/Plan blocked — build: required-gate/)).toBeInTheDocument();
  });

  it('warns that verdicts are static-only when the live ruleset is unreadable (roadmap 4.6)', async () => {
    const api = fakeApi({ ruleset: vi.fn(async () => ({ readable: false, derivedRequired: [], liveRequired: [], missingFromModel: [], extraInModel: [], inSync: false })) });
    render(<OptimizeView repo="o/r" api={api} />);
    expect(await screen.findByText(/static-only/i)).toBeInTheDocument();
    expect(screen.getByText('administration:read')).toBeInTheDocument();
  });

  it('shows no static-only caveat when the ruleset is readable', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    await screen.findAllByText('Simulate demote');
    expect(screen.queryByText(/static-only/i)).not.toBeInTheDocument();
  });

  it('leads with ranked findings showing impact up front, one-click to simulate (roadmap 5.2)', async () => {
    const api = fakeApi();
    render(<OptimizeView repo="o/r" api={api} />);
    const findings = await screen.findByLabelText('Findings');
    // the always-green e2e (5,000 min, 0 real failures in the fixture) is a demotion candidate
    expect(findings).toHaveTextContent(/e2e/);
    expect(findings).toHaveTextContent(/5,000 min\/window · never failed/);
    fireEvent.click(within(findings).getByRole('button', { name: 'Simulate' }));
    expect(await screen.findByText(/saves 5,000 min/)).toBeInTheDocument();
  });

  it('shows closed-loop calibration accuracy when past changes have landed (roadmap 5.4)', async () => {
    const api = fakeApi({ outcomes: vi.fn(async () => ({ outcomes: [{ prNumber: 5, check: 'e2e', costAccuracy: 0.9, directionCorrect: true, confidence: 'high', caveat: '' }], accuracy: { count: 4, meanCostAccuracy: 0.83, directionHitRate: 1, recommenderUsable: false } })) });
    render(<OptimizeView repo="o/r" api={api} />);
    expect(await screen.findByText(/83% accurate/)).toBeInTheDocument();
    expect(screen.getByText(/4 landed changes.*advisory until proven/)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    const api = fakeApi({ getPipeline: vi.fn(async () => { throw new Error('no derivable model'); }) });
    render(<OptimizeView repo="o/r" api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no derivable model');
  });

  // Issue #168: per-action pending state — one in-flight action must NOT disable unrelated buttons
  it('#168: simulate in-flight does not disable the quarantine button for other rows', async () => {
    let resolveSimulate!: (v: unknown) => void;
    const hangingSimulate = new Promise((res) => { resolveSimulate = res; });
    const api = fakeApi({
      simulate: vi.fn(() => hangingSimulate as Promise<never>),
    });
    render(<OptimizeView repo="o/r" api={api} />);

    // Wait for the model to render and click "Simulate demote" for e2e (row 0)
    const simulateBtns = await screen.findAllByText('Simulate demote');
    fireEvent.click(simulateBtns[0]); // e2e simulate — now in-flight

    // The quarantine button for a DIFFERENT row (build, index 1) must NOT be disabled
    const quarantineBtns = await screen.findAllByText('Quarantine (flaky)');
    expect(quarantineBtns[1]).not.toBeDisabled();

    // The simulate button for the SAME row (e2e, index 0) MUST be disabled (prevents double-submit)
    expect(simulateBtns[0]).toBeDisabled();

    // Unblock the promise so the component can settle
    resolveSimulate({ legal: true, note: 'ok', costDeltaMinutes: 0, direction: 'remove', gatesLost: [], gatesGained: [], estimated: false });
  });

  it('#168: quarantine in-flight does not disable the simulate buttons', async () => {
    let resolveQuarantine!: (v: unknown) => void;
    const hangingQuarantine = new Promise((res) => { resolveQuarantine = res; });
    const api = fakeApi({
      quarantineDryRun: vi.fn(() => hangingQuarantine as Promise<never>),
    });
    render(<OptimizeView repo="o/r" api={api} />);

    const quarantineBtns = await screen.findAllByText('Quarantine (flaky)');
    fireEvent.click(quarantineBtns[0]); // e2e quarantine — now in-flight

    // Simulate demote button for ANY row must NOT be disabled
    const simulateBtns = await screen.findAllByText('Simulate demote');
    expect(simulateBtns[0]).not.toBeDisabled();
    expect(simulateBtns[1]).not.toBeDisabled();

    // The quarantine button for THE SAME row (e2e, index 0) MUST be disabled
    expect(quarantineBtns[0]).toBeDisabled();

    resolveQuarantine({ dryRun: true, diff: '@@ @@', baseSha: 'abc' });
  });
});
