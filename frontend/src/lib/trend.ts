export type TrendDirection = 'up' | 'down' | 'flat';
export type TrendPolarity = 'good' | 'bad' | 'neutral';

export interface Trend {
  /** Signed % change vs baseline; null when value/baseline missing or baseline === 0. */
  deltaPct: number | null;
  direction: TrendDirection;
  /** good/bad after applying lowerIsBetter; neutral when not significant or deltaPct null. */
  polarity: TrendPolarity;
  significant: boolean;
}

export interface TrendOpts {
  /** When true, a DECREASE is "good" (queue-wait, p50 durations). Default false. */
  lowerIsBetter?: boolean;
  /** Significance floor in percent (default 5). Below this, polarity is 'neutral'. */
  minPctForSignificance?: number;
}

/**
 * Delta-vs-baseline trend (#258). Pure: compares a value to its baseline and
 * classifies direction, significance, and good/bad polarity. Renders as the
 * shared <TrendArrow>. Below the significance floor the change is 'neutral' so a
 * stable green isn't noised up with arrows.
 */
export function computeTrend(value: number | null, baseline: number | null, opts: TrendOpts = {}): Trend {
  const { lowerIsBetter = false, minPctForSignificance = 5 } = opts;
  if (value == null || baseline == null || baseline === 0 || !Number.isFinite(value) || !Number.isFinite(baseline)) {
    return { deltaPct: null, direction: 'flat', polarity: 'neutral', significant: false };
  }
  const deltaPct = ((value - baseline) / baseline) * 100;
  const direction: TrendDirection = value > baseline ? 'up' : value < baseline ? 'down' : 'flat';
  const significant = direction !== 'flat' && Math.abs(deltaPct) >= minPctForSignificance;
  let polarity: TrendPolarity = 'neutral';
  if (significant) {
    const increaseIsGood = !lowerIsBetter;
    polarity = (direction === 'up') === increaseIsGood ? 'good' : 'bad';
  }
  return { deltaPct, direction, polarity, significant };
}

/** Green-rate of a half-series: ok ÷ non-null; null when too few non-null samples. */
function greenRate(half: { ok: boolean | null }[], minSamples: number): number | null {
  const nonNull = half.filter((p) => p.ok != null);
  if (nonNull.length < minSamples) return null;
  return nonNull.filter((p) => p.ok).length / nonNull.length;
}

/**
 * "Degrading green" trend (#258) for a main-lane series: split by position into
 * older and recent halves, compare green-rate (recent vs older, higher = good).
 * Returns the neutral/flat trend (no arrow) for short, blind, or stable series.
 */
export function greenRateTrend(
  series: { ok: boolean | null }[] | undefined,
  opts: { minSamplesPerHalf?: number } = {},
): Trend {
  const { minSamplesPerHalf = 3 } = opts;
  if (!series || series.length < minSamplesPerHalf * 2) {
    return { deltaPct: null, direction: 'flat', polarity: 'neutral', significant: false };
  }
  const mid = Math.floor(series.length / 2);
  const olderRate = greenRate(series.slice(0, mid), minSamplesPerHalf);
  const recentRate = greenRate(series.slice(mid), minSamplesPerHalf);
  return computeTrend(recentRate, olderRate, { lowerIsBetter: false });
}
