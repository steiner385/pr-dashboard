import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MetricsView } from '../MetricsView';
import type { MetricsBucket, MetricsPayload, MetricsWindow } from '../types';

const EMPTY: MetricsPayload = {
  window: '3d', bucket: 'hour',
  runnerWaits: [], queue: [], queueEfficiency: [], slowestJobs: [], velocity: [],
  leadTime: [], trends: [],
  calibration: [], flakiness: [], demotionCandidates: [], promotionCandidates: [], trainKillers: [], criticalPath: [], lint: [],
  regressions: [], runnerPools: [], reclaims: [], concurrency: [], cost: [],
};

const H = (h: number): string => `2026-06-11T${String(h).padStart(2, '0')}`;
/** Fixed clock so the window axis lines up with the fixture buckets. */
const NOW = () => new Date('2026-06-11T10:30:00Z');

const PAYLOAD: MetricsPayload = {
  window: '3d', bucket: 'hour',
  runnerWaits: [
    { repo: 'acme/widgets', event: 'pull_request', p50: { value: 45, prev: 30 }, buckets: [
      { bucket: H(8), p50: 30, p90: 60, n: 4 },
      { bucket: H(9), p50: 45, p90: 240, n: 6 },
      { bucket: H(10), p50: 40, p90: 120, n: 5 },
    ] },
    { repo: 'acme/widgets', event: 'merge_group', p50: { value: 120, prev: null }, buckets: [
      { bucket: H(10), p50: 120, p90: 300, n: 2 },
    ] },
  ],
  queue: [
    { repo: 'acme/widgets',
      merges: { value: 8, prev: 4 },
      queueWaitP50: { value: 480, prev: 480 },
      groupRunP50: { value: 900, prev: null },
      mergesPerBucket: [
        { bucket: H(8), count: 3 }, { bucket: H(9), count: 2 }, { bucket: H(10), count: 3 }],
      queueWaitBuckets: [
        { bucket: H(8), p50: 500, n: 3 }, { bucket: H(9), p50: 460, n: 2 }, { bucket: H(10), p50: 480, n: 3 }],
      groupRunBuckets: [{ bucket: H(10), p50: 900, n: 2 }] },
  ],
  queueEfficiency: [
    { repo: 'acme/widgets', mergeGroupRuns: 13, queueMerges: 2, runsPerMerge: 6.5,
      runConclusion: { total: 13, runFailed: 11, requiredFailed: 1, advisoryNoise: 10,
        requiredConfigured: true },
      adminBypass: { merges: 20, bypasses: 3, rate: 0.15 } },
  ],
  slowestJobs: [
    { repo: 'acme/widgets', jobs: [
      { name: 'Integration Tests', event: 'merge_group', p50: 1200, p90: 1500,
        variability: 1.25, n: 14, trend: [
          { bucket: H(8), p50: 1100, p90: 1300, n: 4 },
          { bucket: H(9), p50: 1200, p90: 1500, n: 5 },
          { bucket: H(10), p50: 1250, p90: 1450, n: 5 },
        ] },
      { name: 'flaky-suite', event: 'pull_request', p50: 300, p90: 1200,
        variability: 4, n: 9, trend: [{ bucket: H(10), p50: 300, p90: 1200, n: 9 }] },
    ] },
  ],
  velocity: [
    { repo: 'acme/widgets',
      merged: { value: 5, prev: 5 },
      mergeToQaP50: { value: 600, prev: 300 },
      lifespanMeanHours: { value: 26, prev: null },
      mergedPerBucket: [
        { bucket: H(8), count: 2 }, { bucket: H(9), count: 1 }, { bucket: H(10), count: 2 }],
      mergeToQaBuckets: [
        { bucket: H(8), p50: 600, n: 2 }, { bucket: H(9), p50: 540, n: 1 }, { bucket: H(10), p50: 660, n: 2 }],
      avgLifespanBuckets: [
        { bucket: H(8), meanHours: 20, n: 2 }, { bucket: H(9), meanHours: 30, n: 1 }, { bucket: H(10), meanHours: 26, n: 2 }] },
  ],
  leadTime: [
    { repo: 'acme/widgets',
      segments: [
        { id: 'toFirstGreen', medianSecs: 5400, n: 2 },
        { id: 'greenToEnqueued', medianSecs: 300, n: 2 },
        { id: 'queue', medianSecs: 1200, n: 3 },
        { id: 'qaDeploy', medianSecs: 600, n: 8 },
        { id: 'awaitingProd', medianSecs: 86400, n: 6 },
      ],
      totalP50Secs: 93900, totalN: 6, prodDeploys: 6, deploysPerDay: 2 },
  ],
  trends: [
    { repo: 'acme/widgets', points: [
      { bucket: H(8), open: 12, ci: 3, queue: 2, failed: 1 },
      { bucket: H(9), open: 12, ci: 2, queue: 1, failed: 1 },
      { bucket: H(10), open: 11, ci: 2, queue: 1, failed: 0 },
    ] },
  ],
  calibration: [
    { repo: 'acme/widgets', stage: 'ci', n: 42,
      medianErrorPct: 18.4, p90AbsErrorPct: 55,
      buckets: [
        { bucket: H(8), medianErrorPct: 12, n: 14 },
        { bucket: H(9), medianErrorPct: -5, n: 13 },
        { bucket: H(10), medianErrorPct: 22, n: 15 },
      ],
      points: [
        { predicted: 300, actual: 360 }, { predicted: 240, actual: 230 },
        { predicted: 500, actual: 640 }, { predicted: 120, actual: 130 },
      ] },
    { repo: 'acme/widgets', stage: 'queue', n: 11,
      medianErrorPct: -7.2, p90AbsErrorPct: 20,
      buckets: [
        { bucket: H(9), medianErrorPct: -8, n: 6 },
        { bucket: H(10), medianErrorPct: -6, n: 5 },
      ],
      points: [{ predicted: 900, actual: 840 }, { predicted: 800, actual: 760 }] },
  ],
  flakiness: [
    { repo: 'acme/widgets', checks: [
      { name: 'HighFiveCue suite', event: 'pull_request',
        flakeEvents: 3, totalRuns: 13, flakeRatePct: 23.07,
        trend: [
          { bucket: H(8), flakeEvents: 1, runs: 5 },
          { bucket: H(9), flakeEvents: 1, runs: 4 },
          { bucket: H(10), flakeEvents: 1, runs: 4 },
        ] },
      { name: 'steady-job', event: 'merge_group',
        flakeEvents: 1, totalRuns: 10, flakeRatePct: 10,
        trend: [{ bucket: H(10), flakeEvents: 1, runs: 10 }] },
    ] },
  ],
  demotionCandidates: [
    { repo: 'acme/widgets', candidates: [
      { name: 'lint: eslint', event: 'pull_request', currentTier: 'every PR push',
        suggestedTier: 'merge queue only', successRatePct: 100, runsInWindow: 120,
        minutesInWindow: 240, reason: '120/120 green · ~240 runner-min in window' },
    ] },
  ],
  promotionCandidates: [
    { repo: 'acme/widgets', candidates: [
      { name: 'e2e', event: 'push', currentTier: 'every push to main (post-merge)',
        suggestedTier: 'merge queue (pre-merge gate)', realFailures: 6, incidents: 4, failRatePct: 5,
        runsInWindow: 120, minutesInWindow: 600,
        reason: '6 real (non-flaky) failures across 4 incidents in 120 runs (5%) — caught late' },
    ] },
  ],
  trainKillers: [
    { repo: 'acme/widgets', batchSize: 6, medianGroupRunSecs: 1800, checks: [
      { name: 'merge-group e2e', ejects: 7, estCostTrainHours: 21, flakeRatePct: 90,
        reasonCounts: { timeout: 5, 'test-fail': 1, infra: 1, unknown: 0 }, dominantReason: 'timeout', remedy: 'rerun (raise the timeout if it’s chronic)' },
      { name: 'db-migrations', ejects: 2, estCostTrainHours: 6, flakeRatePct: null,
        reasonCounts: { timeout: 0, 'test-fail': 2, infra: 0, unknown: 0 }, dominantReason: 'test-fail', remedy: 'fix the failing check' },
    ] },
  ],
  criticalPath: [
    { repo: 'acme/widgets', event: 'pull_request', endToEndP50Secs: 765,
      path: [
        { name: 'build', durationP50: 100, waitP50: 20 },
        { name: 'unit-tests', durationP50: 600, waitP50: 30 },
        { name: 'rollup-ci', durationP50: 10, waitP50: 5 },
      ],
      offPath: [{ name: 'bats-tests', slackSecs: 660 }] },
    { repo: 'acme/widgets', event: 'merge_group', endToEndP50Secs: 1010,
      path: [
        { name: 'build', durationP50: 100, waitP50: 0 },
        { name: 'integration-suite', durationP50: 900, waitP50: 0 },
        { name: 'rollup-ci', durationP50: 10, waitP50: 0 },
      ],
      offPath: [] },
  ],
  lint: [
    { repo: 'acme/widgets', findings: [
      { rule: 'timeout', severity: 'warn', job: 'unit-tests',
        message: 'timeout 11m vs p99 10m — will timeout-cancel on a slow run',
        observed: 600, configured: 660 },
      { rule: 'timeout', severity: 'info', job: 'build',
        message: 'timeout 60m vs p99 4m — tighten to fail fast',
        observed: 240, configured: 3600 },
    ] },
  ],
  regressions: [
    { repo: 'acme/widgets', checks: [
      { check: 'build-test', event: 'merge_group', priorP50Secs: 240,
        recentP50Secs: 600, ratio: 2.5, sinceApprox: '2026-06-09T14:00:00Z' },
      { check: 'unit-tests', event: 'pull_request', priorP50Secs: 120,
        recentP50Secs: 200, ratio: 1.67, sinceApprox: '2026-06-10T08:00:00Z' },
    ] },
  ],
  runnerPools: [
    { repo: 'acme/widgets', pool: 'kindash-runner', p50: { value: 45, prev: 20 },
      buckets: [
        { bucket: H(8), p50: 30, p90: 90, n: 5 },
        { bucket: H(9), p50: 45, p90: 1200, n: 8 },
        { bucket: H(10), p50: 50, p90: 1500, n: 6 },
      ],
      lastHourP90Secs: 1500, baselineP90Secs: 60, starving: true },
    { repo: 'acme/widgets', pool: 'kindash-ondemand', p50: { value: 4, prev: 5 },
      buckets: [{ bucket: H(10), p50: 4, p90: 9, n: 3 }],
      lastHourP90Secs: 9, baselineP90Secs: 8, starving: false },
  ],
  reclaims: [
    { repo: 'acme/widgets', total: 4,
      perBucket: [
        { bucket: H(8), count: 1 }, { bucket: H(9), count: 2 }, { bucket: H(10), count: 1 }],
      byPool: [
        { pool: 'kindash-runner', count: 3 },
        { pool: 'unknown', count: 1 },
      ] },
  ],
  concurrency: [
    { repo: 'acme/widgets', pool: 'kindash-runner', peak: 18, buckets: [
      { bucket: H(8), peak: 7 }, { bucket: H(9), peak: 18 }, { bucket: H(10), peak: 12 },
    ] },
    { repo: 'acme/widgets', pool: 'unknown', peak: 2, buckets: [
      { bucket: H(10), peak: 2 },
    ] },
  ],
  cost: [
    { repo: 'acme/widgets', totalMinutes: 1234, totalDollars: 18.51,
      retryMinutes: 96, retryDollars: 1.44,
      mergesInWindow: 8, minutesPerMergedPr: 154.25,
      pools: [
        { pool: 'kindash-runner', minutes: 1000, dollars: 8, instanceType: 'm7a.2xlarge spot',
          buckets: [
            { bucket: H(8), minutes: 400 }, { bucket: H(9), minutes: 350 },
            { bucket: H(10), minutes: 250 }] },
        { pool: 'kindash-runner|kindash-ondemand', minutes: 200, dollars: 10, instanceType: null,
          buckets: [
            { bucket: H(10), minutes: 200 }] },
        { pool: 'unknown', minutes: 34, dollars: null, instanceType: null, buckets: [
          { bucket: H(9), minutes: 34 }] },
      ] },
  ],
  costJobs: [
    { repo: 'acme/widgets', jobs: [
      { name: 'unit-tests (16 shards)', event: 'pull_request', minutes: 640, dollars: 5.12,
        pool: 'kindash-runner', samples: 96 },
      { name: 'e2e-tests', event: 'merge_group', minutes: 200, dollars: 10,
        pool: 'kindash-runner|kindash-ondemand', samples: 12 },
      { name: 'mystery', event: 'pull_request', minutes: 34, dollars: null,
        pool: 'unknown', samples: 3 },
    ] },
  ],
  costRuns: [
    { repo: 'acme/widgets', runs: [
      { event: 'pull_request', runNumber: 8123, headShaShort: 'abc1234', minutes: 95,
        dollars: 0.76, jobCount: 14, prNumber: 8962 },
      { event: 'merge_group', runNumber: 8124, headShaShort: 'def5678', minutes: 80,
        dollars: 0.64, jobCount: 12, prNumber: null },
    ] },
  ],
};

