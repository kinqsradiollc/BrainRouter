/**
 * BrainRouter Memory Types — core record shapes.
 *
 * Sensory + cognitive record definitions and the workspace/project tag
 * hashers. Split out of the original `memory.ts` god file; re-exported
 * from the `../memory.js` barrel so the public surface is unchanged.
 */

// ============================
// Record Types
// ============================

export interface SensoryRecord {
  id: string;
  userId: string;
  sessionKey: string;
  sessionId: string;
  role: string;
  messageText: string;
  recordedAt: string;
  timestamp: number;
  skillTag: string;
  /** Semantic workspace-profile tags retained until deferred extraction. */
  memoryTags?: string[];
}

export type MemoryType =
  | "persona"
  | "episodic"
  | "instruction"
  | "skill_context"
  | "tool_preference"
  | "codebase_fact"
  | "api_contract"
  | "data_model"
  | "dependency_constraint"
  | "environment_constraint"
  | "architecture_decision"
  | "implementation_decision"
  | "design_constraint"
  | "security_policy"
  | "performance_baseline"
  | "bug_finding"
  | "debug_trace"
  | "fix_summary"
  | "verification_result"
  | "failed_attempt"
  | "regression_risk"
  | "task_state"
  | "handover_note"
  | "blocked_reason"
  | "review_comment"
  | "release_note"
  | "source_evidence"
  | "artifact_reference"
  | "file_history"
  | "command_knowledge"
  | "lesson";

// The runtime list of every cognitive `MemoryType` lives in the
// crypto-free `./memory-type-list.ts` so browser bundles (the dashboard
// `/memories` filter) can import it without pulling `node:crypto`, which
// the hash helpers below use. Re-exported from the package index.

export type MemoryStatus = "active" | "superseded" | "archived" | "needs_verification";

export type MemorySourceKind =
  | ""
  | "user_instruction"
  | "source_file"
  | "command_output"
  | "test_result"
  | "model_inference"
  | "prior_memory";

export type MemoryVerificationStatus = "" | "verified" | "unverified" | "stale";

export type EvidenceKind = "file" | "command" | "url" | "test" | "benchmark" | "memory" | "other";

export interface EvidenceRef {
  kind: EvidenceKind;
  ref: string;
}

export interface CognitiveRecord {
  id: string;
  userId: string;
  sessionKey: string;
  sessionId: string;
  content: string;
  type: MemoryType;
  priority: number;
  sceneName: string;
  skillTag: string;
  halfLifeDays: number | null; // null = never decays (e.g. instruction)
  supersededBy: string | null;
  invalidAt?: string | null;
  timestampStr: string;
  timestampStart: string;
  timestampEnd: string;
  createdTime: string;
  updatedTime: string;
  metadata: Record<string, unknown>;
  confidence: number;
  status: MemoryStatus;
  sourceKind: MemorySourceKind;
  verificationStatus: MemoryVerificationStatus;
  repoPaths: string[];
  filePaths: string[];
  commands: string[];
  // ACE Feedback Loop
  citationCount: number;
  lastCitedAt: string | null;
  neverCitedCount: number;
  archived: boolean;
  /**
   * Federation Stage 1 (0.4.0) — optional workspace identifier the
   * record was captured under. Default is a stable hash of the
   * workspace root path (see `workspaceTagFromPath`). NULL means
   * "no workspace context known at capture time" — recall filters
   * are NULL-tolerant on either side so legacy records keep
   * surfacing across all workspaces until they're re-captured.
   */
  workspaceTag?: string | null;
  /**
   * AUG-A1 (0.4.1) — optional Project identifier grouping several
   * workspaces under one logical project (a `.brainrouter/project.json`
   * marker names it; `projectTagFromName` hashes that name). NULL means
   * "no project context" — recall filters are NULL-tolerant so legacy /
   * untagged records keep surfacing regardless of the active project.
   */
  projectTag?: string | null;
  /**
   * ADR-010 P5 / ADR-014 — the organization this record belongs to. NULL/absent =
   * the user's personal scope (pre-tenancy records). Recall filters are org-aware:
   * a member only sees their own records + records shared with their active org.
   */
  orgId?: string | null;
  /**
   * ADR-014 — record visibility WITHIN its org. `private` = only the owning user;
   * `org` = every member of `orgId`. Absent = `private` (today's behaviour).
   */
  visibility?: MemoryVisibility;
}

/** Record visibility within an organization (ADR-014). */
export type MemoryVisibility = "private" | "org";

import { createHash } from "node:crypto";

/**
 * Compute the canonical workspace tag from a workspace root path —
 * a 16-char hex SHA-256 prefix. The same root always hashes to the
 * same tag, so the BrainRouter CLI and any peer MCP client agree on
 * the identifier without coordinating.
 *
 * Empty/missing input returns `null` rather than a hash of an empty
 * string, so callers can pass an unresolved workspace through without
 * accidentally tagging records with a synthetic constant.
 */
export function workspaceTagFromPath(workspaceRoot: string | undefined | null): string | null {
  if (!workspaceRoot || workspaceRoot.trim() === "") return null;
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

/**
 * AUG-A1 (0.4.1) — canonical Project tag from a project name (the
 * `name` field of a `.brainrouter/project.json` marker). A 16-char
 * hex SHA-256 prefix over the normalized name, so every workspace that
 * declares the same project name shares one tag. Empty/missing → null.
 */
export function projectTagFromName(projectName: string | undefined | null): string | null {
  const name = projectName?.trim().toLowerCase();
  if (!name) return null;
  return createHash("sha256").update(`project:${name}`).digest("hex").slice(0, 16);
}
