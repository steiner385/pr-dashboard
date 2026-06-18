// Closed-loop outcomes (spec 001, Group H / FR-034 / SC-013). Attributes the
// REALIZED before/after delta of an applied tuning change against its PROJECTED
// delta, and reports projected-vs-realized accuracy. The architect review (I-3)
// flagged this is a confounded causal-inference problem at fleet scale — so every
// outcome carries a confidence + an explicit caveat, and the recommender feedback
// (H2 → D1) is ADVISORY only, never auto-tuning, until accuracy is proven. Pure.
export interface Delta { costDeltaMinutes: number; coverageDelta: number }
export interface AppliedChange {
  prNumber: number; check: string;
  projected: Delta; realized: Delta;
  windowDays: number;
}
export interface Outcome extends AppliedChange {
  costAccuracy: number;       // 0..1, 1 = realized matched projection exactly
  directionCorrect: boolean;  // did cost move the way we predicted?
  confidence: 'high' | 'medium' | 'low';
  caveat: string;
}

const CAVEAT = 'attribution is confounded by concurrent changes in the window — treat as advisory';

function accuracy(projected: number, realized: number): number {
  const denom = Math.max(Math.abs(projected), Math.abs(realized), 1);
  return Math.max(0, Math.min(1, 1 - Math.abs(projected - realized) / denom));
}

export function attributeOutcome(c: AppliedChange): Outcome {
  const costAccuracy = accuracy(c.projected.costDeltaMinutes, c.realized.costDeltaMinutes);
  const directionCorrect = Math.sign(c.projected.costDeltaMinutes) === Math.sign(c.realized.costDeltaMinutes);
  // a short window can't isolate the effect → never high-confidence regardless of fit
  const confidence: Outcome['confidence'] =
    c.windowDays >= 14 && costAccuracy >= 0.75 && directionCorrect ? 'high'
    : c.windowDays >= 7 && directionCorrect ? 'medium'
    : 'low';
  return { ...c, costAccuracy, directionCorrect, confidence, caveat: CAVEAT };
}

export interface AccuracySummary {
  count: number;
  meanCostAccuracy: number;
  directionHitRate: number;
  /** whether the recommender may use this signal — advisory until enough confident samples */
  recommenderUsable: boolean;
}

export function summarizeAccuracy(outcomes: readonly AppliedChange[]): AccuracySummary {
  const o = outcomes.map(attributeOutcome);
  const n = o.length;
  if (n === 0) return { count: 0, meanCostAccuracy: 0, directionHitRate: 0, recommenderUsable: false };
  const meanCostAccuracy = o.reduce((s, x) => s + x.costAccuracy, 0) / n;
  const directionHitRate = o.filter((x) => x.directionCorrect).length / n;
  const confident = o.filter((x) => x.confidence !== 'low').length;
  // only let outcomes feed D1 rankings once we have ≥5 confident samples that mostly hit
  const recommenderUsable = confident >= 5 && directionHitRate >= 0.7 && meanCostAccuracy >= 0.6;
  return { count: n, meanCostAccuracy, directionHitRate, recommenderUsable };
}
