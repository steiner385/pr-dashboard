import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RunnerRouting } from '../RunnerRouting';

const planResp = {
  enabled: false, shedCount: 1, lastError: null, lastPushedAt: null, lastVerifiedAt: null, lastPushedHash: null,
  map: { integration: 'kindash-arc' },
  plan: [
    { key: 'unit', p90Secs: 480, scoreMinutes: 0.7, decision: 'kindash-arc-spot', source: 'auto', reason: 'spot', collecting: false },
    { key: 'integration', p90Secs: 720, scoreMinutes: 1.1, decision: 'kindash-arc', source: 'auto', reason: 'on-demand', collecting: false },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('RunnerRouting panel', () => {
  it('renders each job with a non-color decision label and aria-pressed override controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => planResp }));
    render(<RunnerRouting />);
    await screen.findByText('integration');
    expect(screen.getByTestId('runner-decision-integration').textContent).toMatch(/on-demand/i);
    expect(screen.getByTestId('override-integration-ondemand')).toHaveAttribute('aria-pressed');
    expect(screen.getByTestId('override-integration-spot')).toBeInTheDocument();
    expect(screen.getByTestId('override-integration-auto')).toBeInTheDocument();
  });

  it('PUTs an override and re-fetches the plan', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => planResp })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ applied: ['overrides'] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => planResp });
    vi.stubGlobal('fetch', fetchMock);
    render(<RunnerRouting />);
    fireEvent.click(await screen.findByTestId('override-unit-ondemand'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/runner-routing', expect.objectContaining({ method: 'PUT' })));
  });

  it('shows a non-color failure prefix when lastError is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...planResp, lastError: 'rate limited' }) }));
    render(<RunnerRouting />);
    expect((await screen.findByTestId('runner-push-status')).textContent).toMatch(/Push failed:/);
  });
});
