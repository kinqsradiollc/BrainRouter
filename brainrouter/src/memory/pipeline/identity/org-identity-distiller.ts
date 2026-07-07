import type { LLMRunner } from "@kinqs/brainrouter-types";
import type { OrgPersonaStore } from "../../../tenancy/store.js";
import { CORE_IDENTITY_SYSTEM_PROMPT, formatCoreIdentityPrompt } from "../../prompts/core-identity.js";

/**
 * Team consensus-persona distillation (ADR-014 Phase C). Same synthesis as the
 * user Core Identity, but over the Team's SHARED (visibility='org') persona +
 * instruction memories — team SOPs, conventions, shared identity.
 */
export async function distillOrgPersona(params: {
  orgId: string;
  store: OrgPersonaStore;
  llmRunner: LLMRunner;
}): Promise<{ success: boolean; personaMd?: string }> {
  const { orgId, store, llmRunner } = params;

  const memories = await store.getOrgSharedIdentityCognitives(orgId, 100);
  if (memories.length === 0) {
    return { success: false };
  }

  let personaMd: string;
  try {
    personaMd = await llmRunner.run({
      prompt: formatCoreIdentityPrompt(memories),
      systemPrompt: CORE_IDENTITY_SYSTEM_PROMPT,
      taskId: "org-identity-distillation",
      timeoutMs: 90_000,
    });
  } catch (err) {
    console.error(`[BrainRouter] Team persona distillation failed for "${orgId}":`, (err as Error).message);
    return { success: false };
  }

  const now = new Date().toISOString();
  const existing = await store.getOrgIdentity(orgId);
  await store.upsertOrgIdentity({
    orgId,
    personaMd: personaMd.trim(),
    cognitiveCountAtGeneration: memories.length,
    createdTime: existing?.createdTime ?? now,
    updatedTime: now,
  });
  return { success: true, personaMd: personaMd.trim() };
}
