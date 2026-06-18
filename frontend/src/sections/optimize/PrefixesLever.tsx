// The requiredCheckPrefixes lever (spec roadmap 4.5) as a one-click governed
// action. Preview computes the suggested prefixes from the model's merge_group
// checks and shows the exact `.pr-dashboard.yml` change (other keys preserved);
// Open files a draft PR. Self-contained state so it drops into any surface.
import { useState } from 'react';
import type { WorkspaceApi } from '../../shell/workspaceApi';

export function PrefixesLever({ repo, api }: { repo: string; api: WorkspaceApi }) {
  const [preview, setPreview] = useState<{ prefixes: string[]; newText: string } | null>(null);
  const [opened, setOpened] = useState<{ number: number; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doPreview() {
    setBusy(true); setError(null); setOpened(null);
    try { const r = await api.prefixesDryRun(repo); setPreview({ prefixes: r.prefixes, newText: r.newText }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function doOpen() {
    setBusy(true); setError(null);
    try { setOpened(await api.prefixesOpen(repo, preview?.prefixes)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="prefixes-lever" aria-label="Required-check prefixes">
      <h3>Required-check prefixes</h3>
      <p className="prefixes-blurb">
        Configure <code>requiredCheckPrefixes</code> so the merge queue can separate a real gate failure
        from advisory noise. Suggested from the checks that run at <code>merge_group</code>.
      </p>
      {!preview && <button type="button" disabled={busy} onClick={doPreview}>Preview .pr-dashboard.yml change</button>}
      {preview && (
        <>
          <p className="prefixes-suggested" role="status">
            Suggested: {preview.prefixes.map((p) => <code key={p}>{p}</code>).reduce((acc, el, i) => (i === 0 ? [el] : [...acc, ', ', el]), [] as React.ReactNode[])}
          </p>
          <pre className="prefixes-diff" aria-label="pr-dashboard.yml preview">{preview.newText}</pre>
          {!opened && <button type="button" className="prefixes-open" disabled={busy} onClick={doOpen}>Open draft PR</button>}
        </>
      )}
      {opened && <p className="prefixes-opened" role="status">Opened draft PR <a href={opened.url}>#{opened.number}</a> — review and merge there.</p>}
      {error && <p className="prefixes-error" role="alert">Couldn’t prepare the change: {error}</p>}
    </section>
  );
}
