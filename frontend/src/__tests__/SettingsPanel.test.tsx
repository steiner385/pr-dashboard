import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import type { ConfigResponse } from '../types';

// ---- fixtures ----

const CONFIG: ConfigResponse = {
  resolved: {
    owners: ['acme', 'octo'],
    exclude: ['acme/private'],
    retentionDays: 7,
    batchSize: 6,
    intervals: { sweepMs: 60_000, hotMs: 15_000, deployMs: 30_000 },
    tokenSource: 'gh',
    apiUrl: 'https://api.github.com/graphql',
    port: 4400,
    ancestrySource: 'api',
    notifications: {
      enabled: true,
      command: ['notify-send', '{title}', '{body}'],
      // already host-masked by the server (issue #51)
      webhookUrl: 'https://hooks.slack.com/…',
      digest: { enabled: true, hourLocal: 8 },
      events: { 'ci-failed': true, 'group-failed': true, 'queue-blocked': true,
        ready: false, overdue: false, 'prod-live': true, 'queue-stalled': true,
        'duration-regression': true, 'runner-starvation': true, 'budget-breach': true },
    },
  },
  readOnlyKeys: ['tokenSource', 'apiUrl', 'port', 'ancestrySource'],
  sources: { configPath: '/etc/pr-dashboard/config.json', perField: {} },
  repos: {
    'acme/widgets': {
      rollupJobId: { value: 'ci', source: 'in-repo' },
      workflowPath: { value: '.github/workflows/ci.yml', source: 'default' },
      batchSize: { value: 6, source: 'derived' },
      requiredCheckPrefixes: { value: ['static-checks', 'build'], source: 'override' },
      deploy: { value: { environments: [{ name: 'qa' }, { name: 'prod' }] }, source: 'in-repo' },
    },
  },
  writableTo: '/etc/pr-dashboard/config.json',
};

