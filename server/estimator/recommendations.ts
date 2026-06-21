/**
 * Recommendations digest (tuning tool, step 2). The dashboard already computes
 * tuning advice across several panels (batch-size advisor, queue efficiency,
 * workflow lint); this collects them into one ranked "what to tune" list. Pure
 * derivation over already-computed payload sections — no new measurement.
 */

import { cleanJobName } from './workflow-lint';

export type RecPriority = 'high' | 'medium' | 'low';

export interface Recommendation {
  repo: string;
  /** Stable id for the kind of recommendation (de-dup / linking). */
  kind: string;
  priority: RecPriority;
  /** Short imperative headline. */
  title: string;
  /** The why + the numbers. */
  detail: string;
}

export interface RecommendationInputs {
  batchAdvisor: { repo: string; currentBatch: number; recommendedBatch: number;
    ejectProbPerGroup: number; arrivalsPerTrain: number;
    curve: { batch: number; throughputPerHour: number }[] }[];
  queueEfficiency: { repo: string;
    runConclusion: { total: number; runFailed: number; advisoryNoise: number; requiredConfigured: boolean };
    adminBypass: { rate: number | null; merges: number } }[];
  lint: { repo: string; findings: { rule: string; severity: 'warn' | 'info'; job: string; message: string }[] }[];
  /** Suggested requiredCheckPrefixes per repo (roadmap 4.5 lever) — derived from
   *  the observed merge_group check names, to make the set-required-prefixes
   *  recommendation actionable (it carries the exact value to configure). */
  prefixSuggestions?: { repo: string; prefixes: string[] }[];
}

const PRIORITY_RANK: Record<RecPriority, number> = { high: 0, medium: 1, low: 2 };

/** Guards on the batch-size advisor's RAISE recommendation. The throughput model
 *  (batch-advisor.ts) maximises B·(1−q)^B assuming infinite demand and idealised
 *  independent ejects — so it will happily recommend a bigger cap even when the
 *  queue never fills the current one (no demand to spend the headroom) or the
 *  eject rate is so high that a deeper batch mostly rebuilds (rework, not merges,
 *  and 2× the on-demand CI cost). When either guard trips we FLIP the advice to
 *  "consider lowering" instead of amplifying. Tunable. */
const BATCH_SATURATION_MARGIN = 0.85; // queue "fills" the cap when arrivalsPerTrain ≥ margin·currentBatch
const BATCH_REWORK_EJECT_THRESHOLD = 0.20; // group-eject ≥ this → deeper batch mostly rebuilds

