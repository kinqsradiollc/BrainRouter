/**
 * Robust JSON extraction from LLM output.
 *
 * Models — especially local / free chat endpoints and reasoning models — wrap or
 * pollute their JSON in ways a naive `raw.match(/\[[\s\S]*\]/)` + `JSON.parse`
 * cannot survive:
 *   - leaked chat-template / role tokens: `[user role]`, `[assistant]`, `<|im_start|>`
 *   - a reasoning preamble, prose, or "Here is the JSON:" before/after the payload
 *   - ```json … ``` code fences
 *   - trailing commas (`[1,2,]`)
 *   - backslashes that aren't valid JSON escapes — Windows paths (`\users`), regex
 *     literals, LaTeX (`\section`), shell snippets
 *
 * The classic failure (reported in the field): the model emits `[user role]` before
 * the real array, the greedy "first `[` → last `]`" regex matches from THAT bracket,
 * and `JSON.parse` dies on `[u…`. Every ad-hoc parser in the pipeline shared this
 * bug; they all route through here now.
 *
 * Strategy: strip code fences, then scan every *balanced* `{…}` / `[…]` span
 * (string- and escape-aware) and return the **largest** span that parses as the
 * requested kind, repairing trailing commas + ambiguous backslashes first.
 * "Largest" beats "first" because the real structured payload is virtually always
 * the biggest valid JSON in the output, so a small `[user role]` or a stray
 * reasoning `[1,2,3]` can't win. This only guarantees *valid JSON of the requested
 * kind* — callers still validate the shape/content.
 */

export type JsonKind = "array" | "object" | "any";

/**
 * Strip a leading and trailing markdown code fence (``` or ```json) when the
 * fence sits on its own line. Best-effort: even if a fence survives, the span
 * scanner below ignores non-bracket noise, so the JSON is still recovered.
 */
export function stripCodeFences(raw: string): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/^```[^\n]*\r?\n/, ""); // opening fence line
  s = s.replace(/\r?\n```[ \t]*$/, ""); // closing fence line
  return s.trim();
}

/**
 * Extract the first/largest parseable JSON value from raw LLM output.
 * Returns the parsed value, or `null` when no balanced span parses as `kind`.
 *   - kind "array"  → only top-level arrays are considered/returned.
 *   - kind "object" → only top-level objects (not arrays).
 *   - kind "any"    → either (the largest wins).
 */
export function extractJsonValue(raw: string, opts: { kind?: JsonKind } = {}): unknown | null {
  const kind = opts.kind ?? "any";
  const text = stripCodeFences(raw);
  if (!text) return null;

  // Fast path: the whole de-fenced body is already JSON of the requested kind.
  const whole = tryParseAs(text, kind);
  if (whole.ok) return whole.value;

  // Otherwise scan balanced spans and keep the largest that parses as `kind`.
  let best: unknown | null = null;
  let bestLen = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "[" && ch !== "{") continue;
    if (kind === "array" && ch !== "[") continue;
    if (kind === "object" && ch !== "{") continue;

    const end = matchBalanced(text, i);
    if (end < 0) continue;
    const span = text.slice(i, end + 1);
    // A span that can't beat the current best length can't win — skip the parse.
    if (best !== null && span.length <= bestLen) continue;

    const res = tryParseAs(span, kind);
    if (res.ok) {
      best = res.value;
      bestLen = span.length;
    }
  }
  return best;
}

/**
 * Like {@link extractJsonValue} but throws a descriptive error (with a truncated
 * preview) when nothing parses, for callers that treat "no JSON" as a hard failure.
 */
export function extractJsonValueOrThrow(
  raw: string,
  opts: { kind?: JsonKind; label?: string } = {},
): unknown {
  const value = extractJsonValue(raw, { kind: opts.kind });
  if (value === null) {
    const label = opts.label ?? "LLM output";
    const kindSuffix = opts.kind && opts.kind !== "any" ? ` ${opts.kind}` : "";
    throw new Error(`${label} contained no parseable JSON${kindSuffix}: ${stripCodeFences(raw).slice(0, 200)}`);
  }
  return value;
}

/** Parse only if the result matches `kind`; never throws. */
function tryParseAs(s: string, kind: JsonKind): { ok: true; value: unknown } | { ok: false } {
  let value: unknown;
  try {
    value = parseJsonWithEscapeRepair(s);
  } catch {
    return { ok: false };
  }
  if (kind === "array" && !Array.isArray(value)) return { ok: false };
  if (kind === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Find the index of the bracket that closes the span opening at `start`
 * (`s[start]` must be `[` or `{`). String- and escape-aware so brackets inside
 * string literals don't affect depth. Returns -1 if unbalanced.
 */
function matchBalanced(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse JSON, repairing the two malformations LLMs emit most: trailing commas
 * and backslashes that aren't valid JSON escapes (Windows paths, regex, LaTeX).
 * JSON.parse rejects the whole payload on the first bad escape, so we'd drop an
 * otherwise-good batch over one stray backslash. Escapes are only touched after
 * a clean parse fails, so valid `\n`/`\t`/`\uXXXX` aren't corrupted.
 */
export function parseJsonWithEscapeRepair(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(stripTrailingCommas(raw));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      const escaped = escapeAmbiguousBackslashesInJsonStrings(raw);
      try {
        return JSON.parse(stripTrailingCommas(escaped));
      } catch {
        return JSON.parse(escapeAmbiguousBackslashesInJsonStrings(stripTrailingCommas(escaped)));
      }
    }
  }
}

/** Escape backslashes inside string literals that aren't valid JSON escapes. */
function escapeAmbiguousBackslashesInJsonStrings(input: string): string {
  let out = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escape) {
      out += ['"', "\\", "/"].includes(ch) ? ch : `\\${ch}`;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      out += "\\";
      escape = true;
      continue;
    }

    out += ch;
    if (ch === '"') inString = false;
  }

  return out;
}

/**
 * Strip trailing commas before `]` or `}` while respecting string literals.
 * LLMs often emit `["a", "b",]` / `{"x":1,}` which JSON.parse rejects.
 */
function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === "]" || input[j] === "}") continue;
    }
    out += ch;
  }
  return out;
}
