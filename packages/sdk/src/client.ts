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
  CoreIdentityRecord,
  SkillActivationsResponse,
} from "@brainrouter/types";

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
    private token = ""
  ) {}

  withApiKey(apiKey: string) {
    return new BrainRouterClient(this.baseUrl, apiKey, this.token);
  }

  withToken(token: string) {
    return new BrainRouterClient(this.baseUrl, this.apiKey, token);
  }

  private headers(): Record<string, string> {
    if (this.token) return { Authorization: `Bearer ${this.token}` };
    if (this.apiKey) return { Authorization: `Bearer ${this.apiKey}` };
    return {};
  }

  private async get<T>(path: string, params?: object): Promise<T> {
    const query = params
      ? new URLSearchParams(
          Object.entries(params)
            .filter((entry): entry is [string, string | number | boolean] => {
              const value = entry[1];
              return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
            })
            .map(([key, value]) => [key, String(value)] as [string, string])
        ).toString()
      : "";
    const res = await fetch(`${this.baseUrl}${path}${query ? `?${query}` : ""}`, { headers: this.headers() });
    if (!res.ok) throw await this.toError(res);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.toError(res);
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.toError(res);
    return res.json() as Promise<T>;
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.toError(res);
    return res.json() as Promise<T>;
  }

  private async deleteReq<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw await this.toError(res);
    return res.json() as Promise<T>;
  }

  private async deleteWithBody<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.toError(res);
    return res.json() as Promise<T>;
  }

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
  getPersona() { return this.get<{ persona: CoreIdentityRecord | null }>("/api/persona"); }
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
