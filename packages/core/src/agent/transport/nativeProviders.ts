import { stripTrailingSlashes } from '../../util/trimEdges.js';
/**
 * Native (non-OpenAI-compatible) provider wire adapters.
 *
 * BrainRouter's default path speaks OpenAI Chat-Completions / Responses, and
 * reaches Anthropic and Gemini through their official OpenAI-compatible shim
 * endpoints. Those shims are convenient but lossy — they don't expose the full
 * native surface (Anthropic's `system` array + content blocks, Gemini's
 * `contents`/`functionCall` model). These adapters add the REAL native wire
 * formats so a user can opt a provider into them via
 * `cli.providerRequestFormat[<provider>] = 'anthropic-messages' | 'gemini-generate'`.
 *
 * Design contract: these functions are PURE shape-translators over the SAME
 * OpenAI-clean message list that `buildChatCompletionPayload` consumes (the
 * agent maps prompt-layers / system / tagged-content BEFORE calling here). That
 * keeps the proven message normalization in one place and limits this module to
 * format translation, which is exhaustively unit-tested. The network glue
 * (timeouts, abort, semaphore, retry) stays in `agent.ts`.
 *
 * Default behavior is UNCHANGED: nothing here runs unless a provider is
 * explicitly opted in. The internal return shape mirrors `callOpenAI`'s:
 * `{ content, toolCalls?, usage?, finishReason? }`.
 */

/** An OpenAI chat content part — plain text or an inline image (data-URL). A
 *  user message that carries a pasted screenshot arrives here as an array of
 *  these (text + image_url), produced by `mapChatCompletionMessage`. */
export type CleanContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** OpenAI-clean message, post-`mapChatCompletionMessage`. `content` is normally
 *  a string; a vision user turn carries an array of text + image_url parts. */
export interface CleanMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | CleanContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

/** OpenAI tool spec as the agent holds it (name/description/inputSchema). */
export interface CleanTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** OpenAI forced-tool choice (or undefined / 'auto'). */
export type CleanToolChoice = 'auto' | { type?: string; function?: { name?: string } } | undefined;

export interface NativeBuildInput {
  model: string;
  /** Concatenated system text (already extracted from prompt-layers/system msgs). */
  system: string;
  /** Non-system messages, OpenAI-clean. */
  messages: CleanMessage[];
  tools: CleanTool[];
  toolChoice?: CleanToolChoice;
  /** Anthropic requires max_tokens; callers pass a resolved value. */
  maxTokens?: number;
}

/** Internal normalized output shape — identical to `callOpenAI`'s return. */
export interface NativeOutput {
  content: string;
  toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; [k: string]: unknown };
  finishReason?: string;
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof (part as any)?.text === 'string' ? (part as any).text : ''))
      .join('');
  }
  if (typeof (content as any)?.text === 'string') return (content as any).text;
  return '';
}

/** Parse a `data:<mime>;base64,<payload>` URL into its parts (null if not one). */
function parseImageDataUrl(url: unknown): { mediaType: string; dataBase64: string } | null {
  if (typeof url !== 'string') return null;
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url.trim());
  return m ? { mediaType: m[1], dataBase64: m[2] } : null;
}

/** Extract inline images from OpenAI `image_url` content parts (vision turns).
 *  A string/empty content yields none — the common, no-image case. */
