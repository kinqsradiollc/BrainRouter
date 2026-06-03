import {
  AddEvidenceRequest,
  AddEvidenceResponse,
  ContradictionsResponse,
  CursorPaginationParams,
  DiagnosticsBundle,
  EvidenceResponse,
  ExplainRecallRequest,
  ExplainRecallResponse,
  ExportMemoriesResponse,
  HookRegisterRequest,
  HookRegisterResponse,
  HookStatusParams,
  HookStatusResponse,
  ImportMemoriesRequest,
  ImportMemoriesResponse,
  MeResponse,
  MemoriesResponse,
  MemoryEvidenceByRecordResponse,
  MemoryStatsResponse,
  MemoryWithEvidenceResponse,
  OperationsResponse,
  RefreshResponse,
  PublicUserRecord,
  ScenesResponse,
  SigninRequest,
  SigninResponse,
  SignupRequest,
  SignupResponse,
  UpdateMemoryRequest,
  WorkingContextRequest,
  WorkingContextResponse,
  WorkingOffloadRequest,
  WorkingOffloadResponse,
  WorkingResetRequest,
  WorkingResetResponse,
  ActiveSessionsResponse,
  ActiveSessionRecord,
  CoreIdentityRecord,
  SkillActivationsResponse,
  SourceDocument,
  SourceChunk,
  BlackboardItem,
  MemoryTreeNode,
  VaultExportEntry,
  GraphAnalytics,
} from "@kinqs/brainrouter-types";

export class BrainRouterApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: string
  ) {
    super(message);
    this.name = "BrainRouterApiError";
  }
}

export class BrainRouterClient {
  constructor(
    private baseUrl = "",
    private apiKey = "",
    private token = "",
    /** Optional refresh hook: called once on a 401; return a fresh access token
     *  to transparently replay the request, or null to let the error surface. */
    private onUnauthorized?: () => Promise<string | null>
  ) {}

  withApiKey(apiKey: string) {
    return new BrainRouterClient(this.baseUrl, apiKey, this.token, this.onUnauthorized);
  }

  withToken(token: string) {
    return new BrainRouterClient(this.baseUrl, this.apiKey, token, this.onUnauthorized);
  }

  /** Wire (or replace) the refresh hook on an existing client. */
  withOnUnauthorized(hook: () => Promise<string | null>) {
    this.onUnauthorized = hook;
    return this;
  }

  private headers(tokenOverride?: string): Record<string, string> {
    const bearer = tokenOverride || this.token || this.apiKey;
    return bearer ? { Authorization: `Bearer ${bearer}` } : {};
  }

  private qs(params?: object): string {
    if (!params) return "";
    const query = new URLSearchParams(
      Object.entries(params)
        .filter((entry): entry is [string, string | number | boolean] => {
          const value = entry[1];
          return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
        })
        .map(([key, value]) => [key, String(value)] as [string, string])
    ).toString();
    return query ? `?${query}` : "";
  }

  /** Single fetch path for every verb, with one transparent refresh-and-retry on 401. */
  private async request<T>(method: string, path: string, opts?: { query?: object; body?: unknown }): Promise<T> {
    const url = `${this.baseUrl}${path}${this.qs(opts?.query)}`;
    const hasBody = opts?.body !== undefined;
    const fire = (tokenOverride?: string) =>
      fetch(url, {
        method,
        headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...this.headers(tokenOverride) },
        body: hasBody ? JSON.stringify(opts!.body) : undefined,
      });

    let res = await fire();
    if (res.status === 401 && this.onUnauthorized && (this.token || this.apiKey)) {
      const fresh = await this.onUnauthorized();
      if (fresh) {
        this.token = fresh;
        res = await fire(fresh);
      }
    }
    if (!res.ok) throw await this.toError(res);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private get<T>(path: string, params?: object): Promise<T> { return this.request<T>("GET", path, { query: params }); }
  private post<T>(path: string, body: unknown): Promise<T> { return this.request<T>("POST", path, { body }); }
  private put<T>(path: string, body: unknown): Promise<T> { return this.request<T>("PUT", path, { body }); }
  private patch<T>(path: string, body: unknown): Promise<T> { return this.request<T>("PATCH", path, { body }); }
  private deleteReq<T>(path: string): Promise<T> { return this.request<T>("DELETE", path); }
  private deleteWithBody<T>(path: string, body: unknown): Promise<T> { return this.request<T>("DELETE", path, { body }); }