/** Empty RunnerPlanResponse — silences the RunnerRouting panel mounted in MetricsView. */
const RUNNER_PLAN_EMPTY = {
  enabled: false, shedCount: 0, lastError: null, lastPushedAt: null,
  lastVerifiedAt: null, lastPushedHash: null, map: {}, plan: [],
};

/** Mock fetch that echoes the requested window/bucket (server clamp emulated).
 *  Calls to /api/runner-plan (from the RunnerRouting panel) are handled
 *  transparently and are NOT tracked by the returned vi.fn() — existing
 *  toHaveBeenCalledTimes assertions stay accurate for metrics calls only. */
function mockFetchOk(payload: MetricsPayload = PAYLOAD) {
  const fn = vi.fn(async (url: string | URL | Request) => {
    const params = new URL(String(url), 'http://x').searchParams;
    const window = (params.get('window') ?? '3d') as MetricsWindow;
    const requested = (params.get('bucket') ?? 'hour') as MetricsBucket;
    const bucket: MetricsBucket = (window === '14d' || window === '30d') ? 'day' : requested;
    return {
      ok: true, status: 200,
      json: async () => ({ ...payload, window, bucket }),
    } as Response;
  });
  // Wrap: runner-plan + demotion-action calls bypass the tracked fn so call-count
  // assertions stay clean for metrics calls only.
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    if (String(url).includes('/api/runner-plan') || String(url).includes('/api/runner-routing')) {
      return { ok: true, status: 200, json: async () => RUNNER_PLAN_EMPTY } as Response;
    }
    if (String(url).includes('/api/demotion/draft-pr')) {
      return { ok: true, status: 200,
        json: async () => ({ number: 99, url: 'https://github.com/o/r/pull/99', branch: 'chore/demote-x' }) } as Response;
    }
    if (String(url).includes('/api/promotion/draft-pr')) {
      return { ok: true, status: 200,
        json: async () => ({ number: 88, url: 'https://github.com/o/r/pull/88', branch: 'chore/promote-x' }) } as Response;
    }
    return fn(url);
  });
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

const PANELS = ['Tuning actions', 'Recent config changes', 'Lead time', 'Trends', 'Runner-wait health', 'Queue throughput',
  'Queue efficiency', 'Batch-size advisor', 'CI needs graph',
  'Slowest / most-variable jobs', 'Merge velocity + deploy lag', 'ETA calibration'];