function imagePartsFromContent(content: unknown): Array<{ mediaType: string; dataBase64: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ mediaType: string; dataBase64: string }> = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as any).type === 'image_url') {
      const parsed = parseImageDataUrl((part as any).image_url?.url);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function safeParseObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function forcedToolName(choice: CleanToolChoice): string | undefined {
  if (!choice || choice === 'auto') return undefined;
  const name = choice.function?.name;
  return typeof name === 'string' && name ? name : undefined;
}

// ---------------------------------------------------------------------------
// Anthropic — POST {base}/messages, auth via `x-api-key` + `anthropic-version`.
// ---------------------------------------------------------------------------

export const ANTHROPIC_VERSION = '2023-06-01';
/** Conservative default when the user hasn't set `cli.maxOutputTokens`. Every
 *  current Claude model accepts 8192; the cut-off → 'length' notice tells the
 *  user to raise `cli.maxOutputTokens` if a long answer is clipped. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

interface AnthropicBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  source?: { type: 'base64'; media_type: string; data: string };
}
interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicBlock[] }

export interface AnthropicPayload {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  tool_choice?: { type: 'auto' } | { type: 'tool'; name: string };
}

export function buildAnthropicMessagesPayload(input: NativeBuildInput): AnthropicPayload {
  const messages: AnthropicMessage[] = [];

  for (const m of input.messages) {
    if (m.role === 'tool') {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: String(m.tool_call_id ?? ''),
        content: asText(m.content),
      };
      // Anthropic wants all tool results for a turn grouped in ONE user message;
      // merge consecutive tool results into the trailing user carrier.
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'user' && prev.content.every((b) => b.type === 'tool_result')) {
        prev.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const content: AnthropicBlock[] = [];
      const text = asText(m.content);
      if (text.trim()) content.push({ type: 'text', text });
      for (const call of m.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: String(call?.id ?? ''),
          name: String(call?.function?.name ?? ''),
          input: safeParseObject(call?.function?.arguments),
        });
      }
      // Anthropic rejects an assistant turn with zero content blocks; drop it.
      if (content.length === 0) continue;
      messages.push({ role: 'assistant', content });
      continue;
    }

    // user (and any unexpected role) → a text block plus any inline image blocks
    // (vision turns). Anthropic wants base64 images as `image` source blocks.
    const userBlocks: AnthropicBlock[] = [];
    const userText = asText(m.content);
    if (userText) userBlocks.push({ type: 'text', text: userText });
    for (const img of imagePartsFromContent(m.content)) {
      userBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } });
    }
    if (userBlocks.length === 0) userBlocks.push({ type: 'text', text: '' });
    messages.push({ role: 'user', content: userBlocks });
  }

  const payload: AnthropicPayload = {
    model: input.model,
    max_tokens: input.maxTokens && input.maxTokens > 0 ? Math.floor(input.maxTokens) : ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  };
  if (input.system.trim()) payload.system = input.system;
  if (input.tools.length > 0) {
    payload.tools = input.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));
    const forced = forcedToolName(input.toolChoice);
    payload.tool_choice = forced ? { type: 'tool', name: forced } : { type: 'auto' };
  }
  return payload;
}

function mapAnthropicStop(stop: unknown): string | undefined {
  switch (stop) {
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence': return 'stop';
    default: return typeof stop === 'string' ? stop : undefined;
  }
}

export function normalizeAnthropicOutput(data: any, endpoint: string, model: string): NativeOutput {
  if (data && typeof data === 'object' && (data.type === 'error' || data.error)) {
    const err = data.error;
    const msg = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err ?? data).slice(0, 400));
    throw new Error(`Anthropic endpoint returned an error envelope (HTTP 200): ${msg}`);
  }
  if (!Array.isArray(data?.content)) {
    throw new Error(
      `Anthropic endpoint returned no content. Model "${model}" at ${endpoint} may not support the Messages API ` +
      `or be misconfigured. Response body: ${JSON.stringify(data).slice(0, 600)}`,
    );
  }

  let content = '';
  const toolCalls: NonNullable<NativeOutput['toolCalls']> = [];
  for (const block of data.content) {
    if (block?.type === 'text' && typeof block.text === 'string') content += block.text;
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id ?? ''),
        type: 'function',
        function: {
          name: String(block.name ?? ''),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // `thinking` blocks are intentionally ignored (not surfaced as content).
  }

  const usage = data.usage && typeof data.usage === 'object'
    ? {
        prompt_tokens: typeof data.usage.input_tokens === 'number' ? data.usage.input_tokens : undefined,
        completion_tokens: typeof data.usage.output_tokens === 'number' ? data.usage.output_tokens : undefined,
        total_tokens:
          (typeof data.usage.input_tokens === 'number' ? data.usage.input_tokens : 0) +
          (typeof data.usage.output_tokens === 'number' ? data.usage.output_tokens : 0),
        ...data.usage,
      }
    : undefined;

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    finishReason: mapAnthropicStop(data.stop_reason),
  };
}

// ---------------------------------------------------------------------------
// Gemini — POST {base}/models/{model}:generateContent, auth via `x-goog-api-key`.
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }

export interface GeminiPayload {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }>;
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY'; allowedFunctionNames?: string[] } };
  generationConfig?: { maxOutputTokens: number };
}

/** Gemini's function `parameters` accept only a subset of JSON Schema (an
 *  OpenAPI 3.0 dialect). Strip the keys that most commonly trigger a 400 —
 *  `$schema`, `$ref`, `$defs`/`definitions`, and `additionalProperties` — while
 *  leaving the structural keywords (type/properties/items/required/enum) intact.
 *  Best-effort: a deep clone so the caller's schema is never mutated. */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === '$schema' || key === '$ref' || key === '$defs' || key === 'definitions' || key === 'additionalProperties') continue;
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
}

