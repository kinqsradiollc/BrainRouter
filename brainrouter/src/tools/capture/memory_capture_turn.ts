import { z } from "zod";
import { memoryEngine } from "../../memory/engine.js";
import { projectTagFromName } from "@kinqs/brainrouter-types";
import { repoScopedWorkspaceTag } from "../../memory/repoScope.js";
import { redactSensitiveMemoryText } from "../../memory/util/redaction.js";
import {
  MEMORY_CAPTURE_MAX_TAGS,
  MEMORY_CAPTURE_TAG_PATTERN,
  normalizeMemoryTags,
} from "../../memory/capture/memoryTags.js";

const memoryTagsSchema = z.array(
  z.string()
    .trim()
    .min(1)
    .max(128)
    .regex(MEMORY_CAPTURE_TAG_PATTERN)
    .refine((tag) => redactSensitiveMemoryText(tag) === tag, "Memory tags cannot contain credential material."),
).max(MEMORY_CAPTURE_MAX_TAGS).transform(normalizeMemoryTags);

export const memoryCaptureTurnToolSchema = {
  name: "memory_capture_turn",
  description: "Record a completed conversation turn for memory processing. Call this passively after every agent response to ensure accurate tracking.",
  inputSchema: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "The ID of the user (enforces multi-tenant isolation)."
      },
      sessionKey: {
        type: "string",
        description: "A stable identifier for this conversation channel/session."
      },
      sessionId: {
        type: "string",
        description: "An optional sub-session identifier."
      },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["user", "assistant", "tool"] },
            content: { type: "string" },
            timestamp: { type: "number", description: "Epoch timestamp in milliseconds" }
          },
          required: ["role", "content", "timestamp"]
        },
        description: "The new messages that occurred in this turn."
      },
      activeSkill: {
        type: "string",
        description: "The name of the BrainRouter skill currently being executed (if any)."
      },
      skillHints: {
        type: "string",
        description: "Skill-specific extraction hints provided by the active skill."
      },
      memoryTags: {
        type: "array",
        items: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]{0,127}$", maxLength: 128 },
        maxItems: 32,
        description: "Reviewed semantic tags from the active workspace manifest. Stored separately from activeSkill."
      },
      workspaceRoot: {
        type: "string",
        description: "Absolute path of the workspace this turn belongs to — hashed to a stable workspace_tag for per-workspace scoping."
      },
      repoTag: {
        type: "string",
        description: "ADR-015 P1c — the repo-identity tag (16-hex hash of the normalized git remote, from git-info). When present it scopes this turn by REPO instead of the folder path, so recall survives a moved/renamed folder or a second clone. Omit for a non-git workspace to fall back to workspaceRoot's path hash. Send the same repoTag to memory_recall to read it back."
      },
      projectName: {
        type: "string",
        description: "Project name (from .brainrouter/project.json) — hashed to a stable project_tag."
      }
    },
    required: ["sessionKey", "messages"]
  }
} as const;

export async function handleMemoryCaptureTurn(args: any, options?: { defaultUserId?: string; defaultOrgId?: string }) {
  const params = z.object({
    userId: z.string().optional(),
    sessionKey: z.string(),
    sessionId: z.string().optional(),
    // DoS bound — a single capture writes + redacts + chunks + inserts each
    // message synchronously on the lone SQLite writer. Truncate (not reject) to
    // keep legit turns working while capping a pathological one: ≤1000 messages,
    // ≤200 KB each. Normal turns (<50 messages, <50 KB) are untouched.
    messages: z.array(z.object({
      role: z.enum(["user", "assistant", "tool"]),
      content: z.string().transform((s) => s.slice(0, 200_000)),
      timestamp: z.number()
    })).transform((a) => a.slice(0, 1000)),
    activeSkill: z.string().optional(),
    skillHints: z.string().optional(),
    memoryTags: memoryTagsSchema.optional(),
    workspaceRoot: z.string().optional(),
    repoTag: z.string().trim().max(64).optional(),
    projectName: z.string().optional()
  }).parse(args);
  const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";

  try {
    if (params.activeSkill) {
      memoryEngine.spikeSkill(effectiveUserId, params.activeSkill);
    }

    const result = await memoryEngine.capture({
      userId: effectiveUserId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      messages: params.messages,
      activeSkill: params.activeSkill,
      skillHints: params.skillHints,
      memoryTags: params.memoryTags,
      // ADR-017 D4 — org scope is server-authoritative: it comes from the
      // authenticated MCP connection (defaultOrgId), never a client argument,
      // so a caller can't write into another org's memory (mirrors memory_recall).
      orgId: options?.defaultOrgId ?? null,
      // ADR-015 P1c — scope by repo identity when the client knows its git remote
      // (survives a moved/renamed folder), else the workspace path hash.
      workspaceTag: repoScopedWorkspaceTag(params.repoTag, params.workspaceRoot),
      projectTag: projectTagFromName(params.projectName)
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `Capture failed: ${err.message}` }]
    };
  }
}
