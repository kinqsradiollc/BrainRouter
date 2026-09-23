/**
 * ADR-058 D13 — Matilda's NATIVE chat surface (`POST …/api/chat`, SSE).
 *
 * Why a native adapter: Matilda's OpenAI-compatible endpoint ignores `tools`
 * entirely; tool calling exists only here, where the server templates
 * `clientTools` for the model and the model answers with DSML blocks in the
 * token stream (see ./dsml.ts). Everything in this file is what the live
 * endpoint measured, not what the docs implied:
 *
 *  - Body: `{ messages, clientTools?, conversation_id, responseMode:'auto' }`.
 *    `input` is an SDK convenience (400 on the wire); `role:'system'` is rejected
 *    (400); `role:'assistant'` history IS accepted. The server never restores
 *    context from `conversation_id` (with or without `persist`) — so the full
 *    user+assistant history travels every turn, exactly like the OpenAI path,
 *    and `conversation_id` is only a per-session grouping key.
 *  - Instructions PREFIXED onto the task message suppress client-tool calls
 *    (0/3 at every length, neutral or real text); the SAME instructions as their
 *    own prior user message, ending with an explicit client-tools hint, restore
 *    them (3/3 with BrainRouter's real prompt). So the system prompt is sent as
 *    `messages[0]` + the hint, and the task stays its own clean message.
 *  - `responseMode:'auto'` is required for client tools (omitted/deep/instant →
 *    server-side tools run instead; 0/3). The SDK's "code specialist" routing
 *    intent text also suppresses them — it is deliberately NOT sent.
 *  - Limits: 64 KiB request body (403 at the edge), ≤64 `clientTools` (400),
 *    ~20k dense chars per message (422). No OpenAI-style `model` field.
 *  - Tool results go back as a user message `[Client tool result: <name>]\n…`
 *    (the SDK's own roundtrip shape).
 *
 * Browser-safe: no node:* imports.
 */
import type { CleanMessage, CleanTool, NativeBuildInput, NativeOutput } from '../../../agent/transport/nativeProviders.js';
import { sseEvents, type NativeStreamHandlers } from '../../../agent/transport/nativeProviderStream.js';
import { HISTORY_RESERVE_FOR_TOOLS_BYTES, capMessageContent, elideOldestToolResultsToBudget, elidedToolResultNote, utf8Bytes } from '../../requestLimits.js';
import { pinnedToolNames, rankAndCapTools } from '../../../tool/policy/toolBudget.js';
import { createDsmlInterceptor, newToolCallId } from './dsml.js';
import { promisedToolsGuardMessage } from '../../../agent/runtime/turnGuardMessages.js';

export const MATILDA_NATIVE_LIMITS = {
  /** Edge-enforced request-body cap: 65 536 bytes → 200, 65 537 → 403. */
  maxBodyBytes: 65_536,
  /** `clientTools must contain no more than 64 elements` (400). */
  maxClientTools: 64,
  /** Conservative per-message cap under the ~20k-char 422 boundary. */
  maxMessageChars: 16_000,
  /** `clientTools.N.description must be shorter than or equal to 2000 characters` (400). */
  maxToolDescriptionChars: 2_000,
  /** What a description is ALLOWED to cost here: its lead sentences. Measured on a
   *  real turn, 41 tools cost 47 KB of the 64 KiB — 19k chars of description and
   *  25 KB of schema — leaving nothing for history; the model reads a schema, not
   *  a manual. Cut at a sentence boundary past this many chars. */
  toolDescriptionBudgetChars: 320,
  /** Room for the "advertised now: …" name list at the end of the instructions. */
  advertisedNamesChars: 600,
} as const;

/** Lead sentences of a description within `budget` chars (sentence boundary when
 *  one exists past half the budget), never over the validator's `hardMax`. */
export function budgetToolDescription(text: string, budget: number, hardMax: number): string {
  const t = text.trim();
  const cap = Math.min(budget, hardMax);
  if (t.length <= cap) return t;
  const head = t.slice(0, cap);
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.endsWith('.') ? head.length - 1 : -1);
  if (lastStop >= Math.floor(cap / 2)) return head.slice(0, lastStop + 1);
  return `${head.slice(0, cap - 1)}…`;
}

