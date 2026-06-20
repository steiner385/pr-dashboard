import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { PipelineCanvas } from '../sections/build/PipelineCanvas';
import type { Lane } from '../sections/build/laneLayout';

const LANES: Lane[] = [
  { tierId: 'pr', label: 'PR', event: 'pull_request', nodes: [
    { check: 'lint', gates: false, conditional: false },
    { check: 'e2e', gates: true, conditional: false },
  ] },
  { tierId: 'queue', label: 'Queue', event: 'merge_group', nodes: [
    { check: 'flaky', gates: false, conditional: true },
  ] },
];

describe('PipelineCanvas (read-only DAG lanes)', () => {
  it('renders a lane per tier with its label and event', () => {
    render(<PipelineCanvas lanes={LANES} />);
    expect(screen.getByTestId('lane-pr')).toBeInTheDocument();
    expect(screen.getByTestId('lane-queue')).toBeInTheDocument();
    expect(within(screen.getByTestId('lane-pr')).getByText('PR')).toBeInTheDocument();
  });

  it('places nodes in their lane', () => {
    render(<PipelineCanvas lanes={LANES} />);
    const pr = screen.getByTestId('lane-pr');
    expect(within(pr).getByText('lint')).toBeInTheDocument();
    expect(within(pr).getByText('e2e')).toBeInTheDocument();
  });

  it('strips the raw ${{ … }} template from the node name + aria-label, keeping the testid raw', () => {
    const lanes: Lane[] = [{ tierId: 'pr', label: 'PR', event: 'pull_request', nodes: [
      { check: 'static / test: unit (${{ matrix.shard }}/8) (1/8)', gates: true, conditional: false },
    ] }];
    render(<PipelineCanvas lanes={lanes} onSelect={vi.fn()} />);
    // visible name + aria-label are clean…
    expect(screen.getByText('static / test: unit (1/8)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /static \/ test: unit \(1\/8\) — gate/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('${{');
    // …but the test id (and onSelect key) keep the raw check name
    expect(screen.getByTestId('node-pr-static / test: unit (${{ matrix.shard }}/8) (1/8)')).toBeInTheDocument();
  });

  it('labels gating color-independently (the word "gate" is in the accessible name, not just a color)', () => {
    render(<PipelineCanvas lanes={LANES} />);
    const e2e = screen.getByTestId('node-pr-e2e');
    expect(e2e).toHaveAccessibleName(/e2e.*gate/i);
    const flaky = screen.getByTestId('node-queue-flaky');
    expect(flaky).toHaveAccessibleName(/flaky.*conditional/i);
  });

  it('highlights the selected node’s dependencies (needs DAG edges, roadmap 5.1)', () => {
    // e2e selected; its needs = {lint} → lint is marked as a dependency, color-independently.
    render(<PipelineCanvas lanes={LANES} onSelect={vi.fn()} selected="e2e" highlightDeps={new Set(['lint'])} />);
    const lint = screen.getByTestId('node-pr-lint');
    expect(lint.className).toMatch(/dep-highlight/);
    expect(lint).toHaveAccessibleName(/dependency of the selected check/i); // word, not just color
    // a non-dependency node is not marked
    expect(screen.getByTestId('node-queue-flaky').className).not.toMatch(/dep-highlight/);
  });

  it('draws an SVG edge from each dependency to the selected node (needs DAG arrows, roadmap 5.1)', () => {
    render(<PipelineCanvas lanes={LANES} onSelect={vi.fn()} selected="e2e" highlightDeps={new Set(['lint'])} />);
    const edge = screen.getByTestId('pipeline-canvas').querySelector('line[data-edge="lint->e2e"]');
    expect(edge).not.toBeNull();
  });

  it('draws no edges when nothing is selected', () => {
    render(<PipelineCanvas lanes={LANES} onSelect={vi.fn()} />);
    expect(screen.getByTestId('pipeline-canvas').querySelectorAll('line[data-edge]')).toHaveLength(0);
  });

  it('renders an empty-state when no lanes have nodes', () => {
    render(<PipelineCanvas lanes={[{ tierId: 'pr', label: 'PR', event: 'pull_request', nodes: [] }]} />);
    expect(screen.getByText(/no checks/i)).toBeInTheDocument();
  });

  it('with onSelect, nodes are keyboard-operable buttons that report the check', () => {
    const onSelect = vi.fn();
    render(<PipelineCanvas lanes={LANES} onSelect={onSelect} selected="e2e" />);
    const e2e = screen.getByTestId('node-pr-e2e');
    expect(e2e.tagName).toBe('BUTTON');
    expect(e2e).toHaveAttribute('aria-pressed', 'true'); // selected, color-independent
    fireEvent.click(screen.getByTestId('node-pr-lint'));
    expect(onSelect).toHaveBeenCalledWith('lint');
  });
});
