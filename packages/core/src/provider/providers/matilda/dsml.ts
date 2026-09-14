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
 *   3. The same parameter form with the model's OWN key names (seen live 2026-09,
 *      single-line, no `string` attribute):
 *        <｜DSML｜tool_call> <｜DSML｜parameter name="tool">list_dir</｜DSML｜parameter> <｜DSML｜parameter name="params">{"path": "."}</｜DSML｜parameter> </｜DSML｜tool_call>
 *      Any of name/tool/tool_name/function names the tool; any of
 *      arguments/args/params/parameters/input carries the arguments; and when
 *      no argument key is present, every OTHER parameter element is itself an
 *      argument (`<parameter name="path">.</parameter>`).
 *
 * The bars are the FULLWIDTH VERTICAL LINE (U+FF5C), not ASCII `|`. Pure and
 * browser-safe.
 */

const BAR = '｜';
export const DSML_TOOL_CALL_OPEN = `<${BAR}DSML${BAR}tool_call>`;
export const DSML_TOOL_CALL_CLOSE = `</${BAR}DSML${BAR}tool_call>`;
/** 4. Seen live 2026-09-14: the block closed with `</｜DSML｜invoke>` and carried
 *  ONE parameter whose NAME is the tool and whose text is the input —
 *  `<｜DSML｜parameter name="code_exec" class="inline">ls -la openSrc/</｜DSML｜parameter>`.
 *  Unlifted, the whole block leaked into the visible answer and the runtime's
 *  guards then argued with it for four rounds. */
export const DSML_TOOL_CALL_CLOSE_ALT = `</${BAR}DSML${BAR}invoke>`;
const PARAM_RE = new RegExp(
  `<${BAR}DSML${BAR}parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)</${BAR}DSML${BAR}parameter>`,
  'g',
);

/**
 * A tool-call id that is unique for the life of the process, not just within
 * one parsed response. The runtime pairs tool calls with their results BY ID
 * across the whole conversation; a per-response counter (`call_x_1` in every
 * model call of a turn) made a second call reuse the first one's id, the
 * pairing repair then saw the real result as already claimed and synthesized
 * "tool call orphaned by model" for a call that had in fact run.
 */
let toolCallSerial = 0;
const toolCallEpoch = Math.random().toString(36).slice(2, 8);
export function newToolCallId(prefix: string): string {
  toolCallSerial += 1;
  return `${prefix}_${toolCallEpoch}_${toolCallSerial}`;
}

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

const NAME_KEYS = ['name', 'tool', 'tool_name', 'function'] as const;
const ARG_KEYS = ['arguments', 'args', 'params', 'parameters', 'input'] as const;

/** First non-empty string under any of `keys`. */
function pick(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** A parameter element's text as a JSON value: JSON when it parses, else the string. */
function paramValue(text: string): unknown {
  const t = text.trim();
  if (!t) return '';
  try { return JSON.parse(t); } catch { return text; }
}

/** Parse the payload found between the markers. Returns null when no dialect
 *  yields a tool name — the caller then treats the block as plain text. */
export function parseDsmlToolCallPayload(payload: string): DsmlToolCall | null {
  const text = payload.trim();
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const name = pick(j, NAME_KEYS);
        if (name) {
          const argKey = ARG_KEYS.find((k) => j[k] !== undefined);
          return { name, arguments: argumentsJson(argKey ? j[argKey] : undefined), ...(typeof j.id === 'string' ? { id: j.id } : {}) };
        }
      }
    } catch { /* not the JSON dialect — fall through */ }
  }
  const params: Record<string, string> = {};
  for (const m of text.matchAll(PARAM_RE)) params[m[1]] = m[2].trim();
  let name = pick(params, NAME_KEYS);
  if (!name) {
    // Dialect 4: a single parameter element named after the tool itself, its
    // text the input (`name="code_exec"` → code_exec with {"input": "…"}).
    const keys = Object.keys(params).filter((k) => !(ARG_KEYS as readonly string[]).includes(k) && k !== 'id');
    if (keys.length === 1 && /^[A-Za-z_][\w.-]*$/.test(keys[0])) {
      return { name: keys[0], arguments: argumentsJson(params[keys[0]]), ...(params.id ? { id: params.id } : {}) };
    }
    return null;
  }
  const argKey = ARG_KEYS.find((k) => typeof params[k] === 'string');
  let args: string;
  if (argKey) {
    args = argumentsJson(params[argKey]);
  } else {
    // No argument container: the remaining parameter elements ARE the arguments.
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if ((NAME_KEYS as readonly string[]).includes(k) || k === 'id') continue;
      rest[k] = paramValue(v);
    }
    args = JSON.stringify(rest);
  }
  return { name, arguments: args, ...(params.id ? { id: params.id } : {}) };
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
      // Either close marker ends the block (the model has used both).
      const candidates = [DSML_TOOL_CALL_CLOSE, DSML_TOOL_CALL_CLOSE_ALT]
        .map((tag) => ({ tag, idx: buffer.indexOf(tag) }))
        .filter((c) => c.idx !== -1)
        .sort((a, b) => a.idx - b.idx);
      const close = candidates[0];
      if (!close) {
        if (!flushing) return; // wait for the rest of the block
        onText(DSML_TOOL_CALL_OPEN + buffer); // unterminated at end of stream — surface verbatim
        buffer = '';
        inBlock = false;
        return;
      }
      const payload = buffer.slice(0, close.idx);
      buffer = buffer.slice(close.idx + close.tag.length);
      inBlock = false;
      const call = parseDsmlToolCallPayload(payload);
      if (call) onToolCall(call);
      else onText(DSML_TOOL_CALL_OPEN + payload + close.tag); // unparseable — keep it visible rather than lose it
    }
  };

  return {
    push: (delta) => { buffer += delta; drain(false); },
    flush: () => drain(true),
    reset: () => { buffer = ''; inBlock = false; },
  };
}
