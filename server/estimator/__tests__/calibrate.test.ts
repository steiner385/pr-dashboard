import { describe, it, expect } from 'vitest';
import { applyEtaCalibration, CALIBRATED_STAGES, CALIBRATION_MIN_FACTOR } from '../calibrate';
import type { StageResult } from '../../types';

const ciStage = (over: Partial<StageResult> = {}): StageResult => ({
  stage: 'ci', substate: null, percent: 40, etaSeconds: 600,
  etaRangeSeconds: null, overdue: false, ...over,
});

describe('applyEtaCalibration (issue #35 conformal-lite ranges)', () => {
  it('factor > 1.15 sets the displayed range to [eta, round(eta × factor)]', () => {
    expect(applyEtaCalibration(ciStage(), 1.5).etaRangeSeconds).toEqual([600, 900]);
    // rounding, not truncation
    expect(applyEtaCalibration(ciStage({ etaSeconds: 100 }), 1.333).etaRangeSeconds)
      .toEqual([100, 133]);
  });

  it('no factor (null) keeps the existing heuristic range untouched', () => {
    const heuristic = ciStage({ etaRangeSeconds: [600, 800] });
    expect(applyEtaCalibration(heuristic, null)).toEqual(heuristic);
    expect(applyEtaCalibration(ciStage(), null).etaRangeSeconds).toBeNull();
  });

  it('tiny corrections do not churn the display: factor ≤ 1.15 is a no-op', () => {
    expect(applyEtaCalibration(ciStage(), 1.15).etaRangeSeconds).toBeNull();
    expect(applyEtaCalibration(ciStage(), 1.0).etaRangeSeconds).toBeNull();
    expect(applyEtaCalibration(ciStage(), 0.8).etaRangeSeconds).toBeNull(); // pessimistic ETAs never narrow
    expect(applyEtaCalibration(ciStage(), 1.16).etaRangeSeconds).toEqual([600, 696]);
    expect(CALIBRATION_MIN_FACTOR).toBe(1.15);
  });

  it('widens but never narrows an existing heuristic range', () => {
    // heuristic upper 700 < calibrated 900 → calibrated wins
    expect(applyEtaCalibration(ciStage({ etaRangeSeconds: [600, 700] }), 1.5)
      .etaRangeSeconds).toEqual([600, 900]);
    // heuristic upper 1200 > calibrated 720 → heuristic kept (lower re-anchored on eta)
    expect(applyEtaCalibration(ciStage({ etaRangeSeconds: [600, 1200] }), 1.2)
      .etaRangeSeconds).toEqual([600, 1200]);
  });

  it('applies only to the ETA-tracked stages', () => {
    expect([...CALIBRATED_STAGES].sort()).toEqual(['ci', 'qa-deploy', 'queue']);
    for (const stage of ['ready', 'parked', 'merged', 'awaiting-prod'] as const) {
      const s = ciStage({ stage });
      expect(applyEtaCalibration(s, 2)).toEqual(s);
    }
    expect(applyEtaCalibration(ciStage({ stage: 'queue' }), 1.5).etaRangeSeconds)
      .toEqual([600, 900]);
    expect(applyEtaCalibration(ciStage({ stage: 'qa-deploy' }), 1.5).etaRangeSeconds)
      .toEqual([600, 900]);
  });

  it('null etaSeconds (overdue/bare stages) and zero etaSeconds stay untouched', () => {
    const overdue = ciStage({ etaSeconds: null, overdue: true });
    expect(applyEtaCalibration(overdue, 1.5)).toEqual(overdue);
    const done = ciStage({ etaSeconds: 0 });
    expect(applyEtaCalibration(done, 1.5).etaRangeSeconds).toBeNull(); // [0,0] is no range
  });

  it('returns a new object and never mutates the input stage', () => {
    const input = ciStage();
    const out = applyEtaCalibration(input, 1.5);
    expect(out).not.toBe(input);
    expect(input.etaRangeSeconds).toBeNull();
  });
});
