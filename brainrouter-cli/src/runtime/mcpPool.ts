import { McpClientWrapper, resolveIdentityFromConfig } from './mcpClient.js';
import type { LLMConfig, ServerConfig } from '../config/config.js';

/**
 * 0.3.7 — Multi-MCP support. Wraps a `Map<serverId, McpClientWrapper>`
 * and exposes the same public API as a single wrapper (`isConnected`,
 * `getIdentity`, `getServerName`, `listTools`, `callTool`, `close`),
 * so existing call-sites that hold an `mcpClient` reference keep
 * working unchanged.
 *
 * Pattern lifted from Claude Code's `.mcp.json` model (see
 * `openSrc/claude-code/CHANGELOG.md` — concurrent startup at line 688,
 * tool prefixing at line 1515, graceful degradation at line 189). Our
 * shape:
 *
 *   - All configured servers attempt connection concurrently on boot,
 *     each with a 5s timeout. Offline ones do NOT block others.
 *   - Tools surface to the agent with `mcp_<serverId>_<toolName>`
 *     prefix (Claude Code style).
 *   - `callTool` accepts BOTH the prefixed form (the canonical name
 *     the LLM sees in the tool inventory) AND the raw form (back-compat
 *     for the existing system prompt and skills that hardcode
 *     `memory_recall` etc.). Raw form routes to the unique server
 *     providing that tool name; collision (two servers expose the same
 *     unprefixed name) returns a helpful error pointing at the
 *     prefixed form.
 *
 * Future versions may drop the raw-name fallback once skills and
 * prompts are migrated to prefixed names; the pool then becomes the
 * pure Claude Code shape. Until then the dual-name resolution is a
 * transition aid documented in CHANGELOG `[0.3.7]`.
 */

export type McpServerStatus = {
  serverId: string;
  identity: 'brainrouter' | 'third-party' | 'unknown';
  /** 'connected' once the underlying wrapper reports isConnected. */
  status: 'connected' | 'connecting' | 'offline' | 'failed';
  /** Filled after the first successful listTools (used by /mcp list). */
  toolCount?: number;
  /** Per-server error message when status === 'failed'. */
  error?: string;
};

/**
 * Choose which configured MCP profiles should connect for a normal CLI run.
 *
 * BrainRouter profiles are special: users may store several BrainRouter MCPs
 * (local, staging, remote, self-hosted), but only one should be active at a
 * time because the BrainRouter MCP is the memory/brain plane. Third-party MCPs
 * are additive tools, so they all connect concurrently.
 *
 * `requestedProfile` is the explicit escape hatch (`--profile <name>`): it
 * scopes the run to exactly that profile, matching the existing single-server
 * mode.
 */
export function selectMcpServerIds(
  servers: Record<string, ServerConfig>,
  activeServer?: string,
  requestedProfile?: string,
): string[] {
  const ids = Object.keys(servers);
  if (requestedProfile) return servers[requestedProfile] ? [requestedProfile] : [];

  const brainrouterIds = ids.filter((id) =>
    resolveIdentityFromConfig(servers[id], id) === 'brainrouter',
  );
  const activeBrainrouter = activeServer && brainrouterIds.includes(activeServer)
    ? activeServer
    : brainrouterIds[0];

  return ids.filter((id) => {
    const identity = resolveIdentityFromConfig(servers[id], id);
    return identity !== 'brainrouter' || id === activeBrainrouter;
  });
}

function isBrainrouterOwnedTool(name: string): boolean {
  return name.startsWith('memory_') ||
    [
      'list_skills',
      'get_skill',
      'search_skills',
      'create_skill',
      'update_skill',
      'get_persona',
      'get_reference',
      'list_template_docs',
      'get_template_doc',
    ].includes(name);
}

export class McpClientPool {
  /** serverId → connected wrapper. */
  private clients = new Map<string, McpClientWrapper>();
  /** serverId → status entry (kept even for failed/offline servers so /mcp can render them). */
  private statuses = new Map<string, McpServerStatus>();
  /**
   * Unprefixed tool name → owning serverId. Sentinel `__COLLISION__`
   * marks tool names exposed by multiple servers (must be addressed
   * via the prefixed form).
   */
  private toolToServer = new Map<string, string>();
  /** Prefixed form (`mcp_<serverId>_<tool>`) → `{serverId, tool}` for fast dispatch. */
  private prefixedToServer = new Map<string, { serverId: string; tool: string }>();
  /** LLM config from the last connectAll — needed for reconnect calls. */
  private currentLlmConfig?: LLMConfig;
  /** Raw server configs from the last connectAll — needed for /mcp reconnect <id>. */
  private serverConfigs = new Map<string, ServerConfig>();
  /** serverId → prefix used in tool names. Brainrouter servers get "brainrouter"; others keep their config key. */
  private prefixIds = new Map<string, string>();
  /** Reverse: prefixId → serverId (needed to dispatch `mcp_brainrouter_X` back to the real key). */
  private prefixToServerId = new Map<string, string>();

