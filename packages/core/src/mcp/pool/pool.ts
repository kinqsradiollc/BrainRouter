import { McpClientWrapper } from '../client/client.js';
import { resolveIdentityFromConfig } from '../client/identity.js';
import type { LLMConfig, ServerConfig } from '../../config/config.js';
import { reconnectBackoffMs } from '../reconnect/reconnect.js';
import type { McpServerStatus } from '../types.js';
import { dueForReconnect } from './reconnectSweep.js';
import { resolvePreferredBrainrouterServerId } from './brainProfiles.js';
import { isBrainrouterOwnedTool, normalizeMcpToolName } from './toolNames.js';

/**
 * 0.3.7 — Multi-MCP support. Wraps a `Map<serverId, McpClientWrapper>`
 * and exposes the same public API as a single wrapper (`isConnected`,
 * `getIdentity`, `getServerName`, `listTools`, `callTool`, `close`),
 * so existing call-sites that hold an `mcpClient` reference keep
 * working unchanged.
 *
 * Concurrent startup:,
 * tool prefixing at line 1515, graceful degradation at line 189). Our
 * shape:
 *
 *   - All configured servers attempt connection concurrently on boot,
 *     each with a 5s timeout. Offline ones do NOT block others.
 *   - Tools surface to the agent with `mcp_<serverId>_<toolName>`
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
  // WS9 — background auto-reconnect supervisor state.
  private reconnectTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempts = new Map<string, number>();
  private reconnectNextAt = new Map<string, number>();
  /** Preference rank for a published BrainRouter profile; higher ranks win concurrent discovery. */
  private brainrouterPriorities = new Map<string, number>();
  /** Serializes BrainRouter publication so two successful handshakes cannot overlap in the live pool. */
  private brainrouterPublicationTail: Promise<void> = Promise.resolve();
  /** Invalidates async tool-index snapshots when the live topology changes. */
  private toolIndexGeneration = 0;
  /**
   * Per-server operation generation invalidates connects that were already
   * awaiting transport startup when a profile is removed; deleting
   * the visible maps alone cannot stop their continuation from re-inserting it.
   */
  private serverGenerations = new Map<string, number>();

  private beginServerOperation(serverId: string): number {
    this.toolIndexGeneration += 1;
    const generation = (this.serverGenerations.get(serverId) ?? 0) + 1;
    this.serverGenerations.set(serverId, generation);
    return generation;
  }

  private isCurrentServerOperation(serverId: string, generation: number): boolean {
    return this.serverGenerations.get(serverId) === generation;
  }

  /** Kept as a seam for deterministic connect-race tests. */
  private createClientWrapper(): McpClientWrapper {
    return new McpClientWrapper();
  }

  private publishConnectedWrapper(
    serverId: string,
    wrapper: McpClientWrapper,
    brainrouterPriority: number,
  ): void {
    this.clients.set(serverId, wrapper);
    this.assignPrefixId(serverId, wrapper);
    this.statuses.set(serverId, {
      serverId,
      identity: wrapper.getIdentity(),
      status: 'connected',
    });
    if (wrapper.getIdentity() === 'brainrouter') {
      this.brainrouterPriorities.set(serverId, brainrouterPriority);
    } else {
      this.brainrouterPriorities.delete(serverId);
    }
  }

  private async publishBrainrouterWrapperExclusively(
    serverId: string,
    generation: number,
    wrapper: McpClientWrapper,
    retireServerIds: readonly string[],
    brainrouterPriority: number,
  ): Promise<boolean> {
    let release!: () => void;
    const predecessor = this.brainrouterPublicationTail;
    this.brainrouterPublicationTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      if (!this.isCurrentServerOperation(serverId, generation)) return false;

      const retired = new Set(retireServerIds);
      let strongestPublishedPriority = Number.NEGATIVE_INFINITY;
      for (const [otherId, other] of this.clients) {
        if (otherId !== serverId && other.getIdentity() === 'brainrouter') {
          retired.add(otherId);
          strongestPublishedPriority = Math.max(
            strongestPublishedPriority,
            this.brainrouterPriorities.get(otherId) ?? 0,
          );
        }
      }
      retired.delete(serverId);
      if (strongestPublishedPriority > brainrouterPriority) {
        this.statuses.delete(serverId);
        this.serverConfigs.delete(serverId);
        this.reconnectAttempts.delete(serverId);
        this.reconnectNextAt.delete(serverId);
        this.brainrouterPriorities.delete(serverId);
        return false;
      }
      for (const otherId of retired) {
        await this.removeOne(otherId);
      }

      if (!this.isCurrentServerOperation(serverId, generation)) return false;
      this.publishConnectedWrapper(serverId, wrapper, brainrouterPriority);
      return true;
    } finally {
      release();
    }
  }

  /** WS9 — start a background supervisor that auto-reconnects any dropped server
   *  (brain or tool) with per-server exponential backoff, so a transient outage
   *  self-heals without a manual reconnect or waiting for the next tool call. */
  startReconnectSupervisor(intervalMs = 15_000): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setInterval(() => { void this.sweepReconnect(); }, Math.max(5_000, intervalMs));
    this.reconnectTimer.unref?.();
  }

  /** WS9 — stop the supervisor (called on close()). */
  stopReconnectSupervisor(): void {
    if (this.reconnectTimer) { clearInterval(this.reconnectTimer); this.reconnectTimer = undefined; }
  }

  private async sweepReconnect(): Promise<void> {
    const now = Date.now();
    for (const s of this.getStatuses()) {
      if (s.status === 'connected' || s.status === 'connecting') {
        this.reconnectAttempts.delete(s.serverId);
        this.reconnectNextAt.delete(s.serverId);
      }
    }
    for (const serverId of dueForReconnect(this.getStatuses(), this.reconnectNextAt, now)) {
      const attempt = (this.reconnectAttempts.get(serverId) ?? 0) + 1;
      this.reconnectAttempts.set(serverId, attempt);
      this.reconnectNextAt.set(serverId, now + reconnectBackoffMs(attempt));
      try { await this.reconnectOne(serverId); } catch { /* still down — retried after backoff */ }
    }
  }

  private getPrefixId(serverId: string): string {
    return this.prefixIds.get(serverId) ?? serverId;
  }

  private clearPrefixId(serverId: string): void {
    const prefixId = this.prefixIds.get(serverId);
    if (prefixId && this.prefixToServerId.get(prefixId) === serverId) {
      this.prefixToServerId.delete(prefixId);
    }
    this.prefixIds.delete(serverId);
  }

  private assignPrefixId(serverId: string, wrapper: McpClientWrapper): void {
    const id = wrapper.getIdentity() === 'brainrouter' ? 'brainrouter' : serverId;
    this.clearPrefixId(serverId);
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
    options?: {
      timeoutMs?: number;
      onStatusChange?: (s: McpServerStatus) => void;
      preferredBrainrouterServerId?: string;
    },
  ): Promise<McpServerStatus[]> {
    this.setReconnectLlmConfig(llmConfig);
    const entries = Object.entries(servers);
    const configuredBrainrouterId = resolvePreferredBrainrouterServerId(
      servers,
      options?.preferredBrainrouterServerId,
    );
    // Stash configs first so `/mcp reconnect <id>` can find them later.
    for (const [serverId, cfg] of entries) this.serverConfigs.set(serverId, cfg);
    const tasks = entries.map(([serverId, cfg], index) =>
      this.connectOne(serverId, cfg, llmConfig, options?.timeoutMs, {
        brainrouterPriority: serverId === configuredBrainrouterId
          ? entries.length + 1
          : entries.length - index,
      }).then(() => {
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
    options: {
      retireBrainrouterServerIds?: readonly string[];
      brainrouterPriority?: number;
    } = {},
  ): Promise<void> {
    if (llmConfig !== undefined) this.setReconnectLlmConfig(llmConfig);
    const generation = this.beginServerOperation(serverId);
    const previous = this.clients.get(serverId);
    const configIdentity = resolveIdentityFromConfig(config, serverId);
    const priorRuntimeIdentity = previous?.getIdentity() ?? this.statuses.get(serverId)?.identity;
    const previousIdentity = configIdentity !== 'unknown'
      ? configIdentity
      : priorRuntimeIdentity ?? 'unknown';
    const brainrouterPriority = options.brainrouterPriority
      ?? this.brainrouterPriorities.get(serverId)
      ?? 0;
    if (previousIdentity === 'brainrouter') {
      this.brainrouterPriorities.set(serverId, brainrouterPriority);
    }
    if (previous) {
      try { await previous.close(); } catch { /* ignore */ }
      if (!this.isCurrentServerOperation(serverId, generation)) return;
      if (this.clients.get(serverId) === previous) {
        this.clients.delete(serverId);
        this.clearPrefixId(serverId);
      }
    }
    this.serverConfigs.set(serverId, config);
    this.statuses.set(serverId, { serverId, identity: previousIdentity, status: 'connecting' });
    const wrapper = this.createClientWrapper();
    const startedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        wrapper.connect(config, llmConfig ?? this.currentLlmConfig, serverId),
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      if (!this.isCurrentServerOperation(serverId, generation)) {
        try { await wrapper.close(); } catch { /* ignore */ }
        return;
      }
      if (wrapper.getIdentity() === 'unknown') {
        let identityTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
          await Promise.race([
            wrapper.listTools(),
            new Promise<never>((_, reject) => {
              identityTimeout = setTimeout(
                () => reject(new Error(`identity probe timed out after ${timeoutMs}ms`)),
                remainingMs,
              );
            }),
          ]);
        } finally {
          if (identityTimeout) clearTimeout(identityTimeout);
        }
      }
      if (!this.isCurrentServerOperation(serverId, generation)) {
        try { await wrapper.close(); } catch { /* ignore */ }
        return;
      }
      if (wrapper.getIdentity() === 'brainrouter') {
        const published = await this.publishBrainrouterWrapperExclusively(
          serverId,
          generation,
          wrapper,
          options.retireBrainrouterServerIds ?? [],
          brainrouterPriority,
        );
        if (!published) {
          try { await wrapper.close(); } catch { /* ignore */ }
          return;
        }
      } else {
        this.publishConnectedWrapper(serverId, wrapper, 0);
      }
    } catch (err: any) {
      if (!this.isCurrentServerOperation(serverId, generation)) {
        try { await wrapper.close(); } catch { /* ignore */ }
        return;
      }
      this.statuses.set(serverId, {
        serverId,
        identity: wrapper.getIdentity() === 'unknown' ? previousIdentity : wrapper.getIdentity(),
        status: 'failed',
        error: err?.message ?? String(err),
      });
      try { await wrapper.close(); } catch { /* ignore */ }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    await this.refreshToolIndex();
  }

  private async disconnectOneAtGeneration(serverId: string, generation: number): Promise<boolean> {
    const wrapper = this.clients.get(serverId);
    if (wrapper) {
      try { await wrapper.close(); } catch { /* ignore */ }
    }
    if (!this.isCurrentServerOperation(serverId, generation)) return false;
    this.clients.delete(serverId);
    this.clearPrefixId(serverId);
    const prev = this.statuses.get(serverId);
    this.statuses.set(serverId, {
      serverId,
      identity: prev?.identity ?? 'unknown',
      status: 'offline',
    });
    await this.refreshToolIndex();
    return this.isCurrentServerOperation(serverId, generation);
  }

  /** Tear down a single server. Removes it from the pool and rebuilds the tool index. */
  async disconnectOne(serverId: string): Promise<void> {
    const generation = this.beginServerOperation(serverId);
    await this.disconnectOneAtGeneration(serverId, generation);
  }

  /**
   * Remove a server from the live pool and its reconnect catalog.
   *
   * `disconnectOne` deliberately retains status/config so a transiently
   * offline profile can be retried by the supervisor. Callers reconciling the
   * pool to a newly committed config need the opposite semantic: a profile
   * that is no longer selected must not be resurrected in the background.
   */
  async removeOne(serverId: string): Promise<void> {
    const generation = this.beginServerOperation(serverId);
    const wrapper = this.clients.get(serverId);
    this.clients.delete(serverId);
    this.clearPrefixId(serverId);
    this.statuses.delete(serverId);
    this.serverConfigs.delete(serverId);
    this.reconnectAttempts.delete(serverId);
    this.reconnectNextAt.delete(serverId);
    this.brainrouterPriorities.delete(serverId);
    if (wrapper) {
      try { await wrapper.close(); } catch { /* ignore */ }
    }
    if (this.isCurrentServerOperation(serverId, generation)) {
      await this.refreshToolIndex();
    }
  }

  /** Reconnect: close + connect again using the stashed config. */
  async reconnectOne(serverId: string): Promise<void> {
    const config = this.serverConfigs.get(serverId);
    if (!config) {
      throw new Error(`No stored config for serverId "${serverId}". Add it to ~/.config/brainrouter/config.json first.`);
    }
    const generation = this.beginServerOperation(serverId);
    const disconnected = await this.disconnectOneAtGeneration(serverId, generation);
    if (!disconnected || !this.serverConfigs.has(serverId)) return;
    await this.connectOne(serverId, config, this.currentLlmConfig);
  }

  /** Replace the provider snapshot used by future background reconnects. */
  setReconnectLlmConfig(llmConfig?: LLMConfig): void {
    this.currentLlmConfig = llmConfig === undefined ? undefined : structuredClone(llmConfig);
  }

  /**
   * Walk every connected client and rebuild the tool→server indices.
   * Called after every connect / disconnect / reconnect so the
   * dispatch path stays correct without re-fetching tools on every
   * `callTool`.
   */
  private async refreshToolIndex(): Promise<void> {
    const generation = ++this.toolIndexGeneration;
    // Fetch every connected server's tools IN PARALLEL — a sequential
    // `await listTools()` per server was pure additive latency on the startup
    // critical path (N servers × one round-trip each, summed). Build the index
    // from the results in deterministic Map order so collision resolution is
    // byte-for-byte unchanged; only the network fetch fans out.
    const connected = [...this.clients].filter(([, wrapper]) => wrapper.isConnected());
    const settled = await Promise.allSettled(connected.map(([, wrapper]) => wrapper.listTools()));
    if (
      this.toolIndexGeneration !== generation
      || connected.some(([serverId, wrapper]) => (
        this.clients.get(serverId) !== wrapper || !wrapper.isConnected()
      ))
    ) {
      return;
    }

    const nextToolToServer = new Map<string, string>();
    const nextPrefixedToServer = new Map<string, { serverId: string; tool: string }>();
    const statusUpdates: Array<{ serverId: string; wrapper: McpClientWrapper; toolCount: number }> = [];
    for (let i = 0; i < connected.length; i++) {
      const [serverId, wrapper] = connected[i];
      const result = settled[i];
      if (result.status !== 'fulfilled') continue; // listTools failed — retries next refresh
      const tools = (result.value as any).tools ?? [];
      statusUpdates.push({ serverId, wrapper, toolCount: tools.length });
      for (const tool of tools) {
        const rawName = tool.name;
        const pid = this.getPrefixId(serverId);
        const prefixed = `mcp_${pid}_${rawName}`;
        nextPrefixedToServer.set(prefixed, { serverId, tool: rawName });
        const existing = nextToolToServer.get(rawName);
        if (existing && existing !== serverId) {
          // Two servers expose the same unprefixed tool name. Mark
          // collision so the raw-name resolver knows to require the
          // prefix.
          nextToolToServer.set(rawName, '__COLLISION__');
        } else if (!existing) {
          nextToolToServer.set(rawName, serverId);
        }
      }
    }

    // Publishing is synchronous after the final generation check, so a newer
    // connect/remove/refresh cannot interleave a stale snapshot into the maps.
    this.toolToServer = nextToolToServer;
    this.prefixedToServer = nextPrefixedToServer;
    for (const { serverId, wrapper, toolCount } of statusUpdates) {
      const status = this.statuses.get(serverId);
      if (status) {
        status.toolCount = toolCount;
        status.identity = wrapper.getIdentity();
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
    // Parallel fetch across servers (was sequential await = summed latency on
    // the per-turn path); concatenate in deterministic Map order afterward.
    const connected = [...this.clients].filter(([, wrapper]) => wrapper.isConnected());
    const settled = await Promise.allSettled(connected.map(([, wrapper]) => wrapper.listTools()));
    for (let i = 0; i < connected.length; i++) {
      const [serverId, wrapper] = connected[i];
      const result = settled[i];
      if (result.status !== 'fulfilled') continue; // drop this server's tools this turn
      const tools = (result.value as any).tools ?? [];
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
    }
    return { tools: all };
  }

  private resolveResourceServerId(server: string): string | undefined {
    if (this.clients.has(server)) return server;
    return this.prefixToServerId.get(server);
  }

  private connectedResourceClients(server?: string): Array<[string, McpClientWrapper]> {
    if (server) {
      const serverId = this.resolveResourceServerId(server);
      if (!serverId) return [];
      const wrapper = this.clients.get(serverId);
      return wrapper && wrapper.isConnected() ? [[serverId, wrapper]] : [];
    }
    return [...this.clients].filter(([, wrapper]) => wrapper.isConnected());
  }

  /**
   * Codex-style MCP resource facade. Lists resources across connected servers
   * and tags each result with the concrete `server` id that `readResource`
   * expects. A cursor is server-local, so paging without a server selector is
   * only accepted when exactly one server is connected.
   */
  async listResources(params: { cursor?: string; server?: string } = {}, options?: { signal?: AbortSignal }): Promise<any> {
    const connected = this.connectedResourceClients(params.server);
    if (params.server && connected.length === 0) {
      throw new Error(`MCP server "${params.server}" is not connected or unknown.`);
    }
    if (params.cursor && !params.server && connected.length > 1) {
      throw new Error('list_mcp_resources: `cursor` requires `server` when multiple MCP servers are connected.');
    }

    const all: any[] = [];
    const nextCursors: Record<string, string> = {};
    const settled = await Promise.allSettled(
      connected.map(([, wrapper]) => wrapper.listResources({ cursor: params.cursor }, options)),
    );
    for (let i = 0; i < connected.length; i++) {
      const [serverId] = connected[i];
      const result = settled[i];
      if (result.status !== 'fulfilled') continue;
      for (const resource of (result.value as any).resources ?? []) {
        all.push({ server: serverId, ...resource });
      }
      const nextCursor = (result.value as any).nextCursor;
      if (typeof nextCursor === 'string' && nextCursor) nextCursors[serverId] = nextCursor;
    }
    return {
      resources: all,
      ...(Object.keys(nextCursors).length === 1 ? { nextCursor: Object.values(nextCursors)[0] } : {}),
      ...(Object.keys(nextCursors).length > 1 ? { nextCursors } : {}),
    };
  }

  /** Same facade as {@link listResources}, for parameterized MCP resources. */
  async listResourceTemplates(params: { cursor?: string; server?: string } = {}, options?: { signal?: AbortSignal }): Promise<any> {
    const connected = this.connectedResourceClients(params.server);
    if (params.server && connected.length === 0) {
      throw new Error(`MCP server "${params.server}" is not connected or unknown.`);
    }
    if (params.cursor && !params.server && connected.length > 1) {
      throw new Error('list_mcp_resource_templates: `cursor` requires `server` when multiple MCP servers are connected.');
    }

    const all: any[] = [];
    const nextCursors: Record<string, string> = {};
    const settled = await Promise.allSettled(
      connected.map(([, wrapper]) => wrapper.listResourceTemplates({ cursor: params.cursor }, options)),
    );
    for (let i = 0; i < connected.length; i++) {
      const [serverId] = connected[i];
      const result = settled[i];
      if (result.status !== 'fulfilled') continue;
      for (const template of (result.value as any).resourceTemplates ?? []) {
        all.push({ server: serverId, ...template });
      }
      const nextCursor = (result.value as any).nextCursor;
      if (typeof nextCursor === 'string' && nextCursor) nextCursors[serverId] = nextCursor;
    }
    return {
      resourceTemplates: all,
      ...(Object.keys(nextCursors).length === 1 ? { nextCursor: Object.values(nextCursors)[0] } : {}),
      ...(Object.keys(nextCursors).length > 1 ? { nextCursors } : {}),
    };
  }

  /** Read a single MCP resource from the server id returned by listResources. */
  async readResource(params: { server: string; uri: string }, options?: { signal?: AbortSignal }): Promise<any> {
    const server = String(params.server ?? '').trim();
    const uri = String(params.uri ?? '').trim();
    if (!server) throw new Error('read_mcp_resource requires a server.');
    if (!uri) throw new Error('read_mcp_resource requires a uri.');

    const serverId = this.resolveResourceServerId(server);
    const wrapper = serverId ? this.clients.get(serverId) : undefined;
    if (!serverId || !wrapper || !wrapper.isConnected()) {
      throw new Error(`MCP server "${server}" is not connected or unknown.`);
    }
    const result = await wrapper.readResource({ uri }, options);
    return { server: serverId, ...result };
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
  async callTool(name: string, args: Record<string, any>, options?: { signal?: AbortSignal }): Promise<any> {
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
    return wrapper.callTool(resolved.tool, args, options); // DESK-6 — forward Stop signal
  }

  /** Internal — map a name (prefixed OR raw) to a concrete server + tool. */
  private resolveToolCall(name: string): { serverId: string; tool: string } | undefined {
    // Back-compat: any legacy double-underscore form is collapsed first so
    // the rest of the resolver only deals with the canonical shape.
    name = normalizeMcpToolName(name);
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
          this.prefixedToServer.has(`mcp_${this.getPrefixId(serverId)}_${name}`)
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
    this.stopReconnectSupervisor(); // WS9 — stop new reconnect attempts before invalidating active ones
    const serverIds = new Set([...this.clients.keys(), ...this.statuses.keys(), ...this.serverConfigs.keys()]);
    for (const serverId of serverIds) this.beginServerOperation(serverId);
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
