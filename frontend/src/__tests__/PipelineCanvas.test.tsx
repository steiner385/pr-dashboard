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

  it('labels gating color-independently (the word "gate" is in the accessible name, not just a color)', () => {
    render(<PipelineCanvas lanes={LANES} />);
    const e2e = screen.getByTestId('node-pr-e2e');
    expect(e2e).toHaveAccessibleName(/e2e.*gate/i);
    const flaky = screen.getByTestId('node-queue-flaky');
    expect(flaky).toHaveAccessibleName(/flaky.*conditional/i);
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