describe('MetricsView', () => {
  it('fetches window=3d bucket=hour by default and renders the core panels', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    expect(screen.getByText('Loading metrics…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Trends' })).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toBe('/api/metrics?window=3d&bucket=hour');
    for (const heading of PANELS) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });

  it('window pills cover 24h–30d with the default pressed', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    for (const w of ['24h', '3d', '7d', '14d', '30d']) {
      expect(screen.getByRole('button', { name: w })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '3d' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switching window refetches; hour stays available at 7d', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?window=7d&bucket=hour');
    expect(screen.getByRole('button', { name: 'hourly' })).not.toBeDisabled();
  });

  it('windows > 7d disable hourly and fetch day buckets', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    fireEvent.click(screen.getByRole('button', { name: '14d' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?window=14d&bucket=day');
    expect(screen.getByRole('button', { name: 'hourly' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'daily' })).toHaveAttribute('aria-pressed', 'true');
    // back to a short window re-enables hourly and restores the preference
    fireEvent.click(screen.getByRole('button', { name: '3d' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));
    expect(String(fetchFn.mock.calls[2]![0])).toBe('/api/metrics?window=3d&bucket=hour');
    expect(screen.getByRole('button', { name: 'hourly' })).not.toBeDisabled();
  });

  it('bucket toggle switches to daily buckets', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    fireEvent.click(screen.getByRole('button', { name: 'daily' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?window=3d&bucket=day');
    expect(screen.getByRole('button', { name: 'daily' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the refresh button refetches the current selection', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh metrics' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?window=3d&bucket=hour');
  });

  it('shows an error state when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 } as Response)));
    render(<MetricsView now={NOW} />);
    await waitFor(() => expect(screen.getByText(/metrics fetch failed/i)).toBeInTheDocument());
  });

  it('renders "no data yet" per empty panel (workflow lint says "no findings" instead)', async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    expect(screen.getAllByText('no data yet')).toHaveLength(10); // every panel except lint
    expect(screen.getByText('no findings')).toBeInTheDocument();
  });

  it('trends panel: one multi-line chart per repo with a legend and latest headline stats', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    const trends = screen.getByRole('heading', { name: 'Trends' }).closest('section')! as HTMLElement;
    // one chart, not four micro-multiples
    expect(trends.querySelectorAll('svg')).toHaveLength(1);
    // legend lists all four series
    const legend = trends.querySelector('.chart-legend')!;
    for (const name of ['open', 'ci', 'queue', 'failed']) {
      expect(within(legend as HTMLElement).getByText(name)).toBeInTheDocument();
    }
    // latest values (last bucket) as the headline stats
    const stats = [...trends.querySelectorAll('.metric-stat b')].map((b) => b.textContent);
    expect(stats).toEqual(['11', '2', '1', '0']);
  });

  it('headline stats show deltas vs the previous window when computable', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    // runner waits: 45 vs 30 → +50%; queue merges: 8 vs 4 → +100%
    expect(screen.getByText('+50% vs prev')).toBeInTheDocument();
    expect(screen.getAllByText('+100% vs prev').length).toBeGreaterThanOrEqual(1);
    // equal windows → "≈ prev" (queueWait 480 vs 480 and merged 5 vs 5)
    expect(screen.getAllByText('≈ prev').length).toBeGreaterThanOrEqual(2);
    // prev null (merge_group runner wait, group run, lifespan) → no delta rendered for those stats
    const mg = screen.getByText('merge_group p50 wait').closest('.metric-stat')! as HTMLElement;
    expect(mg.querySelector('.metric-delta')).toBeNull();
  });

  it('repos with zero data in a panel are omitted entirely', async () => {
    mockFetchOk({
      ...EMPTY,
      trends: [
        { repo: 'octo/empty', points: [] },
        { repo: 'acme/widgets', points: PAYLOAD.trends[0]!.points },
      ],
    });
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    expect(screen.getByRole('heading', { name: 'acme/widgets' })).toBeInTheDocument();
    expect(screen.queryByText('octo/empty')).toBeNull();
  });

  it('sparse series render the collecting-data placeholder instead of dots', async () => {
    mockFetchOk({
      ...EMPTY,
      queue: [{
        repo: 'acme/widgets',
        merges: { value: 2, prev: 0 },
        queueWaitP50: { value: null, prev: null },
        groupRunP50: { value: null, prev: null },
        mergesPerBucket: [{ bucket: H(9), count: 1 }, { bucket: H(10), count: 1 }],
        queueWaitBuckets: [],
        groupRunBuckets: [],
      }],
    });
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Queue throughput' });
    expect(screen.getByText('collecting data — 2 samples so far')).toBeInTheDocument();
  });

  it('queue-efficiency panel shows runs/merge and the run-vs-required-gate split', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const block = await screen.findByTestId('queue-eff-acme/widgets');
    expect(within(block).getByText('6.5')).toBeInTheDocument();              // 13 runs ÷ 2 merges
    expect(within(block).getByText('13 runs ÷ 2 merges')).toBeInTheDocument();
    expect(within(block).getByText('10')).toBeInTheDocument();               // advisory-only failures
    expect(within(block).getByText('of 11 failed runs')).toBeInTheDocument();
    // required-gate failures shown (prefixes configured) — not the config hint
    expect(within(block).queryByText('set requiredCheckPrefixes')).not.toBeInTheDocument();
    // admin-bypass rate: 3 of 20 known merges = 15%
    expect(within(block).getByText('15%')).toBeInTheDocument();
    expect(within(block).getByText('3 of 20 known')).toBeInTheDocument();
  });

  it('queue-efficiency hides the required split and prompts config when prefixes are unset', async () => {
    mockFetchOk({ ...PAYLOAD, queueEfficiency: [
      { repo: 'acme/widgets', mergeGroupRuns: 5, queueMerges: 1, runsPerMerge: 5,
        runConclusion: { total: 5, runFailed: 3, requiredFailed: 0, advisoryNoise: 3,
          requiredConfigured: false },
        adminBypass: { merges: 0, bypasses: 0, rate: null } }] });
    render(<MetricsView now={NOW} />);
    const block = await screen.findByTestId('queue-eff-acme/widgets');
    expect(within(block).getByText('set requiredCheckPrefixes')).toBeInTheDocument();
    expect(within(block).getByText(/required-gate split can.t be computed/)).toBeInTheDocument();
  });

  it('tuning-actions digest renders ranked recommendations with priority badges', async () => {
    mockFetchOk({ ...PAYLOAD, recommendations: [
      { repo: 'acme/widgets', kind: 'admin-bypass', priority: 'high',
        title: 'admin-bypass rate 22% — investigate queue confidence', detail: '22% of merges bypassed' },
      { repo: 'acme/widgets', kind: 'batch-size', priority: 'medium',
        title: 'raise merge-queue batch 6 → 12', detail: 'modelled throughput headroom +50%' },
      { repo: 'acme/widgets', kind: 'set-required-prefixes', priority: 'low',
        title: 'set requiredCheckPrefixes', detail: 'no prefixes configured' }] });
    render(<MetricsView now={NOW} />);
    const list = await screen.findByTestId('recommendations');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // ranked high → low (rendered in payload order, which the server already sorts)
    expect(items[0]!.className).toContain('rec-high');
    expect(items[2]!.className).toContain('rec-low');
    expect(within(list).getByTestId('rec-batch-size').textContent).toContain('raise merge-queue batch 6 → 12');
  });

  it('a recommendation deep-links to its evidence panel (UX-M4)', async () => {
    mockFetchOk({ ...PAYLOAD, recommendations: [
      { repo: 'acme/widgets', kind: 'batch-size', priority: 'medium',
        title: 'raise merge-queue batch 6 → 12', detail: '+50%' }] });
    render(<MetricsView now={NOW} />);
    const link = await screen.findByTestId('rec-link-batch-size');
    // default section is Tuning; clicking jumps to the batch advisor in Throughput
    expect(screen.getByTestId('metrics-subtab-tuning')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(link);
    expect(screen.getByTestId('metrics-subtab-throughput')).toHaveAttribute('aria-pressed', 'true');
    expect(document.getElementById('metrics-batch-advisor')).not.toBeNull();
  });

  it('config-change panel lists changes and overlays a marker on the queue charts', async () => {
    mockFetchOk({ ...PAYLOAD, configChanges: [
      { repo: 'acme/widgets', at: '2026-06-11T09:30:00Z', field: 'batchSize',
        oldValue: '6', newValue: '12' }] });
    render(<MetricsView now={NOW} />);
    const list = await screen.findByTestId('config-changes');
    expect(within(list).getByTestId('cfg-change-batchSize').textContent).toContain('batchSize');
    expect(within(list).getByText('12')).toBeInTheDocument();
    // an amber marker is overlaid on the queue chart at the change's bucket (H9)
    await waitFor(() => expect(document.querySelector('.chart-marker line')).toBeInTheDocument());
  });

  it('batch-size advisor renders the curve and marks the recommended + current batch', async () => {
    mockFetchOk({ ...PAYLOAD, batchAdvisor: [
      { repo: 'acme/widgets', arrivalPerHour: 2.5, trainDurationSecs: 600,
        ejectProbPerGroup: 0.14, ejectProbPerPr: 0.05, currentBatch: 3, recommendedBatch: 5,
        curve: Array.from({ length: 12 }, (_, i) => ({ batch: i + 1, throughputPerHour: i + 1,
          timeInQueueSecs: i < 9 ? 1000 - i * 10 : null, stable: i < 9 })) }] });
    render(<MetricsView now={NOW} />);
    const block = await screen.findByTestId('batch-advisor-acme/widgets');
    expect(within(block).getByText('current is 3')).toBeInTheDocument();   // recommendation headline
    expect(within(block).getByTestId('batch-row-acme/widgets-5').className).toContain('batch-recommended');
    expect(within(block).getByTestId('batch-row-acme/widgets-3').className).toContain('batch-current');
    // an unstable batch shows "—" for time-in-queue
    expect(within(block).getByTestId('batch-row-acme/widgets-12').textContent).toContain('—');
  });

  it('CI needs-graph panel renders the DAG nodes with the critical path highlighted', async () => {
    mockFetchOk({ ...PAYLOAD, needsGraph: [
      { repo: 'acme/widgets', event: 'pull_request', endToEndP50Secs: 720, nodes: [
        { name: 'build', needs: [], durationP50: 100, waitP50: 20, onCriticalPath: true, slackSecs: 0 },
        { name: 'unit-tests', needs: ['build'], durationP50: 600, waitP50: 30, onCriticalPath: true, slackSecs: 0 },
        { name: 'lint', needs: ['build'], durationP50: 60, waitP50: 0, onCriticalPath: false, slackSecs: 540 },
        { name: 'ci', needs: ['unit-tests', 'lint'], durationP50: 10, waitP50: 5, onCriticalPath: true, slackSecs: 0 },
      ] }] });
    render(<MetricsView now={NOW} />);
    const block = await screen.findByTestId('needs-graph-acme/widgets-pull_request');
    // all four jobs rendered as nodes
    for (const name of ['build', 'unit-tests', 'lint', 'ci']) {
      expect(within(block).getByTestId(`ng-node-${name}`)).toBeInTheDocument();
    }
    // critical-path nodes carry the cp class; an off-path node does not
    expect(within(block).getByTestId('ng-node-unit-tests').getAttribute('class')).toContain('cp');
    expect(within(block).getByTestId('ng-node-lint').getAttribute('class')).not.toContain('cp');
  });

  it('slowest-jobs table keeps its leaderboard with variability highlighting and band trends', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await waitFor(() => expect(screen.getByText('Integration Tests')).toBeInTheDocument());
    const calm = screen.getByText('1.3×');
    const spiky = screen.getByText('4.0×');
    expect(calm.className).not.toContain('var-high');
    expect(spiky.className).toContain('var-high');
    // first job's trend renders as a compact band chart (3 populated buckets)
    const table = screen.getByText('Integration Tests').closest('table')! as HTMLElement;
    expect(table.querySelectorAll('svg.chart-svg-compact').length).toBeGreaterThanOrEqual(1);
    // second job has a single trend bucket → compact placeholder
    expect(within(table).getByText('collecting (1)')).toBeInTheDocument();
  });


  it('calibration panel: per-stage headline sentences with signed direction', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'ETA calibration' });
    const panel = heading.closest('section')! as HTMLElement;
    // +18.4% median error → optimistic (stages take longer than promised)
    expect(within(panel).getByText('p50 ETAs run 18% optimistic (n=42)')).toBeInTheDocument();
    // −7.2% → pessimistic (stages finish earlier than promised)
    expect(within(panel).getByText('p50 ETAs run 7% pessimistic (n=11)')).toBeInTheDocument();
    expect(within(panel).getByText(/p90 \|error\| 55%/)).toBeInTheDocument();
  });

  it('calibration panel: error-trend line (zero gridline) and scatter render per stage', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'ETA calibration' });
    const panel = heading.closest('section')! as HTMLElement;
    // ci has 3 buckets → real SignedLine with the emphasized zero gridline
    const trend = within(panel).getByRole('img',
      { name: 'acme/widgets ci median ETA error per hour' });
    expect(trend.querySelector('[data-zero-gridline]')).toBeTruthy();
    // ci has 4 scatter points → real ScatterPlot with the perfect-calibration diagonal
    const scatter = within(panel).getByRole('img',
      { name: 'acme/widgets ci predicted vs actual ETA' });
    expect(scatter.querySelector('[data-diagonal]')).toBeTruthy();
    expect(scatter.querySelectorAll('circle')).toHaveLength(4);
  });

  it('calibration panel: sparse stages fall back to collecting placeholders', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'ETA calibration' });
    const panel = heading.closest('section')! as HTMLElement;
    // queue: 2 buckets and 2 points — both charts guard with placeholders
    expect(within(panel).getAllByText('collecting data — 2 samples so far')).toHaveLength(2);
    expect(within(panel).queryByRole('img',
      { name: 'acme/widgets queue predicted vs actual ETA' })).toBeNull();
  });

  it('calibration panel: entries with no buckets and no points are omitted entirely', async () => {
    mockFetchOk({ ...EMPTY, calibration: [
      { repo: 'acme/widgets', stage: 'ci', n: 0, medianErrorPct: 0, p90AbsErrorPct: 0,
        buckets: [], points: [] },
    ] });
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'ETA calibration' });
    const panel = heading.closest('section')! as HTMLElement;
    expect(within(panel).getByText('no data yet')).toBeInTheDocument();
  });

  it('runner-wait panel labels event tiers and renders full-width band charts', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Runner-wait health' });
    const panel = heading.closest('section')! as HTMLElement;
    expect(within(panel).getByText('pull_request p50 wait')).toBeInTheDocument();
    expect(within(panel).getByText('merge_group p50 wait')).toBeInTheDocument();
    // pull_request tier has 3 populated buckets → a real chart with the band caption
    expect(within(panel).getAllByText(/band = p50–p90/).length).toBeGreaterThanOrEqual(1);
  });
});

