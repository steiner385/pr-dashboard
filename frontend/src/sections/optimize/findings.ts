// Findings-first ranking (roadmap 5.2) — surface the wasteful checks with their
// impact UP FRONT, instead of a flat alphabetical button-farm over every check. A
// demotion candidate is an always-green check (observed cost > 0, zero real failures
// across the window): expensive runner time that never catches anything. Pure.
import type { DerivedModelLike } from './types';

export interface DemotionFinding { check: string; minutes: number; reason: string }

export function demotionFindings(model: DerivedModelLike): DemotionFinding[] {
  const byCheck = new Map<string, { minutes: number; realFailures: number }>();
  for (const c of model.cells) {
    if (!c.observed) continue;
    const e = byCheck.get(c.check) ?? { minutes: 0, realFailures: 0 };
    e.minutes += c.observed.minutes;
    e.realFailures += c.observed.realFailures;
    byCheck.set(c.check, e);
  }
  const out: DemotionFinding[] = [];
  for (const [check, o] of byCheck) {
    if (o.minutes > 0 && o.realFailures === 0) out.push({ check, minutes: o.minutes, reason: 'always-green — wasted runner time' });
  }
  return out.sort((a, b) => b.minutes - a.minutes);
}
