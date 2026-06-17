// HTTP surface for the unified-workspace IDE/model loop (spec 001, contracts/api.md).
// A Router FACTORY taking injected deps so it's testable without the full app and
// wired in index.ts with the real GitHub client. Mutating routes are POST (the
// caller applies the same-origin guard at mount). No direct apply — the only
// write is a DRAFT PR.
import { Router, type Request, type Response } from 'express';
import { ModelDeriver } from '../model/derive';
import { simulateTierMove, simulatePlan, type TierMove } from '../model/simulate';
import { buildPrompt, type PromptInput } from '../actions/prompt';
import { prepareDraftEdit, prepareQuarantineEdit, openDraftPr, type PrClient, type TierAssignIntent } from '../actions/draftPr';
import { auditWorkflowSecurity } from '../model/security';
import { buildSelfHealth, type ApiRateLimit } from '../model/selfHealth';
import { reconcileRuleset } from '../model/ruleset';
import { forecastTrend, type Point } from '../analytics/forecast';
import { buildChangelog, buildAuditLog, type ChangelogRow, type AuditRow } from '../analytics/changelog';
import { attributeOutcome, summarizeAccuracy, type AppliedChange } from '../analytics/outcomes';
import { evaluatePolicies, type PolicyRule } from '../analytics/policy';

export interface WorkspaceRouterDeps {
  deriver: ModelDeriver;
  prClient: PrClient;
  /** live-ruleset required checks for a repo (FR-035a union binding); [] if unreadable. */
  liveRequired?: (repo: string) => Promise<readonly string[]>;
  /** live branch-protection ruleset read (Group I1) — required checks, or null when
   *  unreadable (missing administration:read scope / API error). */
  liveRuleset?: (repo: string) => Promise<readonly string[] | null>;
  /** self-observability inputs (Group O): ingestion freshness + API rate-limit budget. */
  selfHealth?: () => { ingestionFreshnessSecs: number | null; apiRateLimit: ApiRateLimit | null };
  /** cost/minutes daily series + optional budget threshold for forecasting (Group J1). */
  costForecast?: (repo: string) => Promise<{ points: Point[]; thresholdValue?: number; unit?: string }>;
  /** CI config-change rows for the changelog (Group L1). */
  changelog?: (repo: string) => Promise<ChangelogRow[]>;
  /** the tool's own action-audit rows (Group L2). */
  auditLog?: (repo: string) => Promise<AuditRow[]>;
  /** applied-change ledger for closed-loop outcome attribution (Group H). */
  outcomes?: (repo: string) => Promise<AppliedChange[]>;
  /** declarative-policy store (Group I2): read authored rules + persist edits. */
  policyStore?: { get: (repo: string) => Promise<PolicyRule[]>; put?: (repo: string, rules: PolicyRule[]) => Promise<void> };
}

function repoOf(req: Request, res: Response): string | null {
  const repo = String(req.query.repo ?? req.body?.repo ?? '');
  if (!/^[^/]+\/[^/]+$/.test(repo)) { res.status(400).json({ error: 'repo must be "owner/name"' }); return null; }
  return repo;
}

