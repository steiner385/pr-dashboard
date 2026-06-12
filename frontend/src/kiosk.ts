/** Kiosk mode (issue #20): query-param driven, read-only wall-display view. */

export const DEFAULT_CYCLE_SECONDS = 30;
export const MIN_CYCLE_SECONDS = 10;

export interface KioskConfig {
  kiosk: boolean;
  /** Seconds each view stays on screen before the auto-cycle advances. */
  cycleSeconds: number;
}

/** Parse `?kiosk=1&cycle=N`. Read once at App mount — changing the URL
 *  requires a reload, which is exactly what a wall display does anyway. */
export function readKioskConfig(search: string = window.location.search): KioskConfig {
  const params = new URLSearchParams(search);
  const kiosk = params.get('kiosk') === '1';
  let cycleSeconds = DEFAULT_CYCLE_SECONDS;
  const raw = params.get('cycle');
  if (raw !== null && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) cycleSeconds = Math.max(MIN_CYCLE_SECONDS, Math.round(n));
  }
  return { kiosk, cycleSeconds };
}
