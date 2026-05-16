import type { SqliteMemoryStore } from "../store/sqlite.js";
import type { LLMRunner, L2SceneRecord } from "../types.js";
import { L2_SCENE_SYSTEM_PROMPT, formatL2ScenePrompt } from "../prompts/l2-scene.js";
import crypto from "node:crypto";

/**
 * L2 Scene Pipeline
 * Groups L1 memories by scene_name and asks the LLM to produce
 * a Markdown summary for each scene. Updates heat scores.
 */
export async function distillScenes(params: {
  userId: string;
  store: SqliteMemoryStore;
  llmRunner: LLMRunner;
}): Promise<{ scenesDistilled: number; sceneNames: string[] }> {
  const { userId, store, llmRunner } = params;

  // Decay all existing heat scores (each distillation cycle = time passing)
  store.decayL2HeatScores(userId);

  const sceneNames = store.getDistinctSceneNames(userId);
  if (sceneNames.length === 0) {
    return { scenesDistilled: 0, sceneNames: [] };
  }

  const now = new Date().toISOString();
  const distilled: string[] = [];

  for (const sceneName of sceneNames) {
    const l1s = store.getL1sByScene(userId, sceneName, 30);
    if (l1s.length === 0) continue;

    let summaryMd: string;
    try {
      summaryMd = await llmRunner.run({
        prompt: formatL2ScenePrompt(sceneName, l1s),
        systemPrompt: L2_SCENE_SYSTEM_PROMPT,
        taskId: "l2-scene-distillation",
        timeoutMs: 60_000,
      });
    } catch (err) {
      console.error(`[BrainRouter] L2 scene distillation failed for "${sceneName}":`, (err as Error).message);
      continue;
    }

    const existing = store.getTopL2Scenes(userId, 100).find(s => s.sceneName === sceneName);
    const record: L2SceneRecord = {
      id: existing?.id ?? `l2_${crypto.randomBytes(6).toString("hex")}`,
      userId,
      sceneName,
      summaryMd: summaryMd.trim(),
      heatScore: existing ? Math.min(100, existing.heatScore + 30) : 100, // boost freshly distilled
      lastActiveTime: now,
      createdTime: existing?.createdTime ?? now,
      updatedTime: now,
    };

    store.upsertL2Scene(record);
    distilled.push(sceneName);
  }

  console.error(`[BrainRouter] L2 distilled ${distilled.length} scene(s) for user "${userId}".`);
  return { scenesDistilled: distilled.length, sceneNames: distilled };
}
