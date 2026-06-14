import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeliverySpine } from '../DeliverySpine';
import type { DashboardState } from '../../types';

const state = (over: object): DashboardState => ({
  generatedAt: '', staleSince: null, repos: [{ repo: 'acme/widgets', hasDeploy: false,
    prs: [{ number: 1, stage: { stage: 'ci', substate: 'ci-failed' } }], queue: null }], ...over,
}) as unknown as DashboardState;

describe('DeliverySpine', () => {
  it('renders a lane per stage and a worst-wins rollup pill', () => {
    render(<DeliverySpine state={state({})} kiosk={false} />);
    expect(screen.getByTestId('spine-lane-pr-ci')).toBeInTheDocument();
    expect(screen.getByTestId('spine-lane-merge-queue')).toBeInTheDocument();
    expect(screen.getByTestId('spine-lane-main')).toBeInTheDocument();
    expect(screen.getByTestId('spine-rollup')).toHaveTextContent(/need attention/i);
  });
  it('skeleton state when state is null (no crash, lanes present)', () => {
    render(<DeliverySpine state={null} kiosk={false} />);
    expect(screen.getAllByTestId(/spine-lane-/).length).toBeGreaterThan(0);
  });
});
