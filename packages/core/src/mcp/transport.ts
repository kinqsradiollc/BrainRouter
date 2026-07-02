import fs from 'node:fs';
import path from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LLMConfig, ServerConfig } from '../config/config.js';

/**
 * Transport construction for {@link McpClientWrapper}.
 *
 * Building the stdio child's environment (CLI-var filtering, LLM-credential
 * propagation, cwd hinting) and the HTTP transport's auth headers is the bulk
 * of the connect path, so it lives here as focused pure-ish builders. Each
 * returns a ready transport; the wrapper owns `client.connect` + the
 * `connected` flag.
 */

/**
 * Build the stdio transport for a `type: 'stdio'` server config. Merges the
 * child environment safely and hints cwd at the MCP package dir so its
 * `dotenv/config` finds the canonical `.env`.
 */
export function buildStdioTransport(
  serverConfig: ServerConfig,
  llmConfig?: LLMConfig,
): StdioClientTransport {
  if (!serverConfig.command) {
    throw new Error('Stdio server configuration missing "command".');
  }

  // Merge environment variables safely. The CLI and MCP server have
  // separate `.env` files (brainrouter-cli/.env vs brainrouter/.env); we
  // do NOT want CLI-specific knobs (sandbox, tool-loop limit, web search
  // backend) leaking into the MCP child, and we do NOT want
  // process-specific vars where each side wants its own default (e.g.
  // LLM_MAX_CONCURRENT defaults to 4 in the CLI and 2 in the MCP). The
  // MCP child's own `dotenv/config` will load brainrouter/.env via the
  // cwd hint below, so those vars come in from the right source.
  const CLI_ONLY_VARS = new Set([
    'BRAINROUTER_MCP_TIMEOUT_MS',
    'BRAINROUTER_MAX_TOOL_RESULT_CHARS',
    'BRAINROUTER_AUTO_COMPACT_TOKENS',
    'BRAINROUTER_MAX_TOOL_LOOPS',
    'BRAINROUTER_TRACE_LOG',
    'BRAINROUTER_SANDBOX',
    'BRAINROUTER_SANDBOX_NETWORK',
    'BRAINROUTER_SANDBOX_READ_PATHS',
    'BRAINROUTER_SANDBOX_WRITE_PATHS',
    'BRAINROUTER_WEB_SEARCH_ENDPOINT',
  ]);
  // Process-specific: same var name, but each process has its own
  // semantic / default. Don't propagate — let brainrouter/.env decide.
  const PROCESS_SPECIFIC_VARS = new Set([
    'BRAINROUTER_LLM_MAX_CONCURRENT',
    'BRAINROUTER_LLM_TIMEOUT_MS',
  ]);
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (CLI_ONLY_VARS.has(k)) continue;
    if (PROCESS_SPECIFIC_VARS.has(k)) continue;
    mergedEnv[k] = v;
  }
  if (serverConfig.env) {
    for (const [k, v] of Object.entries(serverConfig.env)) {
      if (v !== undefined) {
        // If the shell process environment has a valid key, do not overwrite it with the default config placeholder.
        if (k === 'BRAINROUTER_API_KEY' && process.env.BRAINROUTER_API_KEY && v === 'br_admin_key_placeholder') {
          continue;
        }
        mergedEnv[k] = v;
      }
    }
  }

  // Auto-propagate the CLI's configured LLM settings to the MCP child so
  // server-side memory extraction can share the same credentials/endpoint/model.
  // Existing env vars always win — explicit shell config beats CLI defaults.
  //
  // Critical: when only `OPENAI_API_KEY` is set in the user's shell (which
  // the CLI itself accepts as a fallback in callOpenAI), the MCP child
  // inherits nothing — its cognitive extractor then silently disables,
  // sensory rows pile up, the cognitive table stays empty, and every
  // future recall returns 0 records. The fallback chain below makes the
  // MCP child see whatever credential the CLI itself would have used.
  // API-key resolution must use truthy checks, not `??`. The config file
  // ships with `llm.apiKey: ''` by default — an empty string — and `??`
  // only falls back on null/undefined. The earlier `??` form let the
  // empty config string beat the OPENAI_API_KEY env fallback, leaving
  // the MCP child with no credential, which silently disabled cognitive
  // extraction. Sensory captures still landed, so the CLI happily
  // emitted "💾 Captured turn" while 79 extractions failed in the
  // background. (Verified against scheduler_state.extraction_errors.)
  if (!mergedEnv.BRAINROUTER_LLM_API_KEY) {
    const apiKey =
      (llmConfig?.apiKey && llmConfig.apiKey.trim()) ||
      process.env.OPENAI_API_KEY ||
      process.env.BRAINROUTER_LLM_API_KEY;
    if (apiKey) {
      mergedEnv.BRAINROUTER_LLM_API_KEY = apiKey;
    }
  }
  if (llmConfig?.endpoint && !mergedEnv.BRAINROUTER_LLM_ENDPOINT) {
    const ep = llmConfig.endpoint.replace(/\/$/, '');
    mergedEnv.BRAINROUTER_LLM_ENDPOINT = ep.endsWith('/chat/completions')
      ? ep
      : `${ep}/chat/completions`;
  }
  if (llmConfig?.model && !mergedEnv.BRAINROUTER_LLM_MODEL) {
    mergedEnv.BRAINROUTER_LLM_MODEL = llmConfig.model;
  }
  // (Previously: a loud console.warn here if no LLM API key reached the
  // MCP child. That message landed above the Ink banner and looked like a
  // CLI error even though it was a server-side concern. Server-side
  // extraction failures should surface through MCP's own status channel —
  // not by the CLI second-guessing what the server needs.)

  // Spawn the MCP child with cwd set to the MCP package directory if we
  // can find it from the first arg (typically
  // `node /path/to/BrainRouter/brainrouter/dist/index.js`). The child
  // uses `import "dotenv/config"` which resolves `.env` relative to
  // `process.cwd()` — defaulting to the user's launch dir meant
  // `brainrouter/.env` was never read. With cwd hinted, dotenv finds
  // the canonical config without the user having to copy/symlink files.
  const firstArg = serverConfig.args?.[0];
  let childCwd: string | undefined;
  if (firstArg && firstArg.endsWith('.js')) {
    try {
      // brainrouter/dist/index.js → brainrouter/
      const distDir = path.dirname(firstArg);
      const pkgRoot = path.resolve(distDir, '..');
      // Sanity: only set if the directory contains a `.env` or `package.json`
      // (avoid pointing the child at /usr/local/lib by accident).
      if (
        fs.existsSync(path.join(pkgRoot, '.env')) ||
        fs.existsSync(path.join(pkgRoot, 'package.json'))
      ) {
        childCwd = pkgRoot;
      }
    } catch {
      // Best-effort; if path resolution fails we just don't set cwd.
    }
  }

  return new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args ?? [],
    env: mergedEnv,
    cwd: childCwd,
    // The MCP child is a separate process with its own concerns (its own
    // dotenv, its own auth failures, its own platform warnings). Inheriting
    // its stderr meant every `[BrainRouter] FATAL …`, every dotenv banner,
    // every SQLite ExperimentalWarning leaked above our Ink chat banner
    // and looked like the CLI was crashing. Pipe it so the SDK owns the
    // stream; the CLI can surface a single graceful "MCP unreachable" line
    // through its own offline-mode flow instead.
    stderr: 'pipe',
  });
}

/**
 * Build the Streamable HTTP transport for a `type: 'http'` server config.
 * Applies configured headers and derives a Bearer `Authorization` from
 * `apiKey` when the caller didn't set one explicitly.
 */
export function buildHttpTransport(serverConfig: ServerConfig): StreamableHTTPClientTransport {
  if (!serverConfig.url) {
    throw new Error('HTTP server configuration missing "url".');
  }

  const url = new URL(serverConfig.url);
  const transportOpts: any = {};
  const headers: Record<string, string> = { ...(serverConfig.headers ?? {}) };

  if (serverConfig.apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${serverConfig.apiKey}`;
  }
  if (Object.keys(headers).length > 0) {
    transportOpts.requestInit = {
      headers,
    };
  }

  return new StreamableHTTPClientTransport(url, transportOpts);
}
