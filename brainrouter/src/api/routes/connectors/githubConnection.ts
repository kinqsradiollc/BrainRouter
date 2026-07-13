export interface GithubConnectionProbe {
  connected: boolean;
  login?: string;
  error?: string;
}

type GithubProbeResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type GithubProbeFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<GithubProbeResponse>;

/** Token presence is not connection health. Probe the authenticated identity so
 * expired/revoked GitHub authorizations become a reconnect state before sync. */
export async function probeGithubConnection(
  accessToken: string,
  fetchImpl: GithubProbeFetch = globalThis.fetch as unknown as GithubProbeFetch,
): Promise<GithubConnectionProbe> {
  const token = accessToken.trim();
  if (!token) return { connected: false };
  try {
    const response = await fetchImpl('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      return {
        connected: false,
        error: response.status === 401
          ? 'GitHub authorization expired or was revoked. Reconnect GitHub.'
          : `GitHub connection check failed (HTTP ${response.status}).`,
      };
    }
    const body = await response.json() as { login?: unknown };
    const login = typeof body?.login === 'string' ? body.login.trim() : '';
    return { connected: true, ...(login ? { login } : {}) };
  } catch {
    return { connected: false, error: 'GitHub connection check could not reach GitHub.' };
  }
}
