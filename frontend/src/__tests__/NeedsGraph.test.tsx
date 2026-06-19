import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
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