const SCHEMA_DROP_KEYS = new Set(['title', 'examples', 'default', '$schema', '$comment', 'deprecated']);
const SCHEMA_DESCRIPTION_CHARS = 100;

/** A JSON Schema fit for the wire budget: property descriptions clipped, doc-only
 *  keywords dropped, structure (type/properties/required/enum/items/…) untouched. */
export function compactParameters(schema: unknown, descriptionChars: number = SCHEMA_DESCRIPTION_CHARS): unknown {
  if (Array.isArray(schema)) return schema.map((s) => compactParameters(s, descriptionChars));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (SCHEMA_DROP_KEYS.has(k)) continue;
    if (k === 'description' && typeof v === 'string') {
      out[k] = v.length > descriptionChars ? `${v.slice(0, descriptionChars - 1)}…` : v;
      continue;
    }
    out[k] = typeof v === 'object' && v !== null ? compactParameters(v, descriptionChars) : v;
  }
  return out;
}

/**
 * How much prose each part of the request may cost, in two tiers. The whole
 * enabled tool surface is worth more to the turn than any of this prose: when
 * the standard tier cannot carry every tool the runtime offered (≤ 64), the
 * tight tier trims descriptions, schema notes, the instructions block and old
 * tool results FIRST — and only if even that cannot hold the surface does the
 * fit start dropping tools (pinned ones last).
 */
export interface MatildaBudgetTier {
  /** Lead-sentence budget for a tool description. */
  descriptionChars: number;
  /** Cap for a schema property's `description`. */
  schemaDescriptionChars: number;
  /** Room for the instructions block (`messages[0]`, incl. the hint). */
  instructionsChars: number;
  /** Cap for a tool RESULT message in the history (fresh text, not instructions). */
  toolResultChars: number;
}
export const MATILDA_BUDGET_TIERS: readonly MatildaBudgetTier[] = [
  { descriptionChars: 320, schemaDescriptionChars: 100, instructionsChars: 16_000, toolResultChars: 16_000 },
  { descriptionChars: 200, schemaDescriptionChars: 60, instructionsChars: 12_000, toolResultChars: 8_000 },
];

/** `Client tools advertised now: a, b, c` — bounded; the tail is elided, never the head. */
export function advertisedNamesLine(names: string[], maxChars: number): string {
  const prefix = 'Client tools advertised now: ';
  let line = prefix + names.join(', ');
  if (line.length > maxChars) line = `${line.slice(0, maxChars - 1)}…`;
  return line;
}

/** The sentence that makes the model actually use advertised client tools
 *  (measured: bare task ~2/3, with this hint as the tail of `messages[0]` 3/3). */
export const MATILDA_CLIENT_TOOLS_HINT =
  'You have CLIENT TOOLS advertised for this turn (listed by the platform). When a task needs one, call it by ' +
  'emitting a DSML tool call block for that tool — do not describe the call in prose and do not claim you lack the tool. ' +
  'The workspace, its files and its code exist ONLY on the client: the platform\'s own tools (code_exec, rag_query, ' +
  'spreadsheet operations, built-in web search) run in a separate sandbox that cannot see them — never use those to ' +
  'inspect this workspace. For anything about this workspace call the client tools (list_dir, read_file, grep_search, ' +
  'glob_files) first, in this reply, before answering.';

/**
 * ADR-058 D22 — the re-ask after a sandbox detour. Measured through the capture
 * proxy on the real turn that ran out of steps: a task-shaped last message
 * ("are there any improvements we can do?") is routed by the platform's
 * orchestrator to its own code sandbox — which cannot see the workspace and
 * does not template the client tools — 5/5, with or without the hint, and burns
 * the per-request step budget there. What the platform routes to the client
 * tools instead is the shape BrainRouter's own runtime produces a turn later:
 * the model's announcement as the assistant turn, then the promise guard as the
 * last user message — a client tool call 6/6 across the replayed and the real
 * desktop follow-ups. Shorter notes were not reliable (a bare question 2/4, a
 * note naming the "code sandbox" back to the sandbox 2/2, a guard-styled
 * paraphrase once looped on empty DSML openers until the upstream timeout). So
 * after the platform starts its sandbox the adapter cuts the stream and asks
 * ONCE more in exactly that shape — the same correction, without the wasted call.
 */