function mockFetchOk(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  // default: route by URL — /api/config → CONFIG, /api/repos → discovered list
  fetchSpy.mockImplementation(async (url: unknown) =>
    String(url) === '/api/repos'
      ? mockFetchOk({ repos: [
          { repo: 'acme/widgets', excluded: false },
          { repo: 'acme/legacy', excluded: true },
        ] })
      : mockFetchOk(CONFIG));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsPanel', () => {
  it('does not render or fetch when closed', () => {
    render(<SettingsPanel open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches GET /api/config when opened and renders a dialog', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/config'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
  });

  it('populates the form from the GET response (owners, retentionDays, intervals in seconds)', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    // owners chips
    expect(await screen.findByText('acme')).toBeInTheDocument();
    expect(screen.getByText('octo')).toBeInTheDocument();
    // exclude chip
    expect(screen.getByText('acme/private')).toBeInTheDocument();
    // retentionDays
    expect(screen.getByLabelText(/retention/i)).toHaveValue(7);
    // batchSize
    expect(screen.getByLabelText(/batch size/i)).toHaveValue(6);
    // intervals shown in SECONDS (60000ms -> 60s, 15000 -> 15, 30000 -> 30)
    expect(screen.getByLabelText(/sweep/i)).toHaveValue(60);
    expect(screen.getByLabelText(/hot/i)).toHaveValue(15);
    expect(screen.getByLabelText(/deploy interval/i)).toHaveValue(30);
  });

  it('renders read-only instance section with file-only hint', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    expect(await screen.findByText('gh')).toBeInTheDocument(); // tokenSource
    expect(screen.getByText('https://api.github.com/graphql')).toBeInTheDocument();
    expect(screen.getByText('4400')).toBeInTheDocument();
    expect(screen.getByText('api')).toBeInTheDocument(); // ancestrySource (#18)
    expect(screen.getByText('/etc/pr-dashboard/config.json')).toBeInTheDocument();
    expect(screen.getByText(/file-only for security/i)).toBeInTheDocument();
  });

  it('instance section: costPerMinute absent → labelled not configured (issue #43)', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    expect(await screen.findByText(/not configured — CI cost reports minutes only/))
      .toBeInTheDocument();
  });

  it('instance section: costPerMinute map renders read-only as pool → $/min (issue #43)', async () => {
    const withCpm = { ...CONFIG, resolved: { ...CONFIG.resolved,
      costPerMinute: { 'kindash-runner': 0.008, default: 0.01 } } };
    fetchSpy.mockImplementation(async (url: unknown) =>
      String(url) === '/api/repos'
        ? mockFetchOk({ repos: [] })
        : mockFetchOk(withCpm));
    render(<SettingsPanel open={true} onClose={() => {}} />);
    expect(await screen.findByText('kindash-runner: $0.008/min · default: $0.01/min'))
      .toBeInTheDocument();
  });

  it('instance section: poolMeta absent → labelled not configured (cost explorer)', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    expect(await screen.findByText(/not configured — pools show no instance type/))
      .toBeInTheDocument();
  });

  it('instance section: poolMeta renders read-only with instance type and superseding rate', async () => {
    const withMeta = { ...CONFIG, resolved: { ...CONFIG.resolved,
      poolMeta: {
        'kindash-runner': { instanceType: 'm7a.2xlarge spot', dollarsPerMinute: 0.006 },
        'kindash-ondemand': { instanceType: 'm7a.2xlarge' },
      } } };
    fetchSpy.mockImplementation(async (url: unknown) =>
      String(url) === '/api/repos'
        ? mockFetchOk({ repos: [] })
        : mockFetchOk(withMeta));
    render(<SettingsPanel open={true} onClose={() => {}} />);
    expect(await screen.findByText(
      'kindash-runner: m7a.2xlarge spot, $0.006/min · kindash-ondemand: m7a.2xlarge'))
      .toBeInTheDocument();
  });

  it("instance section: tolerates rate-less poolMeta entries and shows podsPerNode (the live config's shape)", async () => {
    // mirrors the operator's hand-written block: instanceType/note only, no rates
    const withMeta = { ...CONFIG, resolved: { ...CONFIG.resolved,
      poolMeta: {
        'kindash-arc': { instanceType: 'EKS ARC (on-demand)', note: 'ci-fast NodePool' },
        'kindash-arc|kindash-arc-spot': { instanceType: 'EKS ARC (runs-on ternary)' },
        'kindash-arc-spot': { instanceType: 'EKS ARC (spot)', podsPerNode: 4 },
      } } };
    fetchSpy.mockImplementation(async (url: unknown) =>
      String(url) === '/api/repos'
        ? mockFetchOk({ repos: [] })
        : mockFetchOk(withMeta));
    render(<SettingsPanel open={true} onClose={() => {}} />);
    expect(await screen.findByText(
      'kindash-arc: EKS ARC (on-demand) · kindash-arc|kindash-arc-spot: EKS ARC (runs-on ternary)'
      + ' · kindash-arc-spot: EKS ARC (spot), 4 pods/node'))
      .toBeInTheDocument();
  });

  it('renders per-repo read-only section with source tags', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    expect((await screen.findAllByText('acme/widgets')).length).toBeGreaterThan(0);
    // source tags present
    expect(screen.getAllByText('in-repo').length).toBeGreaterThan(0);
    expect(screen.getByText('derived')).toBeInTheDocument();
    expect(screen.getByText('override')).toBeInTheDocument();
    // hint line
    expect(screen.getByText(/edit via \.pr-dashboard\.yml/i)).toBeInTheDocument();
    // deploy env summary
    expect(screen.getByText(/qa/)).toBeInTheDocument();
  });

  it('closes on Esc and returns focus to the trigger', async () => {
    const onClose = vi.fn();
    const trigger = document.createElement('button');
    trigger.setAttribute('aria-label', 'Settings');
    document.body.appendChild(trigger);
    trigger.focus();
    const returnFocusRef = { current: trigger };
    const { rerender } = render(
      <SettingsPanel open={true} onClose={onClose} returnFocusRef={returnFocusRef} />,
    );
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    // Simulate the parent honouring onClose by closing the panel.
    // The focus-management effect cleanup runs on the open→false transition
    // and calls returnFocusRef.current.focus().
    rerender(
      <SettingsPanel open={false} onClose={onClose} returnFocusRef={returnFocusRef} />,
    );
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });

  it('closes on overlay click', async () => {
    const onClose = vi.fn();
    render(<SettingsPanel open={true} onClose={onClose} />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByTestId('settings-overlay'));
    expect(onClose).toHaveBeenCalled();
  });

  it('moves focus into the panel on open', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it('Save PUTs only the safe subset, converting intervals back to ms', async () => {
    fetchSpy.mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/config' && (!init || init.method === undefined)) {
        return Promise.resolve(mockFetchOk(CONFIG));
      }
      // PUT
      return Promise.resolve(mockFetchOk({ applied: ['owners', 'intervals'], restartRequired: [] }));
    });
    render(<SettingsPanel open={true} onClose={() => {}} />);
    await screen.findByText('acme');
    // change sweep interval to 90s
    fireEvent.change(screen.getByLabelText(/sweep/i), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      // safe subset only — no tokenSource/apiUrl/port
      expect(body).not.toHaveProperty('tokenSource');
      expect(body).not.toHaveProperty('apiUrl');
      expect(body).not.toHaveProperty('port');
      expect(body).not.toHaveProperty('repos');
      // notifications is sent ONLY when the toggle changed (it wasn't touched here)
      expect(body).not.toHaveProperty('notifications');
      // intervals back in ms
      expect(body.intervals.sweepMs).toBe(90_000);
      expect(body.owners).toEqual(['acme', 'octo']);
    });
  });

  it('shows the applied toast line on save success', async () => {
    fetchSpy.mockImplementation((_url: string | URL | Request, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'PUT') {
        return Promise.resolve(mockFetchOk({ applied: ['owners', 'batchSize'], restartRequired: [] }));
      }
      return Promise.resolve(mockFetchOk(CONFIG));
    });
    render(<SettingsPanel open={true} onClose={() => {}} />);
    await screen.findByText('acme');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/applied/i)).toBeInTheDocument();
  });

  it('renders field errors on a 400 response', async () => {
    fetchSpy.mockImplementation((_url: string | URL | Request, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'PUT') {
        return Promise.resolve(
          mockFetchOk({ error: 'invalid config', fieldErrors: { batchSize: 'must be a positive integer' } }, 400),
        );
      }
      return Promise.resolve(mockFetchOk(CONFIG));
    });
    render(<SettingsPanel open={true} onClose={() => {}} />);
    await screen.findByText('acme');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText('must be a positive integer')).toBeInTheDocument();
  });

  it('disables Save with a hint when owners list is empty', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    await screen.findByText('acme');
    // remove both owners (re-query each time — removal re-renders the chip list)
    let owners = screen.queryAllByRole('button', { name: /remove owner/i });
    while (owners.length > 0) {
      fireEvent.click(owners[0]!);
      owners = screen.queryAllByRole('button', { name: /remove owner/i });
    }
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(screen.getByText(/owners list cannot be empty/i)).toBeInTheDocument();
  });

  it('adds and removes owner chips', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    await screen.findByText('acme');
    const input = screen.getByLabelText(/add owner/i);
    fireEvent.change(input, { target: { value: 'newowner' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('newowner')).toBeInTheDocument();
    // remove it
    const chip = screen.getByText('newowner').closest('.chip')!;
    fireEvent.click(within(chip as HTMLElement).getByRole('button', { name: /remove owner/i }));
    expect(screen.queryByText('newowner')).not.toBeInTheDocument();
  });

  it('restart flow confirms inline, POSTs, and shows restarting state', async () => {
    fetchSpy.mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/admin/restart') {
        return Promise.resolve(mockFetchOk({ restarting: true }, 202));
      }
      return Promise.resolve(mockFetchOk(CONFIG));
    });
    render(<SettingsPanel open={true} onClose={() => {}} connected={true} />);
    await screen.findByText('acme');
    // click Restart → inline confirm
    fireEvent.click(screen.getByRole('button', { name: /^restart/i }));
    expect(screen.getByText(/restart service\?/i)).toBeInTheDocument();
    // confirm
    fireEvent.click(screen.getByRole('button', { name: /^confirm restart$/i }));
    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(
        (call: unknown[]) => String(call[0]) === '/api/admin/restart',
      );
      expect(post).toBeDefined();
      expect((post![1] as RequestInit).method).toBe('POST');
    });
    expect(await screen.findByText(/restarting/i)).toBeInTheDocument();
  });

  it('shows "back online" after reconnect once a restart was requested', async () => {
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      if (String(url) === '/api/admin/restart') {
        return Promise.resolve(mockFetchOk({ restarting: true }, 202));
      }
      return Promise.resolve(mockFetchOk(CONFIG));
    });
    const { rerender } = render(
      <SettingsPanel open={true} onClose={() => {}} connected={true} />,
    );
    await screen.findByText('acme');
    fireEvent.click(screen.getByRole('button', { name: /^restart/i }));
    fireEvent.click(screen.getByRole('button', { name: /^confirm restart$/i }));
    await screen.findByText(/restarting/i);
    // simulate disconnect then reconnect
    rerender(<SettingsPanel open={true} onClose={() => {}} connected={false} />);
    rerender(<SettingsPanel open={true} onClose={() => {}} connected={true} />);
    expect(await screen.findByText(/back online/i)).toBeInTheDocument();
  });
});