  private async toError(res: Response) {
    const body = await res.text();
    let message = body || res.statusText;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // Keep raw text for non-JSON responses.
    }
    return new BrainRouterApiError(res.status, message, body);
  }

  // Auth Operations
  signIn(body: SigninRequest) { return this.post<SigninResponse>("/api/auth/signin", body); }
  signUp(body: SignupRequest) { return this.post<SignupResponse>("/api/auth/signup", body); }
  me() { return this.get<MeResponse>("/api/auth/me"); }
  refresh(refreshToken: string) { return this.post<RefreshResponse>("/api/auth/refresh", { refreshToken }); }
  signOut() { return this.post<{ success: boolean }>("/api/auth/signout", {}); }
  updateMe(body: { displayName: string }) { return this.put<{ success: boolean }>("/api/auth/me", body); }
  rotateApiKey() { return this.post<{ apiKey: string }>("/api/auth/rotate-key", {}); }

  // Admin User Operations
  getUsers(params?: CursorPaginationParams) { return this.get<{ users: PublicUserRecord[]; nextCursor: string | null; limit: number; hasMore: boolean }>("/api/users", params); }
  createUser(payload: { userId: string; displayName?: string; isAdmin?: boolean }) { return this.post<{ user: PublicUserRecord }>("/api/users", payload); }
  updateUserStatus(userId: string, status: "active" | "disabled") { return this.put<{ success: boolean }>(`/api/users/${userId}/status`, { status }); }
  resetUserApiKey(userId: string) { return this.post<{ apiKey: string }>(`/api/users/${userId}/reset-key`, {}); }
  deleteUser(id: string) { return this.deleteReq<{ success: boolean }>(`/api/users/${id}`); }

  // Telemetry & L1/L2 Memory Operations
  getStats() { return this.get<MemoryStatsResponse>("/api/stats"); }
  // 0.4.3 — source documents + chunks (the captured, citable source layer).
  getSources(params?: { limit?: number }) { return this.get<{ documents: Array<SourceDocument & { chunkCount: number }> }>("/api/brain/sources", params); }
  getSourceChunks(documentId: string) { return this.get<{ chunks: SourceChunk[] }>(`/api/brain/sources/${documentId}/chunks`); }
  // 0.4.3 — blackboard / memory tree / vault layers.
  getBlackboard(params?: { status?: string }) { return this.get<{ items: BlackboardItem[] }>("/api/brain/blackboard", params); }
  getTreeRoots(params?: { kind?: string }) { return this.get<{ roots: MemoryTreeNode[] }>("/api/brain/tree", params); }
  /** DASH-1b — graph analytics lenses (PageRank centrality, broker/bridge entities,
   *  namespace overview, optional shortest connection path between `from` and `to`). */
  getGraphAnalytics(params?: { topN?: number; from?: string; to?: string }) {
    return this.get<GraphAnalytics>("/api/graph/analytics", params);
  }
  getTreeChildren(nodeId: string) { return this.get<{ children: MemoryTreeNode[] }>(`/api/brain/tree/${nodeId}/children`); }
  getVaultExports() { return this.get<{ exports: VaultExportEntry[] }>("/api/brain/vault"); }
  getSkillActivations() { return this.get<SkillActivationsResponse>("/api/skills/activations"); }
  getDiagnostics(userId?: string) { return this.get<DiagnosticsBundle>("/api/governance/diagnostics", { userId }); }
  getMemories(params?: CursorPaginationParams & { query?: string; type?: string; scene?: string; skill?: string; archived?: boolean }) {
    return this.get<MemoriesResponse>("/api/memories", params);
  }
  archiveMemory(id: string) { return this.deleteReq<{ success: boolean }>(`/api/memories/${id}`); }
  governanceDeleteMemory(id: string, reason: string) { return this.deleteWithBody<{ success: boolean }>(`/api/memories/${id}`, { reason }); }
  updateMemory(id: string, body: UpdateMemoryRequest) { return this.patch<MemoryWithEvidenceResponse>(`/api/memories/${id}`, body); }
  addEvidence(recordId: string, body: AddEvidenceRequest) { return this.post<AddEvidenceResponse>(`/api/memories/${recordId}/evidence`, body); }
  exportMemories() { return this.get<ExportMemoriesResponse>("/api/export"); }
  importMemories(body: ImportMemoriesRequest) { return this.post<ImportMemoriesResponse>("/api/import", body); }
  getScenes(params?: CursorPaginationParams) { return this.get<ScenesResponse>("/api/scenes", params); }
  deleteScene(id: string) { return this.deleteReq<{ success: boolean }>(`/api/scenes/${id}`); }
  getPersona() { return this.get<{ persona: CoreIdentityRecord | null }>("/api/persona"); }
  /**
   * Federation Stage 2 (0.4.0) — list the user's active peer sessions
   * (CLIs / MCP hosts currently attached to the brain). Default scope
   * is heartbeats within the last 2 minutes.
   */
  getRemoteSessions(params?: { clientKind?: string; workspaceRoot?: string; includeStale?: boolean; includeUsage?: boolean; staleThresholdMs?: number }) {
    return this.get<{ sessions: ActiveSessionRecord[] }>("/api/sessions", params);
  }
  getContradictions(params?: CursorPaginationParams) { return this.get<ContradictionsResponse>("/api/contradictions", params); }
  resolveContradiction(id: string, status: "resolved" | "dismissed") { return this.post<{ success: boolean }>(`/api/contradictions/${id}/resolve`, { status }); }

  // Phase 3 — Observability & Recall Explainability

  /** Get the operations/audit log (timeline events). */
  getOperations(params?: CursorPaginationParams & { userId?: string; operation?: string; sessionKey?: string; createdAfter?: string; createdBefore?: string }) {
    return this.get<OperationsResponse>(
      "/api/operations",
      params
    );
  }

  /** Get all evidence for a specific memory record. */
  getEvidenceByRecord(recordId: string) {
    return this.get<MemoryEvidenceByRecordResponse>(`/api/evidence/${recordId}`);
  }

  /** Get evidence, optionally filtered by recordId and kind. */
  getEvidence(params?: CursorPaginationParams & { userId?: string; recordId?: string; kind?: string }) {
    return this.get<EvidenceResponse>("/api/evidence", params);
  }

  /** Get a memory with evidence by record ID. */
  getMemory(recordId: string) {
    return this.get<MemoryWithEvidenceResponse>(`/api/memories/${recordId}`);
  }

  /** Explain a recall query — returns full pipeline breakdown + recallExplanation. */
  explainRecall(body: ExplainRecallRequest) {
    return this.post<ExplainRecallResponse>("/api/recall/explain", body);
  }

  getWorkingContext(params: WorkingContextRequest) {
    return this.get<WorkingContextResponse>("/api/working/context", params);
  }

  offloadWorkingPayload(body: WorkingOffloadRequest) {
    return this.post<WorkingOffloadResponse>("/api/working/offload", body);
  }

  resetWorkingMemory(body: WorkingResetRequest) {
    return this.post<WorkingResetResponse>("/api/working/reset", body);
  }

  getActiveSessions(params?: { userId?: string }) {
    return this.get<ActiveSessionsResponse>("/api/working/sessions", params);
  }

  registerHook(body: HookRegisterRequest) {
    return this.post<HookRegisterResponse>("/api/hooks/register", body);
  }

  getHookStatus(params?: HookStatusParams) {
    return this.get<HookStatusResponse>("/api/hooks/status", params);
  }
}
