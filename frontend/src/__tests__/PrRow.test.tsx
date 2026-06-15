import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrRow, readyMergeGate } from '../PrRow';
import type { PrView, CheckView } from '../types';

const pr = (over: Partial<PrView>): PrView => ({
  repo: 'acme/widgets', number: 8962, title: 'fix: calendar overlap', url: 'https://x/8962',
  stage: { stage: 'ci', substate: null, percent: 72, etaSeconds: 240, etaRangeSeconds: null, overdue: false },
  queueAheadCount: null,
  checks: [
    { name: 'fast-checks / ESLint', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true, workflowName: null,
      elapsedSeconds: 180, expectedSeconds: 200, url: 'https://x/run1',
        expectedLowSeconds: null, expectedHighSeconds: null,
        waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false },
    { name: 'lighthouse', status: 'IN_PROGRESS', conclusion: null, isRequired: false, workflowName: null,
      elapsedSeconds: 60, expectedSeconds: 300, url: null,
        expectedLowSeconds: null, expectedHighSeconds: null,
        waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false },
  ],
  groupChecks: null,
  mergeEtaSim: null,
  ...over,
});

describe('PrRow', () => {
  it('shows number, title link, right-aligned ETA, and the metro track for a running CI stage', () => {
    const { container } = render(<PrRow pr={pr({})} hasDeploy />);
    expect(screen.getByText('#8962')).toBeInTheDocument();
    expect(screen.getByText(/calendar overlap/)).toBeInTheDocument();
    expect(screen.getByText('~4m left')).toBeInTheDocument();
    // active node on the track with bold label + ETA beneath
    const active = container.querySelector('.node.active')!;
    expect(active.querySelector('.node-label')!.textContent).toBe('CI');
    expect(active.querySelector('.node-eta')!.textContent).toBe('~4m');
  });

  it('has id="pr-{number}" on the row root (anchor target for the queue train)', () => {
    const { container } = render(<PrRow pr={pr({})} hasDeploy />);
    expect(container.querySelector('#pr-8962')).not.toBeNull();
  });

  it('shows the stage percent in the muted sub line for a running CI stage', () => {
    render(<PrRow pr={pr({})} hasDeploy />);
    // only advisory checks are in progress in the fixture → percent only
    expect(screen.getByText('72%')).toBeInTheDocument();
  });

  it('appends the longest-running in-progress required check to the ci sub line', () => {
    render(<PrRow pr={pr({ checks: [
      { name: 'static-checks / TypeScript', status: 'IN_PROGRESS', conclusion: null, isRequired: true, workflowName: null,
        elapsedSeconds: 120, expectedSeconds: 240, url: null,
        expectedLowSeconds: null, expectedHighSeconds: null,
        waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false },
      { name: 'pr-affected-tests', status: 'IN_PROGRESS', conclusion: null, isRequired: true, workflowName: null,
        elapsedSeconds: 240, expectedSeconds: 540, url: null,
        expectedLowSeconds: null, expectedHighSeconds: null,
        waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false },
      { name: 'lighthouse', status: 'IN_PROGRESS', conclusion: null, isRequired: false, workflowName: null,
        elapsedSeconds: 600, expectedSeconds: 700, url: null,
        expectedLowSeconds: null, expectedHighSeconds: null,
        waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false },
    ] })} hasDeploy />);
    expect(screen.getByText('72% · pr-affected-tests running 4m of ~9m')).toBeInTheDocument();
  });

  it('renders parked ci-failed as a red ✗ CI node with the substate reason in the sub line, no percent', () => {
    const { container } = render(<PrRow pr={pr({
      stage: { stage: 'parked', substate: 'ci-failed', percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false },
    })} hasDeploy />);
    expect(screen.getByText('CI failed')).toBeInTheDocument();
    expect(container.querySelector('.node.fail')).not.toBeNull();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('renders parked draft as an amber parked node labeled with the substate', () => {
    const { container } = render(<PrRow pr={pr({
      stage: { stage: 'parked', substate: 'draft', percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false },
    })} hasDeploy />);
    const parked = container.querySelector('.node.parked')!;
    expect(parked.querySelector('.c')!.textContent).toBe('!');
    expect(parked.querySelector('.node-label')!.textContent).toBe('draft');
    expect(screen.getByText('Draft')).toBeInTheDocument(); // sub line reason
  });

  it('expands on row click to show check detail, collapses on second click', () => {
    render(<PrRow pr={pr({})} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.getByText('fast-checks / ESLint')).toBeInTheDocument();
    expect(screen.queryByText('advisory')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.queryByText('fast-checks / ESLint')).not.toBeInTheDocument();
  });

  it('expandable=false (kiosk): clicking the row does not open the check panel', () => {
    render(<PrRow pr={pr({})} hasDeploy expandable={false} />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.queryByText('fast-checks / ESLint')).not.toBeInTheDocument();
  });

  it('shows "behind 9" in the sub line when stage=queue and queueAheadCount=9', () => {
    render(<PrRow pr={pr({
      stage: { stage: 'queue', substate: null, percent: null, etaSeconds: 600, etaRangeSeconds: null, overdue: false },
      queueAheadCount: 9,
    })} hasDeploy />);
    expect(screen.getByText(/behind 9/)).toBeInTheDocument();
  });

  it('does not show "behind" when aheadCount=0 or null', () => {
    const queueStage = { stage: 'queue' as const, substate: null, percent: null, etaSeconds: 600, etaRangeSeconds: null, overdue: false };
    const { unmount } = render(<PrRow pr={pr({ stage: queueStage, queueAheadCount: 0 })} hasDeploy />);
    expect(screen.queryByText(/behind/)).not.toBeInTheDocument();
    unmount();
    render(<PrRow pr={pr({ stage: queueStage, queueAheadCount: null })} hasDeploy />);
    expect(screen.queryByText(/behind/)).not.toBeInTheDocument();
  });

  it('shows group failure + last percent + position in the sub line for queue/group-failed', () => {
    const { container } = render(<PrRow pr={pr({
      stage: { stage: 'queue', substate: 'group-failed', percent: 89, etaSeconds: null, etaRangeSeconds: null, overdue: false },
      queueAheadCount: 2,
    })} hasDeploy />);
    // the percent is the merge-group build's, never head-commit checks — labeled 'group'
    expect(screen.getByText('Queue group failed · group 89% · behind 2')).toBeInTheDocument();
    expect(container.querySelector('.node.fail .node-label')!.textContent).toBe('Queue');
  });

  it('labels the queue sub-line percent as the group build', () => {
    render(<PrRow pr={pr({
      stage: { stage: 'queue', substate: null, percent: 30, etaSeconds: 600, etaRangeSeconds: null, overdue: false },
    })} hasDeploy />);
    expect(screen.getByText('group 30%')).toBeInTheDocument();
  });

  // HEADGREEN: a group member covered by a building group shows the group's
  // progress with no waiting-line math (aheadCount is 0 for covered members)
  it('covered group member shows the group percent and no "behind" math', () => {
    render(<PrRow pr={pr({
      stage: { stage: 'queue', substate: null, percent: 45, etaSeconds: 300, etaRangeSeconds: null, overdue: false },
      queueAheadCount: 0,
    })} hasDeploy />);
    expect(screen.getByText('group 45%')).toBeInTheDocument();
    expect(screen.queryByText(/behind/)).not.toBeInTheDocument();
  });

  it('queue/unmergeable shows the rebase-needed sub line and no waiting-line math', () => {
    render(<PrRow pr={pr({
      stage: { stage: 'queue', substate: 'unmergeable', percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false },
      queueAheadCount: 0,
    })} hasDeploy />);
    expect(screen.getByText('unmergeable — needs rebase before it can merge')).toBeInTheDocument();
    expect(screen.queryByText(/behind/)).not.toBeInTheDocument();
  });

  // Cascade victims: UNMERGEABLE only because a conflicting entry ahead poisons
  // their speculative merge — "needs rebase" would be wrong advice.
  const queueBlocked = (number = 8962) => pr({
    number,
    stage: { stage: 'queue', substate: 'queue-blocked', percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false },
    queueAheadCount: 0,
  });

  it('queue/queue-blocked names the culprit in the sub line and never says rebase', () => {
    render(<PrRow pr={queueBlocked()} hasDeploy queueCulprit={8878} />);
    expect(screen.getByText('queue blocked — conflict ahead (#8878)')).toBeInTheDocument();
    expect(screen.queryByText(/rebase/)).not.toBeInTheDocument();
    expect(screen.queryByText(/behind \d/)).not.toBeInTheDocument();
  });

  it('queue/queue-blocked without a known culprit drops the PR-number suffix', () => {
    render(<PrRow pr={queueBlocked()} hasDeploy />);
    expect(screen.getByText('queue blocked — conflict ahead')).toBeInTheDocument();
  });

  it('queue/queue-blocked culprit equal to the PR itself drops the suffix (fallback culprit at the front)', () => {
    render(<PrRow pr={queueBlocked(8878)} hasDeploy queueCulprit={8878} />);
    expect(screen.getByText('queue blocked — conflict ahead')).toBeInTheDocument();
  });

  it('queued PR with groupChecks shows the merge-group section first, then PR checks (Y2)', () => {
    const groupCheck = { name: 'ci', status: 'IN_PROGRESS', conclusion: null, isRequired: true,
      workflowName: 'CI', elapsedSeconds: 300, expectedSeconds: 600, url: 'https://x/group',
      expectedLowSeconds: null, expectedHighSeconds: null,
      waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false };
    render(<PrRow pr={pr({
      stage: { stage: 'queue', substate: null, percent: 50, etaSeconds: 300, etaRangeSeconds: null, overdue: false },
      groupChecks: [groupCheck],
    })} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    const labels = screen.getAllByText(/merge group build|PR checks \(head commit\)/);
    expect(labels.map((l) => l.textContent)).toEqual(['merge group build', 'PR checks (head commit)']);
    // group section comes first in the document
    const groupLabel = screen.getByText('merge group build');
    const prLabel = screen.getByText('PR checks (head commit)');
    expect(groupLabel.compareDocumentPosition(prLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // group check rendered alongside the existing head-commit checks
    expect(screen.getByText('ci')).toBeInTheDocument();
    expect(screen.getByText('fast-checks / ESLint')).toBeInTheDocument();
  });

  it('non-queued PRs render the single un-labeled panel (unchanged)', () => {
    render(<PrRow pr={pr({})} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.getByText('fast-checks / ESLint')).toBeInTheDocument();
    expect(screen.queryByText('merge group build')).not.toBeInTheDocument();
    expect(screen.queryByText(/PR checks/)).not.toBeInTheDocument();
  });

  it('queued PR without groupChecks (rollup not fetched) keeps the plain panel', () => {
    render(<PrRow pr={pr({
      stage: { stage: 'queue', substate: null, percent: null, etaSeconds: 600, etaRangeSeconds: null, overdue: false },
      groupChecks: null,
    })} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.getByText('fast-checks / ESLint')).toBeInTheDocument();
    expect(screen.queryByText('merge group build')).not.toBeInTheDocument();
  });

  it('sub-line shows runner-wait summary when ≥1 required check has waitKind=runner and none are IN_PROGRESS', () => {
    render(<PrRow pr={pr({
      stage: { stage: 'ci', substate: null, percent: 20, etaSeconds: 300, etaRangeSeconds: null, overdue: false },
      checks: [
        { name: 'unit-tests', status: 'QUEUED', conclusion: null, isRequired: true, workflowName: null,
          elapsedSeconds: null, expectedSeconds: null, url: null,
          expectedLowSeconds: null, expectedHighSeconds: null,
          waitKind: 'runner', blockedOn: null, waitingSeconds: 60, expectedRunnerWaitSeconds: 90, flakeRatePct: null, likelyFlake: false },
        { name: 'integration-tests', status: 'QUEUED', conclusion: null, isRequired: true, workflowName: null,
          elapsedSeconds: null, expectedSeconds: null, url: null,
          expectedLowSeconds: null, expectedHighSeconds: null,
          waitKind: 'runner', blockedOn: null, waitingSeconds: 30, expectedRunnerWaitSeconds: 120, flakeRatePct: null, likelyFlake: false },
      ],
    })} hasDeploy />);
    // 2 runner-wait jobs; max expected = 120s = 2m; shows "typical ~2m"
    expect(screen.getByText('waiting for runners (2 jobs) · typical ~2m')).toBeInTheDocument();
  });

  it('sub-line omits typical clause when no expected runner wait available', () => {
    render(<PrRow pr={pr({
      stage: { stage: 'ci', substate: null, percent: 10, etaSeconds: 300, etaRangeSeconds: null, overdue: false },
      checks: [
        { name: 'unit-tests', status: 'QUEUED', conclusion: null, isRequired: true, workflowName: null,
          elapsedSeconds: null, expectedSeconds: null, url: null,
          expectedLowSeconds: null, expectedHighSeconds: null,
          waitKind: 'runner', blockedOn: null, waitingSeconds: 45, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false },
      ],
    })} hasDeploy />);
    expect(screen.getByText('waiting for runners (1 jobs)')).toBeInTheDocument();
  });

  it('sub-line shows current-running text (not runner-wait) when a required check is IN_PROGRESS even if others are runner-wait', () => {
    render(<PrRow pr={pr({
      stage: { stage: 'ci', substate: null, percent: 55, etaSeconds: 120, etaRangeSeconds: null, overdue: false },
      checks: [
        { name: 'static-checks / TypeScript', status: 'IN_PROGRESS', conclusion: null, isRequired: true, workflowName: null,
          elapsedSeconds: 120, expectedSeconds: 240, url: null,
          expectedLowSeconds: null, expectedHighSeconds: null,
          waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false },
        { name: 'unit-tests', status: 'QUEUED', conclusion: null, isRequired: true, workflowName: null,
          elapsedSeconds: null, expectedSeconds: null, url: null,
          expectedLowSeconds: null, expectedHighSeconds: null,
          waitKind: 'runner', blockedOn: null, waitingSeconds: 30, expectedRunnerWaitSeconds: 60, flakeRatePct: null, likelyFlake: false },
      ],
    })} hasDeploy />);
    // IN_PROGRESS check is present → use existing running-check line, not runner-wait summary
    expect(screen.getByText(/static-checks \/ TypeScript running/)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for runners/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Issue #40: multi-train merge ETA chip on waiting queued PRs
// ---------------------------------------------------------------------------

describe('PrRow merge ETA simulation (issue #40)', () => {
  const queuedWaiting = (over: Partial<PrView> = {}) => pr({
    stage: { stage: 'queue', substate: null, percent: null,
      etaSeconds: 1500, etaRangeSeconds: null, overdue: false },
    queueAheadCount: 3,
    mergeEtaSim: { p50Secs: 1320, p90Secs: 2460, trainsAhead: 2, assumesEjects: true },
    ...over,
  });

  it('shows the p50/p90 pair instead of the single-number ETA, with the full tooltip', () => {
    render(<PrRow pr={queuedWaiting()} hasDeploy={false} />);
    const chip = screen.getByText('~22m / ~41m p90');
    expect(chip).toHaveClass('eta-sim');
    expect(chip).toHaveAttribute('title',
      'merges in ~22m (p50) / ~41m (p90, assumes ≤1 eject); 2 trains ahead');
    expect(screen.queryByText('~25m left')).toBeNull(); // single number replaced
  });

  it('keeps the "behind N" sub line (queueAheadCount stays)', () => {
    render(<PrRow pr={queuedWaiting()} hasDeploy={false} />);
    expect(screen.getByText(/behind 3/)).toBeInTheDocument();
  });

  it('no eject clause in the tooltip when assumesEjects is false', () => {
    render(<PrRow pr={queuedWaiting({
      mergeEtaSim: { p50Secs: 600, p90Secs: 900, trainsAhead: 1, assumesEjects: false },
    })} hasDeploy={false} />);
    expect(screen.getByText('~10m / ~15m p90')).toHaveAttribute('title',
      'merges in ~10m (p50) / ~15m (p90); 1 train ahead');
  });

  it('falls back to the single-number ETA without a sim (queued, no samples yet)', () => {
    render(<PrRow pr={queuedWaiting({ mergeEtaSim: null })} hasDeploy={false} />);
    expect(screen.getByText('~25m left')).toBeInTheDocument();
    expect(screen.queryByText(/p90/)).toBeNull();
  });

  it('never shows the sim chip outside the queue stage', () => {
    render(<PrRow pr={pr({
      mergeEtaSim: { p50Secs: 600, p90Secs: 900, trainsAhead: 1, assumesEjects: false },
    })} hasDeploy={false} />);
    expect(screen.queryByText(/p90/)).toBeNull();
    expect(screen.getByText('~4m left')).toBeInTheDocument(); // ci stage ETA intact
  });
});

// ---- per-PR waterfall (issue #50) ----
describe('PrRow waterfall (issue #50)', () => {
  const TIMELINE = {
    createdAt: '2026-06-10T08:00:00Z', firstGreenAt: '2026-06-10T09:00:00Z',
    enqueuedAt: '2026-06-10T09:30:00Z', mergedAt: '2026-06-10T10:00:00Z',
    qaLiveAt: '2026-06-10T10:20:00Z', prodLiveAt: null,
  };
  const mergedPr = (over: Partial<PrView> = {}): PrView => pr({
    stage: { stage: 'awaiting-prod', substate: null, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false },
    checks: [], timeline: TIMELINE, ...over,
  });

  it('expanding a merged PR with a timeline shows the waterfall panel', () => {
    const { container } = render(<PrRow pr={mergedPr()} hasDeploy />);
    expect(container.querySelector('.waterfall')).toBeNull(); // collapsed
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.getByText('where did the time go')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid^="waterfall-seg-"]').length).toBe(4);
  });

  it('no waterfall without a timeline (open PRs, pre-upgrade payloads)', () => {
    const { container } = render(<PrRow pr={pr({})} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(container.querySelector('.waterfall')).toBeNull();
    expect(screen.queryByText('where did the time go')).toBeNull();
  });

  it('timeline with no complete segment pair leaves the row unexpandable content-empty', () => {
    const { container } = render(<PrRow pr={mergedPr({
      timeline: { createdAt: null, firstGreenAt: null, enqueuedAt: null,
        mergedAt: '2026-06-10T10:00:00Z', qaLiveAt: null, prodLiveAt: null },
    })} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(container.querySelector('.waterfall')).toBeNull();
    expect(screen.queryByText('where did the time go')).toBeNull();
  });

  it('waterfall renders alongside check sections when checks exist too', () => {
    const { container } = render(<PrRow pr={mergedPr({ checks: pr({}).checks })} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.getByText('where did the time go')).toBeInTheDocument();
    expect(screen.getByText('fast-checks / ESLint')).toBeInTheDocument();
    expect(container.querySelector('.waterfall')).not.toBeNull();
  });
});

// ---- workflow-change impact annotation (issue #49) ----
describe('PrRow CI-change badge + impact card (issue #49)', () => {
  const IMPACT = { summary: [
    '+ android-smoke joins the merge_group gate',
    'required-check set grows by 1: 2 → 3 checks',
  ] };

  it('renders the ⚙ CI change badge when the PR touches workflows', () => {
    render(<PrRow pr={pr({ touchesWorkflows: true, workflowImpact: IMPACT })} hasDeploy />);
    const badge = screen.getByText('⚙ CI change');
    expect(badge).toBeInTheDocument();
    // summary lines ride the title tooltip
    expect(badge).toHaveAttribute('title', IMPACT.summary.join('\n'));
  });

  it('badge falls back to a generic tooltip without a computed diff', () => {
    render(<PrRow pr={pr({ touchesWorkflows: true, workflowImpact: null })} hasDeploy />);
    expect(screen.getByText('⚙ CI change')).toHaveAttribute('title',
      'touches .github/workflows — CI behavior may change');
  });

  it('no badge when the PR does not touch workflows (or on pre-upgrade payloads)', () => {
    render(<PrRow pr={pr({})} hasDeploy />);
    expect(screen.queryByText('⚙ CI change')).toBeNull();
  });

  it('expanding shows the impact card above the gantt with one line per summary entry', () => {
    const { container } = render(<PrRow pr={pr({ touchesWorkflows: true, workflowImpact: IMPACT })} hasDeploy />);
    expect(screen.queryByTestId('workflow-impact')).toBeNull(); // collapsed
    fireEvent.click(screen.getByText('#8962'));
    const card = screen.getByTestId('workflow-impact');
    expect(card).toBeInTheDocument();
    expect(screen.getByText('CI workflow change')).toBeInTheDocument();
    expect(card.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('+ android-smoke joins the merge_group gate')).toBeInTheDocument();
    // card precedes the check gantt in document order
    const gantt = container.querySelector('.checks.gantt')!;
    expect(card.compareDocumentPosition(gantt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no impact card when the diff is null or empty — badge only', () => {
    render(<PrRow pr={pr({ touchesWorkflows: true, workflowImpact: null })} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.queryByTestId('workflow-impact')).toBeNull();
  });
});

describe('PrRow — PR-level CI cost line (cost explorer)', () => {
  it('expanded panel shows minutes + dollars when both are present', () => {
    render(<PrRow pr={pr({ costMinutes: 38, costDollars: 1.2 })} hasDeploy />);
    expect(screen.queryByTestId('pr-cost')).toBeNull(); // collapsed
    fireEvent.click(screen.getByText('#8962'));
    const line = screen.getByTestId('pr-cost');
    expect(line.textContent).toBe('CI cost this run: 38m (~$1.20)');
    expect(line).toHaveAttribute('title', expect.stringContaining('CI cost this run'));
  });

  it("'(partial)' qualifies the $ when some checks ran on unpriced pools", () => {
    render(<PrRow pr={pr({ costMinutes: 38, costDollars: 1.2, costDollarsPartial: true })} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.getByTestId('pr-cost').textContent)
      .toBe('CI cost this run: 38m (~$1.20) (partial)');
  });

  it("no '(partial)' suffix in minutes-only mode — the flag only qualifies a $ figure", () => {
    render(<PrRow pr={pr({ costMinutes: 90, costDollars: null, costDollarsPartial: false })} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.getByTestId('pr-cost').textContent).toBe('CI cost this run: 1h 30m');
  });

  it('minutes-only when no rates are configured (costDollars null)', () => {
    render(<PrRow pr={pr({ costMinutes: 90, costDollars: null })} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.getByTestId('pr-cost').textContent).toBe('CI cost this run: 1h 30m');
  });

  it('hidden when costMinutes is null (nothing started / merged PRs / pre-upgrade payloads)', () => {
    render(<PrRow pr={pr({ costMinutes: null, costDollars: null })} hasDeploy />);
    fireEvent.click(screen.getByText('#8962'));
    expect(screen.queryByTestId('pr-cost')).toBeNull();
    // pre-upgrade payload: the fields are absent entirely
    render(<PrRow pr={pr({})} hasDeploy />);
    expect(screen.queryByTestId('pr-cost')).toBeNull();
  });
});

describe('PrRow ready+auto-merge action', () => {
  afterEach(() => vi.unstubAllGlobals());

  const mkCheck = (over: Partial<CheckView>): CheckView => ({
    name: 'static-checks / TypeScript', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true,
    workflowName: null, elapsedSeconds: 100, expectedSeconds: 120, url: null,
    expectedLowSeconds: null, expectedHighSeconds: null, waitKind: null, blockedOn: null,
    waitingSeconds: null, expectedRunnerWaitSeconds: null, flakeRatePct: null, likelyFlake: false, ...over });

  const draft = (over: Partial<PrView> = {}): PrView => pr({
    stage: { stage: 'parked', substate: 'draft', percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false },
    checks: [], ...over });

  it('readyMergeGate: only drafts show the button; conflict and failed-check block it', () => {
    expect(readyMergeGate(pr({})).show).toBe(false); // non-draft
    expect(readyMergeGate(draft()).show).toBe(true);
    expect(readyMergeGate(draft()).blocked).toBe(false);
    expect(readyMergeGate(draft({ mergeStateStatus: 'DIRTY' })).blocked).toBe(true);
    expect(readyMergeGate(draft({ checks: [mkCheck({ conclusion: 'FAILURE' })] })).blocked).toBe(true);
    // a still-running required check does NOT block (auto-merge waits for green)
    expect(readyMergeGate(draft({ checks: [mkCheck({ status: 'IN_PROGRESS', conclusion: null })] })).blocked).toBe(false);
  });

  it('renders an enabled button on a clean draft, hidden on a non-draft', () => {
    const { rerender } = render(<PrRow pr={draft()} hasDeploy />);
    expect(screen.getByTestId('pr-ready-merge')).toBeEnabled();
    rerender(<PrRow pr={pr({})} hasDeploy />);
    expect(screen.queryByTestId('pr-ready-merge')).toBeNull();
  });

  it('disables the button (with a reason) when the draft conflicts with base', () => {
    render(<PrRow pr={draft({ mergeStateStatus: 'DIRTY' })} hasDeploy />);
    expect(screen.getByTestId('pr-ready-merge')).toBeDisabled();
    expect(screen.getByText(/conflicts with base/)).toBeInTheDocument();
  });

  it('disables the button when a required check has already failed', () => {
    render(<PrRow pr={draft({ checks: [mkCheck({ conclusion: 'FAILURE', name: 'unit-tests' })] })} hasDeploy />);
    expect(screen.getByTestId('pr-ready-merge')).toBeDisabled();
    expect(screen.getByText(/required check failing \(unit-tests\)/)).toBeInTheDocument();
  });

  it('is hidden in kiosk (non-expandable) mode', () => {
    render(<PrRow pr={draft()} hasDeploy expandable={false} />);
    expect(screen.queryByTestId('pr-ready-merge')).toBeNull();
  });

  it('POSTs { repo, number } and shows the armed result on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markedReady: true, autoMergeArmed: true, alreadyArmed: false, cleanReadyToMerge: false }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PrRow pr={draft()} hasDeploy />);
    fireEvent.click(screen.getByTestId('pr-ready-merge'));
    const msg = await screen.findByTestId('pr-action-msg');
    expect(msg.textContent).toMatch(/marked ready · auto-merge armed/);
    expect(msg.textContent).toContain('✓'); // non-colour success channel (UX-L4)
    expect(fetchMock).toHaveBeenCalledWith('/api/pr/ready-merge', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ repo: 'acme/widgets', number: 8962 });
  });

  it('surfaces a server error message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: 'GitHub App lacks pull_requests:write' }),
    }));
    render(<PrRow pr={draft()} hasDeploy />);
    fireEvent.click(screen.getByTestId('pr-ready-merge'));
    const msg = await screen.findByTestId('pr-action-msg');
    expect(msg).toHaveClass('err');
    expect(msg.textContent).toMatch(/pull_requests:write/);
    expect(msg.textContent).toContain('✗');     // non-colour failure channel (UX-L4)
    expect(msg.textContent).toContain('Error:'); // …plus a text prefix
  });
});

describe('PrRow keyboard expand (UX-H1)', () => {
  it('the summary is a keyboard-operable button that toggles on Enter/Space', () => {
    const { container } = render(<PrRow pr={pr({})} hasDeploy />);
    const main = container.querySelector('.pr-main')!;
    expect(main).toHaveAttribute('role', 'button');
    expect(main).toHaveAttribute('tabindex', '0');
    expect(main).toHaveAttribute('aria-expanded', 'false');
    // collapsed: expanded-only check gantt absent
    expect(screen.queryByText('fast-checks / ESLint')).toBeNull();
    fireEvent.keyDown(main, { key: 'Enter' });
    expect(main).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('fast-checks / ESLint')).toBeInTheDocument();
    fireEvent.keyDown(main, { key: ' ' });
    expect(main).toHaveAttribute('aria-expanded', 'false');
  });

  it('is inert (no role/tabindex) in non-expandable kiosk mode', () => {
    const { container } = render(<PrRow pr={pr({})} hasDeploy expandable={false} />);
    const main = container.querySelector('.pr-main')!;
    expect(main).not.toHaveAttribute('role');
    expect(main).not.toHaveAttribute('tabindex');
  });
});