export const MATILDA_REASK_QUESTION =
  'Which client tool call (list_dir, read_file, grep_search or glob_files) do you emit first? Emit it now as a DSML tool call block.';
export function matildaReaskNote(): string {
  return `${promisedToolsGuardMessage()}\n\n${MATILDA_REASK_QUESTION}`;
}

/** The assistant turn the re-ask replies to when the platform took over before
 *  the model had said anything (the wire needs a non-empty one). */
export const MATILDA_REASK_FILLER = "I'll start by exploring the workspace to understand what we're working with.";

/** Thrown by the parser when the platform started its own code sandbox on a
 *  request that advertised client tools (and no client tool had been called):
 *  the transport asks once more with `reask` set. Carries the text painted so far. */
export class MatildaSandboxDetourError extends Error {
  readonly code = 'sandbox_detour';
  constructor(readonly textSoFar: string) {
    super('Matilda routed the request to its platform sandbox instead of the advertised client tools');
    this.name = 'MatildaSandboxDetourError';
  }
}

export interface MatildaParseOptions {
  /** Cut the stream (throw `MatildaSandboxDetourError`) the moment the platform
   *  starts its own code sandbox before any client tool call. Set on the first
   *  attempt of a request that advertised client tools; never on the re-ask. */
  cutOnSandboxDetour?: boolean;
  /** D24 — how many DSML open markers may arrive without a close before the
   *  stream is declared degenerate (the model looping on empty openers). */
  maxDegenerateOpeners?: number;
  /** D24 — the longest the stream may run with bytes arriving but NOTHING
   *  surfaced (no visible text, no reasoning line, no tool call, no provider
   *  activity) before it is declared degenerate. 0 disables. */
  quietOutputMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** D24 — the stream kept sending but could never become an answer: a loop of
 *  empty DSML openers, or minutes of events with nothing to surface. Retryable
 *  (the resilient wrapper and the router treat 502 + this code as transient). */
export class MatildaDegenerateOutputError extends Error {
  readonly code = 'degenerate_output';
  readonly status = 502;
  constructor(readonly reason: string) {
    super(`Matilda stream produced no usable output: ${reason}`);
    this.name = 'MatildaDegenerateOutputError';
  }
}
export const MATILDA_DEGENERATE_DEFAULTS = { maxDegenerateOpeners: 3, quietOutputMs: 45_000 } as const;

/** The platform's code-sandbox tool as it appears on the wire: `tool_start
 *  {"tool":"assistant","input":"Running code" | "Running python"}`. */
export function isSandboxToolStart(j: Record<string, unknown> | null): boolean {
  if (j?.tool !== 'assistant') return false;
  const input = typeof j.input === 'string' ? j.input.toLowerCase() : '';
  return input === '' || /\b(running|executing)\b/.test(input);
}

export interface MatildaChatMessage { role: 'user' | 'assistant'; content: string }
export interface MatildaClientTool { name: string; description: string; parameters: unknown }
export interface MatildaChatPayload {
  messages: MatildaChatMessage[];
  clientTools?: MatildaClientTool[];
  conversation_id: string;
  responseMode: 'auto';
  persist: false;
}

/** The roundtrip header the platform's own tool loop uses: a failed tool comes
 *  back as an error, not as a result the model might act on as if it succeeded. */
export function toolResultHeader(name: string, failed: boolean): string {
  return failed ? `[Client tool error: ${name}]` : `[Client tool result: ${name}]`;
}

/** Tool output is untrusted input: a page or file that happens to contain the
 *  roundtrip header must not be able to forge a second "result" inside the one
 *  message. Defanged, not removed, so the text is still readable. */
export function neutralizeToolResultHeaders(content: string): string {
  return content.replace(/\[Client tool (result|error):/g, '[client tool $1:');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('');
  }
  return String(content);
}

function latestUserText(messages: CleanMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return textOf(messages[i].content);
  }
  return '';
}

/** Per-session conversation ids (a grouping key only — see the header). Keyed by
 *  the calling session when the transport knows it, else by the conversation's
 *  first user message so the id is still stable across a session's turns. */
const conversationIds = new Map<string, string>();
export function matildaConversationIdFor(sessionKey: string | undefined, messages: CleanMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  const key = sessionKey?.trim() || `first:${textOf(first?.content).slice(0, 200)}`;
  let id = conversationIds.get(key);
  if (!id) {
    id = globalThis.crypto.randomUUID();
    conversationIds.set(key, id);
  }
  return id;
}

