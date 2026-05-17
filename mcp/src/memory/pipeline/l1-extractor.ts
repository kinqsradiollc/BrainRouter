import { EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt } from "../prompts/l1-extraction.js";
import type { L0Record, L1Record, LLMRunner, MemoryType } from "../types.js";
import crypto from "node:crypto";

export interface L1ExtractionResult {
  success: boolean;
  extractedCount: number;
  records: L1Record[];
  sceneNames: string[];
}

// Ensure the message has actual words to extract from, not just symbols or single letters.
function shouldExtractL1(text: string): boolean {
  if (!text) return false;
  const clean = text.trim();
  if (clean.length < 3) return false;
  // If it's pure symbols/numbers, ignore
  if (/^[^a-zA-Z\u4e00-\u9fa5]+$/.test(clean)) return false;
  return true;
}

export async function extractL1Memories(params: {
  messages: L0Record[];
  userId: string;
  sessionKey: string;
  sessionId: string;
  llmRunner: LLMRunner;
  maxMessagesPerExtraction?: number;
  maxBackgroundMessages?: number;
  previousSceneName?: string;
  existingSceneNames?: string[];
  activeSkill?: string;
  skillHints?: string;
}): Promise<L1ExtractionResult> {
  const { 
    messages, userId, sessionKey, sessionId, llmRunner, 
    maxMessagesPerExtraction = 10, maxBackgroundMessages = 5,
    previousSceneName, existingSceneNames, activeSkill, skillHints
  } = params;

  if (messages.length === 0) {
    return { success: true, extractedCount: 0, records: [], sceneNames: [] };
  }

  const qualifiedMessages = messages.filter((m) => shouldExtractL1(m.messageText));
  if (qualifiedMessages.length === 0) {
    return { success: true, extractedCount: 0, records: [], sceneNames: [] };
  }

  const newMessages = qualifiedMessages.slice(-maxMessagesPerExtraction);
  const bgEndIdx = qualifiedMessages.length - newMessages.length;
  const backgroundMessages = bgEndIdx > 0
    ? qualifiedMessages.slice(Math.max(0, bgEndIdx - maxBackgroundMessages), bgEndIdx)
    : [];

  const userPrompt = formatExtractionPrompt({
    newMessages,
    backgroundMessages,
    previousSceneName,
    existingSceneNames,
    activeSkill,
    skillHints
  });

  let rawResult: string;
  try {
    rawResult = await llmRunner.run({
      prompt: userPrompt,
      systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT,
      taskId: "l1-extraction",
      timeoutMs: 120_000
    });
  } catch (err) {
    console.error("[BrainRouter] LLM extraction failed:", err);
    return { success: false, extractedCount: 0, records: [], sceneNames: [] };
  }

  const parsedScenes = parseExtractionResult(rawResult);
  
  const records: L1Record[] = [];
  const sceneNames: string[] = [];

  const nowStr = new Date().toISOString();

  for (const scene of parsedScenes) {
    sceneNames.push(scene.scene_name);
    for (const mem of scene.memories) {
      records.push({
        id: `l1_${sessionKey}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        userId,
        sessionKey,
        sessionId,
        content: mem.content,
        type: mem.type,
        priority: mem.priority,
        sceneName: scene.scene_name,
        skillTag: mem.skill_tag || activeSkill || "",
        halfLifeDays: mem.type === "instruction" ? null : (mem.type === "persona" ? 180 : (mem.type === "skill_context" ? 7 : 30)),
        supersededBy: null,
        timestampStr: "", // Phase 1: Not strictly tracking time from LLM, just raw extraction
        timestampStart: "",
        timestampEnd: "",
        createdTime: nowStr,
        updatedTime: nowStr,
        metadata: mem.metadata,
        // ACE fields — zero on creation, updated by citation tracking
        citationCount: 0,
        lastCitedAt: null,
        neverCitedCount: 0,
        archived: false,
      });
    }
  }

  return {
    success: true,
    extractedCount: records.length,
    records,
    sceneNames
  };
}

// --------------------------------------------------------
// Parsing
// --------------------------------------------------------

interface ParsedScene {
  scene_name: string;
  memories: Array<{
    type: MemoryType;
    content: string;
    priority: number;
    skill_tag?: string;
    metadata: Record<string, unknown>;
  }>;
}

function parseExtractionResult(raw: string): ParsedScene[] {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith("\`\`\`")) {
      cleaned = cleaned.replace(/^\`\`\`(?:json)?\s*\n?/, "").replace(/\n?\`\`\`\s*$/, "");
    }

    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    const scenes: ParsedScene[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      
      const s = item as any;
      const memories = Array.isArray(s.memories) ? s.memories.map((m: any) => ({
        content: String(m.content || ""),
        type: (m.type as MemoryType) || "episodic",
        priority: typeof m.priority === "number" ? m.priority : 50,
        skill_tag: m.skill_tag ? String(m.skill_tag) : undefined,
        metadata: m.metadata && typeof m.metadata === "object" ? m.metadata : {}
      })).filter((m: any) => m.content.length > 0) : [];

      scenes.push({
        scene_name: String(s.scene_name || "Unknown Scene"),
        memories
      });
    }

    return scenes;
  } catch (err) {
    console.error("[BrainRouter] Failed to parse extraction result", err);
    return [];
  }
}
