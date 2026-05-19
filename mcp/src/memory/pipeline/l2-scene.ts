import type { IMemoryStore } from "@brainrouter/types";
import type { LLMRunner, L2SceneRecord } from "@brainrouter/types";
import { L2_SCENE_SYSTEM_PROMPT, formatL2ScenePrompt } from "../prompts/l2-scene.js";
import { L2_SCENE_CLUSTER_SYSTEM_PROMPT, formatSceneClusterPrompt } from "../prompts/l2-scene-cluster.js";
import { L2_MAX_SCENES } from "../scheduler.js";
import crypto from "node:crypto";

async function canonicalizeSceneNames(params: {
  userId: string;
  store: IMemoryStore;
  llmRunner: LLMRunner;
}) {
  const { userId, store, llmRunner } = params;
  const sceneNames = store.getDistinctSceneNames(userId);
  if (sceneNames.length < 2) return;

  try {
    const rawCluster = await llmRunner.run({
      prompt: formatSceneClusterPrompt(sceneNames),
      systemPrompt: L2_SCENE_CLUSTER_SYSTEM_PROMPT,
      taskId: "l2-scene-clustering",
      timeoutMs: 45_000,
    });

    const jsonMatch = rawCluster.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const clusters = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(clusters)) return;

    for (const cluster of clusters) {
      const canonical = String(cluster.canonical || "").trim();
      const aliases = Array.isArray(cluster.aliases) ? cluster.aliases.map((a: any) => String(a).trim()) : [];
      if (!canonical || aliases.length === 0) continue;

      for (const alias of aliases) {
        if (alias === canonical) continue;
        store.renameSceneInL1Records(userId, alias, canonical);
      }
    }
  } catch (err) {
    console.error(`[BrainRouter] Scene canonicalization failed for "${userId}":`, (err as Error).message);
  }
}

/**
 * L2 Scene Pipeline
 * Groups L1 memories by scene_name and asks the LLM to produce
 * a Markdown summary for each scene. Updates heat scores.
 */
export async function distillScenes(params: {
  userId: string;
  store: IMemoryStore;
  llmRunner: LLMRunner;
}): Promise<{ scenesDistilled: number; sceneNames: string[] }> {
  const { userId, store, llmRunner } = params;

  // Run scene canonicalization/clustering pass to prevent cold-start fragmentation
  await canonicalizeSceneNames({ userId, store, llmRunner });

  // Decay all existing heat scores (each distillation cycle = time passing)
  store.decayL2HeatScores(userId);

  const sceneNames = store.getDistinctSceneNames(userId);
  if (sceneNames.length === 0) {
    return { scenesDistilled: 0, sceneNames: [] };
  }

  const now = new Date().toISOString();
  const distilled: string[] = [];

  // Fetch existing L2 scene names up-front so the prompt can avoid near-duplicates
  const existingL2SceneNames = store.getTopL2Scenes(userId, 50).map(s => s.sceneName);

  for (const sceneName of sceneNames) {
    const l1s = store.getL1sByScene(userId, sceneName, 30);
    if (l1s.length === 0) continue;

    let summaryMd: string;
    try {
      summaryMd = await llmRunner.run({
        prompt: formatL2ScenePrompt(sceneName, l1s, existingL2SceneNames.filter(n => n !== sceneName)),
        systemPrompt: L2_SCENE_SYSTEM_PROMPT,
        taskId: "l2-scene-distillation",
        timeoutMs: 60_000,
      });
    } catch (err) {
      console.error(`[BrainRouter] L2 scene distillation failed for "${sceneName}":`, (err as Error).message);
      continue;
    }

    const existing = store.getL2SceneByName(userId, sceneName);
    const record: L2SceneRecord = {
      id: existing?.id ?? `l2_${crypto.randomBytes(6).toString("hex")}`,
      userId,
      sceneName,
      summaryMd: summaryMd.trim(),
      heatScore: existing ? Math.min(100, existing.heatScore + 30) : 100,
      lastActiveTime: now,
      createdTime: existing?.createdTime ?? now,
      updatedTime: now,
    };

    store.upsertL2Scene(record);
    distilled.push(sceneName);
  }

  // Auto-merge cold scenes if we exceed the max threshold
  await mergeScenes({ userId, store, llmRunner });

  console.error(`[BrainRouter] L2 distilled ${distilled.length} scene(s) for user "${userId}".`);
  return { scenesDistilled: distilled.length, sceneNames: distilled };
}

async function mergeScenes(params: { userId: string; store: IMemoryStore; llmRunner: LLMRunner }) {
  const { userId, store, llmRunner } = params;
  
  const sceneCount = store.getL2SceneCount(userId);
  if (sceneCount < L2_MAX_SCENES) return;

  const overflow = sceneCount - L2_MAX_SCENES + 1;
  const coldScenes = store.getColdL2Scenes(userId, overflow + 3);
  
  // Need at least 2 cold scenes to meaningfully merge
  if (coldScenes.length < 2) return;

  // Skip any existing [Archived] scene from the merge input — we'll update it separately
  const archiveSceneName = "[Archived]";
  const scenesToMerge = coldScenes.filter(s => s.sceneName !== archiveSceneName);
  if (scenesToMerge.length < 2) return;

  const sceneSummaries = scenesToMerge.map(s => `## ${s.sceneName}\n${s.summaryMd}`).join("\n\n");
  
  let unifiedSummary: string;
  try {
    unifiedSummary = await llmRunner.run({
      prompt: `Merge the following old scene summaries into a single concise "Archived Scenes" overview.\n\n${sceneSummaries}\n\nOutput only the Markdown summary. Be concise — no preamble.`,
      systemPrompt: L2_SCENE_SYSTEM_PROMPT,
      taskId: "l2-scene-merge",
      timeoutMs: 60_000,
    });
  } catch (err) {
    console.error(`[BrainRouter] L2 scene merge failed for "${userId}":`, (err as Error).message);
    return;
  }

  const now = new Date().toISOString();
  
  // Look up any pre-existing [Archived] scene
  const existingArchive = store.getL2SceneByName(userId, archiveSceneName);
  
  const record: L2SceneRecord = {
    id: existingArchive?.id ?? `l2_${crypto.randomBytes(6).toString("hex")}`,
    userId,
    sceneName: archiveSceneName,
    summaryMd: unifiedSummary.trim(),
    heatScore: 10,
    lastActiveTime: now,
    createdTime: existingArchive?.createdTime ?? now,
    updatedTime: now,
  };

  store.upsertL2Scene(record);
  
  const idsToDelete = scenesToMerge.map(s => s.id);
  store.deleteL2Scenes(userId, idsToDelete);
  
  console.error(`[BrainRouter] L2 auto-merge: merged ${idsToDelete.length} cold scenes into "${archiveSceneName}".`);
}
