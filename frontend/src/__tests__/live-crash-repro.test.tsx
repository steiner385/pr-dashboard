import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MetricsView } from '../MetricsView';
import payload from './__live_payload.json';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, status: 200, json: async () => payload,
  } as Response);
});
afterEach(() => vi.restoreAllMocks());

describe('live payload crash repro', () => {
  it('renders the live /api/metrics payload without throwing', async () => {
    render(<MetricsView />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument(), { timeout: 5000 });
  });
});
