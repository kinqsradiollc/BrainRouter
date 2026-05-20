import type { IMemoryStore } from "@brainrouter/types";
import type { LLMRunner, CoreIdentityRecord } from "@brainrouter/types";
import { CORE_IDENTITY_SYSTEM_PROMPT, formatCoreIdentityPrompt } from "../prompts/core-identity.js";

/**
 * Core Identity Distillation Pipeline
 * Scans ALL persona + instruction CognitiveRecords across all sessions
 * for a user and synthesizes a durable Narrative Profile.
 */
export async function distillCoreIdentity(params: {
  userId: string;
  store: IMemoryStore;
  llmRunner: LLMRunner;
}): Promise<{ success: boolean; personaMd?: string }> {
  const { userId, store, llmRunner } = params;

  // Cross-session: fetch all persona + instruction cognitives for this user
  const memories = store.getIdentityAndInstructionCognitives(userId, 100);

  if (memories.length === 0) {
    console.error(`[BrainRouter] Core Identity distillation skipped for "${userId}" — no persona/instruction memories yet.`);
    return { success: false };
  }

  let personaMd: string;
  try {
    personaMd = await llmRunner.run({
      prompt: formatCoreIdentityPrompt(memories),
      systemPrompt: CORE_IDENTITY_SYSTEM_PROMPT,
      taskId: "identity-distillation",
      timeoutMs: 90_000,
    });
  } catch (err) {
    console.error(`[BrainRouter] Core Identity distillation failed for "${userId}":`, (err as Error).message);
    return { success: false };
  }

  const now = new Date().toISOString();
  const existing = store.getCoreIdentity(userId);

  const record: CoreIdentityRecord = {
    userId,
    personaMd: personaMd.trim(),
    cognitiveCountAtGeneration: memories.length,
    createdTime: existing?.createdTime ?? now,
    updatedTime: now,
  };

  store.upsertCoreIdentity(record);
  console.error(`[BrainRouter] Core Identity updated for "${userId}" (${memories.length} cognitive records).`);

  return { success: true, personaMd: personaMd.trim() };
}
