import { VERSION } from '../version.js';
import { stripTrailingSlashes } from '../util/trimEdges.js';

export interface RuntimeServerInfo {
  protocol: 'runtime/v1';
  version: string;
}

export type RuntimeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function trimBaseUrl(baseUrl: string): string {
  return stripTrailingSlashes(baseUrl.trim());
}

function majorMinor(version: string): string {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(version.trim());
  return match ? `${match[1]}.${match[2]}` : '';
}

function getFetch(fetchImpl?: RuntimeFetch): RuntimeFetch {
  const fn = fetchImpl ?? globalThis.fetch;
  if (!fn) throw new Error('No fetch implementation is available for runtime client requests');
  return fn.bind(globalThis) as RuntimeFetch;
}

export async function fetchRuntimeServerInfo(baseUrl: string, fetchImpl?: RuntimeFetch): Promise<RuntimeServerInfo> {
  const res = await getFetch(fetchImpl)(`${trimBaseUrl(baseUrl)}/runtime/v1/server_info`);
  if (!res.ok) throw new Error(`Runtime runner server_info failed with HTTP ${res.status}`);
  const body = await res.json() as Partial<RuntimeServerInfo>;
  if (body.protocol !== 'runtime/v1' || typeof body.version !== 'string' || !body.version.trim()) {
    throw new Error('Runtime runner returned an invalid server_info response');
  }
  return { protocol: body.protocol, version: body.version.trim() };
}

export async function assertRuntimeServerCompatible(
  baseUrl: string,
  options: { clientVersion?: string; fetch?: RuntimeFetch } = {},
): Promise<RuntimeServerInfo> {
  const info = await fetchRuntimeServerInfo(baseUrl, options.fetch);
  const clientVersion = options.clientVersion ?? VERSION;
  const clientMinor = majorMinor(clientVersion);
  const serverMinor = majorMinor(info.version);
  if (!clientMinor || !serverMinor || clientMinor !== serverMinor) {
    throw new Error(
      `Runtime runner version mismatch: client ${clientVersion} is not compatible with runner ${info.version}. ` +
      'Use matching BrainRouter major/minor versions for local and remote runtimes.',
    );
  }
  return info;
}
