import { FLAKE_MIN_RUNS, type FlakeStat, type HistoryStore } from './history';
import type { DigestConfig } from './notifier';
import type { DurationRegressionView, PoolHealthView } from './poller';

/**
 * Daily digest (issue #51): a scheduled morning summary of the last 24h —
 * "overnight: 14 merged, 2 ejects (culprit X, flake-likely), runner p90
 * normal, 1 duration regression" — delivered through the notifier's sinks
 * (SSE / command / webhook) as a single 'digest' event.
 *
 * Split for testability:
 *   - `gatherDigestInput`  — reads history + the poller's live caches into
 *     plain data (structural deps, fakeable).
 *   - `composeDigest`      — PURE: plain data in, { subject, body } out.
 *   - `DigestScheduler`    — a self-rearming timeout to the next local
 *     `hourLocal` occurrence; fake-timer tested.
 */

// ---- compose (pure) ---------------------------------------------------------

/** Everything the digest says about one repo (plain data, pre-aggregated). */
export interface DigestRepoInput {
  repo: string;
  /** PRs merged in the window. */
  merges: number;
  /** Distinct ejected merge-group builds in the window. */
  ejects: number;
  /** The check that ejected the most groups, cross-referenced against the
   *  flake radar (null rate = no qualifying flake stats for that check). */
  topCulprit: { name: string; ejects: number; flakeRatePct: number | null } | null;
  /** Live pool-health snapshot (last-hour p90 vs 7d baseline, starving flag). */
  pools: PoolHealthView[];
  /** Currently-active duration regressions (the poller's hourly-scan cache). */
  regressions: DurationRegressionView[];
  /** Live queue health; null when the repo has no merge queue tracked. */
  queue: { state: string; detail: string } | null;
}

export interface DigestInput {
  at: Date;
  windowHours: number;
  repos: DigestRepoInput[];
}

