import { describe, it, expect } from 'vitest';
import { workspaceEnabled } from '../shell/enabled';

function fakeStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), _m: m };
}

describe('workspaceEnabled (workspace is the DEFAULT; legacy is a sticky back-door)', () => {
  it('defaults to TRUE (the new workspace) with no flag and nothing stored', () => {
    expect(workspaceEnabled('', fakeStore())).toBe(true);
  });

  it('?legacy=1 drops to the classic App and persists the opt-out', () => {
    const s = fakeStore();
    expect(workspaceEnabled('?legacy=1', s)).toBe(false);
    expect(s._m.get('workspace.enabled')).toBe('0');
  });

  it('?workspace=0 is an equivalent legacy back-door (persists)', () => {
    const s = fakeStore();
    expect(workspaceEnabled('?workspace=0', s)).toBe(false);
    expect(s._m.get('workspace.enabled')).toBe('0');
  });

  it('sticky: a prior legacy opt-out is remembered without the query param', () => {
    expect(workspaceEnabled('', fakeStore({ 'workspace.enabled': '0' }))).toBe(false);
  });

  it('?workspace=1 returns to the workspace from a pinned-legacy state', () => {
    const s = fakeStore({ 'workspace.enabled': '0' });
    expect(workspaceEnabled('?workspace=1', s)).toBe(true);
    expect(s._m.get('workspace.enabled')).toBe('1');
  });

  it('?legacy=0 is an equivalent way back to the workspace', () => {
    const s = fakeStore({ 'workspace.enabled': '0' });
    expect(workspaceEnabled('?legacy=0', s)).toBe(true);
    expect(s._m.get('workspace.enabled')).toBe('1');
  });

  it('a stored opt-in (legacy from a prior version) still reads as workspace', () => {
    expect(workspaceEnabled('', fakeStore({ 'workspace.enabled': '1' }))).toBe(true);
  });
});
