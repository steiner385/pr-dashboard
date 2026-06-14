import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Responsive-layout regression guard (mobile audit). jsdom can't measure
 * layout/overflow, so the live device verification (Playwright at 390px / 360px,
 * every tab horizontal-overflow-free) is manual. This test is the committed CI
 * backstop: it asserts the phone breakpoint and each specific overflow fix still
 * exist in styles.css, so the mobile responsiveness can't be silently removed.
 * (vitest stubs CSS imports to empty, so read the file from disk.)
 */
const css = ((): string => {
  for (const p of ['frontend/src/styles.css', 'src/styles.css']) {
    try { return readFileSync(resolve(process.cwd(), p), 'utf8'); } catch { /* try next */ }
  }
  throw new Error('styles.css not found from cwd ' + process.cwd());
})();

/** Brace-balanced extraction of every @media block (CSS nests braces). */
function mediaBlocks(src: string): { cond: string; body: string }[] {
  const out: { cond: string; body: string }[] = [];
  const re = /@media([^{]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push({ cond: m[1], body: src.slice(start, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

describe('responsive layout guard (mobile)', () => {
  // A phone breakpoint = a max-width at/under 768px (kiosk lives at 768–1023 and
  // must NOT be hit by these rules).
  const phoneBlocks = mediaBlocks(css)
    .filter((b) => {
      const mw = /max-width:\s*(\d+)px/.exec(b.cond);
      return mw != null && Number(mw[1]) <= 768;
    });
  const phoneCss = phoneBlocks.map((b) => b.body).join('\n');

  it('defines a phone breakpoint below the kiosk range', () => {
    expect(phoneBlocks.length).toBeGreaterThan(0);
  });

  it('keeps wide metric tables scrolling within their own box (not widening the page)', () => {
    expect(phoneCss).toMatch(/\.metric-table[^{}]*\{[^}]*overflow-x:\s*auto/);
  });

  it('lets the cost runner-minute rows flex down instead of overflowing', () => {
    expect(phoneCss).toMatch(/\.cost-pool/);
    expect(phoneCss).toMatch(/\.cost-pool-instance/);
  });

  it('shrinks / scrolls the metro stage track so a long pipeline fits', () => {
    expect(phoneCss).toMatch(/\.track[^{}]*\{[^}]*overflow-x:\s*auto/);
    expect(phoneCss).toMatch(/\.node\b/);
  });
});
