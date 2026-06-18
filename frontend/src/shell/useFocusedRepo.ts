import { useFocusedPipeline } from './PipelineSwitcher';

/** Resolve the focused repo: controlled (host-owned, no persist/adopt) or sticky. */
export function useFocusedRepo(
  { controlled, onChange, repos }:
  { controlled?: string; onChange?: (repo: string) => void; repos: readonly string[] },
): [string | null, (repo: string) => void] {
  const isControlled = controlled !== undefined;
  const [sticky, setSticky] = useFocusedPipeline(repos, !isControlled);
  if (isControlled) return [controlled as string, (r) => onChange?.(r)];
  return [sticky, setSticky];
}
