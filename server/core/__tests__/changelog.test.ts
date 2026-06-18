import { describe, it, expect } from 'vitest';
import { buildChangelog, buildAuditLog } from '../analytics/changelog';

describe('buildChangelog (Group L1 / FR-039)', () => {
  it('orders newest-first and defaults a missing actor', () => {
    const out = buildChangelog([
      { at: '2026-06-01T00:00:00Z', kind: 'workflow', summary: 'added e2e gate' },
      { at: '2026-06-10T00:00:00Z', kind: 'config', summary: 'retention 7→30d', actor: 'tony' },
    ]);
    expect(out.map((e) => e.summary)).toEqual(['retention 7→30d', 'added e2e gate']);
    expect(out[1].actor).toBe('unknown');
  });
  it('de-duplicates identical at+summary and caps to the limit', () => {
    const dup = { at: '2026-06-01T00:00:00Z', kind: 'x', summary: 'same' };
    expect(buildChangelog([dup, dup, dup])).toHaveLength(1);
    expect(buildChangelog(Array.from({ length: 80 }, (_, i) => ({ at: `2026-06-${(i % 28) + 1}T0${i % 9}:00:00Z`, kind: 'x', summary: `s${i}` })), 50)).toHaveLength(50);
  });
});

describe('buildAuditLog (Group L2 / FR-039)', () => {
  it('orders newest-first and attributes every entry to the workspace', () => {
    const out = buildAuditLog([
      { at: '2026-06-01T00:00:00Z', action: 'draft-pr', repo: 'o/r', target: 'e2e', result: 'opened #5' },
      { at: '2026-06-02T00:00:00Z', action: 'prompt', repo: 'o/r', target: 'lint' },
    ]);
    expect(out[0].action).toBe('prompt');
    expect(out.every((e) => e.actor === 'workspace')).toBe(true);
  });
});
