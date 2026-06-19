/**
 * ADR-004 Phase 3 — Users capability.
 *
 * Extracted VERBATIM from `SqliteMemoryStore` (1/10 coupling: own `users` table
 * via `this.db`; `deleteUser` issues cross-table DELETEs but makes no
 * cross-capability method calls). `SqliteMemoryStore` composes one of these and
 * delegates.
 */

import { DatabaseSync } from "node:sqlite";
import type { CursorPaginationOptions, UserRecord } from "@kinqs/brainrouter-types";

export class SqliteUsersStore {
  constructor(private readonly db: DatabaseSync) {}

  public createUser(userId: string, apiKey: string, displayName = "", isAdmin = false): UserRecord {
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO users (user_id, api_key, password_hash, display_name, email, is_admin, status, created_at)
      VALUES (?, ?, NULL, ?, '', ?, 'active', ?)
    `).run(userId, apiKey, displayName, isAdmin ? 1 : 0, createdAt);
    return {
      userId,
      apiKey,
      passwordHash: null,
      displayName,
      email: "",
      isAdmin,
      status: "active",
      createdAt,
    };
  }

  public getUserByApiKey(apiKey: string): UserRecord | null {
    const row = this.db.prepare(
      "SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE api_key = ?"
    ).get(apiKey) as any;
    if (!row) return null;
    return {
      userId: row.user_id,
      apiKey: row.api_key,
      passwordHash: row.password_hash ?? null,
      displayName: row.display_name ?? "",
      email: row.email ?? "",
      isAdmin: Boolean(row.is_admin),
      status: row.status === "disabled" ? "disabled" : "active",
      createdAt: row.created_at,
    };
  }

  public getUserByEmail(email: string): UserRecord | null {
    const row = this.db.prepare(
      "SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE lower(email) = lower(?)"
    ).get(email) as any;
    if (!row) return null;
    return {
      userId: row.user_id,
      apiKey: row.api_key,
      passwordHash: row.password_hash ?? null,
      displayName: row.display_name ?? "",
      email: row.email ?? "",
      isAdmin: Boolean(row.is_admin),
      status: row.status === "disabled" ? "disabled" : "active",
      createdAt: row.created_at,
    };
  }

  public getUserById(userId: string): UserRecord | null {
    const row = this.db.prepare(
      "SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE user_id = ?"
    ).get(userId) as any;
    if (!row) return null;
    return {
      userId: row.user_id,
      apiKey: row.api_key,
      passwordHash: row.password_hash ?? null,
      displayName: row.display_name ?? "",
      email: row.email ?? "",
      isAdmin: Boolean(row.is_admin),
      status: row.status === "disabled" ? "disabled" : "active",
      createdAt: row.created_at,
    };
  }

  public updateUserPassword(userId: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE user_id = ?").run(passwordHash, userId);
  }

  public updateUserEmail(userId: string, email: string): void {
    this.db.prepare("UPDATE users SET email = ? WHERE user_id = ?").run(email, userId);
  }

  public updateUserDisplayName(userId: string, displayName: string): void {
    this.db.prepare("UPDATE users SET display_name = ? WHERE user_id = ?").run(displayName, userId);
  }

  public updateUserStatus(userId: string, status: "active" | "disabled"): void {
    this.db.prepare("UPDATE users SET status = ? WHERE user_id = ?").run(status, userId);
  }

  public updateUserApiKey(userId: string, apiKey: string): void {
    this.db.prepare("UPDATE users SET api_key = ? WHERE user_id = ?").run(apiKey, userId);
  }

  public listUsers(pagination?: CursorPaginationOptions<{ createdAt: string; userId: string }>): UserRecord[] {
    const where: string[] = [];
    const args: any[] = [];
    if (pagination?.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND user_id > ?))");
      args.push(pagination.cursor.createdAt, pagination.cursor.createdAt, pagination.cursor.userId);
    }
    args.push(pagination?.limit ?? 500);
    const rows = this.db.prepare(
      `SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at
       FROM users
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, user_id ASC
       LIMIT ?`
    ).all(...args) as any[];
    return rows.map((row) => ({
      userId: row.user_id,
      apiKey: row.api_key,
      passwordHash: row.password_hash ?? null,
      displayName: row.display_name ?? "",
      email: row.email ?? "",
      isAdmin: Boolean(row.is_admin),
      status: row.status === "disabled" ? "disabled" : "active",
      createdAt: row.created_at,
    }));
  }

  public deleteUser(userId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM users WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM sensory_stream WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM cognitive_fts WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM cognitive_records WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM contradictions WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM contextual_focus WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM core_identity WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM scheduler_state WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM graph_nodes WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM graph_edges WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM cognitive_connections WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM memory_evidence WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM memory_operations WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM memory_file_index WHERE user_id = ?").run(userId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