export interface MatildaBuildOptions {
  conversationId: string;
  /** D22 — the second attempt after a sandbox detour: what the model had said
   *  becomes the assistant turn and the promise guard + question the last user
   *  message (the history is otherwise unchanged). */
  reask?: { assistantText: string };
}

/** Build the native body from the transport's normalized input. */
export function buildMatildaChatPayload(input: NativeBuildInput, opts: MatildaBuildOptions): MatildaChatPayload {
  const { maxBodyBytes, maxClientTools } = MATILDA_NATIVE_LIMITS;
  const hasTools = input.tools.length > 0;
  const taskText = latestUserText(input.messages);
  const ranked = input.tools.map((t: CleanTool) => ({ name: t.name, description: t.description, tool: t }));
  const pinned = pinnedToolNames(taskText, ranked.map((r) => r.name));
  const max = Math.min(ranked.length, maxClientTools);

  // Tier by tier: the standard prose first; if it cannot carry every tool the
  // runtime offered, the tight prose; only then fewer tools (binary search on
  // the largest pinned-first, relevance-ranked top-k that fits).
  let built = buildAtTier(input, opts, MATILDA_BUDGET_TIERS[0], ranked, pinned, taskText);
  if (!hasTools) return built.payload;
  if (built.apply(max) <= maxBodyBytes) return built.payload;
  for (const tier of MATILDA_BUDGET_TIERS.slice(1)) {
    built = buildAtTier(input, opts, tier, ranked, pinned, taskText);
    if (built.apply(max) <= maxBodyBytes) return built.payload;
  }
  let lo = 0;
  let hi = max - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2); // ≥ 1 while lo < hi
    if (built.apply(mid) <= maxBodyBytes) lo = mid; else hi = mid - 1;
  }
  built.apply(lo);
  return built.payload;
}

interface RankedTool { name: string; description?: string; tool: CleanTool }

/** The body at one prose tier plus `apply(k)`: advertise the top-k tools (all when
 *  k ≥ offered, none when k = 0), refresh the advertised-names line, return the
 *  wire byte count. */
