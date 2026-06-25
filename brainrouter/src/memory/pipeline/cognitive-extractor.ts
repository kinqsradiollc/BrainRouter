import { EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt } from "../prompts/cognitive-extraction.js";
import { getMemoryTypeConfig } from "../config/memory-type-config.js";
import type { SensoryRecord, CognitiveRecord, LLMRunner, MemorySourceKind, MemoryType, MemoryVerificationStatus } from "@kinqs/brainrouter-types";
import { isExternalTimeoutError } from "../llm/llm-response.js";
import { extractJsonValue } from "../util/llm-json.js";
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
    if (isExternalTimeoutError(err)) {
      console.warn(`[BrainRouter] LLM extraction timed out; sensory records remain queued for the extraction sweeper. ${errorMessage}`);
    } else {
      console.error("[BrainRouter] LLM extraction failed:", err);
    }
    return { success: false, extractedCount: 0, records: [], sceneNames: [], errorMessage };
  }

  if (process.env.BRAINROUTER_EXTRACTION_DEBUG_RAW === "on") {
    // Diagnostic only — OFF by default. When enabled, logs the raw model body
    // (truncated) so malformed-output root causes (e.g. a bare `[sensory_...]`
    // identifier list) can be confirmed under load. May contain user content;
    // do not enable in shared/production logs.
    console.warn(`[BrainRouter][diag] extraction raw len=${rawResult.length} body=${JSON.stringify(rawResult.slice(0, 500))}`);
  }

  if (!rawResult.trim()) {
    return {
      success: false,
      extractedCount: 0,
      records: [],
      sceneNames: [],
      errorMessage: "LLM extraction returned an empty response.",
    };
  }
  if (!/\[[\s\S]*\]/.test(rawResult)) {
    return {
      success: false,
      extractedCount: 0,
      records: [],
      sceneNames: [],
      errorMessage: `LLM extraction returned non-JSON output: ${rawResult.slice(0, 200)}`,
    };
  }

  const outcome = parseExtractionResult(rawResult);
  if (outcome.parseFailed) {
    // The body was non-empty but unusable (unparseable JSON, or a non-scene
    // shape such as a bare `[sensory_...]` identifier list). Report failure so
    // the caller re-queues the sensory rows for the sweeper instead of marking
    // them extracted and dropping them. Single warn — no scary stack dump.
    console.warn(`[BrainRouter] Cognitive extraction body invalid, re-queued: ${outcome.reason}`);
    return {
      success: false,
      extractedCount: 0,
      records: [],
      sceneNames: [],
      errorMessage: outcome.reason ?? "Failed to parse extraction result.",
    };
  }
  const parsedScenes = outcome.scenes;
  
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

// Outcome of parsing one extraction body. `parseFailed` distinguishes a body
// the caller must RE-QUEUE (unparseable, or a non-scene shape like a bare
// `[sensory_...]` identifier list) from a genuine empty result (`[]`, "nothing
// notable") which should be accepted and marked extracted. Conflating the two
// is what silently dropped sensory rows.
interface ParseExtractionOutcome {
  scenes: ParsedScene[];
  parseFailed: boolean;
  reason?: string;
}

// A scene must be a plain object. Reject arrays explicitly — `typeof [] ===
// "object"`, so a bare list item like ["a","b"] would otherwise be mistaken for
// an (empty) scene and silently accepted.
function isSceneObject(item: unknown): item is Record<string, unknown> {
  return !!item && typeof item === "object" && !Array.isArray(item);
}

function parseExtractionResult(raw: string): ParseExtractionOutcome {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith("\`\`\`")) {
      cleaned = cleaned.replace(/^\`\`\`(?:json)?\s*\n?/, "").replace(/\n?\`\`\`\s*$/, "");
    }

    // Robust extraction: tolerates leaked role tokens (`[user role]`), prose,
    // fences, trailing commas, and bad backslash escapes — see llm-json.ts.
    const parsed = extractJsonValue(cleaned, { kind: "array" });
    if (parsed === null) {
      // Covers both "no array at all" and "array-like but unparseable" — the
      // robust extractor returns null for either (see llm-json.ts).
      return { scenes: [], parseFailed: true, reason: "No parseable JSON array found in extraction output." };
    }
    if (!Array.isArray(parsed)) {
      return { scenes: [], parseFailed: true, reason: "Extraction output was not a JSON array." };
    }
    if (parsed.length === 0) {
      // Genuine "nothing notable" — the model correctly returned an empty list.
      // Accept it so trivial turns are marked extracted, not re-queued forever.
      return { scenes: [], parseFailed: false };
    }

    const scenes: ParsedScene[] = [];
    let validSceneObjects = 0;
    for (const item of parsed) {
      if (!isSceneObject(item)) continue;
      validSceneObjects += 1;

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

    if (validSceneObjects === 0) {
      // Non-empty body that yielded zero scene objects — e.g. a bare identifier
      // list like ["sensory_7d...", ...]. Re-queue rather than silently drop.
      return {
        scenes: [],
        parseFailed: true,
        reason: `Extraction output had ${parsed.length} item(s) but no valid scene objects (likely a bare identifier list).`,
      };
    }

    return { scenes, parseFailed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { scenes: [], parseFailed: true, reason: `Failed to JSON-parse extraction output: ${msg}` };
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
