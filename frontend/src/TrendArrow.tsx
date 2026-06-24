import type { Trend } from './lib/trend';

/** Consistent delta-vs-baseline arrow (#258). Renders nothing when the change
 *  is flat or below the significance floor, so a stable green isn't noised up. */
export function TrendArrow({ trend, baselineLabel = 'vs prev window' }: { trend: Trend; baselineLabel?: string }) {
  if (trend.direction === 'flat' || !trend.significant || trend.deltaPct == null) return null;
  const pct = Math.round(trend.deltaPct);
  const label = `${pct > 0 ? '+' : ''}${pct}% ${baselineLabel}`;
  const glyph = trend.direction === 'up' ? '▲' : '▼';
  return (
    <span className={`trend-arrow trend-arrow--${trend.polarity}`} title={label} aria-label={label}>
      {glyph}
    </span>
  );
}