function buildAtTier(
  input: NativeBuildInput,
  opts: MatildaBuildOptions,
  tier: MatildaBudgetTier,
  ranked: RankedTool[],
  pinned: Set<string>,
  taskText: string,
): { payload: MatildaChatPayload; apply: (k: number) => number } {
  const { maxBodyBytes, maxMessageChars, maxToolDescriptionChars, advertisedNamesChars } = MATILDA_NATIVE_LIMITS;
  const hasTools = ranked.length > 0;
  const instructionsChars = Math.min(tier.instructionsChars, maxMessageChars);
  const toolResultChars = Math.min(tier.toolResultChars, maxMessageChars);
  const describe = (text: string | undefined): string => budgetToolDescription(text ?? '', tier.descriptionChars, maxToolDescriptionChars);
  const messages: MatildaChatMessage[] = [];

  // 1) The system prompt + the client-tools hint as their OWN prior user message.
  //    The hint ends with the NAMES of the tools actually advertised this turn
  //    (filled in after the byte fit), so the model's picture of its surface is
  //    the wire's — it once told the person it had no `list_dir` while the
  //    platform had templated a different subset.
  const system = input.system.trim();
  const instructionsIndex = system || hasTools ? 0 : -1;
  const instructionsMessage = (advertised: string[]): MatildaChatMessage => {
    const names = hasTools && advertised.length ? advertisedNamesLine(advertised, advertisedNamesChars) : '';
    const hint = hasTools ? [MATILDA_CLIENT_TOOLS_HINT, names].filter(Boolean).join('\n') : '';
    const room = Math.max(0, instructionsChars - (hint ? hint.length + 2 : 0));
    const sys = system ? (capMessageContent({ content: system }, room).content as string) : '';
    return { role: 'user', content: [sys, hint].filter(Boolean).join('\n\n') };
  };
  if (instructionsIndex === 0) messages.push(instructionsMessage([]));

  // 2) The clean history. user → user; assistant → its visible text plus a
  //    compact note of any tool calls it made; tool results → user messages in
  //    the SDK's roundtrip shape, capped at the tier's result budget. (The
  //    model's own DSML is never echoed back.)
  for (const m of input.messages) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: textOf(m.content) });
    } else if (m.role === 'assistant') {
      const parts = [textOf(m.content)];
      const calls = (m as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls ?? [];
      // A sentence, not a bracketed stub: a turn whose only content was
      // "[Called client tool: list_dir(…)]" was read back by the model as "a
      // message containing only a tool-call block" and it dropped the task.
      for (const tc of calls) parts.push(`I called the client tool ${tc.function?.name ?? 'tool'} with ${tc.function?.arguments || '{}'}; its result follows.`);
      const content = parts.filter(Boolean).join('\n');
      if (content) messages.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const name = (m as { name?: string }).name ?? 'tool';
      const failed = (m as { isError?: boolean }).isError === true;
      const body = neutralizeToolResultHeaders(textOf(m.content));
      messages.push(capMessageContent({ role: 'user', content: `${toolResultHeader(name, failed)}\n${body}` }, toolResultChars));
    }
  }

  // 2b) D22 — the re-ask: what the model said before the platform took over,
  //     then the runtime's promise guard + the question (the measured shape).
  if (opts.reask) {
    const said = opts.reask.assistantText.trim() || MATILDA_REASK_FILLER;
    messages.push(capMessageContent({ role: 'assistant', content: said }, toolResultChars));
    messages.push({ role: 'user', content: matildaReaskNote() });
  }

  const framed = (ms: MatildaChatMessage[]): MatildaChatPayload => ({
    messages: ms,
    conversation_id: opts.conversationId,
    responseMode: 'auto',
    // Agent turns are BrainRouter's, not the person's Matilda web-app chat
    // history: never persist them there (the official agent SDK sends the same).
    persist: false,
  });

  // 2c) D23 — the history must fit on its own. A session with eight 16k tool
  //     results is ~100 KB of messages; no tool cut can bring that under the
  //     64 KiB edge limit (403 "forbidden" before the model sees a byte). The
  //     oldest tool results are elided to a note (header kept, newest kept whole).
  const historyBudget = maxBodyBytes - 1_024 - (hasTools ? HISTORY_RESERVE_FOR_TOOLS_BYTES : 0);
  const isResult = (m: MatildaChatMessage): boolean => m.role === 'user' && /^\[Client tool (result|error): /.test(m.content);
  const fitted = elideOldestToolResultsToBudget<MatildaChatMessage>(messages.map((msg) => capMessageContent(msg, maxMessageChars)), historyBudget, {
    measure: (ms) => utf8Bytes(JSON.stringify(framed(ms))),
    isToolResult: isResult,
    contentChars: (m) => m.content.length,
    elide: (m) => {
      const nl = m.content.indexOf('\n');
      const header = nl === -1 ? m.content : m.content.slice(0, nl);
      return { role: m.role, content: `${header}\n${elidedToolResultNote(m.content.length - header.length)}` };
    },
  });
  const payload: MatildaChatPayload = framed(fitted);

  // 3) clientTools: pinned first (runtime-mandated, workspace essentials, named in
  //    the latest message), then the most task-relevant — the first live turns
  //    cut `profile_stage` on a question about the economy and the model, told
  //    to call it, rightly said no such tool existed.
  const apply = (k: number): number => {
    if (k <= 0 || !hasTools) {
      delete payload.clientTools;
      if (instructionsIndex === 0) payload.messages[0] = capMessageContent(instructionsMessage([]), maxMessageChars);
      return utf8Bytes(JSON.stringify(payload));
    }
    const kept = k >= ranked.length ? ranked : rankAndCapTools(ranked, taskText, k, { pinned }).kept;
    payload.clientTools = kept.map((r) => ({
      name: r.tool.name,
      description: describe(r.tool.description),
      parameters: compactParameters(r.tool.inputSchema ?? { type: 'object', properties: {} }, tier.schemaDescriptionChars),
    }));
    if (instructionsIndex === 0) payload.messages[0] = capMessageContent(instructionsMessage(kept.map((r) => r.tool.name)), maxMessageChars);
    return utf8Bytes(JSON.stringify(payload));
  };
  return { payload, apply };
}

const SERVER_TOOL_OUTPUT_PREVIEW_CHARS = 200;
const SERVER_TOOL_INPUT_PREVIEW_CHARS = 120;

