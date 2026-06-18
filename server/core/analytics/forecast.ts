// Cost/capacity forecasting (spec 001, Group J1 / FR-037 / SC-015). Pure
// least-squares trend over a daily series → projected value + days-to-threshold +
// a confidence (R²-based). The persona review (I-3) flagged that a 7-day window is
// too noisy for a point estimate, so we report confidence and require a minimum
// sample; callers should feed the longer-retained series and treat low-confidence
// forecasts as advisory. No Date.now — `nowDay` is passed (keeps it pure/testable).
export interface Point { day: number; value: number } // day = integer day index
export interface Forecast {
  slopePerDay: number;
  projectedAt: number | null;     // value projected `horizonDays` out (null if too few points)
  daysToThreshold: number | null; // days until the trend crosses `thresholdValue` (null = never/na)
  rSquared: number;
  confidence: 'high' | 'medium' | 'low';
  sampleDays: number;
}

export interface ForecastOpts { thresholdValue?: number; horizonDays?: number }

export function forecastTrend(points: readonly Point[], opts: ForecastOpts = {}): Forecast {
  const n = points.length;
  const horizon = opts.horizonDays ?? 30;
  if (n < 2) {
    return { slopePerDay: 0, projectedAt: null, daysToThreshold: null, rSquared: 0, confidence: 'low', sampleDays: n };
  }
  // least squares y = a + b x
  const sx = points.reduce((s, p) => s + p.day, 0);
  const sy = points.reduce((s, p) => s + p.value, 0);
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) { const dx = p.day - mx, dy = p.value - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  const rSquared = (sxx === 0 || syy === 0) ? (sxx === 0 ? 0 : 1) : (sxy * sxy) / (sxx * syy);

  const lastDay = Math.max(...points.map((p) => p.day));
  const projectedAt = a + b * (lastDay + horizon);

  let daysToThreshold: number | null = null;
  if (opts.thresholdValue != null && b > 0) {
    const lastValue = a + b * lastDay;
    if (lastValue < opts.thresholdValue) daysToThreshold = Math.max(0, Math.ceil((opts.thresholdValue - lastValue) / b));
    else daysToThreshold = 0; // already at/over threshold
  }

  // confidence: needs both a decent fit AND enough days (noisy short windows → low)
  const confidence: Forecast['confidence'] =
    n >= 21 && rSquared >= 0.6 ? 'high'
    : n >= 10 && rSquared >= 0.3 ? 'medium'
    : 'low';

  return { slopePerDay: b, projectedAt, daysToThreshold, rSquared, confidence, sampleDays: n };
}