  private getPrefixId(serverId: string): string {
    return this.prefixIds.get(serverId) ?? serverId;
  }

  private assignPrefixId(serverId: string, wrapper: McpClientWrapper): void {
    const id = wrapper.getIdentity() === 'brainrouter' ? 'brainrouter' : serverId;
    this.prefixIds.set(serverId, id);
    this.prefixToServerId.set(id, serverId);
  }

  /**
   * Connect to every entry in `servers` concurrently. Each connect
   * gets its own timeout; offline servers don't block the others.
   * Returns the status array after all connects settle.
   */
  async connectAll(
    servers: Record<string, ServerConfig>,
    llmConfig?: LLMConfig,
    options?: { timeoutMs?: number; onStatusChange?: (s: McpServerStatus) => void },
  ): Promise<McpServerStatus[]> {
    this.currentLlmConfig = llmConfig;
    const entries = Object.entries(servers);
    // Stash configs first so `/mcp reconnect <id>` can find them later.
    for (const [serverId, cfg] of entries) this.serverConfigs.set(serverId, cfg);
    const tasks = entries.map(([serverId, cfg]) =>
      this.connectOne(serverId, cfg, llmConfig, options?.timeoutMs).then(() => {
        const s = this.statuses.get(serverId);
        if (s && options?.onStatusChange) options.onStatusChange(s);
      }),
    );
    await Promise.allSettled(tasks);
    await this.refreshToolIndex();
    return this.getStatuses();
  }

