import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostPanel } from '../CostPanel';
import type { DashboardState } from '../../../types';

const cost = (over: object = {}): DashboardState['cost'] => ({
  totalDollars: 152, days: 7, retryWastePct: 8,
  byStage: [
    { stage: 'pr', dollars: 60, minutes: 600 },
    { stage: 'queue', dollars: 38, minutes: 380 },
    { stage: 'main', dollars: 24, minutes: 240 },
    { stage: 'scheduled', dollars: 30, minutes: 300 },
  ],
  ...over,
});

describe('CostPanel', () => {
  it('renders a per-stage breakdown row for every stage with $, % and minutes', () => {
    render(<CostPanel cost={cost()} />);
    const rows = screen.getAllByTestId('spine-cost-stage');
    expect(rows).toHaveLength(4);
    // PR row carries its dollars, percent of total, and minutes
    const pr = screen.getByTestId('spine-cost-stage-pr');
    expect(pr).toHaveTextContent(/PR/);
    expect(pr).toHaveTextContent(/\$60/);
    expect(pr).toHaveTextContent(/39%/);  // 60/152
  });

  it('shows the total and the retry-waste percentage', () => {
    render(<CostPanel cost={cost()} />);
    expect(screen.getByTestId('spine-cost-total')).toHaveTextContent(/\$152/);
    expect(screen.getByTestId('spine-cost-total')).toHaveTextContent(/7d/);
    expect(screen.getByTestId('spine-cost-retry')).toHaveTextContent(/8%/);
  });

  it('shows minutes (no $) for an unpriced stage subset', () => {
    render(<CostPanel cost={cost({
      byStage: [
        { stage: 'pr', dollars: null, minutes: 600 },
        { stage: 'queue', dollars: 38, minutes: 380 },
        { stage: 'main', dollars: 24, minutes: 240 },
        { stage: 'scheduled', dollars: 30, minutes: 300 },
      ],
    })} />);
    const pr = screen.getByTestId('spine-cost-stage-pr');
    expect(pr).toHaveTextContent(/600/);     // minutes still shown
    expect(pr).not.toHaveTextContent(/\$/);  // no dollar figure
  });

  it('shows an empty note when no rates are configured (no cost)', () => {
    render(<CostPanel cost={null} />);
    expect(screen.getByText(/no rates/i)).toBeInTheDocument();
  });

  it('shows the empty note when every stage dollar is null (minutes-only mode)', () => {
    render(<CostPanel cost={cost({
      totalDollars: null, retryWastePct: null,
      byStage: [
        { stage: 'pr', dollars: null, minutes: 600 },
        { stage: 'queue', dollars: null, minutes: 380 },
        { stage: 'main', dollars: null, minutes: 240 },
        { stage: 'scheduled', dollars: null, minutes: 300 },
      ],
    })} />);
    expect(screen.getByText(/no rates/i)).toBeInTheDocument();
  });

  it('omits the retry row when retry-waste is null', () => {
    render(<CostPanel cost={cost({ retryWastePct: null })} />);
    expect(screen.queryByTestId('spine-cost-retry')).not.toBeInTheDocument();
  });
});
