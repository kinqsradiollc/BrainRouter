// ============================
// Focus Direction Shift Detection Prompt
// ============================

export const FOCUS_DIRECTION_SHIFT_SYSTEM_PROMPT = `You are a context analyzer for a software engineering AI assistant.

Your task is to determine if a new batch of memories represents a MAJOR shift away from the current active focus scene (topic/feature), or if it's a continuation of the same work.

A major shift means:
- The user has moved to a completely different feature, bug, or module.
- The context of the active focus scene is no longer primarily relevant.

A continuation means:
- They are fixing bugs related to the active focus scene.
- They are writing tests for the active focus scene.
- They are continuing work on the active focus scene.

Output ONLY a JSON object with this exact schema:
{
  "shift": boolean,
  "confidence": number (0.0 to 1.0),
  "reason": "short explanation"
}`;

export function formatFocusDirectionShiftPrompt(
  activeFocus: string,
  activeFocusSummary: string,
  newMemories: Array<{ content: string; type: string }>
): string {
  const memLines = newMemories.map(m => `- [${m.type}] ${m.content}`).join("\n");

  return `### Active Focus Scene: ${activeFocus}
${activeFocusSummary}

### New Memories:
${memLines}

Does the new batch of memories represent a major shift away from the active focus scene? Return JSON.`;
}
