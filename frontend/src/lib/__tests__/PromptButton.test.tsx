import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromptButton } from '../PromptButton';

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  document.execCommand = (() => true) as typeof document.execCommand;
});

describe('PromptButton', () => {
  it('a SYNC getText copies and confirms with a truthful "Copied" only after the write lands', async () => {
    render(<PromptButton getText={() => 'PROMPT-TEXT'} testId="b" />);
    const btn = screen.getByTestId('b');
    expect(btn.textContent).toMatch(/Copy AI prompt/);
    fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toMatch(/Copied/));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('PROMPT-TEXT');
    expect(btn).toHaveAttribute('data-status', 'copied');
  });

  it('renders the prompt text in a <pre> when showPrompt (default)', async () => {
    render(<PromptButton getText={() => 'HELLO'} testId="b" promptTestId="p" />);
    fireEvent.click(screen.getByTestId('b'));
    expect(await screen.findByTestId('p')).toHaveTextContent('HELLO');
  });

  it('does not render a <pre> when showPrompt is false AND the copy succeeds', async () => {
    render(<PromptButton getText={() => 'HELLO'} testId="b" promptTestId="p" showPrompt={false} />);
    fireEvent.click(screen.getByTestId('b'));
    await waitFor(() => expect(screen.getByTestId('b')).toHaveAttribute('data-status', 'copied'));
    expect(screen.queryByTestId('p')).not.toBeInTheDocument();
  });

  it('on COPY FAILURE: reveals the prompt to copy by hand + a clear failure label (the empty-clipboard bug)', async () => {
    // simulate an insecure/Tailscale context: no async clipboard AND execCommand fails
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => { throw new Error('insecure'); }) } });
    document.execCommand = (() => false) as typeof document.execCommand;
    render(<PromptButton getText={() => 'THE-PROMPT'} testId="b" promptTestId="p" showPrompt={false} />);
    fireEvent.click(screen.getByTestId('b'));
    // even with showPrompt=false, the text is revealed so it's never lost
    expect(await screen.findByTestId('p')).toHaveTextContent('THE-PROMPT');
    expect(screen.getByTestId('b')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('b').textContent).toMatch(/select below/i);
  });

  it('an ASYNC getText shows Building… then the resolved prompt', async () => {
    render(<PromptButton getText={async () => 'ASYNC-PROMPT'} testId="b" promptTestId="p" />);
    fireEvent.click(screen.getByTestId('b'));
    expect(screen.getByTestId('b').textContent).toMatch(/Building/);
    expect(await screen.findByTestId('p')).toHaveTextContent('ASYNC-PROMPT');
  });

  it('honours a custom label', () => {
    render(<PromptButton getText={() => 'x'} label="Copy demote prompt" testId="b" />);
    expect(screen.getByTestId('b').textContent).toMatch(/Copy demote prompt/);
  });

  it('survives a rejected async getText (shows a fallback, clears busy)', async () => {
    render(<PromptButton getText={async () => { throw new Error('nope'); }} testId="b" promptTestId="p" />);
    fireEvent.click(screen.getByTestId('b'));
    await waitFor(() => expect(screen.getByTestId('b')).not.toBeDisabled());
    expect(screen.getByTestId('p').textContent?.toLowerCase()).toContain('prompt');
  });
});
