/**
 * B1a knowledge actor contract.
 *
 * REST and MCP adapters construct this only from authenticated server context;
 * knowledge request payloads never supply tenant, user, role, or admin fields.
 * Invalid or incomplete context fails closed before a store query is possible.
 */
import { can, normalizeRole, type Role } from "../../tenancy/rbac.js";

export interface KnowledgeActor {
  userId: string;
  orgId: string;
  role: Role;
  isSystemAdmin: boolean;
}

export interface KnowledgeAuthContext {
  userId?: string | null;
  orgId?: string | null;
  role?: string | null;
  isAdmin?: boolean;
}

export type KnowledgeAction = "read" | "write";

/** Derive the domain actor from an adapter's trusted auth context. */
export function knowledgeActorFromAuth(context: KnowledgeAuthContext): KnowledgeActor | null {
  const userId = context.userId?.trim();
  const orgId = context.orgId?.trim();
  const role = normalizeRole(context.role);
  if (!userId || !orgId || !role) return null;
  return { userId, orgId, role, isSystemAdmin: context.isAdmin === true };
}

/** Central role decision used by every future knowledge adapter/service. */
export function canUseKnowledge(actor: KnowledgeActor, action: KnowledgeAction): boolean {
  if (actor.isSystemAdmin) return true;
  return can(actor.role, action === "read" ? "knowledge:read" : "knowledge:write");
}
