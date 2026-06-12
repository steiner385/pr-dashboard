import { describe, it, expect } from 'vitest';
import { diffCiGraphs } from '../workflow-impact';
import { deriveCiGraph } from '../required-checks';

/** Realistic fixtures: graphs derived from actual workflow YAML, exactly the
 *  shapes the poller diffs at detail-fetch time (issue #49). */
const BASE_YML = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
  mobile-checks:
    uses: ./.github/workflows/mobile.yml
  ci:
    needs: [build, mobile-checks]
    runs-on: ubuntu-latest
`;
const base = () => deriveCiGraph(BASE_YML)!;

describe('diffCiGraphs (issue #49)', () => {
  it('identical graphs → null (no card, no badge noise)', () => {
    expect(diffCiGraphs(base(), deriveCiGraph(BASE_YML)!)).toBeNull();
  });

  it('job added to the rollup closure → joins line + set-grows line', () => {
    const head = deriveCiGraph(`
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
  mobile-checks:
    uses: ./.github/workflows/mobile.yml
  android-smoke:
    runs-on: ubuntu-latest
  ci:
    needs: [build, mobile-checks, android-smoke]
    runs-on: ubuntu-latest
`)!;
    expect(diffCiGraphs(base(), head)!.summary).toEqual([
      '+ android-smoke joins the merge_group gate',
      'required-check set grows by 1: 3 → 4 checks',
    ]);
  });

  it('job removed from the closure → leaves line + set-shrinks line', () => {
    const head = deriveCiGraph(`
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
  mobile-checks:
    uses: ./.github/workflows/mobile.yml
  ci:
    needs: [build]
    runs-on: ubuntu-latest
`)!;
    expect(diffCiGraphs(base(), head)!.summary).toEqual([
      '− mobile-checks / leaves the merge_group gate',
      'required-check set shrinks by 1: 3 → 2 checks',
    ]);
  });

  it('timeout change only → one timeout line, no size-delta line', () => {
    const head = deriveCiGraph(BASE_YML.replace('timeout-minutes: 30', 'timeout-minutes: 45'))!;
    expect(diffCiGraphs(base(), head)!.summary).toEqual([
      'build timeout-minutes 30m → 45m',
    ]);
  });

  it('timeout removed reads as unset (the 360m GitHub default applies)', () => {
    const head = deriveCiGraph(BASE_YML.replace('    timeout-minutes: 30\n', ''))!;
    expect(diffCiGraphs(base(), head)!.summary).toEqual([
      'build timeout-minutes 30m → unset',
    ]);
  });

  it('swap (add one, remove one) → both job lines, no size-delta line', () => {
    const head = deriveCiGraph(`
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
  android-smoke:
    runs-on: ubuntu-latest
  ci:
    needs: [build, android-smoke]
    runs-on: ubuntu-latest
`)!;
    expect(diffCiGraphs(base(), head)!.summary).toEqual([
      '+ android-smoke joins the merge_group gate',
      '− mobile-checks / leaves the merge_group gate',
    ]);
  });
});
