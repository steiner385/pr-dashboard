import { describe, it, expect } from 'vitest';
import { formatDur, formatEta, stageLabel } from '../format';

describe('formatDur', () => {
  it('formats compact durations', () => {
    expect(formatDur(45)).toBe('45s');
    expect(formatDur(240)).toBe('4m');
    expect(formatDur(3600)).toBe('1h');
    expect(formatDur(3900)).toBe('1h 5m');
  });
});

describe('formatEta', () => {
  it('formats minutes/seconds', () => {
    expect(formatEta(240, null, false)).toBe('~4m left');
    expect(formatEta(45, null, false)).toBe('~45s left');
    expect(formatEta(3900, null, false)).toBe('~1h 5m left');
  });
  it('ranges and overdue', () => {
    expect(formatEta(120, [120, 360], false)).toBe('~2–6m left');
    expect(formatEta(null, null, true)).toBe('overdue');
    expect(formatEta(null, null, false)).toBe('');
    expect(formatEta(0, null, false)).toBe('done');
  });
});

describe('stageLabel', () => {
  it('labels queue/unmergeable distinctly', () => {
    expect(stageLabel('queue', 'unmergeable')).toBe('Queue — unmergeable');
  });
  it('labels queue/queue-blocked as blocked behind a conflict (cascade victim)', () => {
    expect(stageLabel('queue', 'queue-blocked')).toBe('Queue — blocked behind conflict');
  });
  it('keeps the plain queue label without substate', () => {
    expect(stageLabel('queue', null)).toBe('Merge queue');
  });
});
