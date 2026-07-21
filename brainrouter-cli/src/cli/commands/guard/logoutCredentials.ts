/**
 * BrainRouter logout credential removal and its durable commit boundary.
 * Transport credentials can live in legacy HTTP headers, stdio env/arguments,
 * or the first-class apiKey field; every location is cleared as one atomic
 * config update, and a failed write restores the exact prior object graph.
 */
import {
  saveConfigOrThrow,
  type Config,
  type LLMConfig,
  type ServerConfig,
} from '@kinqs/brainrouter-core/config';
import {
  containsObviousCredentialValue,
  isSensitiveCredentialName,
  stripMcpStdioCredentials,
} from '../../mcpUrl.js';
import type { RuntimeMcpState } from '../../../entry/mcpStartup.js';

interface ClearedCredentialMap {
  entries: Record<string, string>;
  removed: string[];
}

export interface ClearedBrainrouterCredentials {
  server: ServerConfig;
  llm?: LLMConfig;
  removed: string[];
}

/** Preserve runtime selectors/peers while replacing one launch-cloned profile. */
export function replaceLoggedOutRuntimeProfile(
  runtimeMcp: RuntimeMcpState | undefined,
  profile: string,
  server: ServerConfig,
): RuntimeMcpState | undefined {
  if (!runtimeMcp?.servers[profile]) return runtimeMcp;
  return {
    ...runtimeMcp,
    servers: {
      ...runtimeMcp.servers,
      [profile]: server,
    },
  };
}

function clearCredentialMap(
  entries: Record<string, string> | undefined,
  prefix: 'server.headers' | 'server.env',
): ClearedCredentialMap | undefined {
  if (!entries) return undefined;
  const kept: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(entries)) {
    const credentialValue = /^Bearer\s+\S+/i.test(value)
      || containsObviousCredentialValue(value);
    if (isSensitiveCredentialName(name) || credentialValue) {
      removed.push(`${prefix}.${name}`);
    } else {
      kept[name] = value;
    }
  }
  return { entries: kept, removed };
}

/** Pure projection of a profile and base LLM config into their logged-out form. */
export function clearBrainrouterCredentials(
  server: ServerConfig,
  llm: LLMConfig | undefined,
): ClearedBrainrouterCredentials {
  const nextServer: ServerConfig = { ...server };
  const removed: string[] = [];

  if (Object.prototype.hasOwnProperty.call(nextServer, 'apiKey')) {
    const hadApiKey = Boolean(nextServer.apiKey);
    delete nextServer.apiKey;
    if (hadApiKey) removed.push('server.apiKey');
  }

  const headers = clearCredentialMap(server.headers, 'server.headers');
  if (headers?.removed.length) {
    nextServer.headers = headers.entries;
    removed.push(...headers.removed);
  }

  const env = clearCredentialMap(server.env, 'server.env');
  if (env?.removed.length) {
    nextServer.env = env.entries;
    removed.push(...env.removed);
  }

  if (server.type === 'stdio' && server.args) {
    const args = stripMcpStdioCredentials(server.args);
    if (args.length !== server.args.length || args.some((argument, index) => argument !== server.args?.[index])) {
      nextServer.args = args;
      removed.push('server.args');
    }
  }

  let nextLlm = llm;
  if (llm?.apiKey) {
    nextLlm = { ...llm, apiKey: '' };
    removed.push('llm.apiKey');
  }

  return { server: nextServer, llm: nextLlm, removed };
}

/**
 * Persist the complete logged-out projection as one update. Replacing whole
 * records keeps rollback exact even when maps or argument arrays contain values
 * this version does not understand.
 */
export function persistBrainrouterLogout(
  config: Config,
  profile: string,
  persist: (next: Config) => void = saveConfigOrThrow,
): string[] {
  const previousServer = config.servers[profile];
  const hadLlm = Object.prototype.hasOwnProperty.call(config, 'llm');
  const previousLlm = config.llm;
  const cleared: { server?: ServerConfig; llm?: LLMConfig; removed: string[] } = previousServer
    ? clearBrainrouterCredentials(previousServer, previousLlm)
    : {
        llm: previousLlm?.apiKey ? { ...previousLlm, apiKey: '' } : previousLlm,
        removed: previousLlm?.apiKey ? ['llm.apiKey'] : [],
      };
  if (cleared.removed.length === 0) return [];

  if (previousServer && cleared.server) config.servers[profile] = cleared.server;
  if (hadLlm) config.llm = cleared.llm;
  try {
    persist(config);
  } catch (error) {
    if (previousServer) config.servers[profile] = previousServer;
    else delete config.servers[profile];
    if (hadLlm) config.llm = previousLlm;
    else delete config.llm;
    throw error;
  }
  return cleared.removed;
}