describe('MetricsView — flakiest jobs panel (issue #37)', () => {
  it('renders the per-repo flake table: job, event, rate, events/runs, trend sparkline', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await waitFor(() => expect(screen.getByText('HighFiveCue suite')).toBeInTheDocument());
    const panel = screen.getByRole('heading', { name: 'Flakiest jobs' }).closest('section')!;
    const row = within(panel).getByText('HighFiveCue suite').closest('tr')!;
    expect(within(row).getByText('pull_request')).toBeInTheDocument();
    expect(within(row).getByText('23%')).toBeInTheDocument();
    expect(within(row).getByText('3 / 13')).toBeInTheDocument();
    // trend sparkline (compact band chart) present in the row
    expect(row.querySelector('.chart-svg-compact, .chart-placeholder')).not.toBeNull();
    // ≥20% rates highlight; the 10% row does not
    expect(within(row).getByText('23%').classList.contains('var-high')).toBe(true);
    const steady = within(panel).getByText('steady-job').closest('tr')!;
    expect(within(steady).getByText('10%').classList.contains('var-high')).toBe(false);
  });

  it('shows the empty placeholder without flake data', async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Flakiest jobs' });
    const panel = screen.getByRole('heading', { name: 'Flakiest jobs' }).closest('section')!;
    expect(within(panel).getByText('no data yet')).toBeInTheDocument();
  });
});

