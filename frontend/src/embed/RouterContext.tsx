import { createContext, useCallback, useContext, useEffect, useState, useTransition, type ReactNode } from 'react';
import {
  DEFAULT_SECTION, sectionFromHash, hashForSection, sectionFromPath, pathForSection, type SectionId,
} from '../shell/sections';

export interface SectionRoute { active: SectionId; go: (id: SectionId) => void; isPending: boolean }

const RouterContext = createContext<SectionRoute | null>(null);

export function RouterProvider(
  { mode, basename = '', children }: { mode: 'hash' | 'path'; basename?: string; children: ReactNode },
) {
  const [active, setActive] = useState<SectionId>(() =>
    mode === 'hash'
      ? sectionFromHash(location.hash) ?? DEFAULT_SECTION
      : sectionFromPath(location.pathname, basename) ?? DEFAULT_SECTION);

  // React 19 (#181): section switches run as transitions, so a heavy incoming
  // section (Insights / Metrics builds many charts) never blocks the click
  // feedback — React keeps the current section interactive while it renders.
  // `isPending` lets the shell mark the content busy during the switch. The URL
  // update stays synchronous; only the render-triggering setActive is deferred.
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (mode === 'hash') {
      const onHash = () => startTransition(() => setActive(sectionFromHash(location.hash) ?? DEFAULT_SECTION));
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    }
    const onPop = () => startTransition(() => setActive(sectionFromPath(location.pathname, basename) ?? DEFAULT_SECTION));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [mode, basename]);

  const go = useCallback((id: SectionId) => {
    if (mode === 'hash') location.hash = hashForSection(id);
    else history.pushState({}, '', pathForSection(id, basename));
    startTransition(() => setActive(id));
  }, [mode, basename]);

  return <RouterContext.Provider value={{ active, go, isPending }}>{children}</RouterContext.Provider>;
}

export function useSectionRoute(): SectionRoute {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useSectionRoute must be used within a RouterProvider');
  return ctx;
}