/** Compact duration for digest lines (45s / 8m / 1.5h). */
function fmtSecs(secs: number): string {
  if (secs < 90) return `${Math.round(secs)}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A culprit check reads "flake-likely" at/above this flake rate (the same
 *  signal the train-killer leaderboard surfaces; threshold is presentational). */
export const FLAKE_LIKELY_PCT = 5;

function culpritLine(c: NonNullable<DigestRepoInput['topCulprit']>): string {
  const flake = c.flakeRatePct != null
    ? `, ${c.flakeRatePct >= FLAKE_LIKELY_PCT ? 'flake-likely — ' : ''}${c.flakeRatePct.toFixed(0)}% flake rate`
    : '';
  return ` (top culprit: ${c.name} ×${c.ejects}${flake})`;
}

function poolLine(pools: PoolHealthView[]): string | null {
  const evaluated = pools.filter((p) => p.lastHourP90Secs != null);
  if (evaluated.length === 0) return null;
  const starving = evaluated.filter((p) => p.starving);
  if (starving.length === 0) return '  runner waits: all pools normal';
  const detail = starving.map((p) =>
    `${p.pool} p90 ${fmtSecs(p.lastHourP90Secs!)}${p.baselineP90Secs != null
      ? ` vs ${fmtSecs(p.baselineP90Secs)} baseline` : ''}`).join('; ');
  return `  runner waits: ${plural(starving.length, 'pool')} STARVING — ${detail}`;
}

function repoBlock(r: DigestRepoInput): string[] {
  const lines: string[] = [`${r.repo}:`];
  lines.push(`  merged: ${r.merges}`);
  if (r.ejects > 0) {
    lines.push(`  queue ejects: ${r.ejects}${r.topCulprit ? culpritLine(r.topCulprit) : ''}`);
  }
  const pools = poolLine(r.pools);
  if (pools) lines.push(pools);
  if (r.regressions.length > 0) {
    const items = r.regressions.map((g) =>
      `${g.check} (${g.event}) p50 ${fmtSecs(g.priorP50Secs)} → ${fmtSecs(g.recentP50Secs)}`);
    lines.push(`  duration regressions: ${items.join('; ')}`);
  }
  if (r.queue && r.queue.state !== 'healthy') {
    lines.push(`  queue health: ${r.queue.state} — ${r.queue.detail}`);
  }
  return lines;
}

/** True when the repo has anything worth a line beyond "0 merged". */
function notable(r: DigestRepoInput): boolean {
  return r.merges > 0 || r.ejects > 0 || r.regressions.length > 0
    || r.pools.some((p) => p.starving) || (r.queue != null && r.queue.state !== 'healthy');
}

/** PURE digest renderer: plain data in, subject + multi-line body out. */
export function composeDigest(input: DigestInput): { subject: string; body: string } {
  const repos = input.repos.filter(notable);
  const sum = (f: (r: DigestRepoInput) => number): number =>
    repos.reduce((s, r) => s + f(r), 0);
  const merges = sum((r) => r.merges);
  const ejects = sum((r) => r.ejects);
  const regressions = sum((r) => r.regressions.length);
  const starving = sum((r) => r.pools.filter((p) => p.starving).length);
  const headline: string[] = [plural(merges, 'merge'), plural(ejects, 'eject')];
  if (regressions > 0) headline.push(plural(regressions, 'duration regression'));
  if (starving > 0) headline.push(`${plural(starving, 'pool')} starving`);
  const subject = `Daily CI digest (${input.windowHours}h) — ${headline.join(', ')}`;
  if (repos.length === 0) {
    return { subject, body: `Quiet ${input.windowHours}h — no merges, ejects, regressions, or starving pools.` };
  }
  return { subject, body: repos.flatMap(repoBlock).join('\n') };
}

// ---- gather (history + live caches → plain data) ---------------------------

/** The HistoryStore subset the digest reads (structural — fakeable). */
export type DigestHistory = Pick<HistoryStore,
  'mergedSince' | 'groupFailuresSince' | 'flakeStatsByRepo'>;

export interface DigestSources {
  history: DigestHistory;
  exclude: string[];
  /** Poller live caches (the same getters the metrics endpoint reads). */
  activeRegressions: { repo: string; checks: DurationRegressionView[] }[];
  poolHealth: { repo: string; pools: PoolHealthView[] }[];
  /** Live queue health per repo — see `queueHealthFromState`. */
  queueHealth: { repo: string; state: string; detail: string }[];
  now?: Date;
}

/** The digest window. */
export const DIGEST_WINDOW_HOURS = 24;
/** Flake rates need more than one night of samples — cross-ref over 7d. */
const FLAKE_XREF_DAYS = 7;

/** Pull queue health rows out of a DashboardState-shaped object. */
export function queueHealthFromState(state: {
  repos: { repo: string; queue: { health: { state: string; detail: string } } | null }[];
}): { repo: string; state: string; detail: string }[] {
  return state.repos.flatMap((r) => r.queue
    ? [{ repo: r.repo, state: r.queue.health.state, detail: r.queue.health.detail }]
    : []);
}

export function gatherDigestInput(src: DigestSources): DigestInput {
  const now = src.now ?? new Date();
  const since = new Date(now.getTime() - DIGEST_WINDOW_HOURS * 3600_000).toISOString();
  const flakeSince = new Date(now.getTime() - FLAKE_XREF_DAYS * 86400_000).toISOString();
  const dropped = new Set(src.exclude);

  const merges = new Map<string, number>();
  for (const r of src.history.mergedSince(since)) {
    merges.set(r.repo, (merges.get(r.repo) ?? 0) + 1);
  }

  // ejects = distinct group shas; top culprit = check with the most rows
  // (one row per (group sha, check) — same accounting as the train killers)
  const ejectShas = new Map<string, Set<string>>();
  const culpritRows = new Map<string, Map<string, number>>();
  for (const r of src.history.groupFailuresSince(since)) {
    let shas = ejectShas.get(r.repo);
    if (!shas) ejectShas.set(r.repo, shas = new Set());
    shas.add(r.groupSha);
    let byCheck = culpritRows.get(r.repo);
    if (!byCheck) culpritRows.set(r.repo, byCheck = new Map());
    byCheck.set(r.checkName, (byCheck.get(r.checkName) ?? 0) + 1);
  }

  // flake cross-ref: max rate across events per (repo, check), ≥ FLAKE_MIN_RUNS
  const flakeRate = new Map<string, number>();
  const hasEjects = ejectShas.size > 0;
  const flakeByRepo: Map<string, FlakeStat[]> = hasEjects
    ? src.history.flakeStatsByRepo(flakeSince) : new Map();
  for (const [repo, stats] of flakeByRepo) {
    for (const s of stats) {
      if (s.totalRuns < FLAKE_MIN_RUNS) continue;
      const k = `${repo} ${s.name}`;
      flakeRate.set(k, Math.max(flakeRate.get(k) ?? 0, s.flakeRatePct));
    }
  }

  const regByRepo = new Map(src.activeRegressions.map((r) => [r.repo, r.checks]));
  const poolsByRepo = new Map(src.poolHealth.map((r) => [r.repo, r.pools]));
  const queueByRepo = new Map(src.queueHealth.map((r) =>
    [r.repo, { state: r.state, detail: r.detail }]));

  const repos = [...new Set([
    ...merges.keys(), ...ejectShas.keys(), ...regByRepo.keys(),
    ...poolsByRepo.keys(), ...queueByRepo.keys(),
  ])].filter((r) => !dropped.has(r)).sort();

  return {
    at: now,
    windowHours: DIGEST_WINDOW_HOURS,
    repos: repos.map((repo) => {
      const byCheck = culpritRows.get(repo);
      let topCulprit: DigestRepoInput['topCulprit'] = null;
      if (byCheck && byCheck.size > 0) {
        const [name, count] = [...byCheck].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
        topCulprit = { name, ejects: count,
          flakeRatePct: flakeRate.get(`${repo} ${name}`) ?? null };
      }
      return {
        repo,
        merges: merges.get(repo) ?? 0,
        ejects: ejectShas.get(repo)?.size ?? 0,
        topCulprit,
        pools: poolsByRepo.get(repo) ?? [],
        regressions: regByRepo.get(repo) ?? [],
        queue: queueByRepo.get(repo) ?? null,
      };
    }),
  };
}

// ---- scheduler --------------------------------------------------------------

/** ms until the NEXT local occurrence of `hourLocal`:00:00 — strictly in the
 *  future (firing exactly at the boundary re-arms for tomorrow). Local Date
 *  arithmetic so DST transitions land on the wall-clock hour. */
export function msUntilNextDigest(hourLocal: number, now: Date): number {
  const next = new Date(now);
  next.setHours(hourLocal, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(hourLocal, 0, 0, 0); // re-assert across a DST boundary
  }
  return next.getTime() - now.getTime();
}

export interface DigestSchedulerDeps {
  /** Live digest config (file-only, but read per-arm for symmetry). */
  config: () => DigestConfig;
  /** Compose + send — wired to gather/compose/notifier.sendDigest in index. */
  send: () => void;
  log?: (msg: string) => void;
  now?: () => Date;
}

/** Self-rearming daily timer: each firing computes the next occurrence fresh
 *  (no 24h-interval drift across DST). `send` failures are contained — the
 *  chain always re-arms. */
export class DigestScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: DigestSchedulerDeps) {}

  start(): void {
    const log = this.deps.log ?? console.log;
    const cfg = this.deps.config();
    if (!cfg.enabled) {
      log('[digest] daily digest disabled (notifications.digest.enabled=false)');
      return;
    }
    log(`[digest] daily digest scheduled at ${String(cfg.hourLocal).padStart(2, '0')}:00 local`);
    this.arm();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    const now = (this.deps.now ?? (() => new Date()))();
    const ms = msUntilNextDigest(this.deps.config().hourLocal, now);
    this.timer = setTimeout(() => {
      try {
        this.deps.send();
      } catch (e) {
        (this.deps.log ?? console.warn)(
          `[digest] send failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.arm();
    }, ms);
    this.timer.unref?.();
  }
}
