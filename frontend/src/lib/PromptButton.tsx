// One affordance for "copy an AI prompt", used next to every Draft-PR button and
// as the single home for the copy-to-clipboard + confirmation that was previously
// re-implemented inline in three drawers. The confirmation is TRUTHFUL: it only
// says "✓ Copied!" when the write actually succeeded, and on failure it reveals the
// prompt text so the user can select-and-copy by hand (it's never a dead end).
import { useState } from 'react';

/** Copy `text`, returning whether it actually landed on the clipboard. Tries the
 *  async Clipboard API (needs a SECURE context — https or localhost), then falls
 *  back to a hidden-textarea `execCommand('copy')` which works over plain http on a
 *  LAN/Tailscale host and in older browsers. Returns false only when both fail
 *  (e.g. the write happens after an await, so the user-gesture activation is gone). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* secure-context write refused — fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/** Where the copied prompt is meant to go — shown above the revealed text. */
export const AI_PROMPT_CAPTION = 'Paste into Claude Code (or another AI coding agent):';

export interface PromptButtonProps {
  /** Build the prompt text on click — string (sync) or Promise<string> (async). */
  getText: () => string | Promise<string>;
  label?: string;
  className?: string;
  testId?: string;
  /** Always render the built prompt in a panel below the button (default true).
   *  Even when false, a COPY FAILURE still reveals it so the text is never lost. */
  showPrompt?: boolean;
  promptClassName?: string;
  promptTestId?: string;
}

type Status = 'idle' | 'copied' | 'failed';

export function PromptButton({
  getText, label = 'Copy AI prompt', className = 'cc-prompt-btn',
  testId, showPrompt = true, promptClassName = 'cc-prompt', promptTestId,
}: PromptButtonProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);

  const settle = async (t: string) => {
    setText(t);
    const ok = await copyToClipboard(t);
    setStatus(ok ? 'copied' : 'failed');
    if (ok) window.setTimeout(() => setStatus('idle'), 2000);
  };

  const onClick = () => {
    setStatus('idle');
    const result = getText();
    if (typeof result === 'string') { void settle(result); return; }
    setBusy(true);
    result
      .then(settle)
      .catch(() => { setText('Couldn’t build the prompt — try again.'); setStatus('failed'); })
      .finally(() => setBusy(false));
  };

  // Reveal the text whenever the surface opts in, OR whenever copy failed — so a
  // failed auto-copy degrades to a visible, hand-copyable prompt rather than nothing.
  const reveal = text != null && (showPrompt || status === 'failed');
  const btnLabel = busy ? 'Building…'
    : status === 'copied' ? '✓ Copied!'
    : status === 'failed' ? 'Couldn’t copy — select below ↓'
    : label;

  return (
    <>
      <button type="button" className={`${className}${status === 'copied' ? ' is-copied' : ''}`}
        data-testid={testId} data-status={status} disabled={busy} aria-live="polite" onClick={onClick}>
        {btnLabel}
      </button>
      {reveal && (
        <div className="cc-prompt-panel">
          <p className="cc-prompt-caption" aria-hidden="true">✨ {AI_PROMPT_CAPTION}</p>
          <pre className={promptClassName} data-testid={promptTestId} aria-label="AI prompt">{text}</pre>
        </div>
      )}
    </>
  );
}