describe('SettingsPanel notifications section (issue #19)', () => {
  it('renders the enabled toggle live, command/events read-only with the file-only hint', async () => {
    render(<SettingsPanel open onClose={() => {}} />);
    const heading = await screen.findByRole('heading', { name: 'Notifications' });
    const section = heading.closest('section')!;
    // enabled is a REAL toggle now (the notifications-toggle trap fix)
    const toggle = within(section).getByRole('button', { name: /desktop command notifications/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // command/events stay read-only with the file-only hint
    expect(within(section).getByText(/file-only/)).toBeInTheDocument();
    expect(within(section).getByText('notify-send {title} {body}')).toBeInTheDocument();
    expect(within(section).getByText(/ci-failed: on/)).toBeInTheDocument();
    expect(within(section).getByText(/ready: off/)).toBeInTheDocument();
    expect(within(section).getByText(/prod-live: on/)).toBeInTheDocument();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument();
    // one hint line distinguishes the two sinks (command toggle vs header bell)
    expect(within(section).getByText(/browser pop-ups — the bell in the header/i)).toBeInTheDocument();
  });

  it('shows the webhook URL host-masked and the digest schedule, read-only (issue #51)', async () => {
    render(<SettingsPanel open onClose={() => {}} />);
    const heading = await screen.findByRole('heading', { name: 'Notifications' });
    const section = heading.closest('section')!;
    // the server already masked the URL — the panel must show it verbatim (host only)
    expect(within(section).getByText('https://hooks.slack.com/…')).toBeInTheDocument();
    expect(within(section).getByText('daily at 08:00 local')).toBeInTheDocument();
  });

  it('renders (none)/off when webhookUrl is unset and the digest is disabled', async () => {
    const noHook = { ...CONFIG, resolved: { ...CONFIG.resolved, notifications: {
      ...CONFIG.resolved.notifications, webhookUrl: undefined,
      digest: { enabled: false, hourLocal: 8 } } } };
    fetchSpy.mockImplementation(async (url: unknown) =>
      String(url) === '/api/repos' ? mockFetchOk({ repos: [] }) : mockFetchOk(noHook));
    render(<SettingsPanel open onClose={() => {}} />);
    const heading = await screen.findByRole('heading', { name: 'Notifications' });
    const section = heading.closest('section')!;
    expect(within(section).getByText('(none)')).toBeInTheDocument();
    expect(within(section).getByText('off')).toBeInTheDocument();
  });

  it('toggle → Save PUTs { notifications: { enabled: false } }', async () => {
    fetchSpy.mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/repos') return Promise.resolve(mockFetchOk({ repos: [] }));
      if (u === '/api/config' && (!init || init.method === undefined)) {
        return Promise.resolve(mockFetchOk(CONFIG));
      }
      return Promise.resolve(mockFetchOk({ applied: ['notifications'], restartRequired: [] }));
    });
    render(<SettingsPanel open onClose={() => {}} />);
    const toggle = await screen.findByRole('button', { name: /desktop command notifications/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.notifications).toEqual({ enabled: false });
    });
  });
});

describe('repo include/exclude toggles', () => {
  it('lists discovered repos with toggle state and PUTs the updated exclude on save', async () => {
    render(<SettingsPanel open={true} onClose={() => {}} />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/repos'));

    // both repos listed in the toggle list; states reflect the draft exclude
    await screen.findAllByText('acme/widgets');
    const list = document.querySelector('.repo-toggle-list')!;
    expect(within(list as HTMLElement).getByText('acme/widgets')).toBeInTheDocument();
    expect(within(list as HTMLElement).getByText('acme/legacy')).toBeInTheDocument();

    // exclude acme/widgets via its toggle
    const row = within(list as HTMLElement).getByText('acme/widgets').closest('li')!;
    fireEvent.click(within(row).getByRole('button'));
    expect(within(row).getByRole('button')).toHaveAttribute('aria-pressed', 'false');

    // save → PUT body carries the updated exclude including acme/widgets
    fetchSpy.mockResolvedValueOnce(mockFetchOk({ applied: ['exclude'], restartRequired: [] }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      const put = fetchSpy.mock.calls.find(([, init]: unknown[]) => (init as RequestInit)?.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.exclude).toContain('acme/widgets');
    });
  });
});
