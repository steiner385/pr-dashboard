import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    expect(screen.getByTestId('spine-rollup')).toHaveTextContent(/need attention/i);
  });
  it('skeleton state when state is null (no crash, lanes present)', () => {
    render(<DeliverySpine state={null} kiosk={false} />);
    expect(screen.getAllByTestId(/spine-lane-/).length).toBeGreaterThan(0);
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

  it('renders a Cost lane row (always present)', () => {
    render(<DeliverySpine state={state({})} kiosk={false} />);
    expect(screen.getByTestId('spine-lane-cost')).toBeInTheDocument();
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
