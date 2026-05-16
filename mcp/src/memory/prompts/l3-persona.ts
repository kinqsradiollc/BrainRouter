// ============================
// L3 Persona Synthesis Prompt
// ============================

export const L3_PERSONA_SYSTEM_PROMPT = `You are a user profiling expert for a software engineering AI assistant.

Your task is to synthesize a set of durable user memories (persona traits and instructions) into a concise, structured Narrative Profile.

Rules:
- Be STRICTLY grounded in the provided memories. Do NOT infer or fabricate traits.
- If a trait appears only once and is ambiguous, omit it.
- Prefer concrete observations over vague generalizations.
- Instructions (hard rules the user gave) must be listed verbatim in "Hard Rules".
- Output ONLY the Markdown profile. No preamble.`;

export function formatL3PersonaPrompt(memories: Array<{ content: string; type: string; priority: number }>): string {
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

  return `Synthesize a Narrative Profile from the following user memories.

### Persona Memories (stable traits, preferences):
${personaLines || "- (none)"}

### Instruction Memories (hard rules from the user):
${instructionLines || "- (none)"}

### Output Format (strict Markdown):
## User Narrative Profile
**Archetype**: [1 sentence characterizing this user's engineering style]

**Working Style**:
- [trait 1]
- [trait 2]

**Tech Preferences**:
- [preference 1]

**Hard Rules** (must never be violated):
- [rule 1]
- [rule 2]

**Recurring Patterns**:
- [observable pattern 1]`;
}
