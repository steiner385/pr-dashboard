import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_SECTION, sectionFromHash, hashForSection, sectionFromPath, pathForSection, type SectionId,
} from '../shell/sections';

export interface SectionRoute { active: SectionId; go: (id: SectionId) => void }

const RouterContext = createContext<SectionRoute | null>(null);

export function RouterProvider(
  { mode, basename = '', children }: { mode: 'hash' | 'path'; basename?: string; children: ReactNode },
) {
  const [active, setActive] = useState<SectionId>(() =>
    mode === 'hash'
      ? sectionFromHash(location.hash) ?? DEFAULT_SECTION
      : sectionFromPath(location.pathname, basename) ?? DEFAULT_SECTION);

  useEffect(() => {
    if (mode === 'hash') {
      const onHash = () => setActive(sectionFromHash(location.hash) ?? DEFAULT_SECTION);
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    }
    const onPop = () => setActive(sectionFromPath(location.pathname, basename) ?? DEFAULT_SECTION);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [mode, basename]);

  const go = (id: SectionId) => {
    if (mode === 'hash') location.hash = hashForSection(id);
    else history.pushState({}, '', pathForSection(id, basename));
    setActive(id);
  };

  return <RouterContext.Provider value={{ active, go }}>{children}</RouterContext.Provider>;
}

export function useSectionRoute(): SectionRoute {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useSectionRoute must be used within a RouterProvider');
  return ctx;
}
