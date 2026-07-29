import { loadOrInitConfig } from '@kinqs/brainrouter-core/config';

export interface AccountApiTarget {
  baseUrl: string;
  apiKey: string;
}

export class AccountApiHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AccountApiHttpError';
  }
}

/** Resolve the active hosted profile into the account REST API binding. */
export function resolveAccountApiTarget(): AccountApiTarget | { error: string } {
  const config = loadOrInitConfig();
  const active = config.activeServer;
  const server = active ? config.servers?.[active] : undefined;
  if (!server || server.type !== 'http' || !('url' in server) || !server.url) {
    return { error: 'No hosted BrainRouter server is configured. Run `brainrouter login` to connect to one first.' };
  }
  const baseUrl = String(server.url).replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  const apiKey = String(('apiKey' in server && server.apiKey) || '');
  if (!apiKey) return { error: 'Your BrainRouter profile has no API key. Re-run `brainrouter login`.' };
  return { baseUrl, apiKey };
}

function errorMessage(body: unknown, status: number): string {
  const value = body as { error?: unknown } | null;
  return typeof value?.error === 'string' && value.error
    ? value.error
    : `HTTP ${status}`;
}

/** Shared authenticated account request path for CLI feature clients. */
export async function accountApiRequest<T>(
  target: AccountApiTarget,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(`${target.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new AccountApiHttpError(response.status, errorMessage(json, response.status));
  }
  return json as T;
}