describe('MetricsView — train killers panel (issue #38)', () => {
  it('renders the ranked table with ejects, est. cost, and the flake cross-reference', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await waitFor(() => expect(screen.getByText('merge-group e2e')).toBeInTheDocument());
    const panel = screen.getByRole('heading', { name: 'Train killers' }).closest('section')!;
    const killer = within(panel).getByText('merge-group e2e').closest('tr')!;
    expect(within(killer).getByText('7')).toBeInTheDocument();      // ejects
    expect(within(killer).getByText('21.0')).toBeInTheDocument();   // train-hours
    expect(within(killer).getByText(/90%/)).toBeInTheDocument();    // flake cross-ref
    expect(within(killer).getByText('timeout')).toBeInTheDocument();        // reason tag (4.4b)
    expect(within(killer).getByText(/rerun/)).toBeInTheDocument();          // lead remedy
  });

  it("highlights 'killer AND flaky' rows amber (tk-flaky); flake-unknown rows show – and stay plain", async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await waitFor(() => expect(screen.getByText('merge-group e2e')).toBeInTheDocument());
    const panel = screen.getByRole('heading', { name: 'Train killers' }).closest('section')!;
    const flakyRow = within(panel).getByText('merge-group e2e').closest('tr')!;
    expect(flakyRow.classList.contains('tk-flaky')).toBe(true);
    expect(within(flakyRow).getByText(/⚐ flaky/)).toBeInTheDocument();
    const plainRow = within(panel).getByText('db-migrations').closest('tr')!;
    expect(plainRow.classList.contains('tk-flaky')).toBe(false);
    expect(within(plainRow).getByText('–')).toBeInTheDocument();
  });

  it('documents the cost approximation (median group run × batch size) under the table', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await waitFor(() => expect(screen.getByText('merge-group e2e')).toBeInTheDocument());
    const panel = screen.getByRole('heading', { name: 'Train killers' }).closest('section')!;
    expect(within(panel).getByText(/cost ≈ ejects × median group run/)).toBeInTheDocument();
    expect(within(panel).getByText(/batch size \(6\)/)).toBeInTheDocument();
  });

  it('shows the empty placeholder without train-killer data', async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Train killers' });
    const panel = screen.getByRole('heading', { name: 'Train killers' }).closest('section')!;
    expect(within(panel).getByText('no data yet')).toBeInTheDocument();
  });
});

describe('MetricsView — critical path panel (issue #42)', () => {
  it('renders the expected path as an ordered chain with wait + duration per step', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Critical path' });
    const panel = heading.closest('section')! as HTMLElement;
    const prChain = within(panel).getByRole('list',
      { name: 'acme/widgets pull_request critical path' });
    const steps = within(prChain as HTMLElement).getAllByRole('listitem');
    expect(steps.map((s) => s.querySelector('.cp-name')!.textContent))
      .toEqual(['build', 'unit-tests', 'rollup-ci']);
    // wait + duration split visible on a step (20s wait + 100s run)
    expect(steps[0]!.textContent).toContain('wait 20s');
    expect(steps[0]!.textContent).toContain('+ 2m');
  });

  it('shows the end-to-end p50 headline per event', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Critical path' });
    const panel = heading.closest('section')! as HTMLElement;
    const pr = within(panel).getByText('pull_request end-to-end (p50)')
      .closest('.metric-stat')! as HTMLElement;
    expect(pr.querySelector('b')!.textContent).toBe('13m'); // formatDur(765)
    expect(within(panel).getByText('merge_group end-to-end (p50)')).toBeInTheDocument();
  });

  it('lists off-path jobs with their slack in plain language', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Critical path' });
    const panel = heading.closest('section')! as HTMLElement;
    const off = within(panel).getByText('bats-tests').closest('li')!;
    expect(off.textContent).toContain('could grow 11m before mattering'); // formatDur(660)
  });

  it('documents that the section ignores the window selector', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Critical path' });
    const panel = heading.closest('section')! as HTMLElement;
    // appears in the visible note AND (UX-M1) the sr-only stat description
    expect(within(panel).getAllByText(/ignores the window selector/).length).toBeGreaterThan(0);
  });

  it('shows the empty placeholder without critical-path data', async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Critical path' });
    const panel = heading.closest('section')! as HTMLElement;
    expect(within(panel).getByText('no data yet')).toBeInTheDocument();
  });
});

describe('MetricsView — workflow lint panel (issue #48 rule 1)', () => {
  it('lists findings with severity, job, observed p99 and configured timeout', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Workflow lint' });
    const panel = heading.closest('section')! as HTMLElement;
    const warnRow = within(panel).getByText('unit-tests').closest('tr')!;
    expect(within(warnRow).getByText('warn')).toBeInTheDocument();
    expect(within(warnRow).getByText(/will timeout-cancel on a slow run/)).toBeInTheDocument();
    expect(within(warnRow).getByText('10m')).toBeInTheDocument();  // observed p99 600s
    expect(within(warnRow).getByText('11m')).toBeInTheDocument();  // configured 660s
    const infoRow = within(panel).getByText('build').closest('tr')!;
    expect(within(infoRow).getByText('info')).toBeInTheDocument();
    expect(within(infoRow).getByText(/tighten to fail fast/)).toBeInTheDocument();
  });

  it('severity badges carry distinct classes for styling', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Workflow lint' });
    const panel = heading.closest('section')! as HTMLElement;
    expect(within(panel).getByText('warn').className).toContain('lint-warn');
    expect(within(panel).getByText('info').className).toContain('lint-info');
  });

  it("empty state says 'no findings' (a clean bill of health, not missing data)", async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Workflow lint' });
    const panel = heading.closest('section')! as HTMLElement;
    expect(within(panel).getByText('no findings')).toBeInTheDocument();
  });
});

