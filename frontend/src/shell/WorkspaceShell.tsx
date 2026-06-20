// The persistent workspace shell: a global header (the "spine") + a left rail of
// the five sections + the active section's content (passed as children). Routing
// comes from RouterProvider (hash mode in standalone) via useSectionRoute.
import { type ReactNode } from 'react';
import { SECTIONS, hashForSection } from './sections';
import { useSectionRoute } from '../embed/RouterContext';

export interface WorkspaceShellProps {
  header: ReactNode;
  children: ReactNode;
}

export function WorkspaceShell({ header, children }: WorkspaceShellProps) {
  const { active, go, isPending } = useSectionRoute();
  return (
    <div className="workspace-shell">
      <header className="workspace-header" role="banner">{header}</header>
      <div className="workspace-body">
        <nav className="workspace-rail" role="navigation" aria-label="Workspace sections">
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={hashForSection(s.id)}
                  className={s.id === active ? 'rail-item active' : 'rail-item'}
                  aria-current={s.id === active ? 'page' : undefined}
                  title={s.blurb}
                  onClick={(e) => { e.preventDefault(); go(s.id); }}
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main className="workspace-content" role="main" aria-busy={isPending || undefined}>{children}</main>
      </div>
    </div>
  );
}
