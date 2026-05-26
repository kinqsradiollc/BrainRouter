import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LLMConfig, ServerConfig } from '../config/config.js';

export class McpClientWrapper {
  public client: Client;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  /**
   * True only after a successful `connect()`. Lets the CLI run in a degraded
   * "offline" mode when the MCP server is unreachable at startup — `listTools`
   * returns an empty list and `callTool` returns an error envelope instead of
   * blowing up, which the agent's existing try/catch wrappers already handle.
   */
  private connected = false;
  /**
   * 10a: cached identity. Set once by `detectMcpIdentity` after the first
   * successful `listTools()` (or by `connect` if the config + URL gave us
   * a clear signal). The value drives status surfaces and the brain-offline
   * prompt swap — distinguishes "our brain went down" from "a random
   * third-party MCP went down" once item 11's multi-MCP support lands.
   */
  private identity: 'brainrouter' | 'third-party' | 'unknown' = 'unknown';
  private serverName?: string;

  constructor() {
    this.client = new Client(
      { name: 'brainrouter-cli', version: '0.3.8' },
      { capabilities: {} }
    );
  }

  /** Whether this wrapper has an active MCP transport. */
  public isConnected(): boolean {
    return this.connected;
  }

  /** 10a: who is this MCP? Set by `detectMcpIdentity`; 'unknown' before first list. */
  public getIdentity(): 'brainrouter' | 'third-party' | 'unknown' {
    return this.identity;
  }

  /** 10a: profile name passed at connect (`brainrouter` / `local-http` / etc.). */
  public getServerName(): string | undefined {
    return this.serverName;
  }

  /**
   * 10a: connect with an optional `name` so the wrapper can render identity
   * tags ("BrainRouter MCP offline" vs "third-party MCP offline") without
   * the caller threading it through every error path. The pre-10a single-
   * arg form remains supported — callers that don't pass a name fall back
   * to URL-pattern detection.
   */
  async connect(serverConfig: ServerConfig, llmConfig?: LLMConfig, name?: string): Promise<void> {
    this.serverName = name;
    // Resolve identity upfront from config metadata + name/URL patterns.
    // The tool-signature fallback (memory_recall + list_skills) runs after
    // the first successful `listTools` in `refreshIdentityFromTools`.
    this.identity = resolveIdentityFromConfig(serverConfig, name);
    return this._connect(serverConfig, llmConfig);
  }

  private async _connect(serverConfig: ServerConfig, llmConfig?: LLMConfig): Promise<void> {
    if (serverConfig.type === 'stdio') {
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

      this.transport = new StdioClientTransport({
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

      await this.client.connect(this.transport);
      this.connected = true;
    } else if (serverConfig.type === 'http') {
      if (!serverConfig.url) {
        throw new Error('HTTP server configuration missing "url".');
      }

      const url = new URL(serverConfig.url);
      const transportOpts: any = {};

      if (serverConfig.apiKey) {
        transportOpts.requestInit = {
          headers: {
            'Authorization': `Bearer ${serverConfig.apiKey}`,
          },
        };
      }

      const httpTransport = new StreamableHTTPClientTransport(url, transportOpts);
      this.transport = httpTransport;

      await this.client.connect(httpTransport);
      this.connected = true;
    } else {
      throw new Error(`Unsupported connection type: ${(serverConfig as any).type}`);
    }
  }

  async listTools() {
    // Offline mode: return an empty tool list so the agent's runTurn proceeds
    // with only local tools instead of crashing when it tries to enumerate.
    if (!this.connected) return { tools: [] };
    const res = await this.client.listTools({});
    // 10a: tool-signature fallback for identity detection. If the config +
    // URL didn't already pin the identity, the BrainRouter MCP exposes a
    // distinctive pair (`memory_recall` AND `list_skills`) that no neutral
    // third-party MCP will. Cache the result so the next list doesn't
    // re-probe — identity is stable for the lifetime of a connection.
    if (this.identity === 'unknown' && Array.isArray(res?.tools)) {
      const names = new Set(res.tools.map((t: any) => t?.name));
      if (names.has('memory_recall') && names.has('list_skills')) {
        this.identity = 'brainrouter';
      } else {
        this.identity = 'third-party';
      }
    }
    return res;
  }

  async callTool(name: string, args: Record<string, any>) {
    // Offline mode: synthesize an error envelope that downstream consumers
    // (callMcpTool, agent.captureTurn, memory_recall pipelines) already know
    // how to ignore via their existing isError checks. Without this the SDK
    // would throw "Not connected" from inside transport code, which surfaces
    // as a hard crash instead of a graceful degradation.
    if (!this.connected) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: `MCP server is not connected. Tool "${name}" is unavailable in offline mode. Start the BrainRouter MCP server and reconnect (or restart the CLI) to use memory, skills, and recall.`,
        }],
      };
    }
    // A hung MCP server used to hang the entire runTurn forever — there was
    // no per-tool timeout, and the LLM call timeout only fired between tool
    // rounds. Race the tool call against a configurable timeout so a flaky
    // child server can't lock up the whole CLI.
    const timeoutMs = Number(process.env.BRAINROUTER_MCP_TIMEOUT_MS) || 60_000;
    return Promise.race([
      this.client.callTool({ name, arguments: args }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`MCP tool "${name}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  async close(): Promise<void> {
    if (this.transport) {
      if (this.transport instanceof StreamableHTTPClientTransport) {
        try {
          await this.transport.terminateSession();
        } catch {
          // ignore session termination errors
        }
      }
      try {
        await this.transport.close();
      } catch {
        // ignore
      }
    }
    try {
      await this.client.close();
    } catch {
      // ignore
    }
    this.transport = null;
    this.connected = false;
  }
}

/**
 * 10a: figure out who an MCP profile belongs to from config metadata + name
 * + URL alone, before any network call. Explicit `identity` wins; otherwise
 * we check name prefix and URL host. Returns 'unknown' when nothing matches
 * — the caller (currently `listTools`) falls back to tool-signature
 * detection after the first successful enumeration.
 *
 * Detection cases:
 *   - explicit `identity: 'brainrouter'` or `identity: 'third-party'` → that.
 *   - profile name (case-insensitive) starts with `brainrouter` → brainrouter.
 *   - http URL hostname matches `*.brainrouter.cloud` / `*.brainrouter.dev`
 *     / `*.brainrouter.io` / `*.kinqs.brainrouter.*` → brainrouter.
 *   - stdio command basename matches `brainrouter` / `brainrouter-mcp` → brainrouter.
 *   - otherwise → unknown (let the tool-signature fallback decide).
 */
export function resolveIdentityFromConfig(
  serverConfig: ServerConfig,
  name?: string,
): 'brainrouter' | 'third-party' | 'unknown' {
  if (serverConfig.identity === 'brainrouter' || serverConfig.identity === 'third-party') {
    return serverConfig.identity;
  }
  if (name && /^brainrouter/i.test(name.trim())) {
    return 'brainrouter';
  }
  if (serverConfig.type === 'http' && serverConfig.url) {
    try {
      const url = new URL(serverConfig.url);
      if (/\.brainrouter\.(cloud|dev|io|com|app)$/i.test(url.hostname)) {
        return 'brainrouter';
      }
    } catch {
      // Malformed URL; let later code surface the connection error.
    }
  }
  if (serverConfig.type === 'stdio' && serverConfig.command) {
    const base = serverConfig.command.split(/[/\\]/).pop() ?? '';
    if (/^brainrouter(-mcp)?$/i.test(base)) {
      return 'brainrouter';
    }
  }
  return 'unknown';
}

