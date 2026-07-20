/**
 * ADR-020 D3 — structured session reflection (pure prompt + parser).
 *
 * The general `reflect` synthesizes cross-cutting insights; this instead does a
 * single bounded pass over ONE session and crystallizes the highest-value
 * "what did we learn" signal into typed categories, each stored as its own
 * first-class memory tagged `reflection`. Parsing goes through the shared
 * LLM-JSON chokepoint so leaked tokens / prose / fences never break it.
 */
import { extractJsonValue } from "./llm-json.js";

/** The reflection categories, in priority order. `kind` is the memory kind stored. */
export const REFLECTION_CATEGORIES = [
  { key: "mistakes", kind: "mistake", priority: 82 },
  { key: "antiPatterns", kind: "anti-pattern", priority: 82 },
  { key: "lessons", kind: "lesson", priority: 78 },
  { key: "decisions", kind: "decision", priority: 76 },
  { key: "preferences", kind: "preference", priority: 80 },
  { key: "reusableWorkflows", kind: "workflow", priority: 74 },
] as const;

export type ReflectionCategoryKey = (typeof REFLECTION_CATEGORIES)[number]["key"];

export interface ReflectionElement {
  category: ReflectionCategoryKey;
  kind: string;
  priority: number;
  text: string;
}

export function buildSessionReflectPrompt(sessionSummary: string): { system: string; user: string } {
  const system =
    "You are a reflective memory system. From a single work session, extract the durable, reusable signal a future agent would want. " +
    "Return STRICT JSON only, no prose, with these string-array keys (omit or use [] when none apply): " +
    "mistakes (things that went wrong), antiPatterns (approaches to avoid next time), lessons (generalizable takeaways), " +
    "decisions (choices made and why), preferences (how the user likes things done), reusableWorkflows (repeatable step sequences). " +
    "Each entry is one concise, self-contained sentence. Do NOT invent content not supported by the session. Skip trivial/exploratory sessions by returning all-empty arrays.";
  const user = `Session summary:\n${sessionSummary}\n\nReturn the JSON now.`;
  return { system, user };
}

/** Parse the LLM's structured reflection into typed, deduplicated elements. */
export function parseSessionReflectResponse(raw: string): ReflectionElement[] {
  const value = extractJsonValue(raw, { kind: "object" });
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const out: ReflectionElement[] = [];
  const seen = new Set<string>();
  for (const { key, kind, priority } of REFLECTION_CATEGORIES) {
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const text = typeof item === "string" ? item.trim() : "";
      if (text.length < 4) continue;
      const dedupeKey = `${key}:${text.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ category: key, kind, priority, text });
    }
  }
  return out;
}
