import { describe, it, expect } from 'vitest';
import { readKioskConfig, DEFAULT_CYCLE_SECONDS, MIN_CYCLE_SECONDS } from '../kiosk';

describe('readKioskConfig', () => {
  it('is off without the kiosk param (default cycle)', () => {
    expect(readKioskConfig('')).toEqual({ kiosk: false, cycleSeconds: DEFAULT_CYCLE_SECONDS });
    expect(readKioskConfig('?foo=1')).toEqual({ kiosk: false, cycleSeconds: DEFAULT_CYCLE_SECONDS });
  });

  it('?kiosk=1 enables kiosk with the 30s default cycle', () => {
    expect(readKioskConfig('?kiosk=1')).toEqual({ kiosk: true, cycleSeconds: 30 });
  });

  it('kiosk requires the literal value 1 (kiosk=true / kiosk=0 stay off)', () => {
    expect(readKioskConfig('?kiosk=true').kiosk).toBe(false);
    expect(readKioskConfig('?kiosk=0').kiosk).toBe(false);
  });

  it('&cycle=N sets the per-view seconds', () => {
    expect(readKioskConfig('?kiosk=1&cycle=45').cycleSeconds).toBe(45);
  });

  it('clamps cycle below the 10s floor', () => {
    expect(MIN_CYCLE_SECONDS).toBe(10);
    expect(readKioskConfig('?kiosk=1&cycle=3').cycleSeconds).toBe(10);
    expect(readKioskConfig('?kiosk=1&cycle=-5').cycleSeconds).toBe(10);
  });

  it('falls back to the default for a non-numeric or empty cycle', () => {
    expect(readKioskConfig('?kiosk=1&cycle=abc').cycleSeconds).toBe(DEFAULT_CYCLE_SECONDS);
    expect(readKioskConfig('?kiosk=1&cycle=').cycleSeconds).toBe(DEFAULT_CYCLE_SECONDS);
  });
});
