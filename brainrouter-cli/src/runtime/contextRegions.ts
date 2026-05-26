/**
 * Cache-first context partitioning (0.3.9 item 8).
 *
 * Adapted from openSrc/DeepSeek-Reasonix/src/memory/runtime.ts — the
 * `ImmutablePrefix` / `AppendOnlyLog` / `VolatileScratch` split that
 * keeps prefix-cache hit rate above 95% across long sessions instead of
 * the <20% generic agent loops get.
 *
 * Three regions:
 *
 * 1. **ImmutablePrefix** — system message + tool specs + few-shots +
 *    pinned memory anchor cards (item 9). Computed once per session,
 *    hashed, pinned. Re-pinned only on `/refresh`, model change, MCP
 *    tool inventory change, active-skill latch change.
 *
 * 2. **AppendOnlyLog** — turn messages, monotonically appended. The
 *    only break path is `compactInPlace()`, reserved for `/compact`
 *    and recovery.
 *
 * 3. **VolatileScratch** — reasoning content, plan state, per-turn
 *    notes. Distilled before any information is folded into the log;
 *    never sent upstream verbatim.
 *
 * BrainRouter's unique contribution (item 9): the `ImmutablePrefix`
 * holds MCP-recalled memory anchor cards as part of the prefix
 * payload, not just static config. The fingerprint covers them too,
 * so memory edits invalidate the prefix exactly when needed (and only
 * then).
 *
 * Reasonix reference for invariants: see Pillar 1 in
 * openSrc/DeepSeek-Reasonix/docs/ARCHITECTURE.md and the cache-hit
 * case study in benchmarks/real-world-cache/README.md (single user,
 * 2026-05-01: 99.82% cache hit, $1.38 instead of ~$61 on the same
 * workload).
 */

import { createHash } from 'node:crypto';

/**
 * Minimal OpenAI-shaped chat message — matches what the agent already
 * pushes through `chat.completions`. We don't import a project-wide
 * `ChatMessage` interface because there isn't one yet; the shape is
 * structurally compatible with the agent's existing inline literals.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Optional fields used by tool-call messages — see agent.ts. */
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; type?: string; function: { name: string; arguments: string } }>;
  /** Tag set by item 9 / 12 to mark pinned-anchor and turn-end-shrink synthesized messages. */
  meta?: Record<string, unknown>;
}

/**
 * OpenAI-shaped tool spec — matches what `buildChatCompletionPayload`
 * produces (see prompt.test.ts).
 */
export interface ToolSpec {
  type?: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ImmutablePrefixOptions {
  /** System prompt as a single string. */
  system: string;
  /** Tool specs (OpenAI shape). The order matters for cache fingerprinting. */
  toolSpecs?: readonly ToolSpec[];
  /** Optional few-shot exemplar messages. */
  fewShots?: readonly ChatMessage[];
  /**
   * Pinned MCP memory anchor cards (item 9). Each card is a single
   * synthetic message that lives inside the immutable prefix — when
   * the agent's session opens, item 9 calls `setAnchors()` once and
   * the prefix stays byte-stable across every subsequent turn.
   */
  anchors?: readonly ChatMessage[];
}

/**
 * The cache-stable region of the conversation context. Mutations are
 * surfaced explicitly so the caller knows when to expect a cache miss
 * on the next turn.
 */
export class ImmutablePrefix {
  private _system: string;
  private _toolSpecs: ToolSpec[];
  private _fewShots: ChatMessage[];
  private _anchors: ChatMessage[];
  /** Invalidated by any mutation; recomputed lazily. */
  private _fingerprintCache: string | null = null;

  constructor(opts: ImmutablePrefixOptions) {
    this._system = opts.system;
    this._toolSpecs = [...(opts.toolSpecs ?? [])];
    this._fewShots = [...(opts.fewShots ?? [])];
    this._anchors = [...(opts.anchors ?? [])];
  }

  get system(): string {
    return this._system;
  }

  get toolSpecs(): readonly ToolSpec[] {
    return this._toolSpecs;
  }

  get fewShots(): readonly ChatMessage[] {
    return this._fewShots;
  }

  get anchors(): readonly ChatMessage[] {
    return this._anchors;
  }

  /**
   * Replace the system prompt. Returns `true` iff the string actually
   * changed — false return = no cache miss penalty.
   */
  replaceSystem(s: string): boolean {
    if (this._system === s) return false;
    this._system = s;
    this._fingerprintCache = null;
    return true;
  }

  /**
   * Set the full tool-spec list. Order is significant for the prefix
   * cache key. Returns `true` iff the array changed.
   */
  setToolSpecs(specs: readonly ToolSpec[]): boolean {
    if (toolSpecsEqual(this._toolSpecs, specs)) return false;
    this._toolSpecs = [...specs];
    this._fingerprintCache = null;
    return true;
  }

