/**
 * MEM-33 (0.4.4) — distill a reusable SOP/skill from a successful session.
 * Pure prompt-building + response-parsing so the gate (`<no-skill/>` for
 * exploratory runs) and SOP extraction are unit-testable without an LLM. The
 * engine wires these to its synthesis runner and stores a real skill as a
 * durable `lesson` (reusing MEM-32's reinforcement).
 */

export const NO_SKILL_SENTINEL = "<no-skill/>";

export function buildSkillExtractionPrompt(summary: string): { system: string; user: string } {
  const system = [
    "You distill a REUSABLE engineering skill (a short SOP) from a session summary.",
    "A good skill is a generalizable, repeatable procedure — not a play-by-play of this one task.",
    `If the session was exploratory, trivial, one-off, or has no reusable procedure, respond with EXACTLY ${NO_SKILL_SENTINEL} and nothing else.`,
    "Otherwise respond with a concise titled, numbered SOP (a one-line title, then 3–8 imperative steps). No preamble, no commentary, no code fences.",
  ].join("\n");
  const user = `Session summary:\n${summary}\n\nDistill ONE reusable skill, or ${NO_SKILL_SENTINEL}.`;
  return { system, user };
}

/**
 * Parse the model's response. Returns `{ skill: null }` for the no-skill
 * sentinel, an empty/too-short body, or obvious refusal; otherwise the cleaned
 * SOP text (code fences stripped). Conservative: when in doubt, no skill.
 */
export function parseSkillResponse(raw: string): { skill: string | null } {
  let text = (raw ?? "").trim();
  if (!text) return { skill: null };
  if (new RegExp(NO_SKILL_SENTINEL.replace(/[/]/g, "\\/").replace(/[<>]/g, "\\$&"), "i").test(text)) {
    return { skill: null };
  }
  // Strip a single wrapping code fence if present.
  text = text.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
  // Need at least a title + one step to be a usable SOP.
  if (text.length < 20 || !/\n/.test(text)) return { skill: null };
  return { skill: text };
}
