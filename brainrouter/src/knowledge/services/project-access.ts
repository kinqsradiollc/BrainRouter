/**
 * B1a Project authorization service for knowledge operations.
 *
 * It combines a server-derived actor with the existing Project visibility rule.
 * A null result intentionally covers missing, foreign, and inaccessible ids so
 * presentation adapters can return the same 404 without creating an ID oracle.
 */
import { roleAtLeast } from "../../tenancy/rbac.js";
import type { ProjectRecord } from "../../tenancy/store.js";
import type { KnowledgeActor } from "../contracts/actor.js";

export interface KnowledgeProjectAccessStore {
  getAccessibleProject(
    projectId: string,
    orgId: string,
    userId: string,
    canAccessRestricted: boolean,
  ): Promise<ProjectRecord | null>;
}

export async function resolveKnowledgeProject(
  actor: KnowledgeActor,
  projectId: string,
  store: KnowledgeProjectAccessStore,
): Promise<ProjectRecord | null> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) return null;
  const canAccessRestricted = actor.isSystemAdmin || roleAtLeast(actor.role, "admin");
  return store.getAccessibleProject(normalizedProjectId, actor.orgId, actor.userId, canAccessRestricted);
}