  /**
   * Add a single tool spec (idempotent on name). Returns `true` if
   * the spec was new.
   */
  addTool(spec: ToolSpec): boolean {
    const name = spec.function?.name;
    if (!name) return false;
    if (this._toolSpecs.some(t => t.function?.name === name)) return false;
    this._toolSpecs.push(spec);
    this._fingerprintCache = null;
    return true;
  }

  /**
   * Remove a tool by name. Mirror of `addTool` for MCP hot-unbridge.
   * Same cache-miss cost — the prefix shape changes.
   */
  removeTool(name: string): boolean {
    const idx = this._toolSpecs.findIndex(t => t.function?.name === name);
    if (idx < 0) return false;
    this._toolSpecs.splice(idx, 1);
    this._fingerprintCache = null;
    return true;
  }

  /**
   * Replace the pinned-anchor list (item 9). One call at session start,
   * one call on `/refresh-memory`, otherwise mid-session re-briefings
   * APPEND to `AppendOnlyLog` instead of re-pinning here.
   */
  setAnchors(anchors: readonly ChatMessage[]): boolean {
    if (chatMessagesEqual(this._anchors, anchors)) return false;
    this._anchors = [...anchors];
    this._fingerprintCache = null;
    return true;
  }

  /**
   * Emit the prefix as a flat message list ready to be the head of a
   * chat-completions request. Order:
   *
   *   1. The system message.
   *   2. Pinned anchor cards (item 9 — synthetic assistant messages).
   *   3. Few-shot exemplars (rarely used).
   *
   * Tools are returned separately via `tools()` because OpenAI puts
   * them outside the message array.
   */
  toMessages(): ChatMessage[] {
    const out: ChatMessage[] = [{ role: 'system', content: this._system }];
    for (const a of this._anchors) out.push({ ...a });
    for (const m of this._fewShots) out.push({ ...m });
    return out;
  }

  /**
   * Tool specs as a copy ready to ship to OpenAI's `tools` parameter.
   * Deep-copied to keep the model client from accidentally mutating
   * our cached source.
   */
  tools(): ToolSpec[] {
    return this._toolSpecs.map(t => structuredCloneCompat(t));
  }

  /**
   * 16-char SHA-256 prefix of `(system, tools, fewShots, anchors)`. Two
   * sessions with the same fingerprint will hit the provider prefix
   * cache; any mutation that invalidates the cache also invalidates
   * this hash.
   */
  get fingerprint(): string {
    if (this._fingerprintCache !== null) return this._fingerprintCache;
    this._fingerprintCache = this.computeFingerprint();
    return this._fingerprintCache;
  }

  /**
   * Dev/test only. Throws when the cached fingerprint diverges from a
   * fresh computation — that always means a code path mutated the
   * prefix without going through one of the public setters. Reasonix's
   * equivalent `verifyFingerprint()` catches the same drift; we keep
   * the same shape for parity.
   */
  verifyFingerprint(): string {
    const fresh = this.computeFingerprint();
    if (this._fingerprintCache !== null && this._fingerprintCache !== fresh) {
      throw new Error(
        `ImmutablePrefix fingerprint drift: cached=${this._fingerprintCache}, fresh=${fresh}. A mutation path bypassed setSystem/setToolSpecs/setAnchors — the provider cache will see prefix churn the runtime did not record.`,
      );
    }
    this._fingerprintCache = fresh;
    return fresh;
  }

  private computeFingerprint(): string {
    const blob = JSON.stringify({
      system: this._system,
      tools: this._toolSpecs,
      shots: this._fewShots,
      anchors: this._anchors,
    });
    return createHash('sha256').update(blob).digest('hex').slice(0, 16);
  }
}

/**
 * Monotonically-growing log of turn messages. The only break path is
 * `compactInPlace()`, reserved for `/compact` and recovery scenarios.
 *
 * Why a class and not a plain array: the explicit `append()` method
 * forces callers to think about what they're adding (and turns into
 * a natural hook point for future tracing / persistence).
 */
export class AppendOnlyLog {
  private _entries: ChatMessage[] = [];

  append(message: ChatMessage): void {
    if (!message || typeof message !== 'object' || typeof message.role !== 'string') {
      throw new Error(`AppendOnlyLog: invalid log entry ${JSON.stringify(message)}`);
    }
    this._entries.push(message);
  }

  extend(messages: readonly ChatMessage[]): void {
    for (const m of messages) this.append(m);
  }

