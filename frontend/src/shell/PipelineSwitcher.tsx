// The pipeline context switcher (spec 001, FR-004): a type-to-filter picker that
// makes the focused pipeline explicit + switchable. Focus is sticky (last-focused,
// persisted) — there is no hardcoded "primary". The focused repo's name is the
// guardrail that any authoring action targets the intended pipeline, so it stays
// pinned and visible. Pure presentation + a small persistence hook.
import { useCallback, useMemo, useState, useEffect, useRef, type KeyboardEvent } from 'react';

const STORE_KEY = 'workspace.focusedPipeline';

/** Sticky focused-pipeline state (persisted to localStorage; falls back to first repo). */
export function useFocusedPipeline(repos: readonly string[], enabled = true): [string | null, (repo: string) => void] {
  const [focused, setFocused] = useState<string | null>(() => {
    try { const s = localStorage.getItem(STORE_KEY); if (s && repos.includes(s)) return s; } catch { /* ignore */ }
    return repos[0] ?? null;
  });
  // Adopt a focus once repos load (repos is empty on first render before the live
  // state streams in, so the initial useState lands on null) AND re-home if the
  // current focus disappears from the set. Bug: the old guard `if (focused && …)`
  // never adopted a repo when focus started null — Model/Optimize then stayed on
  // their "select a pipeline" empty state forever. (Found via live browser testing.)
  useEffect(() => {
    if (!enabled) return;
    if (repos.length === 0) return;
    if (!focused || !repos.includes(focused)) {
      let stored: string | null = null;
      try { stored = localStorage.getItem(STORE_KEY); } catch { /* ignore */ }
      setFocused(stored && repos.includes(stored) ? stored : repos[0]);
    }
  }, [repos, focused, enabled]);
  const focus = useCallback((repo: string) => {
    setFocused(repo);
    try { localStorage.setItem(STORE_KEY, repo); } catch { /* ignore */ }
  }, []); // setFocused is stable; localStorage is a global — no deps needed
  return [focused, focus];
}

/** case-insensitive substring filter, focused repo first */
export function filterRepos(repos: readonly string[], query: string, focused: string | null): string[] {
  const q = query.trim().toLowerCase();
  const hits = q ? repos.filter((r) => r.toLowerCase().includes(q)) : [...repos];
  return hits.sort((a, b) => (a === focused ? -1 : b === focused ? 1 : 0));
}

export interface PipelineSwitcherProps {
  repos: readonly string[];
  focused: string | null;
  onFocus: (repo: string) => void;
}

export function PipelineSwitcher({ repos, focused, onFocus }: PipelineSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0); // highlighted option index (keyboard)
  const rootRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => filterRepos(repos, query, focused), [repos, query, focused]);

  const close = useCallback(() => { setOpen(false); setQuery(''); setActive(0); }, []);
  const pick = useCallback((r: string) => { onFocus(r); close(); }, [onFocus, close]);

  // Reset the highlight whenever the candidate set changes.
  useEffect(() => { setActive(0); }, [query, open]);

  // Close on an outside click (roadmap 2.2).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); const r = matches[active]; if (r) pick(r); return; }
  };

  return (
    <div className="pipeline-switcher" ref={rootRef}>
      <button
        type="button"
        className="pipeline-switcher-current"
        aria-label="Switch pipeline"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pipeline-label">{focused ?? 'Select a pipeline'}</span>
      </button>
      {open && (
        <div className="pipeline-switcher-popover">
          <input
            type="text"
            className="pipeline-switcher-filter"
            placeholder="Filter pipelines…"
            aria-label="Filter pipelines"
            role="combobox"
            aria-expanded="true"
            aria-controls="pipeline-listbox"
            aria-activedescendant={matches[active] ? `pl-opt-${active}` : undefined}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <ul id="pipeline-listbox" role="listbox" aria-label="Pipelines">
            {matches.map((r, i) => (
              <li
                key={r}
                id={`pl-opt-${i}`}
                role="option"
                aria-selected={r === focused}
                className={`pipeline-option${r === focused ? ' focused' : ''}${i === active ? ' active' : ''}`}
                onClick={() => pick(r)}
              >
                {r}
              </li>
            ))}
            {matches.length === 0 && <li className="pipeline-option empty">no matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
