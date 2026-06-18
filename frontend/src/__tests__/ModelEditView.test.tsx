import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { WorkspaceApi } from '../shell/workspaceApi';

// Stub the three sub-surfaces — we test the mode switching, not their internals.
vi.mock('../sections/model/ModelView', () => ({ ModelView: () => <div data-testid="inspect">MODEL</div> }));
vi.mock('../sections/optimize/OptimizeView', () => ({ OptimizeView: () => <div data-testid="optimize">OPTIMIZE</div> }));
vi.mock('../sections/build/BuildView', () => ({ BuildView: () => <div data-testid="edit">BUILD</div> }));

import { ModelEditView } from '../sections/modelEdit/ModelEditView';

const api = {} as unknown as WorkspaceApi;

describe('ModelEditView (WS3b — Model/Optimize/Build as one section, three modes)', () => {
  it('defaults to Inspect (the read model) and exposes a mode tablist', () => {
    render(<ModelEditView repo="o/r" api={api} />);
    expect(screen.getByRole('tablist', { name: /mode/i })).toBeInTheDocument();
    expect(screen.getByTestId('inspect')).toBeInTheDocument();
    expect(screen.queryByTestId('edit')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /inspect/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches to Optimize and Edit modes', () => {
    render(<ModelEditView repo="o/r" api={api} />);
    fireEvent.click(screen.getByRole('tab', { name: /optimize/i }));
    expect(screen.getByTestId('optimize')).toBeInTheDocument();
    expect(screen.queryByTestId('inspect')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /edit/i }));
    expect(screen.getByTestId('edit')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /edit/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the select-a-pipeline hint when no repo is focused', () => {
    render(<ModelEditView repo={null} api={api} />);
    expect(screen.getByText(/select a pipeline/i)).toBeInTheDocument();
  });
});
