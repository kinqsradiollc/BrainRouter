/**
 * Skill hints / activations, contextual-focus, and workspace/project tag SQL —
 * verbatim extraction from `PostgresMemoryStore`.
 */

import type {
  ContextualFocusRecord,
  SkillActivationRecord,
  SkillHintsRecord,
} from "@kinqs/brainrouter-types";
import { asNumber, pg } from "../converters.js";
import type { Executor } from "./executor.js";

// ── skill hints / activations ───────────────────────────────────────────

export async function upsertSkillHints(exec: Executor, skillName: string, hints: string, sourceFile = ""): Promise<void> {
  await exec.run(
    `INSERT INTO skill_extraction_hints (skill_name, hints, source_file, registered_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (skill_name) DO UPDATE SET hints=EXCLUDED.hints, source_file=EXCLUDED.source_file, registered_at=EXCLUDED.registered_at`,
    [skillName, hints, sourceFile, new Date().toISOString()],
  );
}

export async function listSkillHints(exec: Executor): Promise<SkillHintsRecord[]> {
  const rows = await exec.rows<any>("SELECT skill_name, hints, source_file, registered_at FROM skill_extraction_hints ORDER BY registered_at DESC");
  return rows.map((r) => ({ skillName: r.skill_name, hints: r.hints, sourceFile: r.source_file, registeredAt: r.registered_at }));
}

export async function getSkillHints(exec: Executor, skillName: string): Promise<string | null> {
  const row = await exec.one<{ hints: string }>("SELECT hints FROM skill_extraction_hints WHERE skill_name = $1", [skillName]);
  return row?.hints ?? null;
}

export async function getSkillActivations(exec: Executor, userId: string): Promise<SkillActivationRecord[]> {
  const rows = await exec.rows<any>(
    "SELECT skill_name, potential, last_decay_time FROM skill_activations WHERE user_id = $1 ORDER BY potential DESC, skill_name ASC",
    [userId],
  );
  return rows.map((r) => ({ skillName: r.skill_name, potential: asNumber(r.potential), lastDecayTime: r.last_decay_time }));
}

export async function upsertSkillActivations(exec: Executor, userId: string, activations: SkillActivationRecord[]): Promise<void> {
  if (activations.length === 0) return;
  await exec.tx(async (client) => {
    for (const record of activations) {
      await client.query(
        `INSERT INTO skill_activations (user_id, skill_name, potential, last_decay_time)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, skill_name) DO UPDATE SET potential=EXCLUDED.potential, last_decay_time=EXCLUDED.last_decay_time`,
        [userId, record.skillName, record.potential, record.lastDecayTime],
      );
    }
  });
}

// ── contextual focus ───────────────────────────────────────────────────

export function focusRow(r: any): ContextualFocusRecord {
  return {
    id: r.id, userId: r.user_id, sceneName: r.scene_name, summaryMd: r.summary_md,
    heatScore: asNumber(r.heat_score), lastActiveTime: r.last_active_time,
    createdTime: r.created_time, updatedTime: r.updated_time,
  };
}

export async function upsertContextualFocus(exec: Executor, record: ContextualFocusRecord): Promise<void> {
  await exec.run(
    `INSERT INTO contextual_focus (id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, scene_name) DO UPDATE SET
       summary_md=EXCLUDED.summary_md, heat_score=EXCLUDED.heat_score,
       last_active_time=EXCLUDED.last_active_time, updated_time=EXCLUDED.updated_time`,
    [record.id, record.userId, record.sceneName, record.summaryMd, record.heatScore, record.lastActiveTime, record.createdTime, record.updatedTime],
  );
}

export async function getTopContextualFocus(exec: Executor, userId: string, limit = 3, cursor?: { heatScore: number; id: string }): Promise<ContextualFocusRecord[]> {
  const where = ["user_id = ?"];
  const args: any[] = [userId];
  if (cursor) {
    where.push("(heat_score < ? OR (heat_score = ? AND id > ?))");
    args.push(cursor.heatScore, cursor.heatScore, cursor.id);
  }
  args.push(limit);
  const rows = await exec.rows<any>(
    pg(`SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time
          FROM contextual_focus WHERE ${where.join(" AND ")}
         ORDER BY heat_score DESC, id ASC LIMIT ?`),
    args,
  );
  return rows.map((r) => focusRow(r));
}