export function deriveRecommendations(inp: RecommendationInputs): Recommendation[] {
  const recs: Recommendation[] = [];

  // Batch-size advisor recommends a different cap than the one in effect.
  for (const b of inp.batchAdvisor) {
    if (b.recommendedBatch === b.currentBatch) continue;
    const cur = b.curve.find((c) => c.batch === b.currentBatch)?.throughputPerHour;
    const rec = b.curve.find((c) => c.batch === b.recommendedBatch)?.throughputPerHour;
    const gainPct = cur != null && rec != null && cur > 0 ? Math.round((rec / cur - 1) * 100) : null;
    const ejectPct = Math.round(b.ejectProbPerGroup * 100);
    const wantsRaise = b.recommendedBatch > b.currentBatch;

    // Guard the RAISE path: the model is blind to whether the cap is even
    // binding (saturation) and to eject-driven rework. If the queue doesn't fill
    // the current cap, or the eject rate is high, raising is a no-op or actively
    // wasteful — flip to "consider lowering" toward what demand/eject support.
    if (wantsRaise) {
      const notSaturated = b.arrivalsPerTrain < b.currentBatch * BATCH_SATURATION_MARGIN;
      const highRework = b.ejectProbPerGroup >= BATCH_REWORK_EJECT_THRESHOLD;
      if (notSaturated || highRework) {
        // Flip to a CONSERVATIVE one-step lower, not a demand-matched target:
        // arrivalsPerTrain is an AVERAGE, and a batch cap exists to absorb bursts
        // (we observe peaks well above the mean), so sizing the cap to the mean
        // would serialise those bursts — the mirror of the model's own blind
        // spot. The reason text carries the fill number so the operator can
        // decide how much further to trim. Skip if currentBatch is already 1.
        const lowerTo = b.currentBatch - 1;
        if (lowerTo >= 1) {
          const reasons: string[] = [];
          if (notSaturated) {
            reasons.push(`queue fills only ~${b.arrivalsPerTrain.toFixed(1)} of ${b.currentBatch} per train — the cap isn't binding`);
          }
          if (highRework) {
            reasons.push(`${ejectPct}% group-eject means a deeper batch mostly rebuilds (rework + 2× CI cost, not merges)`);
          }
          recs.push({ repo: b.repo, kind: 'batch-size', priority: 'low',
            title: `consider lowering merge-queue batch ${b.currentBatch} → ${lowerTo}`,
            detail: `${reasons.join('; ')} — the throughput model favoured ${b.recommendedBatch} but ignores idle-cap and rework` });
        }
        continue; // suppressed the raise; flipped (or nothing actionable)
      }
    }

    // Legit: a saturated, low-rework raise — or a model-recommended lower.
    const dir = wantsRaise ? 'raise' : 'lower';
    recs.push({ repo: b.repo, kind: 'batch-size', priority: 'medium',
      title: `${dir} merge-queue batch ${b.currentBatch} → ${b.recommendedBatch}`,
      detail: gainPct != null
        ? `modelled throughput headroom ${gainPct >= 0 ? '+' : ''}${gainPct}% at ${ejectPct}% group-eject rate`
        : `throughput sweet spot at ${ejectPct}% group-eject rate` });
  }

  for (const q of inp.queueEfficiency) {
    const rc = q.runConclusion;
    // Runs that read FAILED only because an advisory (non-required) job failed.
    if (rc.requiredConfigured && rc.advisoryNoise > 0 && rc.total > 0) {
      const pct = Math.round((rc.advisoryNoise / rc.total) * 100);
      recs.push({ repo: q.repo, kind: 'advisory-in-merge-group',
        priority: pct >= 40 ? 'high' : 'medium',
        title: 'remove advisory jobs from merge_group',
        detail: `${rc.advisoryNoise} of ${rc.total} runs (${pct}%) read FAILED but the required gate passed — only an advisory job failed` });
    }
    // Can't separate gate failures from advisory noise without prefixes.
    if (!rc.requiredConfigured && rc.runFailed > 0) {
      // Roadmap 4.5 lever: make it actionable — suggest the exact prefixes from
      // the observed merge_group check names so the operator can configure them.
      const suggested = inp.prefixSuggestions?.find((p) => p.repo === q.repo)?.prefixes ?? [];
      const suggestion = suggested.length
        ? ` — suggested from observed checks: requiredCheckPrefixes: [${suggested.map((p) => `"${p}"`).join(', ')}] (set in .pr-dashboard.yml)`
        : '';
      recs.push({ repo: q.repo, kind: 'set-required-prefixes', priority: 'low',
        title: 'set requiredCheckPrefixes',
        detail: `no requiredCheckPrefixes configured — every failed merge_group run reads as advisory, so real gate failures can’t be separated${suggestion}` });
    }
    // People routing around the queue (≥10% sustained = alarm).
    if (q.adminBypass.rate != null && q.adminBypass.rate > 0.10 && q.adminBypass.merges >= 5) {
      const pct = Math.round(q.adminBypass.rate * 100);
      recs.push({ repo: q.repo, kind: 'admin-bypass', priority: 'high',
        title: `admin-bypass rate ${pct}% — investigate queue confidence`,
        detail: `${pct}% of merges (≥10% alarm) bypassed the queue — people are routing around it` });
    }
  }

  // Workflow-lint findings (their message IS the recommendation).
  for (const l of inp.lint) {
    for (const f of l.findings) {
      recs.push({ repo: l.repo, kind: `lint:${f.rule}`,
        priority: f.severity === 'warn' ? 'medium' : 'low',
        title: f.message, detail: `job: ${cleanJobName(f.job)}` });
    }
  }

  return recs.sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || a.repo.localeCompare(b.repo)
    || a.title.localeCompare(b.title));
}
