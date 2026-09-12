/**
 * ADR-058 D13 — Matilda's DSML tool-call markup.
 *
 * Matilda does not emit OpenAI `tool_calls`. On its native chat surface the
 * model writes a tool call INTO THE TEXT STREAM as a DSML block, and the client
 * intercepts it. Two payload dialects exist and both are accepted here:
 *
 *   1. The SDK's documented contract — a JSON object between the markers:
 *        <｜DSML｜tool_call>{"name":"read_file","arguments":{"path":"…"}}</｜DSML｜tool_call>
 *   2. The form the live model actually emits (2026-09) — parameter elements:
 *        <｜DSML｜tool_call>
 *        <｜DSML｜parameter name="name" string="true">read_file</｜DSML｜parameter>
 *        <｜DSML｜parameter name="arguments" string="true">{"path":"…"}</｜DSML｜parameter>
 *        </｜DSML｜tool_call>
 *
 * The bars are the FULLWIDTH VERTICAL LINE (U+FF5C), not ASCII `|`. Pure and
 * browser-safe.
 */

const BAR = '｜';
export const DSML_TOOL_CALL_OPEN = `<${BAR}DSML${BAR}tool_call>`;
export const DSML_TOOL_CALL_CLOSE = `</${BAR}DSML${BAR}tool_call>`;
const PARAM_RE = new RegExp(
  `<${BAR}DSML${BAR}parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)</${BAR}DSML${BAR}parameter>`,
  'g',
);

export interface DsmlToolCall {
  name: string;
  /** JSON text — always a valid JSON document (non-JSON argument text is wrapped as `{"input": …}`). */
  arguments: string;
  id?: string;
}

function argumentsJson(raw: unknown): string {
  if (raw === undefined || raw === null) return '{}';
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return '{}';
    try { JSON.parse(text); return text; } catch { return JSON.stringify({ input: raw }); }
  }
  return JSON.stringify(raw);
}

/** Parse the payload found between the markers. Returns null when neither
 *  dialect yields a tool name — the caller then treats the block as plain text. */
export function parseDsmlToolCallPayload(payload: string): DsmlToolCall | null {
  const text = payload.trim();
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.name === 'string' && j.name) {
        return { name: j.name, arguments: argumentsJson(j.arguments ?? j.args), ...(typeof j.id === 'string' ? { id: j.id } : {}) };
      }
    } catch { /* not the JSON dialect — fall through */ }
  }
  const params: Record<string, string> = {};
  for (const m of text.matchAll(PARAM_RE)) params[m[1]] = m[2].trim();
  if (typeof params.name === 'string' && params.name) {
    return { name: params.name, arguments: argumentsJson(params.arguments ?? params.args), ...(params.id ? { id: params.id } : {}) };
  }
  return null;
}

export interface DsmlInterceptor {
  /** Feed a text delta. Visible text is forwarded as soon as it cannot be part of a marker. */
  push(delta: string): void;
  /** End of stream: forward any held text; an unterminated block is forwarded verbatim. */
  flush(): void;
  /** The server discarded the text so far (`replace` event): drop held state. */
  reset(): void;
}

/**
 * Streaming interceptor. Everything outside a complete `tool_call` block goes to
 * `onText`; each complete, parseable block goes to `onToolCall` and is removed
 * from the visible text. A partial OPEN marker at the end of the buffer is held
 * back (never leaked) until the next delta disambiguates it — a marker can arrive
 * split across arbitrary token boundaries.
 */
export function createDsmlInterceptor(
  onText: (text: string) => void,
  onToolCall: (call: DsmlToolCall) => void,
): DsmlInterceptor {
  let buffer = '';
  let inBlock = false;

  /** Longest suffix of `text` that is a proper prefix of `tag`. */
  const partialSuffixLen = (text: string, tag: string): number => {
    const max = Math.min(text.length, tag.length - 1);
    for (let len = max; len > 0; len--) {
      if (tag.startsWith(text.slice(text.length - len))) return len;
    }
    return 0;
  };

  const drain = (flushing: boolean): void => {
    for (;;) {
      if (!inBlock) {
        const openIdx = buffer.indexOf(DSML_TOOL_CALL_OPEN);
        if (openIdx === -1) {
          if (flushing) { if (buffer) onText(buffer); buffer = ''; return; }
          const held = partialSuffixLen(buffer, DSML_TOOL_CALL_OPEN);
          const emit = buffer.slice(0, buffer.length - held);
          if (emit) onText(emit);
          buffer = buffer.slice(buffer.length - held);
          return;
        }
        if (openIdx > 0) onText(buffer.slice(0, openIdx));
        buffer = buffer.slice(openIdx + DSML_TOOL_CALL_OPEN.length);
        inBlock = true;
      }
      const closeIdx = buffer.indexOf(DSML_TOOL_CALL_CLOSE);
      if (closeIdx === -1) {
        if (!flushing) return; // wait for the rest of the block
        onText(DSML_TOOL_CALL_OPEN + buffer); // unterminated at end of stream — surface verbatim
        buffer = '';
        inBlock = false;
        return;
      }
      const payload = buffer.slice(0, closeIdx);
      buffer = buffer.slice(closeIdx + DSML_TOOL_CALL_CLOSE.length);
      inBlock = false;
      const call = parseDsmlToolCallPayload(payload);
      if (call) onToolCall(call);
      else onText(DSML_TOOL_CALL_OPEN + payload + DSML_TOOL_CALL_CLOSE); // unparseable — keep it visible rather than lose it
    }
  };

  return {
    push: (delta) => { buffer += delta; drain(false); },
    flush: () => drain(true),
    reset: () => { buffer = ''; inBlock = false; },
  };
}
