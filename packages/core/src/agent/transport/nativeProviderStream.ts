// ADR-041 A41-5 — provider-native SSE streaming for the Anthropic Messages and
// Gemini generateContent wire formats.
//
// Before this, `callOpenAIStream` issued a NON-streaming native call and surfaced
// the whole answer as one delta (llmTransport.ts). These parsers consume the
// providers' real SSE and emit incremental text/reasoning deltas as they arrive,
// then accumulate the events back into the SAME response shape the non-streaming
// path returns and hand it to the EXISTING normalizer — so the streamed
// `NativeOutput` (content, tool calls, usage, finish reason) is identical to what
// the whole-response path produced. The parsers are pure over an async iterable of
// raw body-text chunks, so they are unit-tested against captured SSE with no
// network.

import { normalizeAnthropicOutput, normalizeGeminiOutput, type NativeOutput } from './nativeProviders.js';

export interface NativeStreamHandlers {
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
}

interface SseEvent { event: string; data: string }

/**
 * Frame an async iterable of raw response-text chunks into SSE events. Chunk
 * boundaries are arbitrary (a single event may arrive across several reads, and
 * one read may carry several events), so the line buffer spans chunks. A blank
 * line dispatches the accumulated event; `data:` lines within one event join with
 * `\n` (the SSE spec); `:`-comment lines (heartbeats) are skipped.
 */
export async function* sseEvents(chunks: AsyncIterable<string>): AsyncGenerator<SseEvent> {
  let buffer = '';
  let event = '';
  let data = '';
  const flush = function* (): Generator<SseEvent> {
    if (data.length > 0) yield { event, data };
    event = '';
    data = '';
  };
  for await (const chunk of chunks) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        yield* flush();
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) {
        const piece = line.slice('data:'.length).replace(/^ /, '');
        data += data.length > 0 ? `\n${piece}` : piece;
      }
    }
  }
  yield* flush();
}

function safeJson(text: string): any | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse an Anthropic Messages SSE stream. Emits text/thinking deltas live and
 * rebuilds the canonical `{ content: [...], usage, stop_reason }` envelope so the
 * shared `normalizeAnthropicOutput` produces the final `NativeOutput`.
 */
export async function parseAnthropicMessageStream(
  chunks: AsyncIterable<string>,
  handlers: NativeStreamHandlers,
  endpoint: string,
  model: string,
): Promise<NativeOutput> {
  let text = '';
  let thinking = '';
  // Tool-use blocks accumulate their input JSON across `input_json_delta` events,
  // keyed by the block index the provider assigns.
  const toolBlocks = new Map<number, { id: string; name: string; partialJson: string }>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: string | undefined;

  for await (const { data } of sseEvents(chunks)) {
    if (data === '[DONE]') break;
    const json = safeJson(data);
    if (!json) continue;
    switch (json.type) {
      case 'message_start': {
        const u = json.message?.usage;
        if (typeof u?.input_tokens === 'number') inputTokens = u.input_tokens;
        if (typeof u?.output_tokens === 'number') outputTokens = u.output_tokens;
        break;
      }
      case 'content_block_start': {
        const block = json.content_block;
        if (block?.type === 'tool_use') {
          toolBlocks.set(json.index, { id: String(block.id ?? ''), name: String(block.name ?? ''), partialJson: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = json.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text;
          handlers.onTextDelta?.(delta.text);
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          thinking += delta.thinking;
          handlers.onReasoningDelta?.(delta.thinking);
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const b = toolBlocks.get(json.index);
          if (b) b.partialJson += delta.partial_json;
        }
        break;
      }
      case 'message_delta': {
        if (typeof json.usage?.output_tokens === 'number') outputTokens = json.usage.output_tokens;
        if (typeof json.delta?.stop_reason === 'string') stopReason = json.delta.stop_reason;
        break;
      }
      case 'error': {
        const msg = json.error?.message ?? JSON.stringify(json.error ?? json).slice(0, 400);
        throw new Error(`Anthropic stream error: ${msg}`);
      }
      // message_stop, content_block_stop, ping — nothing to accumulate.
      default:
        break;
    }
  }
  void thinking; // reasoning is streamed to the handler; not surfaced as content.

  const content: any[] = [];
  if (text) content.push({ type: 'text', text });
  for (const b of [...toolBlocks.values()]) {
    content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.partialJson ? (safeJson(b.partialJson) ?? {}) : {} });
  }
  const usage = inputTokens !== undefined || outputTokens !== undefined
    ? { input_tokens: inputTokens, output_tokens: outputTokens }
    : undefined;
  return normalizeAnthropicOutput({ content, usage, stop_reason: stopReason }, endpoint, model);
}

/**
 * Parse a Gemini `streamGenerateContent?alt=sse` stream. Each event's data is a
 * partial `GenerateContentResponse`; text parts stream live, and the parts,
 * finish reason, and usage accumulate into the canonical envelope for the shared
 * `normalizeGeminiOutput`.
 */
export async function parseGeminiStream(
  chunks: AsyncIterable<string>,
  handlers: NativeStreamHandlers,
  endpoint: string,
  model: string,
): Promise<NativeOutput> {
  let text = '';
  const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let finishReason: string | undefined;
  let usageMetadata: any;
  let promptFeedback: any;

  for await (const { data } of sseEvents(chunks)) {
    if (data === '[DONE]') break;
    const json = safeJson(data);
    if (!json) continue;
    if (json.error) {
      const msg = json.error?.message ?? JSON.stringify(json.error).slice(0, 400);
      throw new Error(`Gemini stream error: ${msg}`);
    }
    if (json.promptFeedback) promptFeedback = json.promptFeedback;
    if (json.usageMetadata) usageMetadata = json.usageMetadata;
    const candidate = Array.isArray(json.candidates) ? json.candidates[0] : undefined;
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text === 'string') {
          text += part.text;
          handlers.onTextDelta?.(part.text);
        } else if (part?.functionCall) {
          functionCalls.push({ name: String(part.functionCall.name ?? ''), args: part.functionCall.args ?? {} });
        }
      }
    }
  }

  // Rebuild one candidate whose parts carry the joined text then each function
  // call, in the order `normalizeGeminiOutput` expects (part index drives the
  // synthetic tool-call id, so text-first keeps ids stable across a turn).
  const parts: any[] = [];
  if (text) parts.push({ text });
  for (const fc of functionCalls) parts.push({ functionCall: { name: fc.name, args: fc.args } });
  const envelope: any = {
    candidates: [{ content: { role: 'model', parts }, finishReason }],
  };
  if (usageMetadata) envelope.usageMetadata = usageMetadata;
  if (promptFeedback) envelope.promptFeedback = promptFeedback;
  return normalizeGeminiOutput(envelope, endpoint, model);
}