  /**
   * Connect a single server. Used both by `connectAll` and by
   * `/mcp connect <id>` for late-joining servers. Idempotent — if
   * the server is already connected, closes the previous wrapper first.
   */
  async connectOne(
    serverId: string,
    config: ServerConfig,
    llmConfig?: LLMConfig,
    timeoutMs = 5_000,
  ): Promise<void> {
    if (this.clients.has(serverId)) {
      try { await this.clients.get(serverId)!.close(); } catch { /* ignore */ }
      this.clients.delete(serverId);
    }
    this.serverConfigs.set(serverId, config);
    this.statuses.set(serverId, { serverId, identity: 'unknown', status: 'connecting' });
    const wrapper = new McpClientWrapper();
    try {
      await Promise.race([
        wrapper.connect(config, llmConfig ?? this.currentLlmConfig, serverId),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      this.clients.set(serverId, wrapper);
      this.assignPrefixId(serverId, wrapper);
      this.statuses.set(serverId, {
        serverId,
        identity: wrapper.getIdentity(),
        status: 'connected',
      });
    } catch (err: any) {
      this.statuses.set(serverId, {
        serverId,
        identity: 'unknown',
        status: 'failed',
        error: err?.message ?? String(err),
      });
      try { await wrapper.close(); } catch { /* ignore */ }
    }
    await this.refreshToolIndex();
  }

  /** Tear down a single server. Removes it from the pool and rebuilds the tool index. */
  async disconnectOne(serverId: string): Promise<void> {
    const wrapper = this.clients.get(serverId);
    if (wrapper) {
      try { await wrapper.close(); } catch { /* ignore */ }
    }
    this.clients.delete(serverId);
    const oldPid = this.prefixIds.get(serverId);
    if (oldPid) this.prefixToServerId.delete(oldPid);
    this.prefixIds.delete(serverId);
    const prev = this.statuses.get(serverId);
    this.statuses.set(serverId, {
      serverId,
      identity: prev?.identity ?? 'unknown',
      status: 'offline',
    });
    await this.refreshToolIndex();
  }

  /** Reconnect: close + connect again using the stashed config. */
  async reconnectOne(serverId: string): Promise<void> {
    const config = this.serverConfigs.get(serverId);
    if (!config) {
      throw new Error(`No stored config for serverId "${serverId}". Add it to ~/.config/brainrouter/config.json first.`);
    }
    await this.disconnectOne(serverId);
    await this.connectOne(serverId, config, this.currentLlmConfig);
  }

  /**
   * Walk every connected client and rebuild the tool→server indices.
   * Called after every connect / disconnect / reconnect so the
   * dispatch path stays correct without re-fetching tools on every
   * `callTool`.
   */
  private async refreshToolIndex(): Promise<void> {
    this.toolToServer.clear();
    this.prefixedToServer.clear();
    for (const [serverId, wrapper] of this.clients) {
      if (!wrapper.isConnected()) continue;
      try {
        const res = await wrapper.listTools();
        const tools = (res as any).tools ?? [];
        const status = this.statuses.get(serverId);
        if (status) {
          status.toolCount = tools.length;
          status.identity = wrapper.getIdentity();
        }
        for (const tool of tools) {
          const rawName = tool.name;
          const pid = this.getPrefixId(serverId);
          const prefixed = `mcp_${pid}_${rawName}`;
          this.prefixedToServer.set(prefixed, { serverId, tool: rawName });
          const existing = this.toolToServer.get(rawName);
          if (existing && existing !== serverId) {
            // Two servers expose the same unprefixed tool name. Mark
            // collision so the raw-name resolver knows to require the
            // prefix.
            this.toolToServer.set(rawName, '__COLLISION__');
          } else if (!existing) {
            this.toolToServer.set(rawName, serverId);
          }
        }
      } catch {
        // Server is connected but listTools failed — its tools won't
        // appear this turn. Will retry on the next refresh.
      }
    }
  }

  /**
   * Concatenated tool list across every connected server, with names
   * prefixed `mcp_<serverId>_<toolName>` (Claude Code style). The
   * agent calls this once per turn and hands it to the LLM.
   */
  async listTools(): Promise<{ tools: any[] }> {
    const all: any[] = [];
    for (const [serverId, wrapper] of this.clients) {
      if (!wrapper.isConnected()) continue;
      try {
        const res = await wrapper.listTools();
        const tools = (res as any).tools ?? [];
        const status = this.statuses.get(serverId);
        if (status) {
          status.identity = wrapper.getIdentity();
        }
        const pid = this.getPrefixId(serverId);
        for (const tool of tools) {
          all.push({
            ...tool,
            name: `mcp_${pid}_${tool.name}`,
            __serverId: serverId,
            __rawName: tool.name,
          });
        }
      } catch {
        // listTools failed for this server — drop its tools this turn.
      }
    }
    return { tools: all };
  }

  /**
   * Route a tool call to the right server. Accepts both name forms:
   *
   *   - `mcp_<serverId>_<tool>` — the canonical form the LLM sees
   *     in the inventory. Stripped + dispatched directly.
   *   - `<tool>` raw form — back-compat for prompts/skills that
   *     hardcode `memory_recall`-style names. Routed to the unique
   *     server providing that tool. Returns a helpful error if two
   *     servers expose the same name (caller must use the prefix).
   */
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    const resolved = this.resolveToolCall(name);
    if (!resolved) {
      // Distinguish the two failure modes — gives the LLM (and humans
      // tailing logs) actionable feedback.
      if (this.toolToServer.get(name) === '__COLLISION__') {
        const prefixes = [...this.clients.keys()]
          .filter((id) => {
            const w = this.clients.get(id);
            return w && w.isConnected() && this.prefixedToServer.has(`mcp_${this.getPrefixId(id)}_${name}`);
          })
          .map((id) => this.getPrefixId(id));
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Ambiguous tool name "${name}" — exposed by ${prefixes.length} MCP servers: ${prefixes.join(', ')}. Use the prefixed form, e.g. mcp_${prefixes[0]}_${name}.`,
          }],
        };
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool "${name}" not found on any connected MCP server.` }],
      };
    }
    const wrapper = this.clients.get(resolved.serverId);
    if (!wrapper || !wrapper.isConnected()) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `MCP server "${resolved.serverId}" is offline; tool "${resolved.tool}" cannot be reached. Try /mcp reconnect ${resolved.serverId}.`,
        }],
      };
    }
    return wrapper.callTool(resolved.tool, args);
  }

  /** Internal — map a name (prefixed OR raw) to a concrete server + tool. */
  private resolveToolCall(name: string): { serverId: string; tool: string } | undefined {
    // Fast path: exact prefixed form match in the index.
    if (name.startsWith('mcp_')) {
      const direct = this.prefixedToServer.get(name);
      if (direct) return direct;
      // Lenient parse: walk prefix IDs first (covers "brainrouter"
      // alias), then raw server IDs as fallback.
      const rest = name.slice('mcp_'.length);
      for (const [pid, realId] of this.prefixToServerId) {
        const prefix = `${pid}_`;
        if (rest.startsWith(prefix)) {
          return { serverId: realId, tool: rest.slice(prefix.length) };
        }
      }
      for (const serverId of this.clients.keys()) {
        const prefix = `${serverId}_`;
        if (rest.startsWith(prefix)) {
          return { serverId, tool: rest.slice(prefix.length) };
        }
      }
      return undefined;
    }
    if (isBrainrouterOwnedTool(name)) {
      for (const [serverId, wrapper] of this.clients) {
        if (
          wrapper.isConnected() &&
          wrapper.getIdentity() === 'brainrouter' &&
          this.prefixedToServer.has(`mcp_${serverId}_${name}`)
        ) {
          return { serverId, tool: name };
        }
      }
    }
    // Raw-name fallback.
    const owner = this.toolToServer.get(name);
    if (!owner || owner === '__COLLISION__') return undefined;
    return { serverId: owner, tool: name };
  }

  // ----- Facade methods that match McpClientWrapper's public surface -----

  /** True iff at least one server is connected. */
  isConnected(): boolean {
    for (const w of this.clients.values()) {
      if (w.isConnected()) return true;
    }
    return false;
  }

  /**
   * Identity precedence: any connected `brainrouter` > any connected
   * `third-party` > `unknown`. The CLI banner + offline prompt swap
   * branch on this — "BrainRouter is offline" makes sense only when
   * we expected one and didn't get one.
   */
  getIdentity(): 'brainrouter' | 'third-party' | 'unknown' {
    for (const w of this.clients.values()) {
      if (w.isConnected() && w.getIdentity() === 'brainrouter') return 'brainrouter';
    }
    for (const w of this.clients.values()) {
      if (w.isConnected() && w.getIdentity() === 'third-party') return 'third-party';
    }
    return 'unknown';
  }

  /**
   * Human-readable summary for the banner/statusline. Single-server
   * pools render just the server name; multi-server pools render
   * a count + the first few names.
   */
  getServerName(): string | undefined {
    const connected = [...this.clients.entries()]
      .filter(([_, w]) => w.isConnected())
      .map(([id]) => id);
    if (connected.length === 0) return undefined;
    if (connected.length === 1) return connected[0];
    const head = connected.slice(0, 3).join(', ');
    return connected.length > 3 ? `${connected.length} servers (${head}, …)` : `${connected.length} servers (${head})`;
  }

  /**
   * Look up a wrapper by serverId. Used by `/mcp tools <server>` and
   * similar commands that want to talk to one specific server.
   */
  getClient(serverId: string): McpClientWrapper | undefined {
    return this.clients.get(serverId);
  }

  /**
   * Find the connected wrapper whose identity is 'brainrouter'. Some
   * code paths (memory capture, working-memory offload) specifically
   * need the canonical brain regardless of how many third-party MCPs
   * the user added.
   */
  getBrainrouterClient(): McpClientWrapper | undefined {
    for (const w of this.clients.values()) {
      if (w.isConnected() && w.getIdentity() === 'brainrouter') return w;
    }
    return undefined;
  }

  /** Server id for the currently connected BrainRouter MCP, if one is active. */
  getActiveBrainrouterServerId(): string | undefined {
    for (const [serverId, wrapper] of this.clients) {
      if (wrapper.isConnected() && wrapper.getIdentity() === 'brainrouter') return serverId;
    }
    return undefined;
  }

  /** Status snapshot for every server the pool has tried to connect to. */
  getStatuses(): McpServerStatus[] {
    return [...this.statuses.values()];
  }

  /** Status for one server (returns undefined if the pool has never seen it). */
  getStatus(serverId: string): McpServerStatus | undefined {
    return this.statuses.get(serverId);
  }

  /** List of serverIds currently held by the pool (connected or not). */
  getServerIds(): string[] {
    return [...this.statuses.keys()];
  }

  /** Close every wrapper. Used on CLI exit. */
  async close(): Promise<void> {
    for (const wrapper of this.clients.values()) {
      try { await wrapper.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.toolToServer.clear();
    this.prefixedToServer.clear();
    this.prefixIds.clear();
    this.prefixToServerId.clear();
    // Keep `statuses` so a `getStatuses()` after close still shows what was there.
  }
}