export function buildGeminiGeneratePayload(input: NativeBuildInput): GeminiPayload {
  const contents: GeminiContent[] = [];

  for (const m of input.messages) {
    if (m.role === 'tool') {
      const part: GeminiPart = {
        functionResponse: {
          name: String(m.name ?? ''),
          // `response` must be a struct; wrap a non-object result.
          response: ((): Record<string, unknown> => {
            const parsed = safeParseObject(m.content);
            return Object.keys(parsed).length > 0 ? parsed : { result: asText(m.content) };
          })(),
        },
      };
      const prev = contents[contents.length - 1];
      if (prev && prev.role === 'user' && prev.parts.every((p) => 'functionResponse' in p)) {
        prev.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      const text = asText(m.content);
      if (text.trim()) parts.push({ text });
      for (const call of m.tool_calls ?? []) {
        parts.push({
          functionCall: {
            name: String(call?.function?.name ?? ''),
            args: safeParseObject(call?.function?.arguments),
          },
        });
      }
      if (parts.length === 0) continue;
      contents.push({ role: 'model', parts });
      continue;
    }

    // user → a text part plus any inline image parts (vision turns). Gemini
    // takes base64 images as `inlineData` parts.
    const userParts: GeminiPart[] = [];
    const gUserText = asText(m.content);
    if (gUserText) userParts.push({ text: gUserText });
    for (const img of imagePartsFromContent(m.content)) {
      userParts.push({ inlineData: { mimeType: img.mediaType, data: img.dataBase64 } });
    }
    if (userParts.length === 0) userParts.push({ text: '' });
    contents.push({ role: 'user', parts: userParts });
  }

  const payload: GeminiPayload = { contents };
  if (input.system.trim()) payload.systemInstruction = { parts: [{ text: input.system }] };
  if (input.tools.length > 0) {
    payload.tools = [{
      functionDeclarations: input.tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: sanitizeGeminiSchema(t.inputSchema || { type: 'object', properties: {} }),
      })),
    }];
    const forced = forcedToolName(input.toolChoice);
    payload.toolConfig = {
      functionCallingConfig: forced ? { mode: 'ANY', allowedFunctionNames: [forced] } : { mode: 'AUTO' },
    };
  }
  if (input.maxTokens && input.maxTokens > 0) {
    payload.generationConfig = { maxOutputTokens: Math.floor(input.maxTokens) };
  }
  return payload;
}

function mapGeminiFinish(reason: unknown, hadToolCall: boolean): string | undefined {
  if (hadToolCall) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS': return 'length';
    case 'STOP': return 'stop';
    default: return typeof reason === 'string' ? reason.toLowerCase() : undefined;
  }
}

export function normalizeGeminiOutput(data: any, endpoint: string, model: string): NativeOutput {
  if (data && typeof data === 'object' && data.error) {
    const msg = typeof data.error === 'string' ? data.error : (data.error?.message ?? JSON.stringify(data.error).slice(0, 400));
    throw new Error(`Gemini endpoint returned an error envelope (HTTP 200): ${msg}`);
  }
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : undefined;
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) {
    // A safety block (no candidate parts) is reported via promptFeedback.
    const blocked = data?.promptFeedback?.blockReason;
    if (blocked) throw new Error(`Gemini blocked the request (${blocked}) at ${endpoint} for model "${model}".`);
    throw new Error(
      `Gemini endpoint returned no candidate content. Model "${model}" at ${endpoint} may not support generateContent ` +
      `or be misconfigured. Response body: ${JSON.stringify(data).slice(0, 600)}`,
    );
  }

  let content = '';
  const toolCalls: NonNullable<NativeOutput['toolCalls']> = [];
  let idx = 0;
  for (const part of parts) {
    if (typeof part?.text === 'string') content += part.text;
    else if (part?.functionCall) {
      const name = String(part.functionCall.name ?? '');
      toolCalls.push({
        // Gemini function calls carry no id; synthesize a stable one. The tool
        // RESULT is matched back to Gemini by function NAME, not this id, so the
        // synthetic value only has to be unique within this turn for the loop.
        id: `call_${name || 'fn'}_${idx}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
      });
    }
    idx += 1;
  }

  const u = data?.usageMetadata;
  const usage = u && typeof u === 'object'
    ? {
        prompt_tokens: typeof u.promptTokenCount === 'number' ? u.promptTokenCount : undefined,
        completion_tokens: typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : undefined,
        total_tokens: typeof u.totalTokenCount === 'number' ? u.totalTokenCount : undefined,
      }
    : undefined;

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    finishReason: mapGeminiFinish(candidate?.finishReason, toolCalls.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Request spec — per-format URL + auth headers. Endpoint is the base the agent
// already resolved (compat base); native paths derive their URL from it.
// ---------------------------------------------------------------------------

export type NativeRequestFormat = 'anthropic-messages' | 'gemini-generate';

export function isNativeRequestFormat(format: string): format is NativeRequestFormat {
  return format === 'anthropic-messages' || format === 'gemini-generate';
}

/** Compute the POST URL + headers for a native call. `endpoint` is the resolved
 *  base (e.g. `https://api.anthropic.com/v1` or
 *  `https://generativelanguage.googleapis.com/v1beta/openai`). Anthropic's
 *  native base equals its compat base (`/v1` + `/messages`); Gemini's native
 *  base drops the `/openai` compat suffix. */
export function nativeRequestSpec(
  format: NativeRequestFormat,
  endpoint: string,
  model: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  const base = stripTrailingSlashes(endpoint);
  if (format === 'anthropic-messages') {
    return {
      url: `${base}/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    };
  }
  // gemini-generate — strip the OpenAI-compat suffix to reach the native surface.
  const nativeBase = base.replace(/\/openai$/, '');
  return {
    url: `${nativeBase}/models/${encodeURIComponent(model)}:generateContent`,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
  };
}