/** The platform's own tools, named for a person: `search` is a web search,
 *  `assistant` is the code sandbox, `processing` the orchestrator's routing
 *  step, `memory` its memory lookup. Unknown names pass through. */
export function serverToolLabel(tool: string): string {
  const what = tool === 'search' ? 'web search' : tool === 'assistant' ? 'sandbox' : tool === 'processing' ? 'processing' : tool === 'memory' ? 'memory' : tool;
  return `Matilda ${what}`;
}

/** BrainRouter's own text to the model — a runtime guard correction or a client
 *  tool result — which the platform searches the web for on every round trip
 *  (measured; not switchable). Naming that is clearer than quoting it back. */
const RUNTIME_TEXT_RE = /^\s*(Runtime [a-z -]+guardrail tripped|\[[Cc]lient tool (result|error):|Task-tracking reminder:)/;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** What a server-side tool event is about, for the person: the search query (or
 *  "BrainRouter's own message" when the platform searched our guard text / a tool
 *  result), the sandbox's step, a progress message. '' when nothing readable. */
export function serverToolDetail(event: string, j: Record<string, unknown> | null): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : JSON.stringify(v));
  const tool = typeof j?.tool === 'string' && j.tool ? j.tool : 'tool';
  if (event === 'tool_start') {
    const input = str(j?.input ?? j?.inputOrArgs ?? j?.args);
    if (tool === 'search' && RUNTIME_TEXT_RE.test(input)) return "on BrainRouter's own message to it (a platform step, not a request)";
    if (tool === 'search' && input) return `"${clip(input, SERVER_TOOL_INPUT_PREVIEW_CHARS)}"`;
    return clip(input, SERVER_TOOL_INPUT_PREVIEW_CHARS);
  }
  if (event === 'tool_progress') return clip(str(j?.message), SERVER_TOOL_INPUT_PREVIEW_CHARS);
  if (tool === 'search') {
    const sources = Array.isArray(j?.sources) ? (j.sources as unknown[]).length : 0;
    const output = str(j?.output);
    const n = sources || (output.startsWith('Found sources:') ? output.split(' | ').length : 0);
    return n ? `${n} source${n === 1 ? '' : 's'}` : clip(output, SERVER_TOOL_OUTPUT_PREVIEW_CHARS);
  }
  return clip(str(j?.output), SERVER_TOOL_OUTPUT_PREVIEW_CHARS);
}

/** One reasoning-stream line for a server-side tool event, or '' when the
 *  payload carries nothing readable. Exported for tests. */
export function describeServerTool(event: string, j: Record<string, unknown> | null): string {
  const tool = typeof j?.tool === 'string' && j.tool ? j.tool : 'tool';
  const label = serverToolLabel(tool);
  const detail = serverToolDetail(event, j);
  if (event === 'tool_start') return `[${label}] ${detail || 'started'}\n`;
  if (event === 'tool_progress') return detail ? `[${label}] ${detail}\n` : '';
  const status = typeof j?.status === 'string' ? j.status : 'done';
  return `[${label} → ${status}]${detail ? ` ${detail}` : ''}\n`;
}

/**
 * Consume the native SSE stream into the transport's `NativeOutput`. Text
 * deltas pass through the DSML interceptor so tool calls never reach the
 * visible text; a `client_tool_call` event (the server-parsed form) is honoured
 * too, de-duplicated against any DSML block for the same call; `replace` drops
 * the text accumulated so far (the server restarted the answer); `error` throws.
 */