describe('MetricsView — CI cost panel (issue #43)', () => {
  const costPanel = async () => {
    const heading = await screen.findByRole('heading', { name: 'CI cost' });
    return heading.closest('section')! as HTMLElement;
  };

  it('renders the headline tiles with $ when costPerMinute is configured', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    expect(within(panel).getByText('1234m')).toBeInTheDocument();
    expect(within(panel).getByText('runner-minutes')).toBeInTheDocument();
    expect(within(panel).getByText('$18.51')).toBeInTheDocument();
    expect(within(panel).getByText('154m')).toBeInTheDocument(); // 154.25 minutes/PR
    expect(within(panel).getByText('minutes / merged PR')).toBeInTheDocument();
    expect(within(panel).getByText('8 merges in window')).toBeInTheDocument();
    expect(within(panel).getByText('96m')).toBeInTheDocument(); // retry burden
    expect(within(panel).getByText('$1.44')).toBeInTheDocument();
  });

  it('lists pool share bars: composite and unknown pools, $ only when priced', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    const runner = within(panel).getByTestId('cost-pool-acme/widgets-kindash-runner');
    expect(within(runner).getByText('1000m ($8.00)')).toBeInTheDocument();
    const composite = within(panel)
      .getByTestId('cost-pool-acme/widgets-kindash-runner|kindash-ondemand');
    expect(within(composite).getByText('200m ($10.00)')).toBeInTheDocument();
    // the unknown pool carries no rate → minutes only, no $
    const unknown = within(panel).getByTestId('cost-pool-acme/widgets-unknown');
    expect(within(unknown).getByText('34m')).toBeInTheDocument();
    expect(within(unknown).queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('minutes-only mode: without costPerMinute every $ disappears and the note says how to enable it', async () => {
    const minutesOnly: MetricsPayload = {
      ...PAYLOAD,
      cost: PAYLOAD.cost!.map((c) => ({
        ...c, totalDollars: null, retryDollars: null,
        pools: c.pools.map((pl) => ({ ...pl, dollars: null })),
      })),
      // the server nulls EVERY dollar figure in minutes-only mode
      costJobs: PAYLOAD.costJobs!.map((c) => ({
        ...c, jobs: c.jobs.map((j) => ({ ...j, dollars: null })) })),
      costRuns: PAYLOAD.costRuns!.map((c) => ({
        ...c, runs: c.runs.map((r) => ({ ...r, dollars: null })) })),
    };
    mockFetchOk(minutesOnly);
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    expect(within(panel).getByText('1234m')).toBeInTheDocument();
    expect(within(panel).queryByText(/\$\d/)).not.toBeInTheDocument();
    expect(within(panel).getByText(/set costPerMinute or poolMeta in config\.json/)).toBeInTheDocument();
  });

  it("empty state reads 'no runner-minutes in window yet'", async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    expect(within(panel).getByText('no runner-minutes in window yet')).toBeInTheDocument();
  });

  // ---- cost explorer sub-sections ----

  it('pool rows show the poolMeta instance type ("–" when unset)', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    const runner = within(panel).getByTestId('cost-pool-acme/widgets-kindash-runner');
    expect(within(runner).getByText('m7a.2xlarge spot')).toBeInTheDocument();
    const unknown = within(panel).getByTestId('cost-pool-acme/widgets-unknown');
    expect(within(unknown).getByText('–')).toBeInTheDocument();
  });

  it('by-job leaderboard: name, event, pool, instance, minutes, $ ("–" unpriced), n', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    const jobs = within(panel).getByTestId('cost-jobs-acme/widgets');
    expect(within(jobs).getByText(/by job \(top 3 by minutes\)/)).toBeInTheDocument();
    const rows = within(jobs).getAllByRole('row').slice(1); // skip header
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('unit-tests (16 shards)')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('640m')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('$5.12')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('96')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('m7a.2xlarge spot')).toBeInTheDocument(); // pool instance join
    expect(within(rows[2]!).getByText('mystery')).toBeInTheDocument();
    expect(within(rows[2]!).getAllByText('–').length).toBeGreaterThan(0); // unpriced $ and no instance
  });

  it('by-run table: run #, event, PR anchor link when known ("–" otherwise), sha, jobs, minutes, $', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    const runs = within(panel).getByTestId('cost-runs-acme/widgets');
    const rows = within(runs).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('#8123')).toBeInTheDocument();
    const prLink = within(rows[0]!).getByRole('link', { name: '#8962' });
    expect(prLink).toHaveAttribute('href', '#pr-8962'); // jumps to the PR row anchor
    expect(within(rows[0]!).getByText('abc1234')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('14')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('95m')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('$0.76')).toBeInTheDocument();
    // run without a live PR head match: no link, an em-dash placeholder
    expect(within(rows[1]!).queryByRole('link')).not.toBeInTheDocument();
    expect(within(rows[1]!).getByText('–')).toBeInTheDocument();
  });

  it('by-run table ramps: no attributable runs yet → collecting note (run numbers are new)', async () => {
    mockFetchOk({ ...PAYLOAD, costRuns: [{ repo: 'acme/widgets', runs: [] }] });
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    const runs = within(panel).getByTestId('cost-runs-acme/widgets');
    expect(within(runs).getByText(/collecting — run numbers record from new ingestion onward/))
      .toBeInTheDocument();
  });

  it('tolerates a pre-upgrade payload without costJobs/costRuns (sections degrade quietly)', async () => {
    const pre = { ...PAYLOAD };
    delete (pre as Partial<MetricsPayload>).costJobs;
    delete (pre as Partial<MetricsPayload>).costRuns;
    mockFetchOk(pre);
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    expect(within(panel).queryByTestId('cost-jobs-acme/widgets')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('cost-runs-acme/widgets')).toBeInTheDocument(); // collecting note
  });
});

describe('MetricsView — lead time panel (issue #44)', () => {
  const ltPanel = async () => {
    const heading = await screen.findByRole('heading', { name: 'Lead time' });
    return heading.closest('section')! as HTMLElement;
  };

  it('renders the DORA headline tiles: deploy frequency and created→prod p50', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await ltPanel();
    expect(within(panel).getByText('2/day')).toBeInTheDocument();
    expect(within(panel).getByText('deploy frequency (prod)')).toBeInTheDocument();
    expect(within(panel).getByText('6 prod deploys in window')).toBeInTheDocument();
    // totalP50Secs 93900 = 26h 5m
    expect(within(panel).getByText('26h 5m')).toBeInTheDocument();
    expect(within(panel).getByText('lead time created → prod (p50)')).toBeInTheDocument();
    expect(within(panel).getByText('n=6')).toBeInTheDocument();
  });

  it('renders one stacked bar with a segment per populated stage, hover = value + n', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await ltPanel();
    const bar = within(panel).getByTestId('leadtime-bar-acme/widgets');
    const segs = [...bar.querySelectorAll('.leadtime-seg')];
    expect(segs).toHaveLength(5);
    expect(segs.map((el) => el.getAttribute('title'))).toEqual([
      'to first green: 1h 30m (n=2)',
      'green → enqueued: 5m (n=2)',
      'queue: 20m (n=3)',
      'QA deploy: 10m (n=8)',
      'awaiting prod: 24h (n=6)',
    ]);
    // widths proportional to medians: awaitingProd (86400 of 93900) dominates
    const widths = segs.map((el) => parseFloat((el as HTMLElement).style.width));
    expect(widths[4]).toBeGreaterThan(80);
    expect(Math.round(widths.reduce((a, b) => a + b))).toBe(100);
  });

  it("legend labels every segment; n under 5 reads 'collecting'", async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await ltPanel();
    const legend = panel.querySelector('.chart-legend')! as HTMLElement;
    const items = [...legend.querySelectorAll('.legend-item')].map((el) => el.textContent);
    expect(items).toHaveLength(5);
    expect(items[0]).toContain('to first green');
    expect(items[0]).toContain('1h 30m (n=2)');
    expect(items[0]).toContain('collecting');      // n=2 < 5
    expect(items[2]).toContain('collecting');      // queue n=3 < 5
    expect(items[3]).not.toContain('collecting');  // qaDeploy n=8
    expect(items[4]).not.toContain('collecting');  // awaitingProd n=6
  });

  it('segments without data (medianSecs null) are absent from the bar but in the legend', async () => {
    mockFetchOk({ ...PAYLOAD, leadTime: [
      { repo: 'acme/widgets',
        segments: [
          { id: 'toFirstGreen', medianSecs: null, n: 0 },
          { id: 'greenToEnqueued', medianSecs: null, n: 0 },
          { id: 'queue', medianSecs: null, n: 0 },
          { id: 'qaDeploy', medianSecs: 600, n: 8 },
          { id: 'awaitingProd', medianSecs: 86400, n: 6 },
        ],
        totalP50Secs: 90000, totalN: 6, prodDeploys: 6, deploysPerDay: 2 },
    ] });
    render(<MetricsView now={NOW} />);
    const panel = await ltPanel();
    const bar = within(panel).getByTestId('leadtime-bar-acme/widgets');
    expect(bar.querySelectorAll('.leadtime-seg')).toHaveLength(2);
    const legend = panel.querySelector('.chart-legend')! as HTMLElement;
    const items = [...legend.querySelectorAll('.legend-item')].map((el) => el.textContent);
    expect(items).toHaveLength(5);
    expect(items[0]).toContain('to first green');
    expect(items[0]).toContain('collecting');      // n=0 — only populates from new merges
    expect(items[0]).not.toContain('(n=');         // no fabricated value
  });

  it('all-null segments show the collecting placeholder instead of an empty bar', async () => {
    mockFetchOk({ ...PAYLOAD, leadTime: [
      { repo: 'acme/widgets',
        segments: [
          { id: 'toFirstGreen', medianSecs: null, n: 0 },
          { id: 'greenToEnqueued', medianSecs: null, n: 0 },
          { id: 'queue', medianSecs: null, n: 0 },
          { id: 'qaDeploy', medianSecs: null, n: 0 },
          { id: 'awaitingProd', medianSecs: null, n: 0 },
        ],
        totalP50Secs: null, totalN: 0, prodDeploys: 1, deploysPerDay: 1 },
    ] });
    render(<MetricsView now={NOW} />);
    const panel = await ltPanel();
    expect(within(panel).queryByTestId('leadtime-bar-acme/widgets')).toBeNull();
    expect(within(panel).getByText(/collecting data — segments populate/)).toBeInTheDocument();
  });

  it("empty state shows 'no data yet' without lead-time rows", async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView now={NOW} />);
    const panel = await ltPanel();
    expect(within(panel).getByText('no data yet')).toBeInTheDocument();
  });

  it('documents which segments only populate from new merges', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await ltPanel();
    expect(within(panel).getByText(/first-green and enqueued timestamps\s+only record from new merges/)).toBeInTheDocument();
  });
});