export async function decayContextualFocusHeatScores(exec: Executor, userId: string, decayFactor = 0.95): Promise<void> {
  await exec.run("UPDATE contextual_focus SET heat_score = heat_score * $1 WHERE user_id = $2", [decayFactor, userId]);
}

export async function boostContextualFocusHeatScore(exec: Executor, userId: string, sceneName: string, boost = 20): Promise<void> {
  await exec.run(
    "UPDATE contextual_focus SET heat_score = LEAST(100.0, heat_score + $1), last_active_time = $2 WHERE user_id = $3 AND scene_name = $4",
    [boost, new Date().toISOString(), userId, sceneName],
  );
}

export async function getCognitivesByFocus(exec: Executor, userId: string, sceneName: string, limit = 30): Promise<any[]> {
  return exec.rows(
    "SELECT record_id, content, type, priority, skill_tag, created_time FROM cognitive_records WHERE user_id = $1 AND scene_name = $2 AND invalid_at IS NULL ORDER BY priority DESC LIMIT $3",
    [userId, sceneName, limit],
  );
}

export async function getContextualFocusCount(exec: Executor, userId: string): Promise<number> {
  const row = await exec.one<{ count: string }>("SELECT COUNT(*) AS count FROM contextual_focus WHERE user_id = $1", [userId]);
  return asNumber(row?.count);
}

export async function getColdContextualFocus(exec: Executor, userId: string, limit: number): Promise<ContextualFocusRecord[]> {
  const rows = await exec.rows<any>(
    "SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time FROM contextual_focus WHERE user_id = $1 ORDER BY heat_score ASC LIMIT $2",
    [userId, limit],
  );
  return rows.map((r) => focusRow(r));
}

export async function deleteContextualFocus(exec: Executor, userId: string, sceneIds: string[]): Promise<void> {
  if (sceneIds.length === 0) return;
  await exec.run("DELETE FROM contextual_focus WHERE user_id = $1 AND id = ANY($2::text[])", [userId, sceneIds]);
}

export async function getContextualFocusByName(exec: Executor, userId: string, sceneName: string): Promise<ContextualFocusRecord | null> {
  const row = await exec.one<any>(
    "SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time FROM contextual_focus WHERE user_id = $1 AND scene_name = $2",
    [userId, sceneName],
  );
  return row ? focusRow(row) : null;
}

export async function getDistinctSceneNames(exec: Executor, userId: string): Promise<string[]> {
  const rows = await exec.rows<{ scene_name: string }>("SELECT DISTINCT scene_name FROM cognitive_records WHERE user_id = $1 AND scene_name != ''", [userId]);
  return rows.map((r) => r.scene_name);
}

export async function renameFocusInCognitiveRecords(exec: Executor, userId: string, oldName: string, canonicalName: string): Promise<void> {
  await exec.tx(async (client) => {
    await client.query("UPDATE cognitive_records SET scene_name = $1, updated_time = $2 WHERE user_id = $3 AND scene_name = $4", [canonicalName, new Date().toISOString(), userId, oldName]);
    await client.query("DELETE FROM contextual_focus WHERE user_id = $1 AND scene_name = $2", [userId, oldName]);
  });
}

// ── workspace / project tags ─────────────────────────────────────────────

export async function getWorkspaceTagsByRecordIds(exec: Executor, userId: string, recordIds: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (recordIds.length === 0) return result;
  for (const id of recordIds) result.set(id, null);
  const rows = await exec.rows<{ record_id: string; workspace_tag: string | null }>(
    "SELECT record_id, workspace_tag FROM cognitive_records WHERE user_id = $1 AND record_id = ANY($2::text[])",
    [userId, recordIds],
  );
  for (const row of rows) result.set(row.record_id, row.workspace_tag ?? null);
  return result;
}

export async function getProjectTagsByRecordIds(exec: Executor, userId: string, recordIds: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (recordIds.length === 0) return result;
  for (const id of recordIds) result.set(id, null);
  const rows = await exec.rows<{ record_id: string; project_tag: string | null }>(
    "SELECT record_id, project_tag FROM cognitive_records WHERE user_id = $1 AND record_id = ANY($2::text[])",
    [userId, recordIds],
  );
  for (const row of rows) result.set(row.record_id, row.project_tag ?? null);
  return result;
}
