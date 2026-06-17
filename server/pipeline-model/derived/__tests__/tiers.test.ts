import { describe, it, expect } from 'vitest';
import { KINDASH_TIERS, tierForEvent } from '../tiers';

describe('tiers', () => {
  it('maps the four v1 GHA events to tiers in order', () => {
    expect(KINDASH_TIERS.map((t) => t.id)).toEqual(['pr', 'queue', 'main', 'nightly']);
    expect(KINDASH_TIERS.map((t) => t.event)).toEqual(['pull_request', 'merge_group', 'push', 'schedule']);
  });
  it('tierForEvent resolves a known event and returns null for an unknown one', () => {
    expect(tierForEvent('merge_group')!.id).toBe('queue');
    expect(tierForEvent('workflow_dispatch')).toBeNull();
  });
});
