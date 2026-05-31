/**
 * MEM-32b (0.4.4) — `reflect`: synthesize NON-OBVIOUS, cross-cutting insights
 * that span MULTIPLE memories (not a restatement of any single one). Pure
 * prompt-building + response-parsing so the gate (`<no-insight/>`) and bullet
 * extraction are unit-testable; the engine runs it through the synthesis LLM and
 * records each insight as a reinforcing `lesson` (kind: "insight", MEM-32).
 */

export const NO_INSIGHT_SENTINEL = "<no-insight/>";

export function buildReflectPrompt(memories: string[]): { system: string; user: string } {
  const system = [
    "You synthesize NON-OBVIOUS, cross-cutting insights from a set of memories — patterns or lessons that span MULTIPLE entries, not a restatement of any single one.",
    `If there is no genuine cross-memory insight, respond with EXACTLY ${NO_INSIGHT_SENTINEL} and nothing else.`,
    "Otherwise list 1–5 insights, each on its own line beginning with '- ', each a single declarative sentence. No preamble, no commentary, no code fences.",
  ].join("\n");
  const numbered = memories
    .map((m, i) => `${i + 1}. ${(m ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}`)
    .join("\n");
  const user = `Memories:\n${numbered}\n\nSynthesize cross-memory insights, or ${NO_INSIGHT_SENTINEL}.`;
  return { system, user };
}

/** Parse the model's response into insight strings; `[]` for the no-insight
 * sentinel or empty output. Extracts bullet/numbered lines; conservative. */
export function parseReflectResponse(raw: string): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (new RegExp(NO_INSIGHT_SENTINEL.replace(/[/<>]/g, "\\$&"), "i").test(text)) return [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/);
    const insight = (m ? m[1] : "").trim();
    if (insight.length >= 12) out.push(insight);
  }
  // Fallback: a single-sentence response with no bullets is one insight.
  if (out.length === 0 && text.length >= 12 && !/\n/.test(text)) out.push(text);
  return out.slice(0, 5);
}
