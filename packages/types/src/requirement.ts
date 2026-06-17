/**
 * BrainRouter Requirement Records (0.4.15)
 *
 * A Requirement Record is a structured unit of intent a chat session can be
 * anchored to: a title + description, a lifecycle status, a priority, a list
 * of acceptance criteria, the clarifying Q&A that shaped it, and links back to
 * the session / tasks / artifacts / memory records it produced.
 *
 * This module is the stable, dependency-free contract shared by the CLI store
 * (and, in later slices, the desktop panel + MCP tools). Field casing follows
 * the rest of this package — camelCase keys, plain-`string` ids, ISO-8601
 * timestamp strings.
 */

/**
 * Identifier for a requirement. A plain `string` alias (matching the
 * `id: string` convention every other record in this package uses) rather
 * than a nominal brand, so callers can pass ids around without casting.
 */
export type RequirementId = string;

/**
 * Lifecycle of a requirement. `draft` is the freshly-created state; a record
 * moves through `clarifying` (open questions), `ready` (criteria agreed),
 * `in-progress`, `done`, and finally `archived` when it is no longer live.
 */
export type RequirementStatus =
  | "draft"
  | "clarifying"
  | "ready"
  | "in-progress"
  | "done"
  | "archived";

export type RequirementPriority = "low" | "medium" | "high";

/** One clarifying exchange: a question, optionally answered. */
export interface ClarifyingQA {
  question: string;
  answer?: string;
}

export interface RequirementRecord {
  id: RequirementId;
  title: string;
  description?: string;
  status: RequirementStatus;
  priority: RequirementPriority;
  /** Concrete, verifiable conditions the requirement is "done" against. */
  acceptanceCriteria: string[];
  /** The clarifying conversation that shaped (or is still shaping) the record. */
  clarifyingQuestions: ClarifyingQA[];
  /** Absolute workspace root the requirement belongs to. */
  workspaceRoot: string;
  /** Session this requirement is anchored to, when known. */
  sessionKey?: string;
  /** Plan/task ids this requirement produced or depends on. */
  taskIds: string[];
  /** Workflow-artifact ids linked to this requirement. */
  artifactIds: string[];
  /** Cognitive memory record ids captured for this requirement. */
  linkedMemoryIds: string[];
  /** Agent-protocol / orchestration event id this record originated from, if any. */
  sourceEventId?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp; bumped on every mutation. */
  updatedAt: string;
}

const REQUIREMENT_STATUSES: readonly RequirementStatus[] = [
  "draft",
  "clarifying",
  "ready",
  "in-progress",
  "done",
  "archived",
];

const REQUIREMENT_PRIORITIES: readonly RequirementPriority[] = ["low", "medium", "high"];

/** Narrow an unknown value to a {@link RequirementStatus}. */
export function isRequirementStatus(x: unknown): x is RequirementStatus {
  return typeof x === "string" && (REQUIREMENT_STATUSES as readonly string[]).includes(x);
}

/** Narrow an unknown value to a {@link RequirementPriority}. */
export function isRequirementPriority(x: unknown): x is RequirementPriority {
  return typeof x === "string" && (REQUIREMENT_PRIORITIES as readonly string[]).includes(x);
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function isClarifyingQAArray(x: unknown): x is ClarifyingQA[] {
  return (
    Array.isArray(x) &&
    x.every(
      (v) =>
        !!v &&
        typeof v === "object" &&
        typeof (v as ClarifyingQA).question === "string" &&
        ((v as ClarifyingQA).answer === undefined || typeof (v as ClarifyingQA).answer === "string"),
    )
  );
}

/**
 * Structural type guard for a {@link RequirementRecord}. Validates the
 * required fields + enum membership so a hand-edited or foreign JSON blob
 * can be rejected before it is treated as a record.
 */
export function isRequirementRecord(x: unknown): x is RequirementRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    (r.description === undefined || typeof r.description === "string") &&
    isRequirementStatus(r.status) &&
    isRequirementPriority(r.priority) &&
    isStringArray(r.acceptanceCriteria) &&
    isClarifyingQAArray(r.clarifyingQuestions) &&
    typeof r.workspaceRoot === "string" &&
    (r.sessionKey === undefined || typeof r.sessionKey === "string") &&
    isStringArray(r.taskIds) &&
    isStringArray(r.artifactIds) &&
    isStringArray(r.linkedMemoryIds) &&
    (r.sourceEventId === undefined || typeof r.sourceEventId === "string") &&
    typeof r.createdAt === "string" &&
    typeof r.updatedAt === "string"
  );
}
