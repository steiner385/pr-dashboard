import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type {
  ConfigResponse,
  ConfigPatch,
  ConfigPutResult,
  ConfigPutError,
  SettingSource,
  RepoSettingsReport,
} from './types';
import { SOURCE_DEFINITIONS, SETTINGS_DEFINITIONS, defTitle, type Definition } from './definitions';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Element to return focus to on close (e.g. the gear button). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Live SSE connection state — drives the restart "back online" detection. */
  connected?: boolean;
}

// ---- editable form model (the safe subset, with intervals in SECONDS) ----

interface FormModel {
  owners: string[];
  exclude: string[];
  retentionDays: number;
  batchSize: number;
  sweepSec: number;
  hotSec: number;
  deploySec: number;
  /** The DESKTOP COMMAND sink (server-side notify-send) — distinct from the
   *  browser-notification bell in the header. */
  notifyCommandEnabled: boolean;
}

function toForm(c: ConfigResponse): FormModel {
  const r = c.resolved;
  return {
    owners: [...r.owners],
    exclude: [...r.exclude],
    retentionDays: r.retentionDays,
    batchSize: r.batchSize,
    sweepSec: Math.round(r.intervals.sweepMs / 1000),
    hotSec: Math.round(r.intervals.hotMs / 1000),
    deploySec: Math.round(r.intervals.deployMs / 1000),
    notifyCommandEnabled: r.notifications.enabled,
  };
}

/** Build the PUT body — safe subset only, intervals converted back to ms.
 *  notifications rides along ONLY when the toggle changed: the server merges
 *  `{ enabled }` into the file block, and an unchanged toggle must not turn a
 *  default-sourced notifications block into a file-sourced one. */
function toPatch(f: FormModel, initialNotifyEnabled: boolean): ConfigPatch {
  return {
    owners: f.owners,
    exclude: f.exclude,
    retentionDays: f.retentionDays,
    batchSize: f.batchSize,
    intervals: {
      sweepMs: f.sweepSec * 1000,
      hotMs: f.hotSec * 1000,
      deployMs: f.deploySec * 1000,
    },
    ...(f.notifyCommandEnabled !== initialNotifyEnabled
      ? { notifications: { enabled: f.notifyCommandEnabled } }
      : {}),
  };
}

/** Per-sub-page help marker on a Settings section heading: the same copy the
 *  LegendPanel lists under "Settings", surfaced in place as a hover tooltip
 *  (title-only, like SourceTag — aria-hidden so it stays out of the heading's
 *  accessible name; the LegendPanel carries the screen-reader-accessible copy). */
function SectionHelp({ def }: { def: Definition }) {
  return (
    <span className="settings-help" title={defTitle(def)} aria-hidden="true">
      ⓘ
    </span>
  );
}

function SourceTag({ source }: { source: SettingSource }) {
  const def = SOURCE_DEFINITIONS[source];
  return (
    <span className={`source-tag source-${source}`} title={def.text}>
      {def.label}
    </span>
  );
}

// ---- chip list editor (owners / exclude) ----