  /**
   * Replace the entire log with a fresh content list. Reserved for
   * `/compact` and recovery — every call is a hard cache miss on the
   * append region. Mirrors Reasonix's `compactInPlace`.
   */
  compactInPlace(replacement: readonly ChatMessage[]): void {
    this._entries = replacement.map(m => ({ ...m }));
  }

  get entries(): readonly ChatMessage[] {
    return this._entries;
  }

  get length(): number {
    return this._entries.length;
  }

  toMessages(): ChatMessage[] {
    return this._entries.map(e => ({ ...e }));
  }
}

/**
 * Per-turn scratch. Reasoning content, plan state, and free-form notes
 * live here. Distilled into the append log by Pillar 2 (item 11
 * repair) before any of it is sent upstream; never folded raw.
 */
export class VolatileScratch {
  reasoning: string | null = null;
  planState: Record<string, unknown> | null = null;
  notes: string[] = [];

  reset(): void {
    this.reasoning = null;
    this.planState = null;
    this.notes = [];
  }
}

/**
 * Bundle the three regions into a single per-session object. Callers
 * own the instance for the lifetime of a session and call
 * `toMessages()` to materialise the request payload.
 */
export class ContextRegions {
  readonly prefix: ImmutablePrefix;
  readonly log: AppendOnlyLog;
  readonly scratch: VolatileScratch;

  constructor(prefixOpts: ImmutablePrefixOptions) {
    this.prefix = new ImmutablePrefix(prefixOpts);
    this.log = new AppendOnlyLog();
    this.scratch = new VolatileScratch();
  }

  /**
   * Flatten the prefix + log into a single message list for the chat
   * completions request. Volatile scratch is not included by design —
   * it never reaches the wire.
   */
  toMessages(): ChatMessage[] {
    return [...this.prefix.toMessages(), ...this.log.toMessages()];
  }

  /**
   * Snapshot the prefix fingerprint at the moment of the call. Useful
   * to attach to per-turn telemetry (item 10) so we can detect
   * prefix-churn turns after the fact.
   */
  get prefixFingerprint(): string {
    return this.prefix.fingerprint;
  }
}

/**
 * Compute the cache-stable prefix fingerprint for an outbound chat
 * request without owning a `ContextRegions` instance. The stable
 * slice is:
 *
 *   - The first system message (only one is expected).
 *   - Every subsequent message marked `meta.pinned === true`
 *     (item 9's anchor cards).
 *   - The full tool-spec list (order significant).
 *
 * The append-only log is intentionally NOT part of the fingerprint —
 * that's the part that churns turn-to-turn and is expected to land
 * in the provider's append-region cache slot.
 *
 * Use this in the LLM-call boundary so tracing can correlate "the
 * provider returned a cache miss" with "the fingerprint changed since
 * the previous turn".
 */
export function computePrefixFingerprint(
  messages: readonly ChatMessage[],
  tools: readonly ToolSpec[] | readonly { name: string; description?: string; inputSchema?: unknown }[] | undefined,
): string {
  const prefixSlice: ChatMessage[] = [];
  let sawSystem = false;
  for (const m of messages) {
    if (!sawSystem && m.role === 'system') {
      prefixSlice.push({ role: m.role, content: m.content });
      sawSystem = true;
      continue;
    }
    if (m.meta && (m.meta as any).pinned === true) {
      prefixSlice.push({ role: m.role, content: m.content, meta: { pinned: true } });
    }
  }
  const normalisedTools = Array.isArray(tools) ? tools.map(t => {
    // OpenAI shape (`function.name`) and MCP shape (`name`) both flatten to
    // the same canonical form here so the fingerprint stays stable across
    // either representation. The agent passes the OpenAI shape post-build
    // but tests sometimes pass the raw MCP shape.
    if ('function' in t && t.function) return { name: t.function.name, params: t.function.parameters };
    return { name: (t as any).name, params: (t as any).inputSchema };
  }) : [];
  const blob = JSON.stringify({ prefix: prefixSlice, tools: normalisedTools });
  return createHash('sha256').update(blob).digest('hex').slice(0, 16);
}

// ---- internals --------------------------------------------------------

function toolSpecsEqual(a: readonly ToolSpec[], b: readonly ToolSpec[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

function chatMessagesEqual(a: readonly ChatMessage[], b: readonly ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

/**
 * `structuredClone` is Node 17+ global; the BrainRouter CLI targets
 * Node ≥18 (engines field on the root package), so this branch is
 * effectively the no-op default. Wrap it anyway so a future
 * environment without it falls back to JSON round-trip.
 */
function structuredCloneCompat<T>(value: T): T {
  if (typeof (globalThis as any).structuredClone === 'function') {
    return (globalThis as any).structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}
