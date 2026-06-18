import { describe, it, expect } from 'vitest';
import {
  METRIC_DEFINITIONS,
  METRIC_SECTION_GROUPS,
  LANE_DEFINITIONS,
  SETTINGS_DEFINITIONS,
  DESIGNER_DEFINITIONS,
} from '../definitions';

describe('METRIC_SECTION_GROUPS', () => {
  it('covers every METRIC_DEFINITIONS key exactly once (no key falls out of the legend)', () => {
    const grouped = METRIC_SECTION_GROUPS.flatMap((g) => g.keys);
    // no duplicates across groups
    expect(new Set(grouped).size).toBe(grouped.length);
    // and the union is exactly the full definition set
    expect([...grouped].sort()).toEqual(Object.keys(METRIC_DEFINITIONS).sort());
  });

  it('every group has a label and at least one key', () => {
    for (const g of METRIC_SECTION_GROUPS) {
      expect(g.label).toBeTruthy();
      expect(g.keys.length).toBeGreaterThan(0);
    }
  });
});

describe('lane / settings / designer definitions', () => {
  it('LANE_DEFINITIONS covers the 7 delivery lanes by id', () => {
    expect(Object.keys(LANE_DEFINITIONS).sort()).toEqual(
      ['cost', 'deploy', 'failures', 'main', 'merge-queue', 'pr-ci', 'scheduled'],
    );
  });

  it('SETTINGS_DEFINITIONS covers the 5 settings sub-pages', () => {
    expect(Object.keys(SETTINGS_DEFINITIONS).sort()).toEqual(
      ['instance', 'notifications', 'perRepo', 'tuning', 'watchedRepos'],
    );
  });

  it('every definition carries a non-empty label and text', () => {
    for (const def of [
      ...Object.values(LANE_DEFINITIONS),
      ...Object.values(SETTINGS_DEFINITIONS),
      ...Object.values(DESIGNER_DEFINITIONS),
    ]) {
      expect(def.label).toBeTruthy();
      expect(def.text).toBeTruthy();
    }
  });
});
