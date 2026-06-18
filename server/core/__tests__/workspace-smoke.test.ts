// Verifies the PURE pass/fail logic of the boot-smoke harness (the live fetch
// runner needs a running server + token — run by the operator, see the script header).
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, imported for its pure export
import { summarize } from '../../../scripts/workspace-smoke.mjs';

describe('workspace-smoke summarize (pure)', () => {
  it('passes when every probe is ok', () => {
    const s = summarize([{ name: 'a', ok: true, detail: 'x' }, { name: 'b', ok: true, detail: 'y' }]);
    expect(s).toMatchObject({ pass: true, total: 2, failed: 0 });
    expect(s.lines[0]).toMatch(/^✓ a/);
  });

  it('fails and counts failures when any probe is not ok', () => {
    const s = summarize([{ name: 'a', ok: true, detail: 'x' }, { name: 'b', ok: false, detail: 'boom' }]);
    expect(s).toMatchObject({ pass: false, total: 2, failed: 1 });
    expect(s.lines[1]).toBe('✗ b — boom');
  });

  it('an empty probe set is a vacuous pass', () => {
    expect(summarize([])).toMatchObject({ pass: true, total: 0, failed: 0 });
  });
});
