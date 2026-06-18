// frontend/src/embed/PrDashboard.tsx
import { ApiBaseProvider } from './ApiBaseContext';
import { RouterProvider, useSectionRoute } from './RouterContext';
import { useWorkspaceData } from '../useWorkspaceData';
import { useFocusedRepo } from '../shell/useFocusedRepo';
import { SectionContent } from '../SectionContent';
import { StatusStrip } from './StatusStrip';
import '../styles.css';

export interface PrDashboardProps {
  /** Host proxy root for all data + the SSE. Default '/api'. Auth is the host's job. */
  apiBase?: string;
  /** URL prefix the embed lives under (path routing). Default ''. */
  basename?: string;
  /** 'path' (embedded, default) drives sections via History; 'hash' = standalone style. */
  routerMode?: 'path' | 'hash';
  /** Controlled focused repo; omit for the in-content sticky switcher. */
  focusedRepo?: string;
  onFocusChange?: (repo: string) => void;
  /** Appended to the `.prdash-root` wrapper. */
  className?: string;
  /** Send credentials on the SSE (cookie-proxy hosts). Default false. */
  withCredentials?: boolean;
}

function PrDashboardInner(
  { focusedRepo, onFocusChange }: Pick<PrDashboardProps, 'focusedRepo' | 'onFocusChange'>,
) {
  const { state, connected, stale, repos, api } = useWorkspaceData();
  const [focused, focus] = useFocusedRepo({ controlled: focusedRepo, onChange: onFocusChange, repos });
  const { active } = useSectionRoute();
  return (
    <>
      <StatusStrip repos={repos} focused={focused} onFocus={focus} connected={connected} stale={stale} api={api} />
      <SectionContent active={active} state={state} connected={connected} api={api} focused={focused} onFocusRepo={focus} />
    </>
  );
}

/** Content-only embeddable dashboard. The host owns chrome, routing shell, and auth. */
export function PrDashboard(
  { apiBase = '/api', basename = '', routerMode = 'path', focusedRepo, onFocusChange, className, withCredentials = false }: PrDashboardProps,
) {
  return (
    <ApiBaseProvider base={apiBase} withCredentials={withCredentials}>
      <RouterProvider mode={routerMode} basename={basename}>
        <div className={className ? `prdash-root ${className}` : 'prdash-root'}>
          <PrDashboardInner focusedRepo={focusedRepo} onFocusChange={onFocusChange} />
        </div>
      </RouterProvider>
    </ApiBaseProvider>
  );
}
