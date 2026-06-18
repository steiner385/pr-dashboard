import { describe, it, expect } from 'vitest';
import { suggestRequiredPrefixes } from '../required-prefixes';

describe('suggestRequiredPrefixes (roadmap 4.5 — the requiredCheckPrefixes lever)', () => {
  it('extracts the reusable-workflow caller segment (before " / ")', () => {
    expect(suggestRequiredPrefixes([
      'static-checks / test: unit (1/8)',
      'static-checks / types: tsc',
      'build / build: production',
    ])).toEqual(['build', 'static-checks']); // deduped to distinct callers
  });

  it('falls back to the job name before ": " for top-level jobs', () => {
    expect(suggestRequiredPrefixes(['setup: prepare', 'setup: changed-scope', 'lint: e2e floor manifest']))
      .toEqual(['lint', 'setup']);
  });

  it('keeps a plain name with no separators whole', () => {
    expect(suggestRequiredPrefixes(['ci', 'deploy'])).toEqual(['ci', 'deploy']);
  });

  it('ignores blank/whitespace names and dedupes + sorts', () => {
    expect(suggestRequiredPrefixes(['  ', '', 'build / a', 'build / b', 'apex / x'])).toEqual(['apex', 'build']);
  });

  it('returns [] for no checks', () => {
    expect(suggestRequiredPrefixes([])).toEqual([]);
  });
});
