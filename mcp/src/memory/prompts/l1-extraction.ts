import type { L0Record } from "@brainrouter/types";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are a Skill-Aware Memory Extraction Expert for a software engineering AI assistant.

Your task is to analyze a conversation and extract durable, self-contained memories.

### Scene Segmentation
Determine if the topic has changed since the previous scene.
If there are existing scenes, PREFER to reuse the most relevant existing scene name — only create a new name if the topic is genuinely different from ALL existing scenes.
If reusing, use the EXACT existing name (no paraphrasing).
If creating new, format: "AI helping [user role] with [goal activity]" (unique, max 50 chars).

### Memory Types

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

5. **tool_preference** — Stable preferences about tools, workflows, or command usage.
6. **codebase_fact / api_contract / data_model** — Verified facts about code, public APIs, schemas, or storage models.
7. **dependency_constraint / environment_constraint** — Version, runtime, platform, sandbox, or deployment constraints.
8. **architecture_decision / implementation_decision / design_constraint** — Durable decisions and constraints that future agents must preserve.
9. **security_policy / performance_baseline** — Security rules or measured performance facts. Extract only with direct evidence.
10. **bug_finding / debug_trace / fix_summary / verification_result / failed_attempt / regression_risk** — Debugging history, fixes, checks, and risk notes.
11. **task_state / handover_note / blocked_reason / review_comment / release_note** — Planning, review, release, and continuation state.
12. **source_evidence / artifact_reference / file_history / command_knowledge** — Evidence-backed references to files, artifacts, file evolution, or command behavior.

Allowed type values:
persona, episodic, instruction, skill_context, tool_preference, codebase_fact, api_contract,
data_model, dependency_constraint, environment_constraint, architecture_decision,
implementation_decision, design_constraint, security_policy, performance_baseline,
bug_finding, debug_trace, fix_summary, verification_result, failed_attempt, regression_risk,
task_state, handover_note, blocked_reason, review_comment, release_note, source_evidence,
artifact_reference, file_history, command_knowledge.

### Quality Rules
- Nothingness > Bad memory. Prefer empty over wrong.
- Memory must stand alone without the conversation.
- Merge causally-linked facts into one memory.
- Do not extract AI outputs — only user behavior and statements.
- Filter out: tool calls, one-time requests, casual greetings.
- Evidence-gated types (api_contract, data_model, security_policy, performance_baseline) require a cited file path, command, test result, or explicit user statement.
- Use confidence from 0.0 to 1.0. Use lower confidence for model inference, higher confidence for direct source or command output.
- Classify sourceKind as user_instruction, source_file, command_output, test_result, model_inference, or prior_memory.
- Extract filePaths, repoPaths, and commands when explicitly mentioned; otherwise use empty arrays.

### Output
Return ONLY a valid JSON array matching this format exactly:
[
  {
    "scene_name": "current or inherited scene name",
    "message_ids": ["id1"],
    "memories": [
      {
        "type": "one allowed type value",
        "content": "self-contained memory statement",
        "priority": 85,
        "skill_tag": "the active skill",
        "source_message_ids": ["id1"],
        "confidence": 0.75,
        "sourceKind": "user_instruction|source_file|command_output|test_result|model_inference|prior_memory",
        "verificationStatus": "verified|unverified|stale",
        "repoPaths": [],
        "filePaths": [],
        "commands": [],
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
  existingSceneNames?: string[];
  activeSkill?: string;
  skillHints?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "None", existingSceneNames = [], activeSkill = "None", skillHints = "None" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.messageText}`)
        .join("\n\n")
    : "None";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.messageText}`)
    .join("\n\n");

  const existingScenesNote = existingSceneNames.length > 0
    ? `[EXISTING SCENES] (reuse one of these if the topic matches):\n${existingSceneNames.map(n => `  - ${n}`).join("\n")}`
    : "[EXISTING SCENES]: None yet";

  return `[PREVIOUS SCENE]: ${previousSceneName}
${existingScenesNote}
[ACTIVE SKILL]: ${activeSkill}
[SKILL EXTRACTION HINTS]: ${skillHints}

[BACKGROUND CONVERSATION] (Context only, DO NOT extract from here):
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[NEW MESSAGES TO EXTRACT FROM] (Extract memories ONLY from here):
${newText}`;
}
