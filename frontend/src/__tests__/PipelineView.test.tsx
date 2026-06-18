import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PipelineView } from '../sections/pipeline/PipelineView';
import type { DashboardState, PrView } from '../types';

const pr = (repo: string, number: number, title: string, stage = 'ci'): PrView => ({
  repo, number, title, url: `https://x/${number}`,
  stage: { stage, substate: null, percent: 50, etaSeconds: 100, etaRangeSeconds: null, overdue: false },
  queueAheadCount: null, checks: [],
} as unknown as PrView);

const state = (over: Partial<DashboardState> = {}): DashboardState => ({
  generatedAt: '', staleSince: null,
  repos: [
    { repo: 'acme/alpha', hasDeploy: false, prs: [pr('acme/alpha', 1, 'alpha fix')], queue: null },
    { repo: 'acme/beta', hasDeploy: false, prs: [pr('acme/beta', 2, 'beta feature')], queue: null },
  ],
  ...over,
}) as unknown as DashboardState;

describe('PipelineView (the PR pipeline view, ported into the workspace)', () => {
  it('renders a section per repo with the PrRow rows', () => {
    render(<PipelineView state={state()} focusedRepo={null} />);
    expect(screen.getByText('acme/alpha')).toBeInTheDocument();
    expect(screen.getByText('alpha fix')).toBeInTheDocument();
    expect(screen.getByText('beta feature')).toBeInTheDocument();
  });

  it('orders the focused repo first', () => {
    render(<PipelineView state={state()} focusedRepo="acme/beta" />);
    const headers = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headers[0]).toContain('acme/beta');
  });

  it('collapsing a repo hides its PRs and shows a summary', () => {
    render(<PipelineView state={state()} focusedRepo={null} />);
    const alphaHeader = screen.getByText('acme/alpha').closest('button')!;
    expect(within(alphaHeader).queryByText(/PRs/)).not.toBeInTheDocument();
    fireEvent.click(alphaHeader);
    expect(screen.queryByText('alpha fix')).not.toBeInTheDocument();
    expect(alphaHeader).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows a loading state when state is null', () => {
    render(<PipelineView state={null} focusedRepo={null} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('surfaces "what merges next" from the queue (roadmap 4.4)', () => {
    const st = state({ repos: [{ repo: 'acme/alpha', hasDeploy: false, prs: [pr('acme/alpha', 1, 'p')], queue: {
      groups: [{ oid: 'a', prNumbers: [42], percent: 80, etaSeconds: 120, failed: false }],
      waiting: [], unmergeable: [], queueBlocked: [], unmergeableCulprit: null, batchSize: 1,
    } }] } as never);
    render(<PipelineView state={st} focusedRepo={null} />);
    expect(screen.getByText(/Merges next:/)).toHaveTextContent(/#42.*building 80%/);
  });

  it('collapses the awaiting-prod herd into one expandable row, keeping running PRs visible', () => {
    const st = state({ repos: [{ repo: 'acme/alpha', hasDeploy: true, queue: null, prs: [
      pr('acme/alpha', 1, 'running pr', 'ci'),
      pr('acme/alpha', 2, 'merged a', 'qa-deploy'),
      pr('acme/alpha', 3, 'merged b', 'qa-deploy'),
    ] }] } as never);
    render(<PipelineView state={st} focusedRepo={null} />);
    // the running PR stays visible; the 2 awaiting-prod collapse behind a toggle
    expect(screen.getByText('running pr')).toBeInTheDocument();
    expect(screen.queryByText('merged a')).not.toBeInTheDocument();
    // qa-deploy PRs are awaiting QA — must NOT be lumped under "awaiting prod"
    const toggle = screen.getByRole('button', { name: /2 merged · 2 awaiting QA/i });
    expect(toggle.textContent).not.toMatch(/awaiting prod/i);
    fireEvent.click(toggle);
    expect(screen.getByText('merged a')).toBeInTheDocument();
  });

  it('splits the cohort label into awaiting-QA and awaiting-prod (no lumping)', () => {
    const st = state({ repos: [{ repo: 'acme/alpha', hasDeploy: true, queue: null, prs: [
      pr('acme/alpha', 1, 'to qa', 'qa-deploy'),
      pr('acme/alpha', 2, 'to prod a', 'awaiting-prod'),
      pr('acme/alpha', 3, 'to prod b', 'awaiting-prod'),
    ] }] } as never);
    render(<PipelineView state={st} focusedRepo={null} />);
    expect(screen.getByRole('button', { name: /3 merged · 1 awaiting QA · 2 awaiting prod/i })).toBeInTheDocument();
  });

  it('surfaces the awaiting-QA and awaiting-prod metric distinctly (not lumped)', () => {
    const st = state({ repos: [{ repo: 'acme/alpha', hasDeploy: true, queue: null,
      prs: [pr('acme/alpha', 1, 'running pr', 'ci')],
      deploy: { envs: [], awaitingQa: 2, awaitingProd: 10, chain: { entries: [], supersededCount: 0, inFlight: null } } }] } as never);
    render(<PipelineView state={st} focusedRepo={null} />);
    const summary = screen.getByRole('status', { name: /deploy backlog/i });
    expect(summary).toHaveTextContent(/2 awaiting QA/);
    expect(summary).toHaveTextContent(/10 awaiting prod/);
  });

  it('omits an awaiting-QA segment when nothing is awaiting QA', () => {
    const st = state({ repos: [{ repo: 'acme/alpha', hasDeploy: true, queue: null,
      prs: [pr('acme/alpha', 1, 'running pr', 'ci')],
      deploy: { envs: [], awaitingQa: 0, awaitingProd: 4, chain: { entries: [], supersededCount: 0, inFlight: null } } }] } as never);
    render(<PipelineView state={st} focusedRepo={null} />);
    const summary = screen.getByRole('status', { name: /deploy backlog/i });
    expect(summary).toHaveTextContent(/4 awaiting prod/);
    expect(summary).not.toHaveTextContent(/awaiting QA/);
  });

  it('surfaces the deploy chain: the in-flight SHA + superseded count (roadmap 4.4c)', () => {
    const st = state({ repos: [{ repo: 'acme/alpha', hasDeploy: true, queue: null,
      prs: [pr('acme/alpha', 1, 'running pr', 'ci')],
      deploy: { envs: [], awaitingQa: 0, awaitingProd: 2, chain: {
        entries: [], supersededCount: 1,
        inFlight: { prNumber: 7, sha: 'sha7', stage: 'qa' } } } }] } as never);
    render(<PipelineView state={st} focusedRepo={null} />);
    const chain = screen.getByRole('status', { name: /deploy chain/i });
    expect(chain).toHaveTextContent(/Deploying #7 — at qa/);
    expect(chain).toHaveTextContent(/1 superseded/);
  });

  it('shows no deploy-chain line when nothing is in flight or superseded', () => {
    const st = state({ repos: [{ repo: 'acme/alpha', hasDeploy: true, queue: null,
      prs: [pr('acme/alpha', 1, 'running pr', 'ci')],
      deploy: { envs: [], awaitingQa: 0, awaitingProd: 0, chain: { entries: [], supersededCount: 0, inFlight: null } } }] } as never);
    render(<PipelineView state={st} focusedRepo={null} />);
    expect(screen.queryByRole('status', { name: /deploy chain/i })).not.toBeInTheDocument();
  });
});
