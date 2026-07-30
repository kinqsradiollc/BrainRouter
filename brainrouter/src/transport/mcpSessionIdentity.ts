import type { Role } from "../tenancy/rbac.js";

/** Authentication state pinned when an HTTP MCP session is initialized. */
export interface McpSessionIdentity {
  userId: string;
  orgId?: string;
  role?: Role;
  isAdmin: boolean;
}

/**
 * Existing MCP sessions must not be reusable under a different actor or tenant.
 * Role/admin changes also force reconnect so long-lived sessions cannot retain
 * stale authorization.
 */
export function matchesMcpSessionIdentity(
  pinned: McpSessionIdentity,
  current: McpSessionIdentity,
): boolean {
  return pinned.userId === current.userId
    && pinned.orgId === current.orgId
    && pinned.role === current.role
    && pinned.isAdmin === current.isAdmin;
}
