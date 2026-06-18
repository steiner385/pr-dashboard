// Build section (spec 001 visual-editor §2.2/§2.3 — the no-code loop MVP, Increment 3):
// pick a check, apply a structured op (one click), compose an ordered, reversible
// mutation stack, and project it through /api/workspace/candidate — which re-derives
// the model and validates it. The candidate panel surfaces the verdict (safe /
// scaffold / blocked) + the generated diff. Authoring never touches YAML; the server
// is the safety arbiter (gatingRegressed blocks a required-gate drop). API injected.
import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceApi, CandidateDto, CandidateMutationDto } from '../../shell/workspaceApi';
import type { DerivedModelLike } from '../optimize/types';
import { laneLayout } from './laneLayout';
import { PipelineCanvas } from './PipelineCanvas';
import { NodeInspector } from './NodeInspector';

const DEFAULT_TIMEOUT = 15;

/** The provenance job id an edit must target for a check (its defining anchor). */
function jobIdFor(model: DerivedModelLike, check: string): string | null {
  return model.checkMeta.find((m) => m.check === check)?.provenance[0]?.jobId ?? null;
}

function labelFor(m: CandidateMutationDto): string {
  switch (m.op) {
    case 'timeout': return `timeout ${m.minutes}m · ${m.jobId}`;
    case 'shift-left': return `shift-left · ${m.jobId}`;
    case 'remove': return `remove · ${m.jobId}`;
    case 'runner': return `runner ${m.runsOn} · ${m.jobId}`;
    case 'concurrency': return `concurrency`;
  }
}

export interface BuildViewProps { repo: string | null; api: WorkspaceApi }

export function BuildView({ repo, api }: BuildViewProps) {
  const [model, setModel] = useState<DerivedModelLike | null>(null);
  const [baseSha, setBaseSha] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stack, setStack] = useState<CandidateMutationDto[]>([]);
  const [candidate, setCandidate] = useState<CandidateDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<{ number: number; url: string } | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [selectedCheck, setSelectedCheck] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    setModel(null); setError(null); setStack([]); setCandidate(null);
    api.getPipeline(repo).then((r) => { setModel(r.model); setBaseSha(r.sourceSha); }).catch((e: Error) => setError(e.message));
  }, [repo, api]);

  // Re-project the candidate whenever the mutation stack changes.
  useEffect(() => {
    if (!repo || stack.length === 0) { setCandidate(null); return; }
    let cancelled = false;
    setBusy(true);
    api.candidate(repo, stack, baseSha ?? undefined)
      .then((c) => { if (!cancelled) setCandidate(c); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [repo, api, stack, baseSha]);

  const add = (m: CandidateMutationDto) => { setOpened(null); setApplyError(null); setStack((s) => [...s, m]); };
  const removeAt = (i: number) => { setOpened(null); setApplyError(null); setStack((s) => s.filter((_, j) => j !== i)); };

  async function openDraftPr() {
    if (!repo || stack.length === 0) return;
    setBusy(true); setApplyError(null);
    try { setOpened(await api.candidateApply(repo, stack, baseSha ?? undefined)); }
    catch (e) { setApplyError((e as Error).message); }
    finally { setBusy(false); }
  }

  const lanes = useMemo(() => (model ? laneLayout(model) : []), [model]);

  const verdict = useMemo(() => {
    if (!candidate) return null;
    if (!candidate.ok) return { kind: 'refused' as const, text: candidate.reason ?? 'cannot apply' };
    if (candidate.validation.gatingRegressed) return { kind: 'blocked' as const, text: `blocked — would drop required gate(s): ${candidate.validation.lostGates.join(', ')}` };
    if (candidate.validation.lowConfidence) return { kind: 'scaffold' as const, text: 'low parse-confidence — scaffold only (no structured apply)' };
    return { kind: 'safe' as const, text: 'safe — no required gate lost' };
  }, [candidate]);

  if (!repo) return <div className="build-view empty">Select a pipeline to build.</div>;
  if (error) return <div className="build-view error" role="alert">Couldn’t load the model: {error}</div>;
  if (!model) return <div className="build-view" role="status">Deriving the pipeline model…</div>;

  return (
    <div className="build-view">
      <h2>Build — {repo}</h2>
      <p className="build-blurb">Shape the pipeline by applying structured changes — the tool generates the YAML and validates it. No required gate can be silently dropped.</p>

      <PipelineCanvas lanes={lanes} onSelect={setSelectedCheck} selected={selectedCheck ?? undefined} />

      {selectedCheck && jobIdFor(model, selectedCheck) && (
        <NodeInspector check={selectedCheck} jobId={jobIdFor(model, selectedCheck)!} onApply={add} />
      )}

      <ul className="build-checks" role="list">
        {model.checks.map((c) => {
          const job = jobIdFor(model, c);
          if (!job) return null;
          return (
            <li key={c} className="build-check">
              <span className="build-check-name">{c}</span>
              <button type="button" disabled={busy} onClick={() => add({ op: 'timeout', jobId: job, minutes: DEFAULT_TIMEOUT })}>Add timeout</button>
              <button type="button" disabled={busy} onClick={() => add({ op: 'shift-left', jobId: job })}>Shift-left</button>
              <button type="button" disabled={busy} onClick={() => add({ op: 'remove', jobId: job })}>Remove</button>
            </li>
          );
        })}
      </ul>

      {stack.length > 0 && (
        <section className="build-stack" aria-label="Pending changes">
          <h3>{stack.length} pending change{stack.length === 1 ? '' : 's'}</h3>
          <ol>
            {stack.map((m, i) => (
              <li key={i}>
                <span>{labelFor(m)}</span>
                <button type="button" aria-label={`remove pending change ${i + 1}`} onClick={() => removeAt(i)}>✕</button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {verdict && (
        <section className="build-candidate" aria-label="Candidate">
          <p data-testid="candidate-verdict" className={`candidate-verdict ${verdict.kind}`} role="status">{verdict.text}</p>
          {candidate?.ok && candidate.files.length > 0 && (
            <pre className="build-diff" aria-label="generated diff">{candidate.files.map((f) => `# ${f.file}\n${f.diff}`).join('\n\n')}</pre>
          )}
          {verdict.kind === 'safe' && !opened && (
            <button type="button" className="build-exit" disabled={busy} onClick={openDraftPr}>Open draft PR</button>
          )}
          {verdict.kind === 'scaffold' && (
            <p className="build-exit-note">Low confidence — this would generate a review scaffold rather than a structured apply.</p>
          )}
          {opened && (
            <p className="build-opened" role="status">Opened draft PR <a href={opened.url}>#{opened.number}</a> — review and merge there.</p>
          )}
          {applyError && <p className="build-apply-error" role="alert">Couldn’t open the PR: {applyError}</p>}
        </section>
      )}
    </div>
  );
}
