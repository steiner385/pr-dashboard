import { describe, it, expect } from 'vitest';
import {
  fetchEnvironments,
  fetchRecentDeployments,
  fetchDeploymentState,
  type DeployClient,
  type DeploymentRec,
} from '../github-deploy';

/** Minimal fake client: restGet returns the canned value for the matching path prefix */
function makeClient(responses: Map<string, unknown>): DeployClient {
  return {
    async restGet<T = unknown>(path: string): Promise<T> {
      for (const [key, val] of responses) {
        if (path.startsWith(key) || path === key) return val as T;
      }
      throw new Error(`No canned response for path: ${path}`);
    },
  };
}

// ---------------------------------------------------------------------------
// fetchEnvironments
// ---------------------------------------------------------------------------

describe('fetchEnvironments', () => {
  it('returns environment names from a well-formed body', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/environments',
        { environments: [{ name: 'production' }, { name: 'staging' }] },
      ]]),
    );
    const envs = await fetchEnvironments(client, 'owner/repo');
    expect(envs).toEqual(['production', 'staging']);
  });

  it('returns [] when the body has no environments field', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/environments', {}]]),
    );
    const envs = await fetchEnvironments(client, 'owner/repo');
    expect(envs).toEqual([]);
  });

  it('filters out empty-string environment names', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/environments',
        { environments: [{ name: '' }, { name: 'production' }] },
      ]]),
    );
    const envs = await fetchEnvironments(client, 'owner/repo');
    expect(envs).toEqual(['production']);
  });

  it('returns [] when the body is completely missing (undefined)', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/environments', undefined]]),
    );
    const envs = await fetchEnvironments(client, 'owner/repo');
    expect(envs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchRecentDeployments
// ---------------------------------------------------------------------------

describe('fetchRecentDeployments', () => {
  it('maps well-formed items to DeploymentRec[]', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 1, environment: 'production', sha: 'abc123', created_at: '2024-01-01T00:00:00Z' },
          { id: 2, environment: 'staging',    sha: 'def456', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(2);
    expect(recs[0]).toEqual<DeploymentRec>({
      id: 1,
      environment: 'production',
      sha: 'abc123',
      createdAt: '2024-01-01T00:00:00Z',
    });
    expect(recs[1]).toEqual<DeploymentRec>({
      id: 2,
      environment: 'staging',
      sha: 'def456',
      createdAt: '2024-01-02T00:00:00Z',
    });
  });

  it('skips an item missing sha', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 1, environment: 'production', created_at: '2024-01-01T00:00:00Z' }, // missing sha
          { id: 2, environment: 'staging', sha: 'abc', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(2);
  });

  it('skips an item missing a numeric id', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 'not-a-number', environment: 'production', sha: 'abc', created_at: '2024-01-01T00:00:00Z' },
          { id: 3, environment: 'staging', sha: 'def', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(3);
  });

  it('skips an item missing environment', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 4, sha: 'abc', created_at: '2024-01-01T00:00:00Z' }, // missing environment
          { id: 5, environment: 'staging', sha: 'def', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(5);
  });

  it('skips an item missing created_at', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 6, environment: 'production', sha: 'abc' }, // missing created_at
          { id: 7, environment: 'staging', sha: 'def', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(7);
  });

  it('passes the correct per_page query parameter', async () => {
    let capturedPath = '';
    const client: DeployClient = {
      async restGet<T>(path: string): Promise<T> {
        capturedPath = path;
        return [] as T;
      },
    };
    await fetchRecentDeployments(client, 'owner/repo', 50);
    expect(capturedPath).toContain('per_page=50');
  });

  it('returns [] when the response is not an array', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/deployments', { message: 'Not Found' }]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchDeploymentState
// ---------------------------------------------------------------------------

describe('fetchDeploymentState', () => {
  it('returns the state and createdAt of the first (newest) status', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments/42/statuses',
        [{ state: 'success', created_at: '2024-01-03T00:00:00Z' }],
      ]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toEqual({ state: 'success', createdAt: '2024-01-03T00:00:00Z' });
  });

  it('returns null when the statuses array is empty', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/deployments/42/statuses', []]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toBeNull();
  });

  it('returns null when the response is not an array', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/deployments/42/statuses', null]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toBeNull();
  });

  it('returns null when the first item is missing state', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments/42/statuses',
        [{ created_at: '2024-01-03T00:00:00Z' }],
      ]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toBeNull();
  });

  it('returns null when the first item is missing created_at', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments/42/statuses',
        [{ state: 'success' }],
      ]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toBeNull();
  });

  it('passes per_page=1 in the path', async () => {
    let capturedPath = '';
    const client: DeployClient = {
      async restGet<T>(path: string): Promise<T> {
        capturedPath = path;
        return [] as T;
      },
    };
    await fetchDeploymentState(client, 'owner/repo', 99);
    expect(capturedPath).toContain('per_page=1');
  });
});
