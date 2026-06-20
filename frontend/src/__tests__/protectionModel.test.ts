import { describe, it, expect } from 'vitest';
import {
  buildFindings, cellKey, groupOf, leafOf, displayName, fmtMin, cellTitle, cellHeat,
  type Cell, type DerivedModel, type MetricsSlice,
} from '../protectionModel';

describe('protectionModel — check-name helpers', () => {
  it('cellKey joins check and tier', () => {
    expect(cellKey('build / unit', 'pr')).toBe('build / unit pr');
  });

  it('groupOf returns the owning workflow, or "other" for a bare leaf', () => {
    expect(groupOf('ci.yml / unit')).toBe('ci.yml');
    expect(groupOf('lint')).toBe('other');
  });

  it('leafOf returns the check leaf, or the whole string when ungrouped', () => {
    expect(leafOf('ci.yml / unit')).toBe('unit');
    expect(leafOf('lint')).toBe('lint');
  });

  it('displayName drops the raw matrix-template shard and collapses whitespace', () => {
    expect(displayName('ci.yml / shard (${{ matrix.index }}/4)')).toBe('shard');
    expect(displayName('ci.yml / unit')).toBe('unit');
  });
});

describe('protectionModel — fmtMin', () => {
  it('shows minutes under an hour, then hours (1 decimal, whole past 10h)', () => {
    expect(fmtMin(30)).toBe('30m');
    expect(fmtMin(60)).toBe('1.0h');
    expect(fmtMin(90)).toBe('1.5h');
    expect(fmtMin(600)).toBe('10h');
  });
});

describe('protectionModel — buildFindings', () => {
  const driftCell = (check: string): Cell => ({
    check, tierId: 'pr', intent: { runs: true, gates: false, conditional: false },
    observed: null, drift: true, state: 'advisory',
  });

  it('emits a drift finding per drifted cell', () => {
    const model: DerivedModel = { tiers: [], checks: [], cells: [driftCell('ci / a')] };
    const out = buildFindings('o/r', model, null);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ goal: 'drift', check: 'ci / a' });
  });

  it('maps demotion candidates to cost and promotion candidates to quality, scoped to the repo', () => {
    const metrics: MetricsSlice = {
      demotionCandidates: [{ repo: 'o/r', candidates: [{ name: 'slow', currentTier: 'pr', suggestedTier: 'nightly', minutesInWindow: 120 }] }],
      promotionCandidates: [{ repo: 'o/r', candidates: [{ name: 'flaky', suggestedTier: 'pr', realFailures: 3 }] }],
    };
    const out = buildFindings('o/r', { tiers: [], checks: [], cells: [] }, metrics);
    expect(out.map((f) => f.goal)).toEqual(['cost', 'quality']);
    expect(out.find((f) => f.goal === 'cost')).toMatchObject({ check: 'slow', weight: 120 });
    expect(out.find((f) => f.goal === 'quality')).toMatchObject({ check: 'flaky', weight: 3 });
  });

  it('ignores candidates for other repos', () => {
    const metrics: MetricsSlice = {
      demotionCandidates: [{ repo: 'other/repo', candidates: [{ name: 'x', currentTier: 'pr', suggestedTier: 'nightly', minutesInWindow: 1 }] }],
    };
    expect(buildFindings('o/r', { tiers: [], checks: [], cells: [] }, metrics)).toHaveLength(0);
  });
});

describe('protectionModel — cell display', () => {
  const cell: Cell = {
    check: 'ci / unit', tierId: 'pr', intent: { runs: true, gates: true, conditional: false },
    observed: { ran: true, runs: 10, realFailures: 2, failRatePct: 20, flakeRatePct: 5, minutes: 40 },
    drift: true, state: 'gate',
  };

  it('cellTitle summarizes state, runs, failures, flake and drift', () => {
    const t = cellTitle(cell);
    expect(t).toContain('ci / unit — pr: gate');
    expect(t).toContain('10 runs');
    expect(t).toContain('2 real fails (20%)');
    expect(t).toContain('flake 5%');
    expect(t).toContain('⚠ drift');
  });

  it('cellHeat returns undefined with no overlay and a color-mix otherwise', () => {
    expect(cellHeat(cell, 'none', { minutes: 40, fail: 20 })).toBeUndefined();
    expect(cellHeat(cell, 'cost', { minutes: 40, fail: 20 })).toContain('color-mix');
    expect(cellHeat(undefined, 'cost', { minutes: 40, fail: 20 })).toBeUndefined();
  });
});
