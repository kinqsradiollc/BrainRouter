import { PublicUserRecord } from "./memory.js";

export interface SigninRequest {
  email: string;
  password?: string;
}

export interface SigninResponse {
  jwt: string;
  userId: string;
  isAdmin: boolean;
  displayName: string;
  apiKey: string;
}

export interface SignupRequest {
  email: string;
  password?: string;
  displayName?: string;
}

export interface SignupResponse {
  jwt: string;
  userId: string;
  isAdmin: boolean;
  displayName: string;
}

export interface MeResponse extends PublicUserRecord {
  apiKey: string;
  mcpPath?: string;
}

export interface UserStatusRequest {
  status: "active" | "disabled";
}

export interface UserResetKeyResponse {
  apiKey: string;
}

export interface CursorPaginationParams {
  cursor?: string;
  limit?: number;
}

export interface CursorPaginatedResponse<T> {
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
  data: T[];
}
