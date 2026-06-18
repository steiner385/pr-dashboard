// The persistent workspace shell (spec 001, FR-001/FR-002/FR-003): a global header
// (the "spine") + a left rail of the five sections + the active section's content.
// Sections not yet rebuilt fall back to the legacy bridge (strangler-fig, D8) so
// the user never loses a capability mid-rebuild. Hash-routed: each section is
// linkable and survives reload (same pattern as the legacy App tabs).
import { useEffect, useState, type ReactNode } from 'react';
import { SECTIONS, DEFAULT_SECTION, sectionFromHash, hashForSection, type SectionId } from './sections';

/** Track the active section from the URL hash (back/forward + deep links work). */
export function useSectionRoute(): [SectionId, (id: SectionId) => void] {
  const [section, setSection] = useState<SectionId>(() => sectionFromHash(location.hash) ?? DEFAULT_SECTION);
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash(location.hash) ?? DEFAULT_SECTION);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (id: SectionId) => { location.hash = hashForSection(id); setSection(id); };
  return [section, go];
}

export interface WorkspaceShellProps {
  /** the persistent spine (health verdict, pipeline switcher, alerts/self-obs) */
  header: ReactNode;
  /** content per section; a section absent here renders the legacy bridge */
  content: Partial<Record<SectionId, ReactNode>>;
  /** rendered for sections not yet rebuilt (deep-links to the classic UI) */
  legacyBridge: (id: SectionId) => ReactNode;
}

export function WorkspaceShell({ header, content, legacyBridge }: WorkspaceShellProps) {
  const [active, go] = useSectionRoute();
  const body = content[active] ?? legacyBridge(active);

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
        <main className="workspace-content" role="main" aria-live="polite">{body}</main>
      </div>
    </div>
  );
}
