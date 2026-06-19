import { Fragment } from 'react';
import type { StageResult } from './types';
import { formatDur } from './format';

export type NodeStatus = 'done' | 'active' | 'fail' | 'pending' | 'parked';
export interface TrackNode { label: string; status: NodeStatus; }

const DEPLOY_LABELS = ['CI', 'Queue', 'Merged', 'QA', 'Prod'];
const SIMPLE_LABELS = ['CI', 'Queue', 'Merged'];

/**
 * Pure mapper: stage/substate → per-node track state.
 * Deploy repos get a 5-node lifecycle (CI/Queue/Merged/QA/Prod), simple repos 3 nodes.
 * Parked draft/conflicting relabel the CI node with the substate (amber `!`);
 * ci-failed / group-failed render as red ✗ at the CI / Queue node respectively;
 * queue/unmergeable (needs a rebase) and queue/queue-blocked (cascade victim —
 * stuck behind a conflicting entry) both render the Queue node as amber `!`.
 */
export function trackState(stage: StageResult, hasDeploy: boolean): TrackNode[] {
  const labels = hasDeploy ? DEPLOY_LABELS : SIMPLE_LABELS;
  const nodes: TrackNode[] = labels.map((label) => ({ label, status: 'pending' as NodeStatus }));
  const doneThrough = (idx: number) => {
    for (let i = 0; i <= idx && i < nodes.length; i++) nodes[i]!.status = 'done';
  };
  switch (stage.stage) {
    case 'parked':
      if (stage.substate === 'ci-failed') nodes[0]!.status = 'fail';
      else nodes[0] = { label: stage.substate ?? 'parked', status: 'parked' };
      break;
    case 'ci':
      nodes[0]!.status = 'active';
      break;
    case 'ready':
      nodes[0]!.status = 'done';
      break;
    case 'queue':
      nodes[0]!.status = 'done';
      nodes[1]!.status = stage.substate === 'group-failed' ? 'fail'
        : stage.substate === 'unmergeable' || stage.substate === 'queue-blocked'
          ? 'parked' : 'active';
      break;
    case 'merged':
      doneThrough(2);
      break;
    case 'qa-deploy':
      doneThrough(2);
      if (hasDeploy) nodes[3]!.status = 'active';
      break;
    case 'awaiting-prod':
      doneThrough(3);
      if (hasDeploy) nodes[4]!.status = 'active';
      break;
  }
  return nodes;
}

const GLYPH: Partial<Record<NodeStatus, string>> = { done: '✓', fail: '✗', parked: '!' };

/** Human-readable state word for aria-label summary. */
function nodeStateSummary(status: NodeStatus): string {
  switch (status) {
    case 'done': return 'complete';
    case 'active': return 'in progress';
    case 'pending': return 'pending';
    case 'fail': return 'failed';
    case 'parked': return 'blocked';
  }
}

/** Descriptive aria-label: "CI: complete, Queue: in progress, Merged: pending" */
function trackAriaLabel(nodes: TrackNode[]): string {
  return nodes.map((n) => `${n.label}: ${nodeStateSummary(n.status)}`).join(', ');
}

/** Hover tooltip per node: states are generic except fail/parked, which carry
 *  the concrete reason derived from the stage/substate that produced them. */
export function nodeTitle(node: TrackNode, stage: StageResult): string {
  switch (node.status) {
    case 'done': return `${node.label} — complete`;
    case 'active': return `${node.label} — in progress`;
    case 'pending': return `${node.label} — not reached yet`;
    case 'fail':
      // fail renders at the CI node (parked/ci-failed) or the Queue node (queue/group-failed)
      return node.label === 'Queue' ? 'merge group build failed' : 'CI failed on the head commit';
    case 'parked':
      if (stage.stage === 'queue') {
        return stage.substate === 'unmergeable'
          ? 'unmergeable — conflicts with the base; needs a rebase before it can merge'
          : 'queue blocked — stuck behind a conflicting entry ahead; revalidates once it is ejected';
      }
      if (stage.substate === 'draft') return 'draft — parked until marked ready for review';
      if (stage.substate === 'conflicting') return 'conflicting with the base branch — needs a rebase';
      return stage.substate ? `parked — ${stage.substate}` : 'parked';
  }
}

function segment(prev: TrackNode, percent: number | null, key: string) {
  if (prev.status === 'done') return <i key={key} className="seg done" />;
  if (prev.status === 'active' && percent != null && percent > 0) {
    return (
      <i key={key} className="seg part"
        style={{ background: `linear-gradient(90deg, var(--accent) ${percent}%, var(--border) ${percent}%)` }} />
    );
  }
  return <i key={key} className="seg" />;
}

export function MetroTrack({ stage, hasDeploy }: { stage: StageResult; hasDeploy: boolean }) {
  const nodes = trackState(stage, hasDeploy);
  const currentIdx = nodes.findIndex((n) => n.status === 'active' || n.status === 'fail' || n.status === 'parked');
  const lastDone = nodes.reduce((acc, n, i) => (n.status === 'done' ? i : acc), 0);
  const pos = currentIdx >= 0 ? currentIdx : lastDone;
  const nodeEta = stage.etaSeconds != null && stage.etaSeconds > 0 && !stage.overdue
    ? `~${formatDur(stage.etaSeconds)}` : null;
  return (
    <div className="track" aria-label={trackAriaLabel(nodes)}>
      {nodes.map((n, i) => (
        <Fragment key={`${n.label}-${i}`}>
          {i > 0 && segment(nodes[i - 1]!, stage.percent, `seg-${i}`)}
          <span className={`node ${n.status}`} title={nodeTitle(n, stage)} aria-hidden="true">
            <span className="c" aria-hidden="true">{GLYPH[n.status] ?? i + 1}</span>
            <span className="node-label">{n.label}</span>
            {n.status === 'active' && nodeEta && <span className="node-eta">{nodeEta}</span>}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
