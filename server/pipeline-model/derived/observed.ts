import type { SuccessStat, FlakeStat } from '../../history';

const SEP = ' ';
export function observedKey(name: string, event: string): string {
  return `${name}${SEP}${event}`;
}

/** Observed facts for one (check, event), reconciled across the success and
 *  flake stat sources. `realFailures` excludes same-sha-resolved flakes. */
export interface ObservedCell {
  ran: boolean;
  runs: number;
  realFailures: number;
  failRatePct: number;
  flakeRatePct: number;
  minutes: number;
}

export function joinObserved(success: SuccessStat[], flake: FlakeStat[]): Map<string, ObservedCell> {
  const flakeOf = new Map(flake.map((f) => [observedKey(f.name, f.event), f]));
  const out = new Map<string, ObservedCell>();
  for (const s of success) {
    const key = observedKey(s.name, s.event);
    const f = flakeOf.get(key);
    const realFailures = Math.max(0, s.failingRuns - (f?.flakeEvents ?? 0));
    out.set(key, {
      ran: s.totalRuns > 0,
      runs: s.totalRuns,
      realFailures,
      failRatePct: s.totalRuns ? Math.round((s.failingRuns / s.totalRuns) * 1000) / 10 : 0,
      flakeRatePct: f?.flakeRatePct ?? 0,
      minutes: Math.round(s.sumDurationSecs / 60),
    });
  }
  return out;
}