export function createWorkspaceRouter(deps: WorkspaceRouterDeps): Router {
  const r = Router();
  const required = async (repo: string) => (deps.liveRequired ? deps.liveRequired(repo) : undefined);

  // GET /pipeline?repo= — Tier-2 SHA-pinned model
  r.get('/pipeline', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    res.json({ repo, sourceSha: pinned.sourceSha, model: pinned.model });
  });

  // POST /simulate — { repo, move } → projection + legality
  r.post('/simulate', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const move = req.body?.move as TierMove | undefined;
    if (!move?.check || !move.fromTierId) return res.status(400).json({ error: 'move {check, fromTierId, toTierId} required' });
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    res.json(simulateTierMove(pinned.model, move, await required(repo)));
  });

  // POST /prompt — { repo, finding } → a Claude Code prompt
  r.post('/prompt', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const finding = req.body?.finding as PromptInput | undefined;
    if (!finding?.goal || !finding.check) return res.status(400).json({ error: 'finding {goal, check, detail} required' });
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    res.json({ prompt: buildPrompt(repo, pinned.model, finding) });
  });

  // GET /ruleset?repo= — reconcile derived required gates vs the live branch-
  // protection ruleset (Group I1 / FR-035 / SC-014). Degrades honestly when the
  // ruleset is unreadable (readable:false), never a false "in sync".
  r.get('/ruleset', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    const live = deps.liveRuleset ? await deps.liveRuleset(repo) : null;
    res.json({ repo, sourceSha: pinned.sourceSha, ...reconcileRuleset(pinned.model, live) });
  });

  // GET /forecast?repo= — cost/capacity trend + days-to-budget (Group J1 / FR-037).
  // Degrades to { available:false } when no series is wired (cost actuals are
  // operator-imported, not auto-telemetry — see the review).
  r.get('/forecast', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    if (!deps.costForecast) return res.json({ repo, available: false, reason: 'no cost series imported' });
    const { points, thresholdValue, unit } = await deps.costForecast(repo);
    res.json({ repo, available: true, unit: unit ?? 'minutes', thresholdValue, ...forecastTrend(points, { thresholdValue }) });
  });

  // GET /changelog?repo= — CI config-change timeline + the tool's action audit
  // (Group L / FR-039). Degrades to empty arrays when no provider is wired.
  r.get('/changelog', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const changes = deps.changelog ? await deps.changelog(repo) : [];
    const audit = deps.auditLog ? await deps.auditLog(repo) : [];
    res.json({ repo, changelog: buildChangelog(changes), audit: buildAuditLog(audit) });
  });

  // GET /outcomes?repo= — applied-change ledger + projected-vs-realized accuracy
  // (Group H / FR-034). Degrades to an empty ledger; the recommender-usable flag
  // gates whether outcomes may feed finding rankings (advisory until proven).
  r.get('/outcomes', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const ledger = deps.outcomes ? await deps.outcomes(repo) : [];
    res.json({ repo, outcomes: ledger.map(attributeOutcome), accuracy: summarizeAccuracy(ledger) });
  });

  // GET /policy?repo= → authored rules + their current violations (Group I2).
  // PUT /policy?repo= { rules } → persist authored rules (guarded at mount).
  r.get('/policy', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const rules = deps.policyStore ? await deps.policyStore.get(repo) : [];
    const pinned = await deps.deriver.deriveAtHead(repo);
    const live = deps.liveRequired ? await deps.liveRequired(repo) : undefined;
    const violations = pinned ? evaluatePolicies(pinned.model, rules, live) : [];
    res.json({ repo, rules, violations });
  });
  r.put('/policy', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    if (!deps.policyStore?.put) return res.status(501).json({ error: 'policy store is read-only' });
    const rules = req.body?.rules as PolicyRule[] | undefined;
    if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules[] required' });
    await deps.policyStore.put(repo, rules);
    res.json({ repo, rules });
  });

  // POST /plan — { repo, moves[] } → composite simulation (N2/FR-042). Composite
  // legality is the merged effect, not the AND of per-move verdicts.
  r.post('/plan', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const moves = req.body?.moves as TierMove[] | undefined;
    if (!Array.isArray(moves) || moves.length === 0) return res.status(400).json({ error: 'moves[] required' });
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    const live = deps.liveRequired ? await deps.liveRequired(repo) : undefined;
    res.json({ repo, sourceSha: pinned.sourceSha, ...simulatePlan(pinned.model, moves, live) });
  });

  // POST /quarantine — { repo, check, jobId, dryRun } → review-gated flake quarantine
  // (Group K2 / FR-038). Refuses a required merge gate; same SHA-pin + optimistic-
  // concurrency + draft-only path as draft-pr. Inherits the action invariants.
  r.post('/quarantine', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const { check, jobId } = req.body ?? {};
    if (!check || !jobId) return res.status(400).json({ error: '{ check, jobId } required' });
    const live = deps.liveRequired ? await deps.liveRequired(repo) : undefined;
    const prep = await prepareQuarantineEdit(deps.deriver, deps.prClient, repo, { check, jobId }, live);
    if (!prep.ok) return res.status(409).json({ error: prep.reason });
    if (req.body?.dryRun !== false) return res.json({ dryRun: true, diff: prep.prepared.diff, baseSha: prep.prepared.baseSha });
    const out = await openDraftPr(deps.deriver, deps.prClient, prep.prepared, check);
    if (out.opened) return res.json({ opened: true, number: out.number, url: out.url });
    if (out.stale) return res.status(409).json({ error: 'HEAD drifted — re-derive and re-confirm', headSha: out.headSha });
    return res.status(502).json({ error: out.reason });
  });

  // GET /self — the tool's own health (Group O / FR-043). Always available; no repo.
  r.get('/self', (_req, res) => {
    const ext = deps.selfHealth?.() ?? { ingestionFreshnessSecs: null, apiRateLimit: null };
    res.json(buildSelfHealth({ ...ext, derivationCache: deps.deriver.cacheStats() }));
  });

  // GET /security?repo= — CI security audit (Group M) of the model's workflow
  // files at the pinned SHA. Tier-2 (SHA-pinned) per the review; per-finding
  // confidence, never a false "clean" (FR-040/SC-016).
  r.get('/security', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    const files = [...new Set((pinned.model.checkMeta ?? []).flatMap((m) => m.provenance.map((p) => p.file)))];
    const findings = [];
    for (const file of files) {
      const yaml = await deps.prClient.fetchWorkflowAtSha(repo, file, pinned.sourceSha);
      if (yaml != null) findings.push(...auditWorkflowSecurity(yaml, file));
    }
    res.json({ repo, sourceSha: pinned.sourceSha, scannedFiles: files.length, findings });
  });

  // POST /draft-pr — { repo, intent, dryRun } → preview diff OR open a draft PR (FR-026)
  r.post('/draft-pr', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const intent = req.body?.intent as TierAssignIntent | undefined;
    if (intent?.kind !== 'tier' || !intent.check || !intent.jobId) return res.status(400).json({ error: 'tier intent {check, jobId, fromTierId, targetEvent} required' });
    const prep = await prepareDraftEdit(deps.deriver, deps.prClient, repo, intent, await required(repo));
    if (!prep.ok) return res.status(409).json({ error: prep.reason });
    if (req.body?.dryRun !== false) return res.json({ dryRun: true, diff: prep.prepared.diff, baseSha: prep.prepared.baseSha });
    const out = await openDraftPr(deps.deriver, deps.prClient, prep.prepared, intent.check);
    if (out.opened) return res.json({ opened: true, number: out.number, url: out.url });
    if (out.stale) return res.status(409).json({ error: 'HEAD drifted — re-derive and re-confirm', headSha: out.headSha });
    return res.status(502).json({ error: out.reason });
  });

  return r;
}
