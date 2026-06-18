import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WorkspaceApi } from '../shell/workspaceApi';

// MetricsView is heavy (fetches /api/metrics); stub it — we test the composition.
vi.mock('../MetricsView', () => ({ MetricsView: () => <div data-testid="metrics">METRICS</div> }));

import { InsightsView } from '../sections/insights/InsightsView';

const api = (over: Partial<WorkspaceApi> = {}): WorkspaceApi => ({
  budgets: vi.fn(async () => ({ gauges: [], alerts: [] })),
  policy: vi.fn(async () => ({ rules: [], violations: [] })),
  outcomes: vi.fn(async () => ({ outcomes: [], accuracy: { count: 0, meanCostAccuracy: 0, directionHitRate: 0, recommenderUsable: false } })),
  changelog: vi.fn(async () => ({ changelog: [], audit: [] })),
  ...over,
} as unknown as WorkspaceApi);

describe('InsightsView (WS3a — Metrics + Tune folded into one section)', () => {
  it('renders the analytics (Metrics) and the tuning panels (budgets etc.) together', async () => {
    render(<InsightsView repo="o/r" api={api()} />);
    expect(screen.getByTestId('metrics')).toBeInTheDocument();
    // the Tune panels are present (with their empty states)
    expect(await screen.findByLabelText('Budgets')).toBeInTheDocument();
    expect(screen.getByLabelText('Policy')).toBeInTheDocument();
  });
});
