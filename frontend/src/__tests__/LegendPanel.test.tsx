import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { LegendPanel } from '../LegendPanel';

describe('LegendPanel', () => {
  it('does not render when closed', () => {
    render(<LegendPanel open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders an aria-modal dialog labelled "Legend" when open', () => {
    render(<LegendPanel open={true} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(screen.getByRole('heading', { name: 'Legend' })).toBeInTheDocument();
  });

  it('renders all five sections', () => {
    render(<LegendPanel open={true} onClose={() => {}} />);
    for (const name of [
      'Pipeline track',
      'Row sub-line terms',
      'Expanded job bars',
      'Queue train',
      'Status tiles',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });

  it('Esc closes the panel', () => {
    const onClose = vi.fn();
    render(<LegendPanel open={true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('overlay click closes the panel', () => {
    const onClose = vi.fn();
    render(<LegendPanel open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('legend-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close button closes the panel', () => {
    const onClose = vi.fn();
    render(<LegendPanel open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close legend' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the panel on open and restores it to returnFocusRef on close', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    const ref = createRef<HTMLElement>();
    ref.current = btn;
    const { rerender } = render(
      <LegendPanel open={true} onClose={() => {}} returnFocusRef={ref} />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    rerender(<LegendPanel open={false} onClose={() => {}} returnFocusRef={ref} />);
    expect(document.activeElement).toBe(btn);
    btn.remove();
  });

  // ---- section content: real rendered examples reusing the live CSS classes ----

  it('pipeline track section draws one example node per state with the real classes', () => {
    const { container } = render(<LegendPanel open={true} onClose={() => {}} />);
    for (const cls of ['done', 'active', 'fail', 'pending', 'parked']) {
      expect(container.querySelector(`.legend-ex .node.${cls} .c`)).not.toBeNull();
    }
    // glyphs match the live track rendering
    expect(container.querySelector('.legend-ex .node.done .c')!.textContent).toBe('✓');
    expect(container.querySelector('.legend-ex .node.fail .c')!.textContent).toBe('✗');
    expect(container.querySelector('.legend-ex .node.parked .c')!.textContent).toBe('!');
    // segment fill examples: done + partial
    expect(container.querySelector('.legend-ex .seg.done')).not.toBeNull();
    expect(container.querySelector('.legend-ex .seg.part')).not.toBeNull();
  });

  it('row sub-line section defines the live vocabulary', () => {
    render(<LegendPanel open={true} onClose={() => {}} />);
    for (const term of [
      'group N%',
      'behind N',
      'queue blocked — conflict ahead (#n)',
      'unmergeable — needs rebase',
      'retrying',
      'overdue',
      'waiting for runners (N jobs)',
    ]) {
      expect(screen.getByText(term)).toBeInTheDocument();
    }
  });

  it('job bars section renders one example bar per row kind with the real classes', () => {
    const { container } = render(<LegendPanel open={true} onClose={() => {}} />);
    for (const cls of ['g-done', 'g-running', 'g-overdue', 'g-failed', 'g-queued']) {
      expect(container.querySelector(`.legend-gantt .g-row.${cls} .g-bar i`)).not.toBeNull();
    }
    // striped runner-wait fills (plain + amber escalation)
    expect(container.querySelector('.legend-gantt .g-row.g-runner-wait')).not.toBeNull();
    expect(container.querySelector('.legend-gantt .g-row.g-runner-wait-amber')).not.toBeNull();
    // p10–p90 band + p50 expected tick examples
    expect(container.querySelector('.legend-gantt .g-bar .band')).not.toBeNull();
    expect(container.querySelector('.legend-gantt .g-bar .exp')).not.toBeNull();
    // the ⧗ / ⊘ queued-state texts are explained
    expect(screen.getAllByText(/⧗ waiting for runner/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/⊘ blocked on/).length).toBeGreaterThan(0);
  });

  it('queue train section renders one mini car per type with the real classes', () => {
    const { container } = render(<LegendPanel open={true} onClose={() => {}} />);
    expect(container.querySelector('.legend-train .car.building:not(.failed)')).not.toBeNull();
    expect(container.querySelector('.legend-train .car.building.failed')).not.toBeNull();
    expect(container.querySelector('.legend-train .car.queued')).not.toBeNull();
    expect(container.querySelector('.legend-train .car.unmergeable')).not.toBeNull();
    expect(container.querySelector('.legend-train .car.queue-blocked')).not.toBeNull();
    // car headers match the live rendering
    expect(screen.getByText('▶ group')).toBeInTheDocument();
    expect(screen.getByText('✗ failing')).toBeInTheDocument();
    expect(screen.getByText('✗ unmergeable')).toBeInTheDocument();
    expect(screen.getByText('⊘ blocked behind conflict')).toBeInTheDocument();
  });

  it('status tiles section shows a swatch and definition per bucket', () => {
    const { container } = render(<LegendPanel open={true} onClose={() => {}} />);
    for (const cls of ['tile-running', 'tile-queued', 'tile-deploy', 'tile-failed', 'tile-idle']) {
      expect(container.querySelector(`.legend-swatch.${cls}`)).not.toBeNull();
    }
    const dtLabels = [...container.querySelectorAll('.legend-swatch')]
      .map((s) => s.parentElement!.textContent!.trim());
    expect(dtLabels).toEqual(['CI running', 'In queue', 'Awaiting prod', 'Failed', 'Ready / other']);
  });
});
