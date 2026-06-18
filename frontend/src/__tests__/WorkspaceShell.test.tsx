import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { WorkspaceShell } from '../shell/WorkspaceShell';
import { sectionFromHash, hashForSection, SECTIONS, DEFAULT_SECTION } from '../shell/sections';

describe('sections routing (pure)', () => {
  it('round-trips a section id through the hash', () => {
    for (const s of SECTIONS) expect(sectionFromHash(hashForSection(s.id))).toBe(s.id);
  });
  it('returns null for an unknown hash', () => {
    expect(sectionFromHash('#nope')).toBeNull();
    expect(sectionFromHash('')).toBeNull();
  });
});

describe('WorkspaceShell', () => {
  beforeEach(() => { location.hash = ''; });

  const bridge = (id: string) => <div data-testid="legacy">legacy:{id}</div>;

  it('renders all five sections in the rail + the header', () => {
    render(<WorkspaceShell header={<div>SPINE</div>} content={{}} legacyBridge={bridge} />);
    const nav = screen.getByRole('navigation', { name: /workspace sections/i });
    for (const s of SECTIONS) expect(within(nav).getByText(s.label)).toBeInTheDocument();
    expect(screen.getByText('SPINE')).toBeInTheDocument();
  });

  it('defaults to Health and marks it aria-current', () => {
    render(<WorkspaceShell header={null} content={{ health: <div>HEALTH</div> }} legacyBridge={bridge} />);
    expect(screen.getByText('HEALTH')).toBeInTheDocument();
    expect(screen.getByText('Health')).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to the legacy bridge for an unbuilt section', () => {
    render(<WorkspaceShell header={null} content={{ health: <div>HEALTH</div> }} legacyBridge={bridge} />);
    fireEvent.click(screen.getByText('Model & Edit'));
    expect(screen.getByTestId('legacy')).toHaveTextContent('legacy:model-edit');
  });

  it('switching sections updates content, hash, and aria-current', () => {
    render(<WorkspaceShell header={null} content={{ health: <div>HEALTH</div>, 'model-edit': <div>OPT</div> }} legacyBridge={bridge} />);
    fireEvent.click(screen.getByText('Model & Edit'));
    expect(screen.getByText('OPT')).toBeInTheDocument();
    expect(location.hash).toBe('#model-edit');
    expect(screen.getByText('Model & Edit')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Health')).not.toHaveAttribute('aria-current');
  });

  it('honors a deep-link hash on mount', () => {
    location.hash = hashForSection('insights');
    render(<WorkspaceShell header={null} content={{ insights: <div>INSIGHTS</div> }} legacyBridge={bridge} />);
    expect(screen.getByText('INSIGHTS')).toBeInTheDocument();
    expect(DEFAULT_SECTION).toBe('health'); // sanity: default is Health, but the hash won
  });

  it('redirects retired #tune / #metrics hashes to Insights (WS3a)', () => {
    location.hash = '#tune';
    render(<WorkspaceShell header={null} content={{ insights: <div>INSIGHTS</div> }} legacyBridge={bridge} />);
    expect(screen.getByText('INSIGHTS')).toBeInTheDocument();
  });
});