function ChipEditor({
  label,
  values,
  onAdd,
  onRemove,
  removeNoun,
}: {
  label: string;
  values: string[];
  onAdd: (v: string) => void;
  onRemove: (i: number) => void;
  /** Singular noun used in the per-chip remove aria-label, e.g. "owner". */
  removeNoun: string;
}) {
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const commit = () => {
    const v = draft.trim();
    if (v) onAdd(v);
    setDraft('');
  };
  return (
    <div className="chip-editor">
      <div className="chip-list">
        {values.map((v, i) => (
          <span className="chip" key={`${v}-${i}`}>
            {v}
            <button
              type="button"
              className="chip-x"
              aria-label={`remove ${removeNoun} ${v}`}
              onClick={() => onRemove(i)}
            >
              ×
            </button>
          </span>
        ))}
        {values.length === 0 && <span className="chip-empty">none</span>}
      </div>
      <input
        id={inputId}
        type="text"
        className="chip-input"
        aria-label={`add ${removeNoun}`}
        placeholder={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

function deploySummary(report: RepoSettingsReport): string {
  const d = report.deploy.value;
  if (!d || d.environments.length === 0) return 'none';
  return d.environments.map((e) => e.name).join(', ');
}

export function SettingsPanel({ open, onClose, returnFocusRef, connected }: SettingsPanelProps) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [form, setForm] = useState<FormModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [restartRequested, setRestartRequested] = useState(false);
  const [backOnline, setBackOnline] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  // Fetch config when the panel opens (not before).
  const [repoNames, setRepoNames] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/repos')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GET /api/repos → ${r.status}`))))
      .then((body: { repos: { repo: string; excluded: boolean }[] }) => {
        if (!cancelled) setRepoNames(body.repos.map((r) => r.repo));
      })
      .catch(() => { /* list stays empty; the hint explains */ });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error(`GET /api/config → ${res.status}`);
        const body = (await res.json()) as ConfigResponse;
        if (cancelled) return;
        setConfig(body);
        setForm(toForm(body));
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset transient state each time the panel re-opens.
  useEffect(() => {
    if (!open) {
      setConfig(null);
      setForm(null);
      setFieldErrors({});
      setAppliedMsg(null);
      setConfirmingRestart(false);
      setRestartRequested(false);
      setBackOnline(false);
      wasDisconnectedRef.current = false;
    }
  }, [open]);

  // Esc to close + focus management (move focus in on open, restore on close).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the panel.
    const focusTarget =
      panelRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? panelRef.current;
    focusTarget?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore focus to the trigger.
      returnFocusRef?.current?.focus();
    };
  }, [open, onClose, returnFocusRef]);

  // Restart reconnect detection: once a restart was requested, the SSE stream
  // drops then comes back. When `connected` flips back to true, show "back online".
  const wasDisconnectedRef = useRef(false);
  useEffect(() => {
    if (!restartRequested) return;
    if (connected === false) {
      wasDisconnectedRef.current = true;
    } else if (connected === true && wasDisconnectedRef.current) {
      setBackOnline(true);
    }
  }, [connected, restartRequested]);

  if (!open) return null;

  const repoList = [...new Set([...repoNames, ...(form?.exclude ?? [])])].sort();
  const ownersEmpty = (form?.owners.length ?? 0) === 0;
  const canSave = !!form && !ownersEmpty && !saving;

  const patchForm = (next: Partial<FormModel>) =>
    setForm((prev) => (prev ? { ...prev, ...next } : prev));

  const handleSave = async () => {
    if (!form || !config || ownersEmpty) return;
    setSaving(true);
    setFieldErrors({});
    setAppliedMsg(null);
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toPatch(form, config.resolved.notifications.enabled)),
      });
      if (res.status === 400) {
        const err = (await res.json()) as ConfigPutError;
        setFieldErrors(err.fieldErrors ?? {});
        if (err.offendingKeys?.length) {
          setLoadError(`rejected keys: ${err.offendingKeys.join(', ')}`);
        }
        return;
      }
      if (!res.ok) throw new Error(`PUT /api/config → ${res.status}`);
      const result = (await res.json()) as ConfigPutResult;
      const applied = result.applied.length ? result.applied.join(', ') : 'nothing changed';
      setAppliedMsg(`applied: ${applied}`);
      // sync the changed-detection baseline so a second Save doesn't re-send
      // an unchanged notifications toggle
      setConfig((c) => c
        ? { ...c, resolved: { ...c.resolved, notifications: {
            ...c.resolved.notifications, enabled: form.notifyCommandEnabled } } }
        : c);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    setConfirmingRestart(false);
    try {
      const res = await fetch('/api/admin/restart', { method: 'POST' });
      if (!res.ok) throw new Error(`restart failed: ${res.status}`);
      setRestartRequested(true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="settings-overlay" data-testid="settings-overlay" onClick={onClose} />
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="settings-head">
          <h2 id={headingId}>Settings</h2>
          <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>

        {loadError && <p className="settings-error" role="alert">{loadError}</p>}
        {!config && !loadError && <p className="settings-loading">Loading…</p>}

        {form && config && (
          <div className="settings-body">
            {/* 1. Watched repos */}
            <section className="settings-section">
              <h3>Watched repos <SectionHelp def={SETTINGS_DEFINITIONS.watchedRepos} /></h3>
              <p className="settings-label">Owners</p>
              <ChipEditor
                label="add owner (e.g. acme)"
                values={form.owners}
                removeNoun="owner"
                onAdd={(v) => setForm((p) => (p ? { ...p, owners: [...p.owners, v] } : p))}
                onRemove={(i) =>
                  setForm((p) => (p ? { ...p, owners: p.owners.filter((_, j) => j !== i) } : p))
                }
              />
              {ownersEmpty && (
                <p className="settings-hint settings-warn">owners list cannot be empty</p>
              )}
              <p className="settings-label">Repos</p>
              {repoList.length === 0 && (
                <p className="settings-hint">repos appear after the first sweep</p>
              )}
              {repoList.length > 0 && (
                <ul className="repo-toggle-list">
                  {repoList.map((repo) => {
                    const excluded = form.exclude.includes(repo);
                    return (
                      <li key={repo} className={excluded ? 'repo-toggle excluded' : 'repo-toggle'}>
                        <span className="repo-toggle-name">{repo}</span>
                        <button
                          type="button"
                          aria-pressed={!excluded}
                          title={excluded ? 'excluded — click to include' : 'included — click to exclude'}
                          onClick={() =>
                            setForm((p) => {
                              if (!p) return p;
                              const exclude = excluded
                                ? p.exclude.filter((r) => r !== repo)
                                : [...p.exclude, repo];
                              return { ...p, exclude };
                            })
                          }
                        >
                          {excluded ? 'Excluded' : 'Included'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* 2. Tuning */}
            <section className="settings-section">
              <h3>Tuning <SectionHelp def={SETTINGS_DEFINITIONS.tuning} /></h3>
              <div className="settings-grid">
                <label htmlFor="cfg-retention">Retention (days)</label>
                <input
                  id="cfg-retention"
                  type="number"
                  min={1}
                  value={form.retentionDays}
                  onChange={(e) => patchForm({ retentionDays: Number(e.target.value) })}
                />
                {fieldErrors.retentionDays && (
                  <p className="settings-field-error">{fieldErrors.retentionDays}</p>
                )}

                <label htmlFor="cfg-batch">Batch size</label>
                <input
                  id="cfg-batch"
                  type="number"
                  min={1}
                  value={form.batchSize}
                  onChange={(e) => patchForm({ batchSize: Number(e.target.value) })}
                />
                {fieldErrors.batchSize && (
                  <p className="settings-field-error">{fieldErrors.batchSize}</p>
                )}

                <label htmlFor="cfg-sweep">Sweep interval (s)</label>
                <input
                  id="cfg-sweep"
                  type="number"
                  min={1}
                  value={form.sweepSec}
                  onChange={(e) => patchForm({ sweepSec: Number(e.target.value) })}
                />
                {fieldErrors['intervals.sweepMs'] && (
                  <p className="settings-field-error">{fieldErrors['intervals.sweepMs']}</p>
                )}

                <label htmlFor="cfg-hot">Hot interval (s)</label>
                <input
                  id="cfg-hot"
                  type="number"
                  min={1}
                  value={form.hotSec}
                  onChange={(e) => patchForm({ hotSec: Number(e.target.value) })}
                />
                {fieldErrors['intervals.hotMs'] && (
                  <p className="settings-field-error">{fieldErrors['intervals.hotMs']}</p>
                )}

                <label htmlFor="cfg-deploy">Deploy interval (s)</label>
                <input
                  id="cfg-deploy"
                  type="number"
                  min={1}
                  value={form.deploySec}
                  onChange={(e) => patchForm({ deploySec: Number(e.target.value) })}
                />
                {fieldErrors['intervals.deployMs'] && (
                  <p className="settings-field-error">{fieldErrors['intervals.deployMs']}</p>
                )}
              </div>
            </section>

            {/* 3. Per-repo (read-only) */}
            <section className="settings-section">
              <h3>Per-repo settings <SectionHelp def={SETTINGS_DEFINITIONS.perRepo} /></h3>
              <p className="settings-hint">
                edit via .pr-dashboard.yml in the repo, or repos./deploy. in config.json
              </p>
              {Object.entries(config.repos).map(([repo, report]) => (
                <div className="repo-settings" key={repo}>
                  <h4>{repo}</h4>
                  <dl className="repo-settings-grid">
                    <dt>rollupJobId</dt>
                    <dd>
                      <code>{report.rollupJobId.value}</code> <SourceTag source={report.rollupJobId.source} />
                    </dd>
                    <dt>workflowPath</dt>
                    <dd>
                      <code>{report.workflowPath.value}</code> <SourceTag source={report.workflowPath.source} />
                    </dd>
                    <dt>batchSize</dt>
                    <dd>
                      {report.batchSize.value} <SourceTag source={report.batchSize.source} />
                    </dd>
                    <dt>prefixes</dt>
                    <dd>
                      {report.requiredCheckPrefixes.value?.length ?? 0}{' '}
                      <SourceTag source={report.requiredCheckPrefixes.source} />
                    </dd>
                    <dt>deploy</dt>
                    <dd>
                      {deploySummary(report)} <SourceTag source={report.deploy.source} />
                    </dd>
                  </dl>
                </div>
              ))}
            </section>

            {/* 4. Instance (read-only) */}
            <section className="settings-section">
              <h3>Instance <SectionHelp def={SETTINGS_DEFINITIONS.instance} /></h3>
              <p className="settings-hint">file-only for security</p>
              <dl className="repo-settings-grid">
                <dt>tokenSource</dt>
                <dd><code>{config.resolved.tokenSource}</code></dd>
                <dt>apiUrl</dt>
                <dd><code>{config.resolved.apiUrl}</code></dd>
                <dt>port</dt>
                <dd><code>{config.resolved.port}</code></dd>
                <dt>ancestrySource</dt>
                <dd><code>{config.resolved.ancestrySource}</code></dd>
                <dt>costPerMinute</dt>
                <dd>
                  <code title="pool label → $ per runner-minute ('default' prices unlisted pools) — drives the CI cost panel's $ figures; file-only">
                    {config.resolved.costPerMinute
                      ? Object.entries(config.resolved.costPerMinute)
                        .map(([pool, rate]) => `${pool}: $${rate}/min`).join(' · ')
                      : '(not configured — CI cost reports minutes only)'}
                  </code>
                </dd>
                <dt>poolMeta</dt>
                <dd>
                  <code title="pool label → { instanceType, dollarsPerMinute, podsPerNode, note } — instance types display in the cost explorer; a dollarsPerMinute here supersedes the costPerMinute entry for the same pool; the effective rate divides by podsPerNode (bin-packing correction); file-only">
                    {config.resolved.poolMeta
                      ? Object.entries(config.resolved.poolMeta)
                        .map(([pool, meta]) => [
                          pool,
                          [meta.instanceType,
                            meta.dollarsPerMinute != null ? `$${meta.dollarsPerMinute}/min` : null,
                            meta.podsPerNode != null ? `${meta.podsPerNode} pods/node` : null]
                            .filter(Boolean).join(', ') || '(empty)',
                        ].join(': ')).join(' · ')
                      : '(not configured — pools show no instance type)'}
                  </code>
                </dd>
                <dt>config file</dt>
                <dd><code>{config.sources.configPath}</code></dd>
              </dl>
            </section>

            {/* 5. Notifications — enabled is live; command/events stay file-only */}
            <section className="settings-section">
              <h3>Notifications <SectionHelp def={SETTINGS_DEFINITIONS.notifications} /></h3>
              <dl className="repo-settings-grid">
                <dt>enabled</dt>
                <dd>
                  <button
                    type="button"
                    aria-pressed={form.notifyCommandEnabled}
                    aria-label="Desktop command notifications"
                    title={form.notifyCommandEnabled
                      ? 'on — the server runs the command below on alert-worthy transitions'
                      : 'off — the server command sink is disarmed'}
                    onClick={() =>
                      patchForm({ notifyCommandEnabled: !form.notifyCommandEnabled })}
                  >
                    {form.notifyCommandEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                  {fieldErrors['notifications.enabled'] && (
                    <p className="settings-field-error">{fieldErrors['notifications.enabled']}</p>
                  )}
                </dd>
                <dt>command</dt>
                <dd><code>{config.resolved.notifications.command.join(' ') || '(none)'}</code></dd>
                <dt>webhook</dt>
                <dd>
                  <code title="generic webhook sink — every event is POSTed as JSON; masked to host only (the URL path may carry a token)">
                    {config.resolved.notifications.webhookUrl ?? '(none)'}
                  </code>
                </dd>
                <dt>digest</dt>
                <dd title="daily 24h summary (merges, ejects, regressions, runner waits, queue health) sent through the command and webhook sinks">
                  {config.resolved.notifications.digest.enabled
                    ? `daily at ${String(config.resolved.notifications.digest.hourLocal).padStart(2, '0')}:00 local`
                    : 'off'}
                </dd>
                <dt>events</dt>
                <dd>
                  {Object.entries(config.resolved.notifications.events)
                    .map(([type, on]) => `${type}: ${on ? 'on' : 'off'}`)
                    .join(' · ')}
                </dd>
              </dl>
              <p className="settings-hint">
                Desktop command notifications — the toggle above; browser pop-ups — the
                bell in the header.
              </p>
              <p className="settings-hint">
                command, webhookUrl, digest, and events are file-only — edit
                notifications.* in config.json (the command runs on the server host;
                the webhook URL may carry a token)
              </p>
            </section>

            {/* Actions */}
            <footer className="settings-actions">
              <button
                type="button"
                className="btn-save"
                onClick={() => void handleSave()}
                disabled={!canSave}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>

              {!confirmingRestart && !restartRequested && (
                <button
                  type="button"
                  className="btn-restart"
                  onClick={() => setConfirmingRestart(true)}
                >
                  Restart…
                </button>
              )}
              {confirmingRestart && (
                <span className="restart-confirm">
                  Restart service?
                  <button type="button" className="btn-restart" onClick={() => void handleRestart()}>
                    Confirm restart
                  </button>
                  <button type="button" className="btn-cancel" onClick={() => setConfirmingRestart(false)}>
                    Cancel
                  </button>
                </span>
              )}

              {appliedMsg && <span className="applied-line" role="status">{appliedMsg}</span>}
              {restartRequested && !backOnline && (
                <span className="restart-line" role="status">restarting…</span>
              )}
              {restartRequested && backOnline && (
                <span className="restart-line restart-back" role="status">back online</span>
              )}
            </footer>
          </div>
        )}
      </div>
    </>
  );
}