describe('MetricsView — duration regressions strip (issue #41)', () => {
  const regPanel = async () => {
    const heading = await screen.findByRole('heading', { name: 'Duration regressions' });
    return heading.closest('section')! as HTMLElement;
  };

  it('renders one chip per active regression with check, event, p50 step, ratio and onset', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await regPanel();
    expect(within(panel).getByText('acme/widgets')).toBeInTheDocument();
    const chip = within(panel).getByText('build-test').closest('li')! as HTMLElement;
    expect(chip.textContent).toContain('merge_group');
    expect(chip.textContent).toContain('4m → 10m');
    expect(chip.textContent).toContain('×2.5');
    expect(chip.textContent).toContain('since ');
    expect(within(panel).getByText('unit-tests')).toBeInTheDocument();
  });

  it("empty state says 'none active' (a healthy day, not missing data)", async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView now={NOW} />);
    const panel = await regPanel();
    expect(within(panel).getByText('none active')).toBeInTheDocument();
  });

  it('tolerates a pre-upgrade payload without the regressions field', async () => {
    const { regressions: _drop, ...legacy } = EMPTY;
    mockFetchOk(legacy as MetricsPayload);
    render(<MetricsView now={NOW} />);
    const panel = await regPanel();
    expect(within(panel).getByText('none active')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Fleet telemetry panels (issues #45/#46/#47)
// ---------------------------------------------------------------------------

describe('MetricsView — Runner pools panel (issue #45)', () => {
  const poolPanel = async () => {
    const heading = await screen.findByRole('heading', { name: 'Runner pools' });
    return heading.closest('section')! as HTMLElement;
  };

  it('renders one stat + band chart per pool, with pool-keyed labels', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await poolPanel();
    expect(within(panel).getByText('kindash-runner p50 wait')).toBeInTheDocument();
    expect(within(panel).getByText('kindash-ondemand p50 wait')).toBeInTheDocument();
    expect(within(panel).getByLabelText(
      'acme/widgets kindash-runner runner wait p50/p90 per hour')).toBeInTheDocument();
  });

  it('a starving pool shows the loud STARVING callout with current p90 vs baseline', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await poolPanel();
    const callout = within(panel).getByTestId('pool-health-acme/widgets-kindash-runner');
    expect(callout.textContent).toContain('STARVING');
    expect(callout.textContent).toContain('last-hour p90 25m');
    expect(callout.textContent).toContain('baseline p90 1m');
    expect(callout.className).toContain('pool-starving');
  });

  it('a healthy pool renders the quiet health line without the alarm class', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await poolPanel();
    const callout = within(panel).getByTestId('pool-health-acme/widgets-kindash-ondemand');
    expect(callout.textContent).not.toContain('STARVING');
    expect(callout.className).not.toContain('pool-starving');
  });

  it('empty state explains samples label from new runs onward; tolerates pre-upgrade payloads', async () => {
    const { runnerPools: _drop, ...legacy } = EMPTY;
    mockFetchOk(legacy as MetricsPayload);
    render(<MetricsView now={NOW} />);
    const panel = await poolPanel();
    expect(within(panel).getByText(/no pool-labeled waits yet/)).toBeInTheDocument();
  });
});

describe('MetricsView — Spot reclaims panel (issue #46)', () => {
  const reclaimPanel = async () => {
    const heading = await screen.findByRole('heading', { name: 'Spot reclaims' });
    return heading.closest('section')! as HTMLElement;
  };

  it('renders the event count, trend chart, and by-pool mini-table', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await reclaimPanel();
    expect(within(panel).getByText('reclaim events')).toBeInTheDocument();
    expect(within(panel).getByText('4')).toBeInTheDocument();
    expect(within(panel).getByLabelText(
      'acme/widgets spot-reclaim events per hour')).toBeInTheDocument();
    const rows = within(panel).getAllByRole('row');
    expect(rows.map((r) => r.textContent)).toEqual(
      expect.arrayContaining(['poolevents', 'kindash-runner3', 'unknown1']));
    expect(within(panel).getByText(/infra kill \(spot reclaim\), not a verdict/)).toBeInTheDocument();
  });

  it("empty state reads 'no reclaim events in window' (likely empty — that's good news)", async () => {
    const { reclaims: _drop, ...legacy } = EMPTY;
    mockFetchOk(legacy as MetricsPayload);
    render(<MetricsView now={NOW} />);
    const panel = await reclaimPanel();
    expect(within(panel).getByText('no reclaim events in window')).toBeInTheDocument();
  });
});

describe('MetricsView — Concurrency demand panel (issue #47)', () => {
  const concPanel = async () => {
    const heading = await screen.findByRole('heading', { name: 'Concurrency demand' });
    return heading.closest('section')! as HTMLElement;
  };

  it('renders a window-peak stat and an area chart per pool', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await concPanel();
    const stat = within(panel).getByText('kindash-runner window peak')
      .closest('.metric-stat')! as HTMLElement;
    expect(within(stat).getByText('18')).toBeInTheDocument();
    expect(within(panel).getByText('unknown window peak')).toBeInTheDocument();
    expect(within(panel).getByLabelText(
      'acme/widgets kindash-runner peak concurrent jobs per hour')).toBeInTheDocument();
  });

  it('the note flags the missing cap overlay as a known follow-up', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const panel = await concPanel();
    expect(within(panel).getByText(/no fleet-cap overlay yet/)).toBeInTheDocument();
  });

  it('empty state + pre-upgrade tolerance', async () => {
    const { concurrency: _drop, ...legacy } = EMPTY;
    mockFetchOk(legacy as MetricsPayload);
    render(<MetricsView now={NOW} />);
    const panel = await concPanel();
    expect(within(panel).getByText('no job intervals in window yet')).toBeInTheDocument();
  });
});

