// ============================
// Core Identity Synthesis Prompt
// ============================

export const CORE_IDENTITY_SYSTEM_PROMPT = `You are a user profiling expert for a software engineering AI assistant.

Your task is to synthesize a set of durable user memories (persona traits and instructions) into a concise, structured 4-layer Core Identity narrative profile.

Rules:
- Be STRICTLY grounded in the provided memories. Do NOT infer or fabricate traits.
- If a trait appears only once and is ambiguous, omit it.
- Prefer concrete observations over vague generalizations.
- Instructions (hard rules the user gave) must be listed verbatim in "Hard Rules".
- DEDUPLICATE Hard Rules: if multiple instruction memories express the same constraint (even with different wording), merge them into one canonical rule. Prefer the most specific and complete version.
- Output ONLY the Markdown profile. No preamble.`;

export function formatCoreIdentityPrompt(memories: Array<{ content: string; type: string; priority: number }>): string {
  const personaLines = memories
    .filter(m => m.type === "persona")
    .sort((a, b) => b.priority - a.priority)
    .map(m => `- ${m.content}`)
    .join("\n");

  const instructionLines = memories
    .filter(m => m.type === "instruction")
    .sort((a, b) => b.priority - a.priority)
    .map(m => `- ${m.content}`)
    .join("\n");

  return `Synthesize a structured Core Identity Narrative Profile from the following user memories.

### Persona Memories (stable traits, preferences):
${personaLines || "- (none)"}

### Instruction Memories (hard rules from the user):
${instructionLines || "- (none)"}

### Output Format (strict Markdown):
## User Narrative Profile

### Layer 1 — Base Anchors
(Stable identity: role, years of experience, core domain, language preferences)
- [anchor 1]
- [anchor 2]

### Layer 2 — Interest Graph
(Topics they care about most: architecture, performance, DX, shipping speed, etc.)
- [interest 1]
- [interest 2]

### Layer 3 — Skill Map  
(Concrete tools, frameworks, languages, and patterns they use or prefer)
- [skill/tool 1]
- [skill/tool 2]

### Layer 4 — Behavioural Patterns
(Observable working styles: how they iterate, what they avoid, what they reward)
- [pattern 1]
- [pattern 2]

### Hard Rules (must never be violated)
- [verbatim instruction 1]
- [verbatim instruction 2]`;
}
