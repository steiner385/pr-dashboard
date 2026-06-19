import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { NeedsGraph } from '../NeedsGraph';
import type { GraphNodeInput } from '../needsLayout';

const node = (name: string, needs: string[], over: Partial<GraphNodeInput> = {}): GraphNodeInput => ({
  name, needs, durationP50: 60, waitP50: 0, onCriticalPath: false, slackSecs: null, ...over });

const formatDur = (secs: number) => `${secs}s`;

describe('NeedsGraph', () => {
  it('uses a unique SVG marker id per instance to avoid url() collision', () => {
    // Render two NeedsGraph instances with different node sets
    const nodes1 = [
      node('a1', []), node('b1', ['a1']),
    ];
    const nodes2 = [
      node('a2', []), node('b2', ['a2']),
    ];

    const { container } = render(
      <>
        <NeedsGraph nodes={nodes1} formatDur={formatDur} />
        <NeedsGraph nodes={nodes2} formatDur={formatDur} />
      </>
    );

    // Query all marker elements
    const markers = container.querySelectorAll('marker');
    expect(markers.length).toBe(2);

    const markerIds: string[] = [];
    markers.forEach((m) => {
      const id = m.getAttribute('id');
      expect(id).not.toBeNull();
      expect(id).not.toBe('ng-arrow'); // Should NOT be the hardcoded id
      markerIds.push(id!);
    });

    // Marker ids must be distinct
    expect(new Set(markerIds).size).toBe(2);
    expect(markerIds[0]).not.toBe(markerIds[1]);

    // Each <line> must reference its own graph's marker id, not a shared literal
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBeGreaterThan(0);

    // First group of lines (first SVG) should reference markerIds[0]
    const firstSvg = container.querySelectorAll('svg')[0];
    const firstLines = firstSvg.querySelectorAll('line');
    firstLines.forEach((line) => {
      const markerEnd = line.getAttribute('markerEnd') || line.getAttribute('marker-end');
      expect(markerEnd).toBe(`url(#${markerIds[0]})`);
    });

    // Second group of lines (second SVG) should reference markerIds[1]
    const secondSvg = container.querySelectorAll('svg')[1];
    const secondLines = secondSvg.querySelectorAll('line');
    secondLines.forEach((line) => {
      const markerEnd = line.getAttribute('markerEnd') || line.getAttribute('marker-end');
      expect(markerEnd).toBe(`url(#${markerIds[1]})`);
    });
  });
});

describe('NeedsGraph — a11y: node as button with keyboard + aria-pressed (#173)', () => {
  const nodes = [node('lint', []), node('build', ['lint']), node('test', ['lint'])];

  it('each job node has role="button" (not "group")', () => {
    const { container } = render(<NeedsGraph nodes={nodes} formatDur={formatDur} />);
    const gs = container.querySelectorAll('[data-testid^="ng-node-"]');
    gs.forEach((g) => {
      expect(g.getAttribute('role')).toBe('button');
    });
  });

  it('each job node has aria-pressed="false" when nothing is active', () => {
    const { container } = render(<NeedsGraph nodes={nodes} formatDur={formatDur} />);
    const gs = container.querySelectorAll('[data-testid^="ng-node-"]');
    gs.forEach((g) => {
      expect(g.getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('pressing Space on a node sets aria-pressed="true" on that node', () => {
    const { container } = render(<NeedsGraph nodes={nodes} formatDur={formatDur} />);
    const lintNode = container.querySelector('[data-testid="ng-node-lint"]')!;
    fireEvent.keyDown(lintNode, { key: ' ' });
    expect(lintNode.getAttribute('aria-pressed')).toBe('true');
    // other nodes are not pressed
    const buildNode = container.querySelector('[data-testid="ng-node-build"]')!;
    expect(buildNode.getAttribute('aria-pressed')).toBe('false');
  });

  it('pressing Space again on an active node toggles it off (aria-pressed semantics)', () => {
    const { container } = render(<NeedsGraph nodes={nodes} formatDur={formatDur} />);
    const lintNode = container.querySelector('[data-testid="ng-node-lint"]')!;
    fireEvent.keyDown(lintNode, { key: ' ' });
    expect(lintNode.getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(lintNode, { key: ' ' }); // second press toggles off
    expect(lintNode.getAttribute('aria-pressed')).toBe('false');
  });

  it('pressing Enter on a node sets aria-pressed="true"', () => {
    const { container } = render(<NeedsGraph nodes={nodes} formatDur={formatDur} />);
    const buildNode = container.querySelector('[data-testid="ng-node-build"]')!;
    fireEvent.keyDown(buildNode, { key: 'Enter' });
    expect(buildNode.getAttribute('aria-pressed')).toBe('true');
  });

  it('pressing Escape clears the active/pressed node', () => {
    const { container } = render(<NeedsGraph nodes={nodes} formatDur={formatDur} />);
    const lintNode = container.querySelector('[data-testid="ng-node-lint"]')!;
    fireEvent.keyDown(lintNode, { key: ' ' });
    expect(lintNode.getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(lintNode, { key: 'Escape' });
    expect(lintNode.getAttribute('aria-pressed')).toBe('false');
  });

  it('mouseEnter also reflects in aria-pressed (hover = active = pressed)', () => {
    const { container } = render(<NeedsGraph nodes={nodes} formatDur={formatDur} />);
    const testNode = container.querySelector('[data-testid="ng-node-test"]')!;
    const buildNode = container.querySelector('[data-testid="ng-node-build"]')!;
    // Before hover: all nodes are unpressed
    expect(testNode.getAttribute('aria-pressed')).toBe('false');
    // Hover sets active → aria-pressed=true on hovered, false on others
    fireEvent.mouseEnter(testNode);
    expect(testNode.getAttribute('aria-pressed')).toBe('true');
    expect(buildNode.getAttribute('aria-pressed')).toBe('false');
    // Mouse leave clears
    fireEvent.mouseLeave(testNode);
    expect(testNode.getAttribute('aria-pressed')).toBe('false');
  });
});
