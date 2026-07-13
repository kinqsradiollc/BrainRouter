import { describe, expect, it, vi } from 'vitest';
import { probeGithubConnection } from './githubConnection.js';

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('probeGithubConnection', () => {
  it('returns the authenticated GitHub login without exposing the token', async () => {
    const fetchImpl = vi.fn(async () => response(200, { login: 'octocat' }));
    await expect(probeGithubConnection('sealed-provider-token', fetchImpl)).resolves.toEqual({
      connected: true,
      login: 'octocat',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sealed-provider-token' }),
    }));
  });

  it('turns a stored but expired token into a reconnect state', async () => {
    await expect(probeGithubConnection('expired', async () => response(401, {}))).resolves.toEqual({
      connected: false,
      error: 'GitHub authorization expired or was revoked. Reconnect GitHub.',
    });
  });

  it('keeps temporary connection failures explicit', async () => {
    await expect(probeGithubConnection('token', async () => { throw new Error('offline'); })).resolves.toEqual({
      connected: false,
      error: 'GitHub connection check could not reach GitHub.',
    });
  });
});
