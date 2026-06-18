// The raw-YAML escape hatch (spec visual-editor §2.5) — the rarely-needed advanced
// path for edits the structured surface can't express. Collapsed by default. The
// edit is re-derived through /candidate/raw (the model is the language server) and
// the gating verdict is shown; low parse-confidence / a dropped gate blocks apply.
// MVP uses a <textarea>; CodeMirror syntax highlighting + lazy-load is a follow-on.
import { useState } from 'react';
import type { WorkspaceApi, CandidateDto } from '../../shell/workspaceApi';

export interface RawYamlHatchProps { repo: string; file: string; baseSha?: string; api: WorkspaceApi }

export function RawYamlHatch({ repo, file, baseSha, api }: RawYamlHatchProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<CandidateDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function validate() {
    setBusy(true); setError(null);
    try { setResult(await api.candidateRaw(repo, file, text, baseSha)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const verdict = result && (
    !result.ok ? { kind: 'refused', text: result.reason ?? 'cannot derive' }
      : result.validation.gatingRegressed ? { kind: 'blocked', text: `blocked — would drop gate(s): ${result.validation.lostGates.join(', ')}` }
      : { kind: 'safe', text: 'safe — no required gate lost' }
  );

  return (
    <section className="raw-hatch" aria-label="Advanced escape hatch">
      <button type="button" className="raw-hatch-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Advanced — edit raw YAML ({file})
      </button>
      {open && (
        <div className="raw-hatch-body">
          <label className="raw-hatch-label" htmlFor="raw-yaml-ta">Raw YAML for {file}</label>
          <textarea id="raw-yaml-ta" className="raw-hatch-textarea" value={text} spellCheck={false}
            placeholder={`Paste the edited contents of .github/workflows/${file} to validate it…`}
            onChange={(e) => setText(e.target.value)} rows={10} />
          <button type="button" disabled={busy || !text.trim()} onClick={validate}>Validate edit</button>
          {error && <p role="alert">Couldn’t validate: {error}</p>}
          {verdict && <p data-testid="hatch-verdict" className={`candidate-verdict ${verdict.kind}`} role="status">{verdict.text}</p>}
        </div>
      )}
    </section>
  );
}
