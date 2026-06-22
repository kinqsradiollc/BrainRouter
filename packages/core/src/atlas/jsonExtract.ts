/**
 * Robust JSON extraction for LLM output (Atlas enrichment, ATLAS-4).
 *
 * Models routinely wrap JSON in ```json fences, prefix it with prose ("Here is
 * the JSON:"), append a trailing note, or emit trailing commas. A bare
 * `JSON.parse` fails on all of these. This helper peels those layers off and
 * returns the first well-formed JSON value, or `null` if none is recoverable —
 * callers treat `null` as "skip this batch" rather than crashing the build.
 *
 * Core's Atlas pipeline lives in this package, so it can't reach the MCP
 * server's own LLM-JSON chokepoint (that sits in a downstream package); this is
 * the equivalent, scoped to Atlas.
 */

/** Strip a single Markdown code fence (```lang … ```), if the text is one. */
function stripFence(text: string): string {
  const fence = text.match(/```(?:json|json5|jsonc)?\s*\n?([\s\S]*?)\n?```/i);
  return fence ? fence[1] : text;
}

/** Remove trailing commas before a closing `}` or `]` (a common LLM slip). */
function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Find the first balanced `{…}` or `[…]` span, respecting strings/escapes so
 * braces inside string literals don't throw off the depth count.
 */
function firstBalancedSpan(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Attempt to parse `text` as JSON after a light cleanup pass. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripTrailingCommas(text));
    } catch {
      return undefined;
    }
  }
}

/**
 * Extract the first recoverable JSON value from raw LLM text. Returns the parsed
 * value, or `null` when nothing parses (caller decides how to degrade).
 */
export function extractAtlasJson(raw: string): unknown {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const unfenced = stripFence(raw).trim();

  // Fast path: the whole thing is JSON.
  const whole = tryParse(unfenced);
  if (whole !== undefined) return whole;

  // Otherwise pull out the first balanced object/array span and parse that.
  const span = firstBalancedSpan(unfenced);
  if (span != null) {
    const parsed = tryParse(span);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

/** Like {@link extractAtlasJson} but guarantees an array (or `[]`). */
export function extractAtlasJsonArray(raw: string): unknown[] {
  const value = extractAtlasJson(raw);
  if (Array.isArray(value)) return value;
  // Some models wrap the array in an object, e.g. { "files": [...] }.
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}