describe('MetricsView — cost actuals + attribution coverage (phase 2)', () => {
  const costPanel = async () => {
    const heading = await screen.findByRole('heading', { name: 'CI cost' });
    return heading.closest('section')! as HTMLElement;
  };

  // NOW (below) is 2026-06-11, so 06-11 is "today" (excluded from coverage).
  // coverage is computed over the comparable day 06-10 only → 71.6/123.45 = 58%.
  const ACTUALS: NonNullable<MetricsPayload['costActuals']> = [
    { scope: 'fleet',
      days: [
        { date: '2026-06-10', actualDollars: 123.45, attributedDollars: 71.6,
          coveragePct: 58, cumulativeCoveragePct: 58 },
        { date: '2026-06-11', actualDollars: 100, attributedDollars: 40,
          coveragePct: 40, cumulativeCoveragePct: null },  // today
      ],
      totalActualDollars: 223.45, totalAttributedDollars: 111.6,
        coveragePct: 58, coverageSince: '2026-06-10',
        recentCoveragePct: 58, recentCoverageDate: '2026-06-10' },
  ];

  it('renders the actuals tiles, the coverage headline, and the per-day table', async () => {
    mockFetchOk({ ...PAYLOAD, costActuals: ACTUALS });
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    const block = within(panel).getByTestId('cost-actuals-fleet');
    expect(within(block).getByText('$223.45')).toBeInTheDocument();   // actual spend
    expect(within(block).getByText('actual spend')).toBeInTheDocument();
    expect(within(block).getByText('$111.60')).toBeInTheDocument();   // attributed
    expect(within(block).getByText('2 days imported')).toBeInTheDocument();
    const headline = within(panel).getByTestId('cost-coverage-fleet');
    expect(headline.textContent).toContain('jobs explain 58% of fleet spend');
    expect(headline.textContent).toContain('since 2026-06-10');     // comparable basis
    expect(headline.textContent).toContain('$51.85');               // 123.45 − 71.60 remainder
    // per-day rows
    const rows = within(block).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('2026-06-10')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('$123.45')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('$71.60')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('58%')).toBeInTheDocument();
  });

  it('minutes-only mode: attributed/coverage read "–", no headline, and the rates nudge shows', async () => {
    const minutesOnly: NonNullable<MetricsPayload['costActuals']> = [
      { scope: 'fleet',
        days: [{ date: '2026-06-11', actualDollars: 100, attributedDollars: null,
          coveragePct: null, cumulativeCoveragePct: null }],
        totalActualDollars: 100, totalAttributedDollars: null, coveragePct: null,
        coverageSince: null, recentCoveragePct: null, recentCoverageDate: null },
    ];
    mockFetchOk({ ...PAYLOAD, costActuals: minutesOnly });
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    const block = within(panel).getByTestId('cost-actuals-fleet');
    // tile value AND the per-day table cell both show the actual
    expect(within(block).getAllByText('$100.00').length).toBeGreaterThan(0);
    expect(within(panel).queryByTestId('cost-coverage-fleet')).not.toBeInTheDocument();
    expect(within(block).getByText(/attribution needs rates/)).toBeInTheDocument();
  });

  it('renders per-pool scopes alongside fleet (scope name in the heading and headline)', async () => {
    const scoped = [...ACTUALS,
      { scope: 'kindash-arc',
        days: [{ date: '2026-06-10', actualDollars: 50, attributedDollars: 45,
          coveragePct: 90, cumulativeCoveragePct: 90 }],
        totalActualDollars: 50, totalAttributedDollars: 45, coveragePct: 90,
        coverageSince: '2026-06-10', recentCoveragePct: 90, recentCoverageDate: '2026-06-10' }];
    mockFetchOk({ ...PAYLOAD, costActuals: scoped });
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    expect(within(panel).getByTestId('cost-actuals-kindash-arc')).toBeInTheDocument();
    expect(within(panel).getByTestId('cost-coverage-kindash-arc').textContent)
      .toContain('jobs explain 90% of kindash-arc spend');
  });

  it('coverage is the comparable-day basis; over-100% reads as rate over-pricing, not a dollar', async () => {
    // Over comparable days (06-09, 06-10; 06-11 is today and excluded) attributed
    // ($240) exceeds actual ($200) → 120%. The headline must explain that as the
    // per-minute rate over-pricing the fleet, NOT present coverage as a dollar.
    const overPriced: NonNullable<MetricsPayload['costActuals']> = [
      { scope: 'fleet',
        days: [
          { date: '2026-06-09', actualDollars: 100, attributedDollars: 150,
            coveragePct: 150, cumulativeCoveragePct: 150 },
          { date: '2026-06-10', actualDollars: 100, attributedDollars: 90,
            coveragePct: 90, cumulativeCoveragePct: 120 },          // (150+90)/(100+100)
          { date: '2026-06-11', actualDollars: 50, attributedDollars: 5,
            coveragePct: 10, cumulativeCoveragePct: null },          // today
        ],
        totalActualDollars: 250, totalAttributedDollars: 245,
        coveragePct: 120, coverageSince: '2026-06-09',
        recentCoveragePct: 90, recentCoverageDate: '2026-06-10' },
    ];
    mockFetchOk({ ...PAYLOAD, costActuals: overPriced });
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    const headline = within(panel).getByTestId('cost-coverage-fleet');
    expect(headline.textContent).toContain('over the 2 tracked days since 2026-06-09');
    expect(headline.textContent).toContain('jobs explain 120% of fleet spend');
    expect(headline.textContent).toContain('attributed ($240.00) runs over actual ($200.00)');
    expect(headline.textContent).toContain('too high');
    // today (06-11) is excluded from the comparable sums
    expect(headline.textContent).not.toContain('$245.00');
    const block = within(panel).getByTestId('cost-actuals-fleet');
    expect(within(block).getByText('tracked days since 2026-06-09')).toBeInTheDocument();
  });

  it('tolerates a pre-upgrade payload without costActuals (no actuals block, panel intact)', async () => {
    mockFetchOk(PAYLOAD); // no costActuals key at all
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    expect(within(panel).queryByTestId('cost-actuals-fleet')).not.toBeInTheDocument();
    expect(within(panel).getByText('runner-minutes')).toBeInTheDocument();
  });

  it('actuals render even when no job minutes exist (panel is non-empty on actuals alone)', async () => {
    mockFetchOk({ ...EMPTY, costActuals: ACTUALS });
    render(<MetricsView now={NOW} />);
    const panel = await costPanel();
    expect(within(panel).queryByText('no runner-minutes in window yet')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('cost-actuals-fleet')).toBeInTheDocument();
  });
});

describe('MetricsView sub-tabs (page cleanup)', () => {
  beforeEach(() => { try { localStorage.removeItem('prdash.metrics.section'); } catch { /* ignore */ } });

  it('renders the 5 section sub-tabs and defaults to Tuning (UX-M3)', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByTestId('metrics-subtab-tuning');
    for (const id of ['tuning', 'throughput', 'performance', 'reliability', 'cost']) {
      expect(screen.getByTestId(`metrics-subtab-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('metrics-subtab-tuning')).toHaveAttribute('aria-pressed', 'true');
  });

  it('switching sub-tabs moves the active marker and persists to localStorage', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByTestId('metrics-subtab-reliability');
    fireEvent.click(screen.getByTestId('metrics-subtab-reliability'));
    expect(screen.getByTestId('metrics-subtab-reliability')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('metrics-subtab-throughput')).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('prdash.metrics.section')).toBe('reliability');
  });

  it('assigns each panel to a section, and only the active section is shown', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByTestId('metrics-subtab-cost');
    // CI cost lives in the Cost section
    expect(document.getElementById('metrics-ci-cost')).toHaveAttribute('data-section', 'cost');
    // default Tuning active → Cost section inactive (hidden by class)
    expect(document.getElementById('metrics-ci-cost')!.className).toContain('metric-panel--inactive');
    fireEvent.click(screen.getByTestId('metrics-subtab-cost'));
    expect(document.getElementById('metrics-ci-cost')!.className).not.toContain('metric-panel--inactive');
  });

  it('restores the persisted section on mount', async () => {
    localStorage.setItem('prdash.metrics.section', 'reliability');
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByTestId('metrics-subtab-reliability');
    expect(screen.getByTestId('metrics-subtab-reliability')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders demotion candidates with the suggested lower tier', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const row = await screen.findByTestId('demotion-lint: eslint/pull_request');
    expect(within(row).getByText('lint: eslint')).toBeInTheDocument();
    expect(within(row).getByText('every PR push')).toBeInTheDocument();
    expect(within(row).getByText('→ merge queue only')).toBeInTheDocument();
    expect(within(row).getByText(/240 min/)).toBeInTheDocument();
  });

  it('renders promotion candidates with the suggested earlier tier', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const row = await screen.findByTestId('promotion-e2e/push');
    expect(within(row).getByText('e2e')).toBeInTheDocument();
    expect(within(row).getByText('every push to main (post-merge)')).toBeInTheDocument();
    expect(within(row).getByText('↑ merge queue (pre-merge gate)')).toBeInTheDocument();
    expect(within(row).getByText(/^6 \(/)).toBeInTheDocument();
  });

  it('the Draft PR button posts and renders the resulting PR link', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const btn = await screen.findByTestId('demotion-draft-lint: eslint/pull_request');
    fireEvent.click(btn);
    const link = await screen.findByText('draft PR ↗');
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/99');
  });

  it('the promotion Draft PR button posts and renders the resulting PR link (#150.2)', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const btn = await screen.findByTestId('promotion-draft-e2e/push');
    fireEvent.click(btn);
    const link = await screen.findByText('draft PR ↗');
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/88');
  });
});
