import { randomUUID } from "node:crypto";
import type { KnowledgeActor } from "../contracts/actor.js";
import type {
  CreateKnowledgeBaseInput,
  KnowledgeBaseRecord,
  KnowledgeServiceFailure,
  KnowledgeServiceResult,
  UpdateKnowledgeBaseInput,
} from "../contracts/base.js";
import type { KnowledgeBaseStore } from "../store.js";
import { canUseKnowledge } from "../contracts/actor.js";
import { resolveKnowledgeProject } from "./project-access.js";

const NOT_FOUND: KnowledgeServiceFailure = { ok: false, code: "not_found" };
const FORBIDDEN: KnowledgeServiceFailure = { ok: false, code: "forbidden" };

type AuthorizedProject = { ok: true; projectId: string } | KnowledgeServiceFailure;

export interface KnowledgeBaseServiceOptions {
  idGenerator?: () => string;
  now?: () => string;
}

export class KnowledgeBaseService {
  readonly #idGenerator: () => string;
  readonly #now: () => string;

  constructor(
    private readonly store: KnowledgeBaseStore,
    options: KnowledgeBaseServiceOptions = {},
  ) {
    this.#idGenerator = options.idGenerator ?? (() => `kb_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async list(actor: KnowledgeActor, projectId: string): Promise<KnowledgeServiceResult<KnowledgeBaseRecord[]>> {
    const access = await this.#authorize(actor, projectId, "read");
    if (!access.ok) return access;
    return { ok: true, value: await this.store.listKnowledgeBases(actor.orgId, access.projectId) };
  }

  async get(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
  ): Promise<KnowledgeServiceResult<KnowledgeBaseRecord>> {
    const access = await this.#authorize(actor, projectId, "read");
    if (!access.ok) return access;
    const normalizedBaseId = baseId.trim();
    if (!normalizedBaseId) return NOT_FOUND;
    const base = await this.store.getKnowledgeBase(normalizedBaseId, actor.orgId, access.projectId);
    return base ? { ok: true, value: base } : NOT_FOUND;
  }

  async create(
    actor: KnowledgeActor,
    projectId: string,
    input: CreateKnowledgeBaseInput,
  ): Promise<KnowledgeServiceResult<KnowledgeBaseRecord>> {
    const access = await this.#authorize(actor, projectId, "write");
    if (!access.ok) return access;
    const normalized = normalizeCreate(input);
    if (!normalized.ok) return normalized;
    const now = this.#now();
    const record: KnowledgeBaseRecord = {
      baseId: this.#idGenerator(),
      orgId: actor.orgId,
      projectId: access.projectId,
      name: normalized.value.name,
      description: normalized.value.description,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.store.createKnowledgeBase(record);
    } catch (error) {
      if (isKnowledgeBaseNameConflict(error)) {
        return { ok: false, code: "conflict", field: "name" };
      }
      throw error;
    }
    return { ok: true, value: record };
  }

  async update(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    patch: UpdateKnowledgeBaseInput,
  ): Promise<KnowledgeServiceResult<KnowledgeBaseRecord>> {
    const access = await this.#authorize(actor, projectId, "write");
    if (!access.ok) return access;
    const normalizedBaseId = baseId.trim();
    if (!normalizedBaseId) return NOT_FOUND;
    const existing = await this.store.getKnowledgeBase(normalizedBaseId, actor.orgId, access.projectId);
    if (!existing) return NOT_FOUND;
    const normalized = normalizePatch(patch);
    if (!normalized.ok) return normalized;
    let updated: KnowledgeBaseRecord | null;
    try {
      updated = await this.store.updateKnowledgeBase(normalizedBaseId, actor.orgId, access.projectId, {
        ...normalized.value,
        updatedAt: this.#now(),
      });
    } catch (error) {
      if (isKnowledgeBaseNameConflict(error)) {
        return { ok: false, code: "conflict", field: "name" };
      }
      throw error;
    }
    return updated ? { ok: true, value: updated } : NOT_FOUND;
  }

  async delete(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
  ): Promise<KnowledgeServiceResult<true>> {
    const access = await this.#authorize(actor, projectId, "write");
    if (!access.ok) return access;
    const normalizedBaseId = baseId.trim();
    if (!normalizedBaseId) return NOT_FOUND;
    const deleted = await this.store.deleteKnowledgeBase(normalizedBaseId, actor.orgId, access.projectId);
    return deleted ? { ok: true, value: true } : NOT_FOUND;
  }

  async #authorize(
    actor: KnowledgeActor,
    projectId: string,
    action: "read" | "write",
  ): Promise<AuthorizedProject> {
    const project = await resolveKnowledgeProject(actor, projectId, this.store);
    if (!project) return NOT_FOUND;
    if (!canUseKnowledge(actor, action)) return FORBIDDEN;
    return { ok: true, projectId: project.projectId };
  }
}

function normalizeCreate(input: CreateKnowledgeBaseInput): KnowledgeServiceResult<Required<CreateKnowledgeBaseInput>> {
  const name = normalizeName(input.name);
  if (!name) return { ok: false, code: "invalid", field: "name" };
  const description = normalizeDescription(input.description ?? "");
  if (description === null) return { ok: false, code: "invalid", field: "description" };
  return { ok: true, value: { name, description } };
}

function normalizePatch(input: UpdateKnowledgeBaseInput): KnowledgeServiceResult<UpdateKnowledgeBaseInput> {
  if (input.name === undefined && input.description === undefined) {
    return { ok: false, code: "invalid", field: "patch" };
  }
  const patch: UpdateKnowledgeBaseInput = {};
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (!name) return { ok: false, code: "invalid", field: "name" };
    patch.name = name;
  }
  if (input.description !== undefined) {
    const description = normalizeDescription(input.description);
    if (description === null) return { ok: false, code: "invalid", field: "description" };
    patch.description = description;
  }
  return { ok: true, value: patch };
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : null;
}

function normalizeDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= 4_000 ? normalized : null;
}

function isKnowledgeBaseNameConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const postgresError = error as { code?: unknown; constraint?: unknown };
  return postgresError.code === "23505"
    && postgresError.constraint === "uq_knowledge_bases_project_name";
}
