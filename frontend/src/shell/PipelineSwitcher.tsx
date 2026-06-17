// The pipeline context switcher (spec 001, FR-004): a type-to-filter picker that
// makes the focused pipeline explicit + switchable. Focus is sticky (last-focused,
// persisted) — there is no hardcoded "primary". The focused repo's name is the
// guardrail that any authoring action targets the intended pipeline, so it stays
// pinned and visible. Pure presentation + a small persistence hook.
import { useMemo, useState, useEffect } from 'react';

const STORE_KEY = 'workspace.focusedPipeline';

/** Sticky focused-pipeline state (persisted to localStorage; falls back to first repo). */
export function useFocusedPipeline(repos: readonly string[]): [string | null, (repo: string) => void] {
  const [focused, setFocused] = useState<string | null>(() => {
    try { const s = localStorage.getItem(STORE_KEY); if (s && repos.includes(s)) return s; } catch { /* ignore */ }
    return repos[0] ?? null;
  });
  // if the stored focus disappears from the repo set, fall back to the first repo
  useEffect(() => {
    if (focused && !repos.includes(focused)) setFocused(repos[0] ?? null);
  }, [repos, focused]);
  const focus = (repo: string) => {
    setFocused(repo);
    try { localStorage.setItem(STORE_KEY, repo); } catch { /* ignore */ }
  };
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
  const matches = useMemo(() => filterRepos(repos, query, focused), [repos, query, focused]);

  return (
    <div className="pipeline-switcher">
      <button
        type="button"
        className="pipeline-switcher-current"
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
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul role="listbox" aria-label="Pipelines">
            {matches.map((r) => (
              <li
                key={r}
                role="option"
                aria-selected={r === focused}
                className={r === focused ? 'pipeline-option focused' : 'pipeline-option'}
                onClick={() => { onFocus(r); setOpen(false); setQuery(''); }}
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
