import { describe, it, expect } from 'vitest';
import { classifyEject, dominantReason, type EjectReason } from '../eject-reason';

describe('classifyEject (roadmap 4.4b — train-killer reason taxonomy)', () => {
  it('a timeout → rerun', () => {
    const r = classifyEject('TIMED_OUT');
    expect(r.reason).toBe('timeout');
    expect(r.remedy).toMatch(/rerun/i);
  });

  it('a test failure → fix', () => {
    const r = classifyEject('FAILURE');
    expect(r.reason).toBe('test-fail');
    expect(r.remedy).toMatch(/fix/i);
  });

  it('a startup failure → infra rerun (transient runner/setup error)', () => {
    const r = classifyEject('STARTUP_FAILURE');
    expect(r.reason).toBe('infra');
    expect(r.remedy).toMatch(/rerun/i);
  });

  it('an unknown/absent conclusion is classified unknown without throwing', () => {
    expect(classifyEject(null).reason).toBe('unknown');
    expect(classifyEject('NEUTRAL').reason).toBe('unknown');
  });
});

describe('dominantReason (which remedy to lead with)', () => {
  it('returns the most frequent reason', () => {
    const counts: Record<EjectReason, number> = { timeout: 1, 'test-fail': 5, infra: 2, unknown: 0 };
    expect(dominantReason(counts)).toBe('test-fail');
  });

  it('breaks ties toward the more actionable reason (test-fail > timeout > infra > unknown)', () => {
    const counts: Record<EjectReason, number> = { timeout: 3, 'test-fail': 3, infra: 3, unknown: 3 };
    expect(dominantReason(counts)).toBe('test-fail');
  });

  it('returns null when there are no ejects', () => {
    expect(dominantReason({ timeout: 0, 'test-fail': 0, infra: 0, unknown: 0 })).toBeNull();
  });
});
