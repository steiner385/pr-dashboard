import { describe, it, expect } from 'vitest';
import { deriveRecommendations, type RecommendationInputs } from '../estimator/recommendations';

const empty: RecommendationInputs = { batchAdvisor: [], queueEfficiency: [], lint: [] };

describe('deriveRecommendations (tuning digest)', () => {
  it('emits nothing when every advisor is satisfied', () => {
    expect(deriveRecommendations({
      batchAdvisor: [{ repo: 'r', currentBatch: 6, recommendedBatch: 6, ejectProbPerGroup: 0.05,
        arrivalsPerTrain: 6, curve: [{ batch: 6, throughputPerHour: 10 }] }],
      queueEfficiency: [{ repo: 'r',
        runConclusion: { total: 5, runFailed: 0, advisoryNoise: 0, requiredConfigured: true },
        adminBypass: { rate: 0.02, merges: 50 } }],
      lint: [{ repo: 'r', findings: [] }],
    })).toEqual([]);
  });

  it('recommends a raise only when the queue is saturated AND rework is low', () => {
    const [r] = deriveRecommendations({ ...empty, batchAdvisor: [
      { repo: 'r', currentBatch: 6, recommendedBatch: 12, ejectProbPerGroup: 0.09, arrivalsPerTrain: 8,
        curve: [{ batch: 6, throughputPerHour: 16 }, { batch: 12, throughputPerHour: 24 }] }] });
    expect(r).toMatchObject({ kind: 'batch-size', priority: 'medium',
      title: 'raise merge-queue batch 6 → 12' });
    expect(r!.detail).toContain('+50%');   // 24/16 − 1
  });

  it('FLIPS a raise to "consider lowering" when the eject rate is high (rework guard)', () => {
    // queue is saturated (8 ≥ 0.85·6) but 25% eject ⇒ a deeper batch mostly rebuilds
    const [r] = deriveRecommendations({ ...empty, batchAdvisor: [
      { repo: 'r', currentBatch: 6, recommendedBatch: 12, ejectProbPerGroup: 0.25, arrivalsPerTrain: 8,
        curve: [{ batch: 6, throughputPerHour: 16 }, { batch: 12, throughputPerHour: 24 }] }] });
    expect(r).toMatchObject({ kind: 'batch-size', priority: 'low',
      title: 'consider lowering merge-queue batch 6 → 5' }); // saturated ⇒ one step down
    expect(r!.detail).toContain('25% group-eject');
    expect(r!.detail).toContain('favoured 12');
  });

  it('FLIPS a raise to a conservative one-step lower when the cap isn\'t binding (saturation guard)', () => {
    // low eject (no rework concern) but the queue only fills ~3 of 6 per train
    const [r] = deriveRecommendations({ ...empty, batchAdvisor: [
      { repo: 'r', currentBatch: 6, recommendedBatch: 12, ejectProbPerGroup: 0.05, arrivalsPerTrain: 3,
        curve: [{ batch: 6, throughputPerHour: 16 }, { batch: 12, throughputPerHour: 24 }] }] });
    expect(r).toMatchObject({ kind: 'batch-size', priority: 'low',
      title: 'consider lowering merge-queue batch 6 → 5' }); // one step, not down to the mean
    expect(r!.detail).toContain('~3.0 of 6'); // fill number surfaced for the operator
    expect(r!.detail).toContain("isn't binding");
  });

  it('names both reasons when the queue is starved AND rework is high', () => {
    const [r] = deriveRecommendations({ ...empty, batchAdvisor: [
      { repo: 'r', currentBatch: 6, recommendedBatch: 12, ejectProbPerGroup: 0.30, arrivalsPerTrain: 2,
        curve: [{ batch: 6, throughputPerHour: 16 }, { batch: 12, throughputPerHour: 24 }] }] });
    expect(r!.title).toBe('consider lowering merge-queue batch 6 → 5');
    expect(r!.detail).toContain("isn't binding");
    expect(r!.detail).toContain('30% group-eject');
  });

  it('does not block a model-recommended LOWER (guards apply only to raises)', () => {
    const [r] = deriveRecommendations({ ...empty, batchAdvisor: [
      { repo: 'r', currentBatch: 12, recommendedBatch: 8, ejectProbPerGroup: 0.30, arrivalsPerTrain: 2,
        curve: [{ batch: 8, throughputPerHour: 20 }, { batch: 12, throughputPerHour: 16 }] }] });
    expect(r).toMatchObject({ kind: 'batch-size', priority: 'medium',
      title: 'lower merge-queue batch 12 → 8' });
  });

  it('emits nothing when a flipped lower would fall below 1 (currentBatch already minimal)', () => {
    const recs = deriveRecommendations({ ...empty, batchAdvisor: [
      { repo: 'r', currentBatch: 1, recommendedBatch: 5, ejectProbPerGroup: 0.05, arrivalsPerTrain: 0.4,
        curve: [{ batch: 1, throughputPerHour: 10 }, { batch: 5, throughputPerHour: 20 }] }] });
    expect(recs.find((x) => x.kind === 'batch-size')).toBeUndefined();
  });

  it('flags advisory-only failures (high when ≥40% of runs)', () => {
    const [r] = deriveRecommendations({ ...empty, queueEfficiency: [
      { repo: 'r', runConclusion: { total: 10, runFailed: 5, advisoryNoise: 5, requiredConfigured: true },
        adminBypass: { rate: null, merges: 0 } }] });
    expect(r).toMatchObject({ kind: 'advisory-in-merge-group', priority: 'high' });
    expect(r!.title).toBe('remove advisory jobs from merge_group');
  });

  it('flags admin-bypass over 10% as high priority', () => {
    const recs = deriveRecommendations({ ...empty, queueEfficiency: [
      { repo: 'r', runConclusion: { total: 0, runFailed: 0, advisoryNoise: 0, requiredConfigured: true },
        adminBypass: { rate: 0.22, merges: 40 } }] });
    expect(recs.find((x) => x.kind === 'admin-bypass')).toMatchObject({ priority: 'high' });
  });

  it('suggests requiredCheckPrefixes when the split is unknowable', () => {
    const recs = deriveRecommendations({ ...empty, queueEfficiency: [
      { repo: 'r', runConclusion: { total: 3, runFailed: 2, advisoryNoise: 2, requiredConfigured: false },
        adminBypass: { rate: null, merges: 0 } }] });
    expect(recs.map((x) => x.kind)).toContain('set-required-prefixes');
  });

  it('makes the prefixes recommendation actionable with the exact suggested value (roadmap 4.5)', () => {
    const recs = deriveRecommendations({ ...empty,
      queueEfficiency: [
        { repo: 'r', runConclusion: { total: 3, runFailed: 2, advisoryNoise: 2, requiredConfigured: false },
          adminBypass: { rate: null, merges: 0 } }],
      prefixSuggestions: [{ repo: 'r', prefixes: ['build', 'static-checks'] }] });
    const rec = recs.find((x) => x.kind === 'set-required-prefixes')!;
    expect(rec.detail).toMatch(/requiredCheckPrefixes: \["build", "static-checks"\]/);
    expect(rec.detail).toMatch(/\.pr-dashboard\.yml/);
  });

  it('omits the suggestion when no merge_group checks were observed', () => {
    const recs = deriveRecommendations({ ...empty,
      queueEfficiency: [
        { repo: 'r', runConclusion: { total: 3, runFailed: 2, advisoryNoise: 2, requiredConfigured: false },
          adminBypass: { rate: null, merges: 0 } }],
      prefixSuggestions: [{ repo: 'r', prefixes: [] }] });
    const rec = recs.find((x) => x.kind === 'set-required-prefixes')!;
    expect(rec.detail).not.toMatch(/suggested/);
  });

  it('includes lint findings and ranks the whole list high → low', () => {
    const recs = deriveRecommendations({
      batchAdvisor: [{ repo: 'r', currentBatch: 4, recommendedBatch: 8, ejectProbPerGroup: 0.1,
        arrivalsPerTrain: 5, curve: [{ batch: 4, throughputPerHour: 8 }, { batch: 8, throughputPerHour: 12 }] }],
      queueEfficiency: [{ repo: 'r',
        runConclusion: { total: 0, runFailed: 0, advisoryNoise: 0, requiredConfigured: true },
        adminBypass: { rate: 0.3, merges: 20 } }],
      lint: [{ repo: 'r', findings: [
        { rule: 'timeout', severity: 'warn', job: 'integration', message: 'timeout 30m but p99 11m' }] }],
    });
    expect(recs.map((r) => r.priority)).toEqual(['high', 'medium', 'medium']);  // sorted
    expect(recs[0]!.kind).toBe('admin-bypass');
    expect(recs.some((r) => r.kind === 'lint:timeout')).toBe(true);
  });
});
