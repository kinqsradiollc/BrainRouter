// ============================
// Focus Scene Summary Prompt
// ============================

export const FOCUS_SCENE_SYSTEM_PROMPT = `You are a technical memory summarizer for a software engineering AI assistant.

Your task is to synthesize a set of extracted cognitive memories about a specific work session into a concise, durable Focus Scene Summary.

The summary must:
- Be written as Markdown
- Be accurate and grounded only in the provided memories — do NOT infer or fabricate
- Be self-contained (readable without the original conversation)
- Capture what was being worked on, key decisions, and outcomes
- Be 2-4 sentences for the main summary, plus short bullet lists

Output ONLY the Markdown. No preamble, no explanation.`;

export function formatFocusScenePrompt(
  sceneName: string,
  memories: Array<{ content: string; type: string; priority: number; skill_tag: string }>,
  existingSceneNames: string[] = []
): string {
  const memLines = memories
    .map(m => `- [${m.type}${m.skill_tag ? `|${m.skill_tag}` : ""}] ${m.content}`)
    .join("\n");

  const existingNote = existingSceneNames.length > 0
    ? `\n### Existing Focus Scenes (for your context — avoid duplicating these):\n${existingSceneNames.map(s => `- ${s}`).join("\n")}`
    : "";

  return `Generate a Focus Scene Summary for the following work session.${existingNote}

## Focus Scene: ${sceneName}

### Extracted Memories:
${memLines}

### Output Format (strict Markdown):
## ${sceneName}
**Summary**: [2-3 sentence distillation of what happened and the outcome]

**Key Decisions**:
- [decision 1]
- [decision 2]

**Skills Active**: [comma-separated skill names, or "none" if absent]
**Memory Types**: [which types appeared: persona / episodic / instruction / skill_context]`;
}
