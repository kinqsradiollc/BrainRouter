/**
 * Provider wire-format resolution (parity with the desktop/core provider layer).
 *
 * The stored `baseUrl` is treated as a BASE (e.g. `https://api.openai.com/v1`); the
 * WIRE FORMAT decides the path: `chat-completions` → POST `/chat/completions`,
 * `responses` → POST `/responses`. This "base URL cause" is why a provider saved
 * with a full `/chat/completions` URL could never speak the Responses API — the
 * resolver below normalizes either shape so BOTH wires work from one saved URL.
 */

/** True for the OpenAI Responses wire. Everything else falls back to chat-completions. */
export function isResponsesWire(wireFormat?: string | null): boolean {
  return String(wireFormat ?? "").trim().toLowerCase() === "responses";
}

/**
 * Resolve the actual request URL from a (possibly full) base URL + wire format.
 * - already ends in the CORRECT wire suffix → used as-is (preserves query strings);
 * - ends in the OTHER suffix → swapped (so a saved `/chat/completions` URL can do
 *   `/responses` and vice-versa);
 * - a bare base (`.../v1`) → the wire suffix is appended.
 */
export function resolveRequestUrl(rawBase: string, wireFormat?: string | null): string {
  const url = String(rawBase ?? "").trim();
  if (!url) return url;
  const path = isResponsesWire(wireFormat) ? "/responses" : "/chat/completions";
  const other = isResponsesWire(wireFormat) ? "/chat/completions" : "/responses";
  const qIdx = url.indexOf("?");
  const query = qIdx >= 0 ? url.slice(qIdx) : "";
  const base = (qIdx >= 0 ? url.slice(0, qIdx) : url).replace(/\/+$/, "");
  const lower = base.toLowerCase();
  if (lower.endsWith(path)) return url;
  if (lower.endsWith(other)) return base.slice(0, base.length - other.length) + path + query;
  return base + path + query;
}

/** Resolve the GET /models URL from a (possibly full) base URL. Strips a wire suffix. */
export function resolveModelsUrl(rawBase: string): string {
  const url = String(rawBase ?? "").trim();
  if (!url) return url;
  const qIdx = url.indexOf("?");
  const query = qIdx >= 0 ? url.slice(qIdx) : "";
  let base = (qIdx >= 0 ? url.slice(0, qIdx) : url).replace(/\/+$/, "");
  base = base.replace(/\/(chat\/completions|responses)$/i, "");
  if (/\/models$/i.test(base)) return base + query;
  return base + "/models" + query;
}

export interface WireBodyInput {
  model: string;
  messages: { role: string; content: string }[];
  tool?: { name: string; description?: string; parameters: unknown };
  maxTokens?: number;
  jsonMode?: boolean;
}

/** Build the request body in the provider's wire shape. */
export function buildRequestBody(wireFormat: string | undefined | null, inp: WireBodyInput): Record<string, unknown> {
  if (isResponsesWire(wireFormat)) {
    // Responses API: system prompt → `instructions`, the rest → `input` items.
    const instructions = inp.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const input = inp.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = { model: inp.model, input };
    if (instructions) body.instructions = instructions;
    if (inp.maxTokens) body.max_output_tokens = inp.maxTokens;
    // Structured-output tool-calling over Responses is provider-specific; we rely on
    // the prompt's JSON instruction (same fallback as when a backend rejects tools).
    return body;
  }
  const body: Record<string, unknown> = { model: inp.model, messages: inp.messages };
  if (inp.maxTokens) body.max_tokens = inp.maxTokens;
  if (inp.tool) {
    body.tools = [{ type: "function", function: { name: inp.tool.name, description: inp.tool.description ?? "", parameters: inp.tool.parameters } }];
    body.tool_choice = { type: "function", function: { name: inp.tool.name } };
  }
  if (inp.jsonMode) body.response_format = { type: "json_object" };
  return body;
}

/** Extract the text from a Responses-API payload (`output_text` or `output[].content[].text`). */
export function extractResponsesText(data: any): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  const out = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) if (typeof c?.text === "string") parts.push(c.text);
  }
  return parts.length ? parts.join("") : undefined;
}