export async function parseMatildaChatStream(
  chunks: AsyncIterable<string>,
  handlers: NativeStreamHandlers,
  endpoint: string,
  model: string,
  parseOptions: MatildaParseOptions = {},
): Promise<NativeOutput> {
  let text = '';
  const toolCalls: NonNullable<NativeOutput['toolCalls']> = [];
  const seen = new Set<string>();
  let usage: NativeOutput['usage'];
  let endedEarly = false;
  // One call can reach us twice — as the DSML block in the token stream AND as
  // the server's parsed `client_tool_call` event — with the arguments serialized
  // differently (`{"path": "."}` vs `{"path":"."}`). Key on the parsed value so
  // the same call is recorded once, never as two calls the runtime then runs twice.
  const canonical = (args: string): string => {
    try {
      const parsed = JSON.parse(args) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? JSON.stringify(parsed, Object.keys(parsed as Record<string, unknown>).sort())
        : JSON.stringify(parsed);
    } catch { return args.trim(); }
  };
  const record = (name: string, args: string, id?: string): void => {
    const key = `${name} ${canonical(args)}`;
    if (seen.has(key)) return;
    seen.add(key);
    toolCalls.push({ id: id ?? newToolCallId('call_matilda'), type: 'function', function: { name, arguments: args } });
  };
  // D24 — "quiet output": bytes keep the stall watchdog fed, but a stream whose
  // tokens are all held inside an unclosable DSML block (or all unsurfaceable
  // events) paints nothing for minutes. Track the last SURFACED moment.
  const now = parseOptions.now ?? (() => Date.now());
  const quietMs = parseOptions.quietOutputMs ?? MATILDA_DEGENERATE_DEFAULTS.quietOutputMs;
  const maxOpeners = parseOptions.maxDegenerateOpeners ?? MATILDA_DEGENERATE_DEFAULTS.maxDegenerateOpeners;
  let lastSurfacedAt = now();
  let degenerateOpeners = 0;
  const surfaced = (): void => { lastSurfacedAt = now(); };
  // Always defined: a surfaceable event is progress whether or not a handler is listening (the non-stream path attaches none).
  const wrap = <T extends unknown[]>(fn?: (...a: T) => void) => (...a: T): void => { surfaced(); fn?.(...a); };
  const paint = { onTextDelta: wrap(handlers.onTextDelta), onReasoningDelta: wrap(handlers.onReasoningDelta), onProviderActivity: wrap(handlers.onProviderActivity) };
  const degenerate = (reason: string): never => {
    handlers.onReasoningDelta?.(`[Matilda's stream produced nothing usable — ${reason}; ending this attempt]\n`);
    handlers.onProviderActivity?.({ label: 'Matilda stream produced no usable output', detail: reason, ok: false });
    throw new MatildaDegenerateOutputError(reason);
  };
  const interceptor = createDsmlInterceptor(
    (t) => { text += t; surfaced(); paint.onTextDelta?.(t); },
    (call) => { surfaced(); record(call.name, call.arguments, call.id); },
    () => {
      degenerateOpeners += 1;
      if (degenerateOpeners >= maxOpeners) degenerate(`${degenerateOpeners} tool-call openers with no close`);
    },
  );

  for await (const ev of sseEvents(chunks)) {
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(ev.data) as Record<string, unknown>; } catch { j = null; }
    if (quietMs > 0 && now() - lastSurfacedAt > quietMs) {
      degenerate(`${Math.round((now() - lastSurfacedAt) / 1000)}s of events with nothing to show`);
    }
    switch (ev.event) {
      case 'token':
        if (typeof j?.content === 'string') interceptor.push(j.content);
        break;
      case 'thinking': {
        const t = typeof j?.content === 'string' ? j.content : typeof j?.text === 'string' ? j.text : '';
        if (t) paint.onReasoningDelta?.(t);
        break;
      }
      case 'client_tool_call':
        if (typeof j?.name === 'string') {
          const args = j.args && typeof j.args === 'object' ? j.args : {};
          record(j.name, JSON.stringify(args), typeof j.id === 'string' ? j.id : undefined);
        }
        break;
      case 'replace':
        interceptor.reset();
        text = '';
        break;
      // The platform's safety layer replaced the answer: the text so far is
      // withdrawn and the replacement (when one is given) is the answer. The
      // categories are recorded as reasoning activity so the person can see
      // WHY the answer changed; painted deltas cannot be recalled, but the
      // returned content — what the transcript keeps — is the replacement.
      case 'safety_replace': {
        interceptor.reset();
        const message = typeof j?.message === 'string' ? j.message : typeof j?.content === 'string' ? j.content : '';
        const categories = Array.isArray(j?.categories) ? (j.categories as unknown[]).filter((c): c is string => typeof c === 'string') : [];
        text = message;
        paint.onReasoningDelta?.(`[Matilda safety replaced the answer${categories.length ? `: ${categories.join(', ')}` : ''}]\n`);
        paint.onProviderActivity?.({ label: 'Matilda safety replaced the answer', ...(categories.length ? { detail: categories.join(', ') } : {}), ok: false });
        if (message) paint.onTextDelta?.(message);
        break;
      }
      case 'usage':
        if (j && typeof j === 'object') {
          usage = {
            ...(typeof j.input_tokens === 'number' ? { prompt_tokens: j.input_tokens } : {}),
            ...(typeof j.output_tokens === 'number' ? { completion_tokens: j.output_tokens } : {}),
            ...j,
          };
        }
        break;
      // Matilda's OWN tools (web `search`, code execution, URL reads) run on the
      // platform before the model answers and cannot be disabled. They are not
      // client tools, so they never become tool calls — but a person watching
      // the turn otherwise sees nothing happen while the answer arrives
      // pre-researched. Surface them as reasoning-stream activity, the channel
      // for "what the model did before it spoke". Wire shapes (measured):
      //   tool_start    {"tool":"search","input":"<query>"}
      //   tool_progress {"tool":"search","message":"…"}
      //   tool_result   {"tool":"search","status":"success","input":"…","output":"Found sources: …"}
      case 'tool_start':
      case 'tool_progress':
      case 'tool_result': {
        // D22 — the platform started its code sandbox on a request that offered
        // client tools, before any client tool was called: this attempt can only
        // end in a sandbox that cannot see the workspace (and, measured, in
        // `request_budget_exceeded`). Say so, cut it, and let the transport ask
        // once more in the shape the platform routes to the client tools.
        if (ev.event === 'tool_start' && parseOptions.cutOnSandboxDetour && toolCalls.length === 0 && isSandboxToolStart(j)) {
          interceptor.flush();
          paint.onReasoningDelta?.('[Matilda routed this request to its own code sandbox, which cannot see the workspace — asking again with the client tools]\n');
          paint.onProviderActivity?.({ label: 'Matilda routed the request to its own sandbox', detail: 'cannot see the workspace — asking again with the client tools', ok: false });
          throw new MatildaSandboxDetourError(text);
        }
        const line = describeServerTool(ev.event, j);
        if (line) paint.onReasoningDelta?.(line);
        if (line) {
          const tool = typeof j?.tool === 'string' && j.tool ? j.tool : 'tool';
          const detail = serverToolDetail(ev.event, j);
          if (ev.event === 'tool_start') paint.onProviderActivity?.({ label: serverToolLabel(tool), ...(detail ? { detail } : {}) });
          else if (ev.event === 'tool_result') paint.onProviderActivity?.({ label: `${serverToolLabel(tool)} finished`, ...(detail ? { detail } : {}), ok: j?.status !== 'error' });
        }
        break;
      }
      case 'error': {
        // Wire shape: {"code":"request_budget_exceeded","error":"The assistant
        // ran out of steps before it could finish."} — the text is under `error`.
        const code = typeof j?.code === 'string' && j.code ? j.code : 'unknown';
        const detail = typeof j?.error === 'string' ? j.error : typeof j?.message === 'string' ? j.message : ev.data;
        // A partial answer is worth more than an error. The platform's OWN step
        // or time budget (`request_budget_exceeded`, `deadline_exceeded`) can end
        // an answer it had already started: keep what was said, say why it
        // stopped, and let the turn finish — the official SDK keeps the text the
        // same way. With nothing said yet there is nothing to keep: throw, with
        // the code on the error so the router can decide whether to retry.
        if (text.trim() || toolCalls.length) {
          paint.onReasoningDelta?.(`[Matilda ended the answer early: ${code} — ${detail}]\n`);
          paint.onProviderActivity?.({ label: 'Matilda ended the answer early', detail: `${code} — ${detail}`, ok: false });
          if (toolCalls.length === 0) {
            const trailer = `\n\n_(Matilda stopped early: ${detail})_`;
            text += trailer;
            paint.onTextDelta?.(trailer);
          }
          endedEarly = true;
          break;
        }
        const err: Error & { status?: number; code?: string } = new Error(
          `matilda-chat stream error from ${endpoint} (${model}): ${code} ${detail}`.trim(),
        );
        err.code = code;
        throw err;
      }
      default:
        // stream_init, generation_status, status, cursor, truncated, done —
        // nothing to surface here.
        break;
    }
    if (endedEarly) break;
  }
  interceptor.flush();
  return {
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  };
}
