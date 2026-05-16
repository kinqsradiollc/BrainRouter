import type { SqliteMemoryStore } from "../store/sqlite.js";
import type { LLMRunner, L3PersonaRecord } from "../types.js";
import { L3_PERSONA_SYSTEM_PROMPT, formatL3PersonaPrompt } from "../prompts/l3-persona.js";

/**
 * L3 Persona Distillation Pipeline
 * Scans ALL persona + instruction L1 memories across all sessions
 * for a user and synthesizes a durable Narrative Profile.
 */
export async function distillPersona(params: {
  userId: string;
  store: SqliteMemoryStore;
  llmRunner: LLMRunner;
}): Promise<{ success: boolean; personaMd?: string }> {
  const { userId, store, llmRunner } = params;

  // Cross-session: fetch all persona + instruction L1s for this user
  const memories = store.getPersonaAndInstructionL1s(userId, 100);

  if (memories.length === 0) {
    console.error(`[BrainRouter] L3 skipped for "${userId}" — no persona/instruction memories yet.`);
    return { success: false };
  }

  let personaMd: string;
  try {
    personaMd = await llmRunner.run({
      prompt: formatL3PersonaPrompt(memories),
      systemPrompt: L3_PERSONA_SYSTEM_PROMPT,
      taskId: "l3-persona-distillation",
      timeoutMs: 90_000,
    });
  } catch (err) {
    console.error(`[BrainRouter] L3 persona distillation failed for "${userId}":`, (err as Error).message);
    return { success: false };
  }

  const now = new Date().toISOString();
  const existing = store.getL3Persona(userId);

  const record: L3PersonaRecord = {
    userId,
    personaMd: personaMd.trim(),
    l1CountAtGeneration: memories.length,
    createdTime: existing?.createdTime ?? now,
    updatedTime: now,
  };

  store.upsertL3Persona(record);
  console.error(`[BrainRouter] L3 persona updated for "${userId}" (${memories.length} L1s).`);

  return { success: true, personaMd: personaMd.trim() };
}
