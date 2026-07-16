/** Typed Team spaces adapter for management and Meetings sharing. */
export type TeamRole = "member" | "admin" | "owner";
export type TeamKind = "organization" | "personal";

export interface TeamContext { orgId: string; name: string; isDefault?: boolean; isPersonal?: boolean; role?: string }
export interface TeamOption {
  id: string;
  kind: TeamKind;
  orgId: string | null;
  orgName?: string;
  ownerUserId?: string;
  name: string;
  createdAt?: string;
  createdBy?: string;
  myRole?: TeamRole;
  canManage: boolean;
}
export interface TeamMember {
  userId: string;
  role: TeamRole;
  displayName?: string;
  email?: string;
  joinedAt?: string;
}
export interface TeamDetail { team: TeamOption; members: TeamMember[]; currentUserId?: string }

export interface TeamsOps {
  contexts(): Promise<TeamContext[]>;
  list(orgId?: string): Promise<TeamOption[]>;
  get(id: string, orgId?: string): Promise<TeamDetail>;
  create(name: string, kind?: TeamKind, orgId?: string): Promise<TeamOption>;
  addMember(id: string, account: string, role: TeamRole, orgId?: string): Promise<TeamMember[]>;
  removeMember(id: string, userId: string, orgId?: string): Promise<void>;
  remove(id: string, orgId?: string): Promise<void>;
}

interface TeamsBridge {
  contexts?(): Promise<unknown>;
  list(orgId?: string): Promise<unknown>;
  get(id: string, orgId?: string): Promise<unknown>;
  create(name: string, kind: TeamKind, orgId?: string): Promise<unknown>;
  addMember(id: string, account: string, role: TeamRole, orgId?: string): Promise<unknown>;
  removeMember(id: string, userId: string, orgId?: string): Promise<unknown>;
  remove(id: string, orgId?: string): Promise<unknown>;
}

function bridge(): TeamsBridge | null {
  const root = globalThis as unknown as { brainrouter?: { teams?: TeamsBridge } };
  return root.brainrouter?.teams ?? null;
}

export function toTeamOptions(raw: unknown): TeamOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id) return [];
    const kind: TeamKind = row.kind === "personal" ? "personal" : "organization";
    const role = ["member", "admin", "owner"].includes(String(row.myRole)) ? row.myRole as TeamRole : undefined;
    return [{
      id: row.id,
      kind,
      orgId: row.orgId == null ? null : String(row.orgId),
      name: typeof row.name === "string" && row.name.trim() ? row.name : row.id,
      canManage: row.canManage === true,
      ...(typeof row.orgName === "string" && row.orgName ? { orgName: row.orgName } : {}),
      ...(typeof row.ownerUserId === "string" ? { ownerUserId: row.ownerUserId } : {}),
      ...(typeof row.createdAt === "string" ? { createdAt: row.createdAt } : {}),
      ...(typeof row.createdBy === "string" ? { createdBy: row.createdBy } : {}),
      ...(role ? { myRole: role } : {}),
    }];
  });
}

export function toTeamContexts(raw: unknown): TeamContext[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.orgId !== "string" || !row.orgId) return [];
    return [{ orgId: row.orgId, name: typeof row.name === "string" && row.name ? row.name : row.orgId, ...(row.isDefault === true ? { isDefault: true } : {}), ...(row.isPersonal === true ? { isPersonal: true } : {}), ...(typeof row.role === "string" ? { role: row.role } : {}) }];
  });
}

function team(value: unknown): TeamOption {
  const row = toTeamOptions([value])[0];
  if (!row) throw new Error("The server returned an invalid team.");
  return row;
}
function members(value: unknown): TeamMember[] {
  if (!Array.isArray(value)) throw new Error("The server returned invalid team members.");
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.userId !== "string" || !["member", "admin", "owner"].includes(String(row.role))) return [];
    return [{ userId: row.userId, role: row.role as TeamRole, ...(typeof row.displayName === "string" ? { displayName: row.displayName } : {}), ...(typeof row.email === "string" ? { email: row.email } : {}), ...(typeof row.joinedAt === "string" ? { joinedAt: row.joinedAt } : {}) }];
  });
}

export function createTeamsOps(): TeamsOps {
  const api = bridge();
  const unavailable = (): never => { throw new Error("Teams is unavailable in this desktop build."); };
  if (!api) return {
    contexts: async () => unavailable(), list: async () => unavailable(), get: async () => unavailable(), create: async () => unavailable(),
    addMember: async () => unavailable(), removeMember: async () => unavailable(), remove: async () => unavailable(),
  };
  return {
    contexts: async () => api.contexts ? toTeamContexts(await api.contexts()) : [],
    list: async (orgId) => toTeamOptions(await api.list(orgId)),
    get: async (id, orgId) => {
      const payload = await api.get(id, orgId) as { team?: unknown; members?: unknown; currentUserId?: unknown } | null;
      if (!payload || typeof payload !== "object") throw new Error("The server returned an invalid team detail.");
      return { team: team(payload.team), members: members(payload.members), ...(typeof payload.currentUserId === "string" ? { currentUserId: payload.currentUserId } : {}) };
    },
    create: async (name, kind = "organization", orgId) => {
      const payload = await api.create(name, kind, orgId) as { team?: unknown } | null;
      if (!payload || typeof payload !== "object") throw new Error("The server returned an invalid team creation result.");
      return team(payload.team);
    },
    addMember: async (id, account, role, orgId) => {
      const payload = await api.addMember(id, account, role, orgId) as { members?: unknown } | null;
      if (!payload || typeof payload !== "object") throw new Error("The server returned an invalid membership result.");
      return members(payload.members);
    },
    removeMember: async (id, userId, orgId) => { await api.removeMember(id, userId, orgId); },
    remove: async (id, orgId) => { await api.remove(id, orgId); },
  };
}

export async function listTeams(): Promise<TeamOption[]> {
  try { return await createTeamsOps().list(); } catch { return []; }
}
