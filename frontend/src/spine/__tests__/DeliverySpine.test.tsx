import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DeliverySpine } from '../DeliverySpine';
import type { DashboardState } from '../../types';

const state = (over: object): DashboardState => ({
  generatedAt: '', staleSince: null, repos: [{ repo: 'acme/widgets', hasDeploy: false,
    prs: [{ number: 1, title: 't', url: 'u', stage: { stage: 'ci', substate: 'ci-failed', percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false }, queueAheadCount: null, checks: [] }], queue: null }], ...over,
}) as unknown as DashboardState;

describe('DeliverySpine', () => {
  it('renders a lane per stage and a worst-wins rollup pill', () => {
    render(<DeliverySpine state={state({})} kiosk={false} />);
    expect(screen.getByTestId('spine-lane-pr-ci')).toBeInTheDocument();
    expect(screen.getByTestId('spine-lane-merge-queue')).toBeInTheDocument();
    expect(screen.getByTestId('spine-lane-main')).toBeInTheDocument();
    expect(screen.getByTestId('spine-lane-deploy')).toBeInTheDocument();
    expect(screen.getByTestId('spine-lane-scheduled')).toBeInTheDocument();
    expect(screen.getByTestId('spine-lane-failures')).toBeInTheDocument();
    expect(screen.getByTestId('spine-rollup')).toHaveTextContent(/need attention/i);
  });
  it('skeleton state when state is null (no crash, lanes present)', () => {
    render(<DeliverySpine state={null} kiosk={false} />);
    expect(screen.getAllByTestId(/spine-lane-/).length).toBeGreaterThan(0);
  });
  it('the focus prop auto-expands the requested lane (global header jump)', () => {
    localStorage.removeItem('prdash.spine.expanded');
    const laneBtn = () => within(screen.getByTestId('spine-lane-merge-queue')).getByRole('button');
    const { rerender } = render(<DeliverySpine state={state({})} kiosk={false} focus={null} />);
    expect(laneBtn()).toHaveAttribute('aria-expanded', 'false');       // collapsed to start
    rerender(<DeliverySpine state={state({})} kiosk={false} focus={{ id: 'merge-queue', nonce: 1 }} />);
    expect(laneBtn()).toHaveAttribute('aria-expanded', 'true');        // header jump expanded it
    expect(laneBtn()).toHaveFocus();                                  // …and moved focus there
  });
  it('PR CI and Merge queue lanes expand to their panels', () => {
    // state with a failed PR in CI so the PR CI lane is red and worth expanding
    const st = {
      generatedAt: '', staleSince: null, repos: [{ repo: 'acme/widgets', hasDeploy: false,
        prs: [{ number: 1, title: 't', url: 'u', stage: { stage: 'ci', substate: 'ci-failed', percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false }, queueAheadCount: null, checks: [] }],
        queue: null,
        laneHealth: { main: 'green', lastGreenSha: 'abc1234', lastGreenAt: '2026-06-10T10:00:00Z', mainSeries: [{ ok: true }, { ok: false }] } }],
    } as unknown as DashboardState;
    render(<DeliverySpine state={st} kiosk />);   // kiosk = all lanes expanded
    expect(screen.getByTestId('spine-prci-row-1')).toBeInTheDocument();
    expect(screen.getAllByTestId('spine-main-spark-bar')).toHaveLength(2);
  });
  it('Deploy lane is wired and expands to its panel when a repo ships deploy data', () => {
    const st = {
      generatedAt: '', staleSince: null, repos: [{ repo: 'acme/widgets', hasDeploy: true,
        prs: [], queue: null,
        deploy: { envs: [{ name: 'qa', liveSha: 'a1b2c3d4', reachable: true }], awaitingQa: 0, awaitingProd: 1 } }],
    } as unknown as DashboardState;
    render(<DeliverySpine state={st} kiosk />);
    expect(screen.getByTestId('spine-lane-deploy')).toBeInTheDocument();
    const env = screen.getByTestId('spine-deploy-env');
    expect(env).toHaveTextContent('qa');
    expect(env).toHaveTextContent('a1b2c3d');
  });

  it('Scheduled lane is wired and expands to its panel when a repo ships scheduled data', () => {
    const st = {
      generatedAt: '', staleSince: null, repos: [{ repo: 'cairnea/KinDash', hasDeploy: false,
        prs: [], queue: null,
        scheduled: { discovered: 2, runs: [
          { workflow: 'nightly.yml', conclusion: 'success', status: 'completed', createdAt: '2026-06-13T06:00:00Z', htmlUrl: 'https://x/1' },
          { workflow: 'weekly.yml', conclusion: 'failure', status: 'completed', createdAt: '2026-06-13T00:00:00Z', htmlUrl: 'https://x/2' },
        ] } }],
    } as unknown as DashboardState;
    render(<DeliverySpine state={st} kiosk />);
    expect(screen.getByTestId('spine-lane-scheduled')).toBeInTheDocument();
    const run = screen.getByTestId('spine-scheduled-run-weekly.yml');
    expect(run).toHaveTextContent('weekly');
    expect(run).toHaveTextContent('✗');
  });

  it('renders a Cost lane row (always present)', () => {
    render(<DeliverySpine state={state({})} kiosk={false} />);
    expect(screen.getByTestId('spine-lane-cost')).toBeInTheDocument();
  });

  it('Failures & flake lane is wired and expands its panel when a repo ships flake data', () => {
    const st = {
      generatedAt: '', staleSince: null, repos: [{ repo: 'cairnea/KinDash', hasDeploy: false,
        prs: [], queue: null,
        flake: { flakyCount: 2, topChecks: [
          { name: 'HighFiveCue', event: 'push', flakeRatePct: 27.7, flakeEvents: 5 },
          { name: 'CalendarSearch', event: 'pull_request', flakeRatePct: 12.1, flakeEvents: 2 },
        ] } }],
    } as unknown as DashboardState;
    render(<DeliverySpine state={st} kiosk />);
    const lane = screen.getByTestId('spine-lane-failures');
    expect(lane).toBeInTheDocument();
    // amber, never red: aria-label carries the 'watch' status word, the glyph
    // is the amber glyph (s-amber), and there is no red glyph anywhere.
    expect(within(lane).getByRole('button')).toHaveAttribute('aria-label', expect.stringMatching(/watch/i));
    expect(lane.querySelector('.s-amber')).not.toBeNull();
    expect(lane.querySelector('.s-red')).toBeNull();
    expect(lane).toHaveTextContent(/HighFiveCue/);
    expect(lane).toHaveTextContent(/2 flaky/);
    const rows = screen.getAllByTestId('spine-flake-row');
    expect(rows[0]).toHaveTextContent('HighFiveCue');    // top by rate
  });

  it('weaves a cost chip into the PR CI lane when state.cost has stage dollars', () => {
    const st = {
      generatedAt: '', staleSince: null,
      repos: [{ repo: 'acme/widgets', hasDeploy: false, prs: [], queue: null }],
      cost: { totalDollars: 152, days: 7, retryWastePct: 8, byStage: [
        { stage: 'pr', dollars: 60, minutes: 600 },
        { stage: 'queue', dollars: 38, minutes: 380 },
        { stage: 'main', dollars: 24, minutes: 240 },
        { stage: 'scheduled', dollars: 30, minutes: 300 },
      ] },
    } as unknown as DashboardState;
    render(<DeliverySpine state={st} kiosk={false} />);
    const prCi = screen.getByTestId('spine-lane-pr-ci');
    expect(prCi).toHaveTextContent(/\$60·7d/);
  });

  it('omits the cost chip from a linear lane when that stage dollars is null', () => {
    const st = {
      generatedAt: '', staleSince: null,
      repos: [{ repo: 'acme/widgets', hasDeploy: false, prs: [], queue: null }],
      cost: { totalDollars: null, days: 7, retryWastePct: null, byStage: [
        { stage: 'pr', dollars: null, minutes: 600 },
        { stage: 'queue', dollars: null, minutes: 380 },
        { stage: 'main', dollars: null, minutes: 240 },
        { stage: 'scheduled', dollars: null, minutes: 300 },
      ] },
    } as unknown as DashboardState;
    render(<DeliverySpine state={st} kiosk={false} />);
    expect(screen.getByTestId('spine-lane-pr-ci')).not.toHaveTextContent(/·7d/);
  });
});

describe('DeliverySpine live region (UX-H4)', () => {
  it('populates the sr-only role=status region with the rollup attention summary', () => {
    const { container } = render(<DeliverySpine state={state({})} kiosk={false} />);
    const live = container.querySelector('.spine-rollup-live')!;
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    // the CI-failed PR makes PR CI red → named in the announcement
    expect(live.textContent).toMatch(/attention: .*PR CI/);
  });
});

describe('DeliverySpine rollup suppression (UX-L2)', () => {
  it('hides its own rollup pill when hideRollup is set (band shows it instead)', () => {
    render(<DeliverySpine state={state({})} kiosk={false} hideRollup />);
    expect(screen.queryByTestId('spine-rollup')).toBeNull();
    // lanes still render
    expect(screen.getByTestId('spine-lane-pr-ci')).toBeInTheDocument();
  });
  it('shows the rollup by default (no band present)', () => {
    render(<DeliverySpine state={state({})} kiosk={false} />);
    expect(screen.getByTestId('spine-rollup')).toBeInTheDocument();
  });
});
