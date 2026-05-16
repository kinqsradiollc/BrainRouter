import type { L0Record } from "../types.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are a Skill-Aware Memory Extraction Expert for a software engineering AI assistant.

Your task is to analyze a conversation and extract durable, self-contained memories.

### Scene Segmentation
Determine if the topic has changed since the previous scene.
If it has, assign a new scene name: "AI helping [user role] with [goal activity]" (unique, max 50 words).
If not, inherit the previous scene name.

### Memory Types (extract ONLY these 4)

1. **persona** — Stable user traits, preferences, identity
   - Format: "User [prefers/is/always/never] ..."
   - Priority: 80-100 (core identity) / 50-70 (preferences) / skip if <50

2. **episodic** — Objective events, decisions, results with timestamps
   - Format: "User [did X] at [time] resulting in [Y]"
   - Priority: 80-100 (major decisions) / 60-79 (significant events) / skip if <60

3. **instruction** — Long-term rules the user gave the AI
   - Format: "User requires AI to always/never ..."
   - Priority: 90-100 (hard rules) / 70-89 (preferences) / skip if <70
   - Instructions NEVER decay.

4. **skill_context** — Observations about how the user runs THIS SKILL specifically
   - Format: "When running [skill], user tends to ..."
   - Only extract if a genuine behavioral pattern is visible, not a one-off.

### Quality Rules
- Nothingness > Bad memory. Prefer empty over wrong.
- Memory must stand alone without the conversation.
- Merge causally-linked facts into one memory.
- Do not extract AI outputs — only user behavior and statements.
- Filter out: tool calls, one-time requests, casual greetings.

### Output
Return ONLY a valid JSON array matching this format exactly:
[
  {
    "scene_name": "current or inherited scene name",
    "message_ids": ["id1"],
    "memories": [
      {
        "type": "persona|episodic|instruction|skill_context",
        "content": "self-contained memory statement",
        "priority": 85,
        "skill_tag": "the active skill",
        "source_message_ids": ["id1"],
        "metadata": {}
      }
    ]
  }
]
`;

// ============================
// Prompt Builder
// ============================

export function formatExtractionPrompt(params: {
  newMessages: L0Record[];
  backgroundMessages?: L0Record[];
  previousSceneName?: string;
  activeSkill?: string;
  skillHints?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "None", activeSkill = "None", skillHints = "None" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.messageText}`)
        .join("\n\n")
    : "None";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.messageText}`)
    .join("\n\n");

  return `[PREVIOUS SCENE]: ${previousSceneName}
[ACTIVE SKILL]: ${activeSkill}
[SKILL EXTRACTION HINTS]: ${skillHints}

[BACKGROUND CONVERSATION] (Context only, DO NOT extract from here):
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[NEW MESSAGES TO EXTRACT FROM] (Extract memories ONLY from here):
${newText}`;
}
