/** Structural client type — matches GithubClient.restGet without importing it. */
export interface DeployClient {
  restGet<T = unknown>(path: string): Promise<T>;
}

/** A single GitHub deployment record, normalised from the REST response. */
export interface DeploymentRec {
  id: number;
  environment: string;
  sha: string;
  createdAt: string;
}

/**
 * Returns the list of environment names configured for a repository.
 * Tolerates a missing/oddly-shaped body — returns [] in that case.
 * Does NOT catch RateLimitError/HttpError; let them propagate.
 */
export async function fetchEnvironments(
  client: DeployClient,
  repo: string,
): Promise<string[]> {
  const body = await client.restGet<unknown>(`/repos/${repo}/environments`);
  if (body == null || typeof body !== 'object') return [];
  const envs = (body as Record<string, unknown>).environments;
  if (!Array.isArray(envs)) return [];
  return envs
    .map((e: unknown) =>
      e != null && typeof e === 'object' ? (e as Record<string, unknown>).name : undefined,
    )
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/**
 * Returns up to `perPage` recent deployments for a repository.
 * Items that are missing a numeric id, string environment, string sha, or
 * string created_at are silently skipped.
 * Does NOT catch RateLimitError/HttpError; let them propagate.
 */
export async function fetchRecentDeployments(
  client: DeployClient,
  repo: string,
  perPage = 30,
): Promise<DeploymentRec[]> {
  const body = await client.restGet<unknown>(
    `/repos/${repo}/deployments?per_page=${perPage}`,
  );
  if (!Array.isArray(body)) return [];
  const results: DeploymentRec[] = [];
  for (const item of body) {
    if (item == null || typeof item !== 'object') continue;
    const { id, environment, sha, created_at } = item as Record<string, unknown>;
    if (typeof id !== 'number') continue;
    if (typeof environment !== 'string') continue;
    if (typeof sha !== 'string') continue;
    if (typeof created_at !== 'string') continue;
    results.push({ id, environment, sha, createdAt: created_at });
  }
  return results;
}

/**
 * Returns the most recent deployment status for a specific deployment, or
 * null if there are no statuses or the response is malformed.
 * Does NOT catch RateLimitError/HttpError; let them propagate.
 */
export async function fetchDeploymentState(
  client: DeployClient,
  repo: string,
  id: number,
): Promise<{ state: string; createdAt: string } | null> {
  const body = await client.restGet<unknown>(
    `/repos/${repo}/deployments/${id}/statuses?per_page=1`,
  );
  if (!Array.isArray(body) || body.length === 0) return null;
  const item = body[0];
  if (item == null || typeof item !== 'object') return null;
  const { state, created_at } = item as Record<string, unknown>;
  if (typeof state !== 'string') return null;
  if (typeof created_at !== 'string') return null;
  return { state, createdAt: created_at };
}
