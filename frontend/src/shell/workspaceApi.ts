// Client for the workspace IDE/model loop endpoints (spec 001, contracts/api.md).
// Thin typed wrappers over fetch so the Optimize/IDE UI calls the already-built
// server loop (/api/workspace/*). `fetchImpl` is injectable for tests.
import type { DerivedModelLike } from '../sections/optimize/types';

type Fetch = typeof fetch;

export interface SimResultDto {
  legal: boolean; reason?: string; note: string;
  costDeltaMinutes: number; direction: string;
  latencyDeltaSeconds?: number;
  riskDeltaPer100?: number;
  throughputDeltaPerHour?: number;
  confidence?: 'high' | 'medium' | 'low';
  gatesLost: string[]; gatesGained: string[]; estimated: boolean;
}
export interface TierMoveDto { check: string; fromTierId: string; toTierId: string | null }
export interface SecurityFindingDto { file: string; jobId?: string; kind: string; detail: string; confidence: 'high' | 'medium' | 'low' }
export interface RulesetDto {
  readable: boolean; derivedRequired: string[]; liveRequired: string[];
  missingFromModel: string[]; extraInModel: string[]; inSync: boolean;
}
export interface ChangelogDto { changelog: { at: string; kind: string; summary: string; actor: string }[]; audit: { at: string; action: string; repo: string; target?: string; result?: string; actor: string }[] }
export interface OutcomesDto { outcomes: { prNumber: number; check: string; costAccuracy: number; directionCorrect: boolean; confidence: string; caveat: string }[]; accuracy: { count: number; meanCostAccuracy: number; directionHitRate: number; recommenderUsable: boolean } }
export interface BudgetsDto { gauges: { kind: string; threshold: number; current: number; unit?: string; fractionUsed: number; state: 'ok' | 'warn' | 'breach' }[]; alerts: BudgetsDto['gauges'] }
export interface PolicyDto { rules: { id: string; kind: string }[]; violations: { ruleId: string; kind: string; check: string; detail: string }[] }
export interface ForecastDto {
  available: boolean; reason?: string; unit?: string; thresholdValue?: number;
  slopePerDay?: number; projectedAt?: number | null; daysToThreshold?: number | null;
  confidence?: 'high' | 'medium' | 'low'; sampleDays?: number;
}
export interface ToolHealthDto {
  ingestionFreshnessSecs: number | null;
  derivationCache: { hits: number; misses: number; hitRate: number; size: number };
  apiRateLimit: { remaining: number; limit: number } | null;
  status: 'ok' | 'degraded';
  reasons: string[];
}
export interface TierIntentDto { kind: 'tier'; check: string; jobId: string; fromTierId: string; targetEvent: string }
export type CandidateMutationDto =
  | { op: 'timeout'; jobId: string; minutes: number }
  | { op: 'runner'; jobId: string; runsOn: string }
  | { op: 'concurrency'; group: string }
  | { op: 'shift-left'; jobId: string }
  | { op: 'remove'; jobId: string };
export interface CandidateDto {
  ok: boolean; reason?: string; baseSha: string;
  files: { file: string; diff: string }[];
  validation: { gatingRegressed: boolean; lostGates: string[]; lowConfidence: boolean };
  model: DerivedModelLike | null;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export function makeWorkspaceApi(fetchImpl: Fetch = fetch, base = '/api/workspace') {
  const q = (repo: string) => `repo=${encodeURIComponent(repo)}`;
  return {
    getPipeline: (repo: string) =>
      fetchImpl(`${base}/pipeline?${q(repo)}`).then(json<{ repo: string; sourceSha: string; model: DerivedModelLike }>),
    simulate: (repo: string, move: TierMoveDto) =>
      fetchImpl(`${base}/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, move }) }).then(json<SimResultDto>),
    prompt: (repo: string, finding: { goal: string; check: string; detail: string; fromTierId?: string; toTierId?: string | null }) =>
      fetchImpl(`${base}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, finding }) }).then(json<{ prompt: string }>),
    draftPrDryRun: (repo: string, intent: TierIntentDto) =>
      fetchImpl(`${base}/draft-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, dryRun: true, intent }) }).then(json<{ dryRun: true; diff: string; baseSha: string }>),
    draftPrOpen: (repo: string, intent: TierIntentDto) =>
      fetchImpl(`${base}/draft-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, dryRun: false, intent }) }).then(json<{ opened: true; number: number; url: string }>),
    security: (repo: string) =>
      fetchImpl(`${base}/security?${q(repo)}`).then(json<{ repo: string; sourceSha: string; scannedFiles: number; findings: SecurityFindingDto[] }>),
    self: () => fetchImpl(`${base}/self`).then(json<ToolHealthDto>),
    ruleset: (repo: string) => fetchImpl(`${base}/ruleset?${q(repo)}`).then(json<RulesetDto>),
    forecast: (repo: string) => fetchImpl(`${base}/forecast?${q(repo)}`).then(json<ForecastDto>),
    changelog: (repo: string) => fetchImpl(`${base}/changelog?${q(repo)}`).then(json<ChangelogDto>),
    outcomes: (repo: string) => fetchImpl(`${base}/outcomes?${q(repo)}`).then(json<OutcomesDto>),
    budgets: () => fetchImpl(`${base}/budgets`).then(json<BudgetsDto>),
    policy: (repo: string) => fetchImpl(`${base}/policy?${q(repo)}`).then(json<PolicyDto>),
    quarantineDryRun: (repo: string, check: string, jobId: string) =>
      fetchImpl(`${base}/quarantine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, check, jobId, dryRun: true }) }).then(json<{ dryRun: true; diff: string; baseSha: string }>),
    quarantines: (repo: string) =>
      fetchImpl(`${base}/quarantines?${q(repo)}`).then(json<{ repo: string; quarantines: { check: string; until: string; reason: string | null }[] }>),
    prefixesDryRun: (repo: string, prefixes?: string[]) =>
      fetchImpl(`${base}/prefixes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, prefixes, dryRun: true }) }).then(json<{ dryRun: true; file: string; prefixes: string[]; newText: string; baseSha: string }>),
    prefixesOpen: (repo: string, prefixes?: string[]) =>
      fetchImpl(`${base}/prefixes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, prefixes, dryRun: false }) }).then(json<{ opened: true; number: number; url: string; prefixes: string[] }>),
    plan: (repo: string, moves: TierMoveDto[]) =>
      fetchImpl(`${base}/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, moves }) }).then(json<{ combinedCostDeltaMinutes: number; legal: boolean; reason?: string; results: SimResultDto[] }>),
    candidate: (repo: string, mutations: CandidateMutationDto[], baseSha?: string) =>
      fetchImpl(`${base}/candidate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, baseSha, mutations }) }).then(json<CandidateDto>),
    candidateApply: (repo: string, mutations: CandidateMutationDto[], baseSha?: string) =>
      fetchImpl(`${base}/candidate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, baseSha, apply: true, mutations }) }).then(json<{ ok: true; number: number; url: string }>),
    candidateRaw: (repo: string, file: string, rawYaml: string, baseSha?: string) =>
      fetchImpl(`${base}/candidate/raw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, baseSha, file, rawYaml }) }).then(json<CandidateDto>),
  };
}
export type WorkspaceApi = ReturnType<typeof makeWorkspaceApi>;
