import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LLMConfig, ServerConfig } from '../config/config.js';
import { getCliKnobs } from '../config/config.js';
import { VERSION } from '../version.js';
import { isConnectivityError } from '../storage/checkpointStore.js';
import { reconnectBackoffMs } from './reconnect.js';
import type { McpIdentity } from './types.js';
import { resolveIdentityFromConfig } from './identity.js';
import { isSessionNotFoundError } from './sessionErrors.js';
import { buildHttpTransport, buildStdioTransport } from './transport.js';

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
  private identity: McpIdentity = 'unknown';
  private serverName?: string;
  /**
   * Stashed at `connect()` time so we can re-establish the transport
   * automatically when the Streamable HTTP server invalidates our
   * `mcp-session-id` (the classic case is the brain process
   * restarting while the CLI keeps running — every subsequent call
   * fails with "Session not found. Send a POST without
   * mcp-session-id to initialise" until we redial).
   */
  private lastServerConfig?: ServerConfig;
  private lastLlmConfig?: LLMConfig;

  constructor() {
    this.client = new Client(
      { name: 'brainrouter-cli', version: VERSION },
      { capabilities: {} }
    );
  }

  /** Whether this wrapper has an active MCP transport. */
  public isConnected(): boolean {
    return this.connected;
  }

  /** 10a: who is this MCP? Set by `detectMcpIdentity`; 'unknown' before first list. */
  public getIdentity(): McpIdentity {
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
    // Stash for the session-expiry auto-reconnect path in `callTool`.
    this.lastServerConfig = serverConfig;
    this.lastLlmConfig = llmConfig;
    return this._connect(serverConfig, llmConfig);
  }

  private async _connect(serverConfig: ServerConfig, llmConfig?: LLMConfig): Promise<void> {
    if (serverConfig.type === 'stdio') {
      this.transport = buildStdioTransport(serverConfig, llmConfig);
      await this.client.connect(this.transport);
      this.connected = true;
    } else if (serverConfig.type === 'http') {
      const httpTransport = buildHttpTransport(serverConfig);
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

  async listResources(params?: { cursor?: string; server?: string }, options?: { signal?: AbortSignal }) {
    // Single-wrapper mode has no server selector; the pool handles that layer.
    if (!this.connected) return { resources: [] };
    const timeoutMs = getCliKnobs().mcpTimeoutMs;
    const request = { ...(params?.cursor ? { cursor: params.cursor } : {}) };
    const invoke = () =>
      Promise.race([
        this.client.listResources(request, { signal: options?.signal, timeout: timeoutMs }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`MCP resources/list timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    try {
      return await invoke();
    } catch (err) {
      if (isSessionNotFoundError(err) && this.lastServerConfig) {
        await this.reinit();
        return await invoke();
      }
      throw err;
    }
  }

  async listResourceTemplates(params?: { cursor?: string; server?: string }, options?: { signal?: AbortSignal }) {
    // Single-wrapper mode has no server selector; the pool handles that layer.
    if (!this.connected) return { resourceTemplates: [] };
    const timeoutMs = getCliKnobs().mcpTimeoutMs;
    const request = { ...(params?.cursor ? { cursor: params.cursor } : {}) };
    const invoke = () =>
      Promise.race([
        this.client.listResourceTemplates(request, { signal: options?.signal, timeout: timeoutMs }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`MCP resources/templates/list timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    try {
      return await invoke();
    } catch (err) {
      if (isSessionNotFoundError(err) && this.lastServerConfig) {
        await this.reinit();
        return await invoke();
      }
      throw err;
    }
  }

  async readResource(params: { uri: string; server?: string }, options?: { signal?: AbortSignal }) {
    // Single-wrapper mode has no server selector; the pool handles that layer.
    if (!this.connected) {
      throw new Error(`MCP server is not connected. Resource "${params.uri}" is unavailable in offline mode.`);
    }
    const timeoutMs = getCliKnobs().mcpTimeoutMs;
    const invoke = () =>
      Promise.race([
        this.client.readResource({ uri: params.uri }, { signal: options?.signal, timeout: timeoutMs }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`MCP resources/read timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    try {
      return await invoke();
    } catch (err) {
      if (isSessionNotFoundError(err) && this.lastServerConfig) {
        await this.reinit();
        return await invoke();
      }
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, any>, options?: { signal?: AbortSignal }) {
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
    const timeoutMs = getCliKnobs().mcpTimeoutMs;
    // DESK-6 — already stopped: don't even dispatch.
    if (options?.signal?.aborted) {
      return { isError: true, content: [{ type: 'text' as const, text: `Tool "${name}" interrupted by user.` }] };
    }
    const invoke = () =>
      Promise.race([
        // DESK-6 — forward the Stop signal + timeout to the SDK so it sends
        // notifications/cancelled and rejects promptly (belt-and-suspenders with
        // the race timeout below).
        this.client.callTool({ name, arguments: args }, undefined, { signal: options?.signal, timeout: timeoutMs }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`MCP tool "${name}" timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    // RECONNECT (0.4.12) — recover the memory transport from a genuine connection
    // DROP (brain restarted / session aged out / socket reset) by redialing + a small
    // bounded retry, so a transient blip doesn't fail the turn into offline mode.
    //
    // CRITICAL — this stays FAST + bounded because memory calls (esp. the per-turn
    // briefing) are best-effort: a slow recall must degrade to "no memory", never
    // block. So an `invoke()` TIMEOUT (the brain is alive but slow/hung) FAILS FAST —
    // redialing would just re-run the same slow query and loop for minutes (the
    // briefing-takes-forever regression). Only a real drop reconnects, capped low,
    // with no offline-wait blocking. A real tool ERROR is returned as an isError
    // envelope (not thrown), so it never enters this loop.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const MCP_MAX_RECONNECTS = 2; // best-effort: a few quick redials, then offline-degrade
    let reconnects = 0;
    let sessionRedials = 0;
    for (;;) {
      try {
        return await invoke();
      } catch (err) {
        // Our own per-call timeout ⇒ the brain is slow/hung, not dropped. Fail fast
        // (caller degrades to offline) rather than redial-and-rerun the slow op.
        if (err instanceof Error && /\btimed out after \d+ms\b/.test(err.message)) throw err;
        // Streamable HTTP session-expiry: the brain restarted / the session aged out
        // and our cached `mcp-session-id` is rejected. Redial + retry a couple of
        // times (the server IS up) without spending the reconnect budget.
        if (isSessionNotFoundError(err) && this.lastServerConfig && sessionRedials < 2) {
          sessionRedials += 1;
          try { await this.reinit(); continue; } catch { /* fall through to transient handling */ }
        }
        // Only a genuine connection drop reconnects; anything else propagates.
        if (!isConnectivityError(err)) throw err;
        reconnects += 1;
        if (reconnects > MCP_MAX_RECONNECTS) throw err;
        console.error(`[BrainRouter] memory call "${name}" — reconnecting ${reconnects}/${MCP_MAX_RECONNECTS}...`);
        try { await this.reinit(); } catch { /* redial best-effort; retry surfaces the real failure */ }
        await sleep(reconnectBackoffMs(reconnects, { capMs: 4000 }));
      }
    }
  }

  /**
   * Force-tear-down the transport + reconnect using the stashed
   * `serverConfig`. Used by the session-expiry recovery path; safe to
   * call repeatedly because `close()` swallows its own errors.
   */
  private async reinit(): Promise<void> {
    try {
      await this.close();
    } catch {
      // ignore — the transport was already in a bad state.
    }
    // `close()` flipped `connected` to false; clear `transport` so the
    // next _connect builds a fresh one.
    this.transport = null;
    this.connected = false;
    // Rebuild the underlying Client too — the SDK caches transport
    // state on the Client instance and won't accept a second connect.
    this.client = new Client(
      { name: 'brainrouter-cli', version: VERSION },
      { capabilities: {} },
    );
    await this._connect(this.lastServerConfig!, this.lastLlmConfig);
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
