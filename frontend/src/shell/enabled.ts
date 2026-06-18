// Frontend flag for the unified workspace (spec 001, strangler-fig). The
// workspace is now the DEFAULT surface; the classic App is a sticky back-door via
// `?legacy=1` (or the equivalent `?workspace=0`). `?workspace=1` / `?legacy=0`
// return to the workspace. Pure + testable; main.tsx just calls it.
const KEY = 'workspace.enabled';

export function workspaceEnabled(search: string, store: Pick<Storage, 'getItem' | 'setItem'>): boolean {
  const params = new URLSearchParams(search);
  const ws = params.get('workspace');
  const legacy = params.get('legacy');
  // Legacy back-door: ?legacy=1 or ?workspace=0 → classic App, remembered.
  if (legacy === '1' || legacy === 'true' || ws === '0' || ws === 'false') {
    try { store.setItem(KEY, '0'); } catch { /* ignore */ }
    return false;
  }
  // Return to the workspace: ?workspace=1 or ?legacy=0, remembered.
  if (ws === '1' || ws === 'true' || legacy === '0' || legacy === 'false') {
    try { store.setItem(KEY, '1'); } catch { /* ignore */ }
    return true;
  }
  // Default ON — only an explicit, persisted legacy opt-out ('0') leaves it.
  try { return store.getItem(KEY) !== '0'; } catch { return true; }
}
