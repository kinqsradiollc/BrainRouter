import type { IMemoryStore } from "@brainrouter/types";
import type { LLMRunner, ContextualFocusRecord } from "@brainrouter/types";
import { FOCUS_SCENE_SYSTEM_PROMPT, formatFocusScenePrompt } from "../prompts/focus-scene.js";
import { FOCUS_SCENE_CLUSTER_SYSTEM_PROMPT, formatFocusSceneClusterPrompt } from "../prompts/focus-scene-cluster.js";
import { MAX_FOCUS_SCENES } from "../scheduler.js";
import crypto from "node:crypto";

async function canonicalizeFocusNames(params: {
  userId: string;
  store: IMemoryStore;
  llmRunner: LLMRunner;
}) {
  const { userId, store, llmRunner } = params;
  const sceneNames = store.getDistinctSceneNames(userId);
  if (sceneNames.length < 2) return;

  try {
    const rawCluster = await llmRunner.run({
      prompt: formatFocusSceneClusterPrompt(sceneNames),
      systemPrompt: FOCUS_SCENE_CLUSTER_SYSTEM_PROMPT,
      taskId: "focus-scene-clustering",
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
        store.renameFocusInCognitiveRecords(userId, alias, canonical);
      }
    }
  } catch (err) {
    console.error(`[BrainRouter] Focus scene canonicalization failed for "${userId}":`, (err as Error).message);
  }
}

/**
 * Distills and updates Focus Scenes by grouping CognitiveRecords.
 */
export async function distillFocusScenes(params: {
  userId: string;
  store: IMemoryStore;
  llmRunner: LLMRunner;
}): Promise<{ focusDistilled: number; sceneNames: string[] }> {
  const { userId, store, llmRunner } = params;

  // Run scene canonicalization/clustering pass to prevent cold-start fragmentation
  await canonicalizeFocusNames({ userId, store, llmRunner });

  // Decay all existing heat scores (each distillation cycle = time passing)
  store.decayContextualFocusHeatScores(userId);

  const sceneNames = store.getDistinctSceneNames(userId);
  if (sceneNames.length === 0) {
    return { focusDistilled: 0, sceneNames: [] };
  }

  const now = new Date().toISOString();
  const distilled: string[] = [];

  // Fetch existing focus scenes up-front so the prompt can avoid near-duplicates
  const existingFocusNames = store.getTopContextualFocus(userId, 50).map(s => s.sceneName);

  for (const sceneName of sceneNames) {
    const cognitives = store.getCognitivesByFocus(userId, sceneName, 30);
    if (cognitives.length === 0) continue;

    let summaryMd: string;
    try {
      summaryMd = await llmRunner.run({
        prompt: formatFocusScenePrompt(sceneName, cognitives, existingFocusNames.filter(n => n !== sceneName)),
        systemPrompt: FOCUS_SCENE_SYSTEM_PROMPT,
        taskId: "focus-scene-distillation",
        timeoutMs: 60_000,
      });
    } catch (err) {
      console.error(`[BrainRouter] Focus scene distillation failed for "${sceneName}":`, (err as Error).message);
      continue;
    }

    const existing = store.getContextualFocusByName(userId, sceneName);
    const record: ContextualFocusRecord = {
      id: existing?.id ?? `focus_${crypto.randomBytes(6).toString("hex")}`,
      userId,
      sceneName,
      summaryMd: summaryMd.trim(),
      heatScore: existing ? Math.min(100, existing.heatScore + 30) : 100,
      lastActiveTime: now,
      createdTime: existing?.createdTime ?? now,
      updatedTime: now,
    };

    store.upsertContextualFocus(record);
    distilled.push(sceneName);
  }

  // Auto-merge cold scenes if we exceed the max threshold
  await mergeFocusScenes({ userId, store, llmRunner });

  console.error(`[BrainRouter] Distilled ${distilled.length} focus scene(s) for user "${userId}".`);
  return { focusDistilled: distilled.length, sceneNames: distilled };
}

async function mergeFocusScenes(params: { userId: string; store: IMemoryStore; llmRunner: LLMRunner }) {
  const { userId, store, llmRunner } = params;
  
  const focusCount = store.getContextualFocusCount(userId);
  if (focusCount < MAX_FOCUS_SCENES) return;

  const overflow = focusCount - MAX_FOCUS_SCENES + 1;
  const coldScenes = store.getColdContextualFocus(userId, overflow + 3);
  
  if (coldScenes.length < 2) return;

  const archiveSceneName = "[Archived]";
  const scenesToMerge = coldScenes.filter(s => s.sceneName !== archiveSceneName);
  if (scenesToMerge.length < 2) return;

  const sceneSummaries = scenesToMerge.map(s => `## ${s.sceneName}\n${s.summaryMd}`).join("\n\n");
  
  let unifiedSummary: string;
  try {
    unifiedSummary = await llmRunner.run({
      prompt: `Merge the following old focus scene summaries into a single concise "Archived Focus Scenes" overview.\n\n${sceneSummaries}\n\nOutput only the Markdown summary. Be concise — no preamble.`,
      systemPrompt: FOCUS_SCENE_SYSTEM_PROMPT,
      taskId: "focus-scene-merge",
      timeoutMs: 60_000,
    });
  } catch (err) {
    console.error(`[BrainRouter] Focus scene merge failed for "${userId}":`, (err as Error).message);
    return;
  }

  const now = new Date().toISOString();
  const existingArchive = store.getContextualFocusByName(userId, archiveSceneName);
  
  const record: ContextualFocusRecord = {
    id: existingArchive?.id ?? `focus_${crypto.randomBytes(6).toString("hex")}`,
    userId,
    sceneName: archiveSceneName,
    summaryMd: unifiedSummary.trim(),
    heatScore: 10,
    lastActiveTime: now,
    createdTime: existingArchive?.createdTime ?? now,
    updatedTime: now,
  };

  store.upsertContextualFocus(record);
  
  const idsToDelete = scenesToMerge.map(s => s.id);
  store.deleteContextualFocus(userId, idsToDelete);
  
  console.error(`[BrainRouter] Focus auto-merge: merged ${idsToDelete.length} cold focus scenes into "${archiveSceneName}".`);
}
