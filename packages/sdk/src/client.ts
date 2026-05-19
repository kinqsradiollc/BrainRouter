import {
  SigninRequest,
  SigninResponse,
  SignupRequest,
  SignupResponse,
  MeResponse,
  PublicUserRecord,
  CursorPaginationParams,
} from "@brainrouter/types";

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
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<T>;
  }

  private async deleteReq<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<T>;
  }

  // Auth Operations
  signIn(body: SigninRequest) { return this.post<SigninResponse>("/api/auth/signin", body); }
  signUp(body: SignupRequest) { return this.post<SignupResponse>("/api/auth/signup", body); }
  me() { return this.get<MeResponse>("/api/auth/me"); }
  rotateApiKey() { return this.post<{ apiKey: string }>("/api/auth/rotate-key", {}); }

  // Admin User Operations
  getUsers(params?: CursorPaginationParams) { return this.get<{ users: PublicUserRecord[]; nextCursor: string | null; limit: number; hasMore: boolean }>("/api/users", params); }
  createUser(payload: { userId: string; displayName?: string; isAdmin?: boolean }) { return this.post<{ user: PublicUserRecord }>("/api/users", payload); }
  updateUserStatus(userId: string, status: "active" | "disabled") { return this.put<{ success: boolean }>(`/api/users/${userId}/status`, { status }); }
  resetUserApiKey(userId: string) { return this.post<{ apiKey: string }>(`/api/users/${userId}/reset-key`, {}); }
  deleteUser(id: string) { return this.deleteReq<{ success: boolean }>(`/api/users/${id}`); }

  // Telemetry & L1/L2 Memory Operations
  getStats() { return this.get<any>("/api/stats"); }
  getMemories(params?: CursorPaginationParams & { type?: string; scene?: string; skill?: string; archived?: boolean }) {
    return this.get<{ memories: any[]; nextCursor: string | null; limit: number; hasMore: boolean }>("/api/memories", params);
  }
  archiveMemory(id: string) { return this.deleteReq<{ success: boolean }>(`/api/memories/${id}`); }
  getScenes(params?: CursorPaginationParams) { return this.get<{ scenes: any[]; nextCursor: string | null; limit: number; hasMore: boolean }>("/api/scenes", params); }
  getPersona() { return this.get<{ persona: any }>("/api/persona"); }
  getContradictions(params?: CursorPaginationParams) { return this.get<{ contradictions: any[]; nextCursor: string | null; limit: number; hasMore: boolean }>("/api/contradictions", params); }
  resolveContradiction(id: string, status: "resolved" | "dismissed") { return this.post<{ success: boolean }>(`/api/contradictions/${id}/resolve`, { status }); }
}
