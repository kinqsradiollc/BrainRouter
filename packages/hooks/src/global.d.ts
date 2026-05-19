declare module "@brainrouter/sdk" {
  export class BrainRouterClient {
    constructor(baseUrl?: string, apiKey?: string);
    getStats(): Promise<any>;
    getMemories(params?: { cursor?: string; limit?: number; type?: string; scene?: string; skill?: string; archived?: boolean }): Promise<{ memories: any[]; nextCursor: string | null; limit: number; hasMore: boolean }>;
    archiveMemory(id: string): Promise<{ success: boolean }>;
    getScenes(params?: { cursor?: string; limit?: number }): Promise<{ scenes: any[]; nextCursor: string | null; limit: number; hasMore: boolean }>;
    getPersona(): Promise<{ persona: any }>;
    getContradictions(params?: { cursor?: string; limit?: number }): Promise<{ contradictions: any[]; nextCursor: string | null; limit: number; hasMore: boolean }>;
    resolveContradiction(id: string, status: "resolved" | "dismissed"): Promise<{ success: boolean }>;
    getUsers(params?: { cursor?: string; limit?: number }): Promise<{ users: any[]; nextCursor: string | null; limit: number; hasMore: boolean }>;
    createUser(payload: { userId: string; displayName?: string; isAdmin?: boolean }): Promise<{ user: any }>;
    deleteUser(id: string): Promise<{ success: boolean }>;
  }
}
