/** prefers-reduced-motion–aware scroll behavior, shared by the queue-train
 *  PR links and the kiosk auto-cycle. Defaults to 'auto' (no animation) when
 *  matchMedia is unavailable (jsdom) or the user prefers reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  const reduced = typeof window.matchMedia === 'function'
    ? !window.matchMedia('(prefers-reduced-motion: no-preference)').matches
    : true;
  return reduced ? 'auto' : 'smooth';
}
