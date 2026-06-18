import { describe, it, expect } from 'vitest';
import { laneToSection, hashForSection, sectionFromHash } from '../shell/sections';

describe('laneToSection (Health lane chips → live deep-links)', () => {
  it('routes operational lanes to Pipeline', () => {
    for (const lane of ['pr-ci', 'merge-queue', 'main', 'deploy', null]) {
      expect(laneToSection(lane)).toBe('pipeline');
    }
  });
  it('routes cost to Insights and failures/scheduled to Diagnose', () => {
    expect(laneToSection('cost')).toBe('insights');
    expect(laneToSection('failures')).toBe('diagnose');
    expect(laneToSection('scheduled')).toBe('diagnose');
  });
  it('the produced hash round-trips back to the section', () => {
    expect(sectionFromHash(hashForSection(laneToSection('cost')))).toBe('insights');
  });
  it('retired #tune / #metrics hashes redirect to Insights', () => {
    expect(sectionFromHash('#tune')).toBe('insights');
    expect(sectionFromHash('#metrics')).toBe('insights');
  });
});
