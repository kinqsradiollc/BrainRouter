/**
 * ADR-032 D4/D8 hosted inspection and revert.
 *
 * The hosted dashboard cannot read a CLI/Desktop filesystem ledger. Its
 * authority is the central lesson record written by the learning checkpoint.
 * Every query below therefore carries both halves of the tenant address and
 * only accepts records with the structured `metadata.learned` envelope.
 */
import { randomUUID } from "node:crypto";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import { cognitiveRowToRecord, parseJsonObject } from "../converters.js";
import type { Executor } from "./executor.js";
import { redactSensitiveMemoryText } from "../../../util/redaction.js";

const MAX_HOSTED_LEARNED_ROWS = 201;
const MAX_HOSTED_RETIREMENT_BATCH = 201;

const HOSTED_RETIREMENT_ELIGIBILITY = `
        user_id = $1
        AND org_id = $2
        AND type = 'lesson'
        AND jsonb_typeof(metadata_json::jsonb -> 'learned') = 'object'
        AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
        AND metadata_json::jsonb -> 'learned' ->> 'itemId' ~ '^lrn_[a-f0-9]{18}$'
        AND metadata_json::jsonb -> 'learned' ->> 'tier' IN ('instruction', 'evidence')
        AND metadata_json::jsonb -> 'learned' ->> 'origin' IN ('human-correction', 'model-inferred')
        AND NOT (
          metadata_json::jsonb -> 'learned' ->> 'tier' = 'instruction'
          AND metadata_json::jsonb -> 'learned' ->> 'origin' <> 'human-correction'
        )
        AND metadata_json::jsonb -> 'learned' ->> 'form' IN ('lesson', 'procedure')
        AND metadata_json::jsonb -> 'learned' ->> 'status' IN ('active', 'demoted')
        AND btrim(content) <> ''
        AND btrim(metadata_json::jsonb -> 'learned' ->> 'falsifier') <> ''
        AND btrim(metadata_json::jsonb -> 'learned' ->> 'expectation') <> ''
        AND jsonb_typeof(metadata_json::jsonb -> 'learned' -> 'provenance') = 'object'
        AND btrim(metadata_json::jsonb -> 'learned' -> 'provenance' ->> 'capturedAt') <> ''`;

export async function listHostedLearnedRecords(
  exec: Executor,
  userId: string,
  orgId: string,
  limit = MAX_HOSTED_LEARNED_ROWS,
): Promise<CognitiveRecord[]> {
  const boundedLimit = Math.max(1, Math.min(MAX_HOSTED_LEARNED_ROWS, Math.floor(limit)));
  const rows = await exec.rows(
    `SELECT * FROM cognitive_records
      WHERE user_id = $1
        AND org_id = $2
        AND type = 'lesson'
        AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
      ORDER BY created_time DESC, record_id ASC
      LIMIT $3`,
    [userId, orgId, boundedLimit],
  );
  return rows.map(cognitiveRowToRecord);
}

/**
 * Take the next bounded D6 partition and durably advance its tenant cursor.
 *
 * `created_time` is immutable while `updated_time` changes on every outcome,
 * so the former plus `record_id` is the stable keyset. At the end of the set,
 * the same transaction fills the remainder from the beginning. The cursor row
 * lock serializes concurrent checkpoints for one tenant without coupling
 * unrelated tenants.
 */
