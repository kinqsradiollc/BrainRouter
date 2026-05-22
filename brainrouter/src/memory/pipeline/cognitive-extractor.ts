import { EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt } from "../prompts/cognitive-extraction.js";
import { getMemoryTypeConfig } from "../memory-type-config.js";
import type { SensoryRecord, CognitiveRecord, LLMRunner, MemorySourceKind, MemoryType, MemoryVerificationStatus } from "@kinqs/brainrouter-types";
import crypto from "node:crypto";

const ALLOWED_MEMORY_TYPES = new Set<MemoryType>([
  "persona", "episodic", "instruction", "skill_context", "tool_preference",
  "codebase_fact", "api_contract", "data_model", "dependency_constraint",
  "environment_constraint", "architecture_decision", "implementation_decision",
  "design_constraint", "security_policy", "performance_baseline", "bug_finding",
  "debug_trace", "fix_summary", "verification_result", "failed_attempt",
  "regression_risk", "task_state", "handover_note", "blocked_reason",
  "review_comment", "release_note", "source_evidence", "artifact_reference",
  "file_history", "command_knowledge",
]);

const ALLOWED_SOURCE_KINDS = new Set<MemorySourceKind>([
  "", "user_instruction", "source_file", "command_output", "test_result",
  "model_inference", "prior_memory",
]);

const ALLOWED_VERIFICATION_STATUSES = new Set<MemoryVerificationStatus>([
  "", "verified", "unverified", "stale",
]);

export interface CognitiveExtractionResult {
  success: boolean;
  extractedCount: number;
  records: CognitiveRecord[];
  sceneNames: string[];
  errorMessage?: string;
}

function shouldExtractCognitive(text: string): boolean {
  if (!text) return false;
  const clean = text.trim();
  if (clean.length < 3) return false;
  if (/^[^a-zA-Z\u4e00-\u9fa5]+$/.test(clean)) return false;
  return true;
}

export async function extractCognitiveMemories(params: {
  messages: SensoryRecord[];
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
}): Promise<CognitiveExtractionResult> {
  const { 
    messages, userId, sessionKey, sessionId, llmRunner, 
    maxMessagesPerExtraction = 10, maxBackgroundMessages = 5,
    previousSceneName, existingSceneNames, activeSkill, skillHints
  } = params;

  if (messages.length === 0) {
    return { success: true, extractedCount: 0, records: [], sceneNames: [] };
  }

  const qualifiedMessages = messages.filter((m) => shouldExtractCognitive(m.messageText));
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
      taskId: "cognitive-extraction",
      timeoutMs: 120_000
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const code = (err as any)?.code;
    if (code === "LLM_NOT_CONFIGURED") {
      // Expected, non-fatal: no LLM is configured server-side. Skip cognitive
      // extraction silently; sensory records are still persisted by the caller.
      return { success: false, extractedCount: 0, records: [], sceneNames: [], errorMessage: "LLM not configured; cognitive extraction skipped." };
    }
    console.error("[BrainRouter] LLM extraction failed:", err);
    return { success: false, extractedCount: 0, records: [], sceneNames: [], errorMessage };
  }

  const parsedScenes = parseExtractionResult(rawResult);
  
  const records: CognitiveRecord[] = [];
  const sceneNames: string[] = [];

  const nowStr = new Date().toISOString();

  for (const scene of parsedScenes) {
    sceneNames.push(scene.scene_name);
    for (const mem of scene.memories) {
      const config = getMemoryTypeConfig(mem.type);
      records.push({
        id: `cognitive_${sessionKey}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        userId,
        sessionKey,
        sessionId,
        content: mem.content,
        type: mem.type,
        priority: mem.priority,
        sceneName: scene.scene_name,
        skillTag: mem.skill_tag || activeSkill || "",
        halfLifeDays: config.halfLifeDays,
        supersededBy: null,
        timestampStr: "",
        timestampStart: "",
        timestampEnd: "",
        createdTime: nowStr,
        updatedTime: nowStr,
        metadata: mem.metadata,
        confidence: mem.confidence ?? config.defaultConfidence,
        status: "active",
        sourceKind: mem.sourceKind,
        verificationStatus: mem.verificationStatus,
        repoPaths: mem.repoPaths,
        filePaths: mem.filePaths,
        commands: mem.commands,
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

interface ParsedScene {
  scene_name: string;
  memories: Array<{
    type: MemoryType;
    content: string;
    priority: number;
    skill_tag?: string;
    confidence?: number;
    sourceKind: MemorySourceKind;
    verificationStatus: MemoryVerificationStatus;
    repoPaths: string[];
    filePaths: string[];
    commands: string[];
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
        type: parseMemoryType(m.type),
        priority: clampNumber(m.priority, 0, 100, 50),
        skill_tag: m.skill_tag ? String(m.skill_tag) : undefined,
        confidence: typeof m.confidence === "number" ? clampNumber(m.confidence, 0, 1, 0.65) : undefined,
        sourceKind: parseSourceKind(m.sourceKind ?? m.source_kind),
        verificationStatus: parseVerificationStatus(m.verificationStatus ?? m.verification_status),
        repoPaths: parseStringArray(m.repoPaths ?? m.repo_paths),
        filePaths: parseStringArray(m.filePaths ?? m.file_paths),
        commands: parseStringArray(m.commands),
        metadata: m.metadata && typeof m.metadata === "object" ? m.metadata : {}
      })).filter((m: any) => m.content.length > 0) : [];

      scenes.push({
        scene_name: String(s.scene_name || "Unknown Focus Scene"),
        memories
      });
    }

    return scenes;
  } catch (err) {
    console.error("[BrainRouter] Failed to parse extraction result", err);
    return [];
  }
}

function parseMemoryType(value: unknown): MemoryType {
  const candidate = String(value || "");
  return ALLOWED_MEMORY_TYPES.has(candidate as MemoryType) ? candidate as MemoryType : "episodic";
}

function parseSourceKind(value: unknown): MemorySourceKind {
  const candidate = String(value || "");
  return ALLOWED_SOURCE_KINDS.has(candidate as MemorySourceKind) ? candidate as MemorySourceKind : "model_inference";
}

function parseVerificationStatus(value: unknown): MemoryVerificationStatus {
  const candidate = String(value || "");
  return ALLOWED_VERIFICATION_STATUSES.has(candidate as MemoryVerificationStatus) ? candidate as MemoryVerificationStatus : "unverified";
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
