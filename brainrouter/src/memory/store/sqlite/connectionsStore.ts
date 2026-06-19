/**
 * ADR-004 Phase 3 — cognitive connections (spreading-activation edges).
 *
 * Extracted VERBATIM from `SqliteMemoryStore` (1/10 coupling: touches only
 * `cognitive_connections` via `this.db`, no cross-capability calls).
 * `SqliteMemoryStore` composes one of these and delegates.
 */

import { DatabaseSync } from "node:sqlite";

export class SqliteConnectionsStore {
  constructor(private readonly db: DatabaseSync) {}

  public upsertConnection(userId: string, sourceId: string, targetId: string, weight: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO cognitive_connections (user_id, source_id, target_id, weight, last_activated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, source_id, target_id) DO UPDATE SET
        weight = excluded.weight,
        last_activated_at = datetime('now')
    `);
    stmt.run(userId, sourceId, targetId, weight);
  }

  public getConnectionsForSource(userId: string, sourceId: string): Array<{ targetId: string; weight: number }> {
    const rows = this.db.prepare(`
      SELECT target_id, weight FROM cognitive_connections
      WHERE user_id = ? AND source_id = ? AND weight >= 0.1
    `).all(userId, sourceId) as any[];
    return rows.map(r => ({ targetId: r.target_id, weight: r.weight }));
  }

  public strengthenConnectionsBatch(userId: string, pairs: Array<{ source: string; target: string }>, delta: number): void {
    if (pairs.length === 0) return;
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(`
        INSERT INTO cognitive_connections (user_id, source_id, target_id, weight, last_activated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, source_id, target_id) DO UPDATE SET
          weight = MIN(1.0, weight + ?),
          last_activated_at = datetime('now')
      `);
      for (const pair of pairs) {
        stmt.run(userId, pair.source, pair.target, delta, delta);
        stmt.run(userId, pair.target, pair.source, delta, delta);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public decayConnections(userId: string, decayFactor: number): void {
    const stmt = this.db.prepare(`
      UPDATE cognitive_connections
      SET weight = MAX(0.0, weight * ?)
      WHERE user_id = ?
    `);
    stmt.run(decayFactor, userId);
  }

  public pruneConnections(userId: string, threshold: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM cognitive_connections
      WHERE user_id = ? AND weight < ?
    `);
    stmt.run(userId, threshold);
  }

  public getAllConnections(userId: string): Array<{ sourceId: string; targetId: string; weight: number; lastActivatedAt: string }> {
    const rows = this.db.prepare(`
      SELECT source_id, target_id, weight, last_activated_at
      FROM cognitive_connections
      WHERE user_id = ?
    `).all(userId) as any[];
    return rows.map(r => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      weight: r.weight,
      lastActivatedAt: r.last_activated_at ?? "",
    }));
  }
}