export async function takeHostedLearnedRetirementBatch(
  exec: Executor,
  userId: string,
  orgId: string,
  limit = MAX_HOSTED_RETIREMENT_BATCH,
  now = new Date(),
): Promise<CognitiveRecord[]> {
  const boundedLimit = Math.max(1, Math.min(MAX_HOSTED_RETIREMENT_BATCH, Math.floor(limit)));
  return exec.tx(async (client) => {
    const at = now.toISOString();
    await client.query(
      `INSERT INTO hosted_learning_retirement_cursors
        (org_id, user_id, last_created_time, last_record_id, updated_at)
       VALUES ($1,$2,NULL,NULL,$3)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [orgId, userId, at],
    );
    const cursorResult = await client.query(
      `SELECT last_created_time, last_record_id
         FROM hosted_learning_retirement_cursors
        WHERE org_id = $1 AND user_id = $2
        FOR UPDATE`,
      [orgId, userId],
    );
    const cursor = cursorResult.rows[0] as {
      last_created_time?: string | null;
      last_record_id?: string | null;
    } | undefined;
    const cursorTime = typeof cursor?.last_created_time === "string" ? cursor.last_created_time : null;
    const cursorId = typeof cursor?.last_record_id === "string" ? cursor.last_record_id : null;

    const after = await client.query(
      `SELECT * FROM cognitive_records
        WHERE ${HOSTED_RETIREMENT_ELIGIBILITY}
          AND ($3::text IS NULL OR (created_time, record_id) > ($3, $4))
        ORDER BY created_time ASC, record_id ASC
        LIMIT $5`,
      [userId, orgId, cursorTime, cursorId, boundedLimit],
    );
    const selected = [...after.rows];
    if (selected.length < boundedLimit && cursorTime !== null && cursorId !== null) {
      const wrapped = await client.query(
        `SELECT * FROM cognitive_records
          WHERE ${HOSTED_RETIREMENT_ELIGIBILITY}
            AND (created_time, record_id) <= ($3, $4)
          ORDER BY created_time ASC, record_id ASC
          LIMIT $5`,
        [userId, orgId, cursorTime, cursorId, boundedLimit - selected.length],
      );
      selected.push(...wrapped.rows);
    }

    const last = selected.at(-1) as Record<string, unknown> | undefined;
    await client.query(
      `UPDATE hosted_learning_retirement_cursors
          SET last_created_time = $1, last_record_id = $2, updated_at = $3
        WHERE org_id = $4 AND user_id = $5`,
      [
        typeof last?.created_time === "string" ? last.created_time : cursorTime,
        typeof last?.record_id === "string" ? last.record_id : cursorId,
        at,
        orgId,
        userId,
      ],
    );
    return selected.map(cognitiveRowToRecord);
  });
}

export async function getHostedLearnedRecordByItemId(
  exec: Executor,
  userId: string,
  orgId: string,
  itemId: string,
): Promise<CognitiveRecord | null> {
  const row = await exec.one(
    `SELECT * FROM cognitive_records
      WHERE user_id = $1
        AND org_id = $2
        AND type = 'lesson'
        AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
        AND metadata_json::jsonb -> 'learned' ->> 'itemId' = $3
      ORDER BY created_time DESC, record_id ASC
      LIMIT 1`,
    [userId, orgId, itemId],
  );
  return row ? cognitiveRowToRecord(row) : null;
}

/** Select the bounded active set that will actually reach one hosted model
 * turn, and increment retrieval counters under the same row locks. */
export async function retrieveHostedLearnedRecords(
  exec: Executor,
  userId: string,
  orgId: string,
  limit = 16,
  now = new Date(),
): Promise<CognitiveRecord[]> {
  const boundedLimit = Math.max(1, Math.min(16, Math.floor(limit)));
  return exec.tx(async (client) => {
    const selected = await client.query(
      `WITH prompt_eligible AS (
        (SELECT record_id, 0 AS tier_order,
            CASE
              WHEN metadata_json::jsonb -> 'learned' -> 'outcome' ->> 'confirmations' ~ '^[0-9]+$'
              THEN (metadata_json::jsonb -> 'learned' -> 'outcome' ->> 'confirmations')::int
              ELSE 0
            END AS confirmation_count,
            updated_time
          FROM cognitive_records
          WHERE user_id = $1
            AND org_id = $2
            AND type = 'lesson'
            AND archived = 0
            AND status = 'active'
            AND jsonb_typeof(metadata_json::jsonb -> 'learned') = 'object'
            AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
            AND metadata_json::jsonb -> 'learned' ->> 'status' = 'active'
            AND metadata_json::jsonb -> 'learned' ->> 'itemId' ~ '^lrn_[a-f0-9]{18}$'
            AND metadata_json::jsonb -> 'learned' ->> 'tier' = 'instruction'
            AND metadata_json::jsonb -> 'learned' ->> 'origin' = 'human-correction'
            AND metadata_json::jsonb -> 'learned' ->> 'form' = 'lesson'
            AND btrim(content) <> ''
            AND btrim(metadata_json::jsonb -> 'learned' ->> 'falsifier') <> ''
            AND btrim(metadata_json::jsonb -> 'learned' ->> 'expectation') <> ''
            AND jsonb_typeof(metadata_json::jsonb -> 'learned' -> 'provenance') = 'object'
            AND btrim(metadata_json::jsonb -> 'learned' -> 'provenance' ->> 'capturedAt') <> ''
          ORDER BY confirmation_count DESC, updated_time DESC, record_id ASC
          LIMIT LEAST($3, 8))
        UNION ALL
        (SELECT record_id, 1 AS tier_order,
            CASE
              WHEN metadata_json::jsonb -> 'learned' -> 'outcome' ->> 'confirmations' ~ '^[0-9]+$'
              THEN (metadata_json::jsonb -> 'learned' -> 'outcome' ->> 'confirmations')::int
              ELSE 0
            END AS confirmation_count,
            updated_time
          FROM cognitive_records
          WHERE user_id = $1
            AND org_id = $2
            AND type = 'lesson'
            AND archived = 0
            AND status = 'active'
            AND jsonb_typeof(metadata_json::jsonb -> 'learned') = 'object'
            AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
            AND metadata_json::jsonb -> 'learned' ->> 'status' = 'active'
            AND metadata_json::jsonb -> 'learned' ->> 'itemId' ~ '^lrn_[a-f0-9]{18}$'
            AND metadata_json::jsonb -> 'learned' ->> 'tier' = 'evidence'
            AND metadata_json::jsonb -> 'learned' ->> 'origin' IN ('model-inferred', 'human-correction')
            AND metadata_json::jsonb -> 'learned' ->> 'form' = 'lesson'
            AND btrim(content) <> ''
            AND btrim(metadata_json::jsonb -> 'learned' ->> 'falsifier') <> ''
            AND btrim(metadata_json::jsonb -> 'learned' ->> 'expectation') <> ''
            AND jsonb_typeof(metadata_json::jsonb -> 'learned' -> 'provenance') = 'object'
            AND btrim(metadata_json::jsonb -> 'learned' -> 'provenance' ->> 'capturedAt') <> ''
          ORDER BY confirmation_count DESC, updated_time DESC, record_id ASC
          LIMIT LEAST($3, 8))
      ), picked AS (
        SELECT record_id, tier_order, confirmation_count, updated_time
          FROM prompt_eligible
         ORDER BY tier_order, confirmation_count DESC, updated_time DESC, record_id ASC
         LIMIT $3
      )
      SELECT records.*
        FROM picked
        JOIN cognitive_records records
          ON records.record_id = picked.record_id
         AND records.user_id = $1
         AND records.org_id = $2
       ORDER BY picked.tier_order, picked.confirmation_count DESC,
                picked.updated_time DESC, picked.record_id ASC
       FOR UPDATE OF records`,
      [userId, orgId, boundedLimit],
    );
    const at = now.toISOString();
    const records: CognitiveRecord[] = [];
    for (const row of selected.rows) {
      const metadata = parseJsonObject(row.metadata_json);
      const learned = metadata.learned && typeof metadata.learned === "object" && !Array.isArray(metadata.learned)
        ? metadata.learned as Record<string, unknown>
        : {};
      const outcome = learned.outcome && typeof learned.outcome === "object" && !Array.isArray(learned.outcome)
        ? learned.outcome as Record<string, unknown>
        : {};
      const updatedMetadata = {
        ...metadata,
        learned: {
          ...learned,
          updatedAt: at,
          outcome: {
            ...outcome,
            retrievals: Math.max(0, Math.floor(Number(outcome.retrievals) || 0)) + 1,
            lastRetrievedAt: at,
          },
        },
      };
      const updated = await client.query(
        `UPDATE cognitive_records
            SET metadata_json = $1, updated_time = $2
          WHERE record_id = $3 AND user_id = $4 AND org_id = $5
            AND status = 'active' AND archived = 0
          RETURNING *`,
        [JSON.stringify(updatedMetadata), at, row.record_id, userId, orgId],
      );
      if (updated.rows[0]) records.push(cognitiveRowToRecord(updated.rows[0]));
    }
    return records;
  });
}

/**
 * The explicit `metadata.learned.status = reverted` marker matters. A central
 * record can also be archived by automatic demotion, which must not be
 * interpreted by a connected device as a human undo.
 */
export async function revertHostedLearnedRecord(
  exec: Executor,
  userId: string,
  orgId: string,
  itemId: string,
  reason: string,
  now = new Date(),
): Promise<CognitiveRecord | null> {
  return exec.tx(async (client) => {
    const selected = await client.query(
      `SELECT * FROM cognitive_records
        WHERE user_id = $1
          AND org_id = $2
          AND type = 'lesson'
          AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
          AND metadata_json::jsonb -> 'learned' ->> 'itemId' = $3
        ORDER BY created_time DESC, record_id ASC
        LIMIT 1
        FOR UPDATE`,
      [userId, orgId, itemId],
    );
    const row = selected.rows[0];
    if (!row) return null;

    const at = now.toISOString();
    const metadata = parseJsonObject(row.metadata_json);
    const learned = metadata.learned && typeof metadata.learned === "object" && !Array.isArray(metadata.learned)
      ? metadata.learned as Record<string, unknown>
      : {};
    const updatedMetadata = {
      ...metadata,
      learned: {
        ...learned,
        status: "reverted",
        statusReason: reason,
        statusChangedAt: at,
        updatedAt: at,
        memoryLifecycle: {
          status: "archived",
          updatedAt: at,
          attempts: Math.max(1, (Number(
            learned.memoryLifecycle && typeof learned.memoryLifecycle === "object"
              ? (learned.memoryLifecycle as Record<string, unknown>).attempts
              : 0,
          ) || 0) + 1),
        },
      },
    };

    const updated = await client.query(
      `UPDATE cognitive_records
          SET metadata_json = $1,
              status = 'archived',
              archived = 1,
              updated_time = $2
        WHERE record_id = $3 AND user_id = $4 AND org_id = $5
        RETURNING *`,
      [JSON.stringify(updatedMetadata), at, row.record_id, userId, orgId],
    );
    await client.query(
      `INSERT INTO memory_operations
        (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
       VALUES ($1,$2,$3,'learned_item_revert','user',$4,$5,$6,$7)`,
      [
        randomUUID(),
        userId,
        row.record_id,
        row.session_key ?? "",
        reason,
        at,
        JSON.stringify({ itemId, orgId }),
      ],
    );
    return updated.rows[0] ? cognitiveRowToRecord(updated.rows[0]) : null;
  });
}

export interface HostedLearnedSyncResult {
  record: CognitiveRecord;
  applied: boolean;
  blockedByHumanRevert: boolean;
}

export interface HostedLearnedLifecycleResult {
  record: CognitiveRecord;
  learnedStatus: string;
  learnedStatusReason?: string;
  memoryStatus: "active" | "archived";
  applied: boolean;
  blockedByHumanRevert: boolean;
}

export interface HostedLearningOutcomeInput {
  id: string;
  outcome: "confirmed" | "contradicted";
  detail: string;
}

interface HostedLearningOutcomeObservationRow {
  outcome: "confirmed" | "contradicted";
}

/** Apply one semantic outcome per distinct logical session. `jobId` remains an
 * execution/audit identifier only: several checkpoints, a queue retry, an idle
 * admission reset, or a resumed process with the same runtime session key all
 * resolve to the same normalized observation row. */
export async function noteHostedLearningOutcomes(
  exec: Executor,
  userId: string,
  orgId: string,
  sessionIdentity: string,
  jobId: string,
  outcomes: readonly HostedLearningOutcomeInput[],
  now = new Date(),
  expectedRecordId?: string,
): Promise<CognitiveRecord[]> {
  if (!/^[a-f0-9]{64}$/.test(sessionIdentity)) {
    throw new Error("hosted learning outcome requires a tenant-bound session identity");
  }
  if (!jobId.trim()) throw new Error("hosted learning outcome requires a durable job id");
  const unique = new Map<string, HostedLearningOutcomeInput>();
  for (const outcome of outcomes.slice(0, 32)) {
    const current = unique.get(outcome.id);
    if (!current || outcome.outcome === "contradicted") unique.set(outcome.id, outcome);
  }
  return exec.tx(async (client) => {
    const changed: CognitiveRecord[] = [];
    const at = now.toISOString();
    // Every transaction acquires item locks in the same order, so two jobs
    // reporting several delivered items cannot deadlock on opposite model
    // output orders.
    for (const outcome of [...unique.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      const selected = await client.query(
        `SELECT * FROM cognitive_records
          WHERE user_id = $1
            AND org_id = $2
            AND type = 'lesson'
            AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
            AND metadata_json::jsonb -> 'learned' ->> 'itemId' = $3
            AND ($4::text IS NULL OR record_id = $4)
          LIMIT 1
          FOR UPDATE`,
        [userId, orgId, outcome.id, expectedRecordId ?? null],
      );
      const row = selected.rows[0];
      if (!row) continue;
      const metadata = parseJsonObject(row.metadata_json);
      const learned = metadata.learned && typeof metadata.learned === "object" && !Array.isArray(metadata.learned)
        ? metadata.learned as Record<string, unknown>
        : {};
      const learnedStatus = learned.status;
      if (learnedStatus !== "active" && learnedStatus !== "demoted") continue;
      if (learnedStatus === "active" && (row.status !== "active" || row.archived === 1)) continue;
      const observed = await client.query<HostedLearningOutcomeObservationRow>(
        `SELECT outcome FROM hosted_learning_outcome_observations
          WHERE org_id = $1 AND user_id = $2 AND item_id = $3 AND session_identity = $4
          FOR UPDATE`,
        [orgId, userId, outcome.id, sessionIdentity],
      );
      const previousObservation = observed.rows[0]?.outcome;
      // A contradiction is final for this session. A repeated confirmation is
      // also a semantic no-op, though the last executing job remains visible.
      if (previousObservation === "contradicted"
        || (previousObservation === "confirmed" && outcome.outcome === "confirmed")) {
        await client.query(
          `UPDATE hosted_learning_outcome_observations
              SET last_job_id = $1, last_observed_at = $2
            WHERE org_id = $3 AND user_id = $4 AND item_id = $5 AND session_identity = $6`,
          [jobId, at, orgId, userId, outcome.id, sessionIdentity],
        );
        continue;
      }
      const previousOutcome = learned.outcome && typeof learned.outcome === "object" && !Array.isArray(learned.outcome)
        ? learned.outcome as Record<string, unknown>
        : {};
      const contradicted = outcome.outcome === "contradicted";
      const restoring = learnedStatus === "demoted" && !contradicted;
      const detail = redactSensitiveMemoryText(outcome.detail).slice(0, 240);
      const previousConfirmations = Math.max(0, Math.floor(Number(previousOutcome.confirmations) || 0));
      const previousContradictions = Math.max(0, Math.floor(Number(previousOutcome.contradictions) || 0));
      const nextOutcome: Record<string, unknown> = {
        ...previousOutcome,
        confirmations: contradicted && previousObservation === "confirmed"
          ? Math.max(0, previousConfirmations - 1)
          : previousConfirmations + (contradicted ? 0 : 1),
        contradictions: previousContradictions + (contradicted ? 1 : 0),
        ...(contradicted ? { lastContradictedAt: at } : { lastConfirmedAt: at }),
      };
      if (contradicted && nextOutcome.confirmations === 0) delete nextOutcome.lastConfirmedAt;
      const previousLifecycle = learned.memoryLifecycle && typeof learned.memoryLifecycle === "object"
        ? learned.memoryLifecycle as Record<string, unknown>
        : {};
      const nextLearned = {
        ...learned,
        updatedAt: at,
        outcome: nextOutcome,
        ...(restoring ? {
          status: "active",
          statusReason: "an observed outcome confirmed it after demotion — restored",
          statusChangedAt: at,
          memoryLifecycle: {
            ...previousLifecycle,
            status: "active",
            updatedAt: at,
            attempts: Math.max(1, Math.floor(Number(previousLifecycle.attempts) || 0) + 1),
          },
        } : {}),
        ...(contradicted ? {
          status: "retired",
          statusReason: `the falsifier was observed: ${detail}`,
          statusChangedAt: at,
          memoryLifecycle: {
            ...previousLifecycle,
            status: "archived",
            updatedAt: at,
            attempts: Math.max(1, Math.floor(Number(previousLifecycle.attempts) || 0) + 1),
          },
        } : {}),
      };
      const updated = await client.query(
        `UPDATE cognitive_records
            SET metadata_json = $1, status = $2, archived = $3, updated_time = $4
          WHERE record_id = $5 AND user_id = $6 AND org_id = $7
          RETURNING *`,
        [JSON.stringify({ ...metadata, learned: nextLearned }),
          contradicted ? "archived" : "active", contradicted ? 1 : 0, at,
          row.record_id, userId, orgId],
      );
      if (!updated.rows[0]) throw new Error("hosted learned outcome record disappeared while locked");
      if (previousObservation === "confirmed") {
        await client.query(
          `UPDATE hosted_learning_outcome_observations
              SET outcome = 'contradicted', last_job_id = $1, last_observed_at = $2
            WHERE org_id = $3 AND user_id = $4 AND item_id = $5 AND session_identity = $6`,
          [jobId, at, orgId, userId, outcome.id, sessionIdentity],
        );
      } else {
        await client.query(
          `INSERT INTO hosted_learning_outcome_observations
            (org_id, user_id, item_id, session_identity, outcome,
             first_job_id, last_job_id, first_observed_at, last_observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$7)`,
          [orgId, userId, outcome.id, sessionIdentity, outcome.outcome, jobId, at],
        );
      }
      await client.query(
        `INSERT INTO memory_operations
          (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
         VALUES ($1,$2,$3,'learned_item_outcome','system',$4,$5,$6,$7)`,
        [randomUUID(), userId, row.record_id, row.session_key ?? "",
          detail, at,
          JSON.stringify({ orgId, itemId: outcome.id, outcome: outcome.outcome, sessionIdentity, jobId })],
      );
      changed.push(cognitiveRowToRecord(updated.rows[0]));
    }
    return changed;
  });
}

function learnedLifecycleResult(
  row: Record<string, any>,
  applied: boolean,
  blockedByHumanRevert: boolean,
): HostedLearnedLifecycleResult {
  const metadata = parseJsonObject(row.metadata_json);
  const learned = metadata.learned && typeof metadata.learned === "object" && !Array.isArray(metadata.learned)
    ? metadata.learned as Record<string, unknown>
    : {};
  return {
    record: cognitiveRowToRecord(row),
    learnedStatus: typeof learned.status === "string" ? learned.status : "active",
    ...(typeof learned.statusReason === "string" ? { learnedStatusReason: learned.statusReason } : {}),
    memoryStatus: row.archived === 1 || row.status === "archived" ? "archived" : "active",
    applied,
    blockedByHumanRevert,
  };
}

/** Read only through the typed learned envelope and both server-pinned tenant
 * keys. Generic memory_get is user-scoped only and is not a lifecycle port. */
export async function getHostedLearnedLifecycle(
  exec: Executor,
  userId: string,
  orgId: string,
  recordId: string,
  itemId: string,
): Promise<HostedLearnedLifecycleResult | null> {
  const row = await exec.one(
    `SELECT * FROM cognitive_records
      WHERE record_id = $1
        AND user_id = $2
        AND org_id = $3
        AND type = 'lesson'
        AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
        AND metadata_json::jsonb -> 'learned' ->> 'itemId' = $4
      LIMIT 1`,
    [recordId, userId, orgId, itemId],
  );
  return row ? learnedLifecycleResult(row, false, false) : null;
}

/** Archive/restore only the authenticated tenant's matching learned record.
 * Restore is permanently blocked after an explicit human revert. */
export async function transitionHostedLearnedLifecycle(
  exec: Executor,
  userId: string,
  orgId: string,
  recordId: string,
  itemId: string,
  operation: "archive" | "restore",
  reason: string,
  now = new Date(),
): Promise<HostedLearnedLifecycleResult | null> {
  return exec.tx(async (client) => {
    const selected = await client.query(
      `SELECT * FROM cognitive_records
        WHERE record_id = $1
          AND user_id = $2
          AND org_id = $3
          AND type = 'lesson'
          AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
          AND metadata_json::jsonb -> 'learned' ->> 'itemId' = $4
        LIMIT 1
        FOR UPDATE`,
      [recordId, userId, orgId, itemId],
    );
    const row = selected.rows[0];
    if (!row) return null;
    const metadata = parseJsonObject(row.metadata_json);
    const learned = metadata.learned && typeof metadata.learned === "object" && !Array.isArray(metadata.learned)
      ? metadata.learned as Record<string, unknown>
      : {};
    if (operation === "restore") {
      const outcome = objectValue(learned.outcome);
      const confirmedAt = typeof outcome.lastConfirmedAt === "string"
        ? Date.parse(outcome.lastConfirmedAt)
        : Number.NaN;
      const statusChangedAt = typeof learned.statusChangedAt === "string"
        ? Date.parse(learned.statusChangedAt)
        : Number.NaN;
      const hasFreshConfirmation = (
        learned.status === "demoted"
        && Number.isFinite(confirmedAt)
        && Number.isFinite(statusChangedAt)
        && confirmedAt > statusChangedAt
        && monotonicCounter(outcome.contradictions, 0) === 0
      );
      if (!hasFreshConfirmation) {
        return learnedLifecycleResult(row, false, learned.status === "reverted");
      }
    }

    const at = now.toISOString();
    const previousLifecycle = learned.memoryLifecycle && typeof learned.memoryLifecycle === "object"
      ? learned.memoryLifecycle as Record<string, unknown>
      : {};
    const updatedMetadata = {
      ...metadata,
      learned: {
        ...learned,
        ...(operation === "restore" ? {
          status: "active",
          statusReason: redactSensitiveMemoryText(reason).slice(0, 400),
          statusChangedAt: at,
          updatedAt: at,
        } : {}),
        memoryLifecycle: {
          status: operation === "restore" ? "active" : "archived",
          updatedAt: at,
          attempts: Math.max(1, (Number(previousLifecycle.attempts) || 0) + 1),
        },
      },
    };
    const active = operation === "restore";
    const updated = await client.query(
      `UPDATE cognitive_records
          SET metadata_json = $1,
              status = $2,
              archived = $3,
              updated_time = $4
        WHERE record_id = $5 AND user_id = $6 AND org_id = $7
        RETURNING *`,
      [JSON.stringify(updatedMetadata), active ? "active" : "archived", active ? 0 : 1, at, recordId, userId, orgId],
    );
    await client.query(
      `INSERT INTO memory_operations
        (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
       VALUES ($1,$2,$3,$4,'system',$5,$6,$7,$8)`,
      [
        randomUUID(), userId, recordId, `learned_item_${operation}`, row.session_key ?? "",
        reason, at, JSON.stringify({ itemId, orgId }),
      ],
    );
    return updated.rows[0]
      ? learnedLifecycleResult(updated.rows[0], true, false)
      : null;
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function monotonicCounter(current: unknown, incoming: unknown): number {
  const existing = Number.isFinite(Number(current)) ? Math.max(0, Math.floor(Number(current))) : 0;
  const candidate = Number.isFinite(Number(incoming)) ? Math.max(0, Math.floor(Number(incoming))) : 0;
  return Math.max(existing, candidate);
}

function laterTimestamp(current: unknown, incoming: unknown): string | undefined {
  const existing = typeof current === "string" && Number.isFinite(Date.parse(current)) ? current : undefined;
  const candidate = typeof incoming === "string" && Number.isFinite(Date.parse(incoming)) ? incoming : undefined;
  if (!candidate) return existing;
  if (!existing) return candidate;
  return Date.parse(candidate) > Date.parse(existing) ? candidate : existing;
}

const LEARNED_STATUS_RANK = {
  active: 0,
  demoted: 1,
  retired: 2,
  reverted: 3,
} as const;

type MonotonicLearnedStatus = keyof typeof LEARNED_STATUS_RANK;

function learnedStatus(value: unknown): MonotonicLearnedStatus {
  return typeof value === "string" && value in LEARNED_STATUS_RANK
    ? value as MonotonicLearnedStatus
    : "active";
}

/** Mirror only counters and forward lifecycle changes from a client ledger.
 * The row lock makes the max/forward merge serializable; identity, tier,
 * provenance and creation authority always remain the server's stored values. */
export async function syncHostedLearnedRecord(
  exec: Executor,
  userId: string,
  orgId: string,
  recordId: string,
  itemId: string,
  learnedProjection: Record<string, unknown>,
  now = new Date(),
): Promise<HostedLearnedSyncResult | null> {
  return exec.tx(async (client) => {
    const selected = await client.query(
      `SELECT * FROM cognitive_records
        WHERE record_id = $1
          AND user_id = $2
          AND org_id = $3
          AND type = 'lesson'
          AND metadata_json::jsonb -> 'learned' ->> 'schemaVersion' = '1'
          AND metadata_json::jsonb -> 'learned' ->> 'itemId' = $4
        LIMIT 1
        FOR UPDATE`,
      [recordId, userId, orgId, itemId],
    );
    const row = selected.rows[0];
    if (!row) return null;
    const existingMetadata = parseJsonObject(row.metadata_json);
    const existingLearned = existingMetadata.learned && typeof existingMetadata.learned === "object"
      ? existingMetadata.learned as Record<string, unknown>
      : {};
    const existingStatus = learnedStatus(existingLearned.status);
    if (existingStatus === "reverted") {
      return {
        record: cognitiveRowToRecord(row),
        applied: false,
        blockedByHumanRevert: true,
      };
    }

    const incomingStatus = learnedStatus(learnedProjection.status);
    const mergedStatus = LEARNED_STATUS_RANK[incomingStatus] > LEARNED_STATUS_RANK[existingStatus]
      ? incomingStatus
      : existingStatus;
    const statusAdvanced = mergedStatus !== existingStatus;
    // D6's first retirement step is an irreversible authority reduction:
    // instruction -> evidence while the item remains active. Preserve all
    // other server-owned identity fields and never permit the reverse change.
    const tierDemoted = (
      existingLearned.tier === "instruction"
      && existingLearned.origin === "human-correction"
      && learnedProjection.tier === "evidence"
      && learnedProjection.origin === "human-correction"
    );
    const existingOutcome = objectValue(existingLearned.outcome);
    const incomingOutcome = objectValue(learnedProjection.outcome);
    const nextOutcome = {
      ...existingOutcome,
      retrievals: monotonicCounter(existingOutcome.retrievals, incomingOutcome.retrievals),
      // Per-session movement is owned by noteHostedLearningOutcomes and the
      // normalized observation table. Aggregate projection may only increase;
      // accepting a decrease here could erase confirmations from hosted jobs
      // or another device that the submitting local ledger cannot see.
      confirmations: monotonicCounter(existingOutcome.confirmations, incomingOutcome.confirmations),
      contradictions: monotonicCounter(existingOutcome.contradictions, incomingOutcome.contradictions),
      lastRetrievedAt: laterTimestamp(existingOutcome.lastRetrievedAt, incomingOutcome.lastRetrievedAt),
      lastConfirmedAt: laterTimestamp(existingOutcome.lastConfirmedAt, incomingOutcome.lastConfirmedAt),
      lastContradictedAt: laterTimestamp(existingOutcome.lastContradictedAt, incomingOutcome.lastContradictedAt),
    };
    const existingLifecycle = objectValue(existingLearned.memoryLifecycle);
    const incomingLifecycle = objectValue(learnedProjection.memoryLifecycle);
    // Sync may archive as state moves forward, but it cannot reactivate a row
    // already made inactive. Explicit host lifecycle handles recoverable
    // active-item archive failures; demoted/retired/reverted items stay closed.
    const rowWasActive = row.status === "active" && row.archived !== 1;
    const active = mergedStatus === "active" && rowWasActive;
    const nextLifecycleStatus = active ? "active" : "archived";
    const existingAttempts = monotonicCounter(existingLifecycle.attempts, 0);
    const nextAttempts = monotonicCounter(existingAttempts, incomingLifecycle.attempts);
    const countersChanged = JSON.stringify(nextOutcome) !== JSON.stringify(existingOutcome);
    const lifecycleChanged = (
      existingLifecycle.status !== nextLifecycleStatus
      || existingAttempts !== nextAttempts
      || (active ? row.archived === 1 || row.status !== "active" : row.archived !== 1 || row.status !== "archived")
    );
    const changed = tierDemoted || statusAdvanced || countersChanged || lifecycleChanged;
    if (!changed) {
      return {
        record: cognitiveRowToRecord(row),
        applied: false,
        blockedByHumanRevert: false,
      };
    }

    const at = now.toISOString();
    const lifecycleAdvanced = tierDemoted || statusAdvanced;
    const statusReason = lifecycleAdvanced && typeof learnedProjection.statusReason === "string"
      ? redactSensitiveMemoryText(learnedProjection.statusReason).slice(0, 400)
      : existingLearned.statusReason;
    const nextLearned = {
      ...existingLearned,
      ...(tierDemoted ? { tier: "evidence" } : {}),
      status: mergedStatus,
      ...(typeof statusReason === "string" ? { statusReason } : {}),
      ...(lifecycleAdvanced ? { statusChangedAt: at } : {}),
      updatedAt: at,
      outcome: nextOutcome,
      memoryLifecycle: {
        ...existingLifecycle,
        status: nextLifecycleStatus,
        updatedAt: at,
        attempts: nextAttempts,
        lastError: undefined,
      },
    };
    const metadata = { ...existingMetadata, learned: nextLearned };
    const updated = await client.query(
      `UPDATE cognitive_records
          SET metadata_json = $1,
              status = $2,
              archived = $3,
              updated_time = $4
        WHERE record_id = $5 AND user_id = $6 AND org_id = $7
        RETURNING *`,
      [JSON.stringify(metadata), active ? "active" : "archived", active ? 0 : 1, at, recordId, userId, orgId],
    );
    await client.query(
      `INSERT INTO memory_operations
        (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
       VALUES ($1,$2,$3,'learned_item_sync','system',$4,$5,$6,$7)`,
      [
        randomUUID(), userId, recordId, row.session_key ?? "",
        `learned lifecycle synchronized: ${mergedStatus}`,
        at, JSON.stringify({ itemId, orgId }),
      ],
    );
    return updated.rows[0]
      ? { record: cognitiveRowToRecord(updated.rows[0]), applied: true, blockedByHumanRevert: false }
      : null;
  });
}
