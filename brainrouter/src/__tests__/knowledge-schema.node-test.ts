/**
 * Project knowledge schema contract. Static assertions run without Postgres;
 * the integration assertion below exercises the same migration against a fresh
 * pgvector database in the normal test:integration suite.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadMigrations } from "../memory/store/postgres/migrate.js";
import { createTestStore } from "./helpers/pgTestStore.js";

const { Client } = pg;
const migrationsDir = fileURLToPath(new URL("../memory/store/postgres/migrations", import.meta.url));

function migrationSql(): string {
  const migration = loadMigrations(migrationsDir).find((item) => item.id === "044_project_knowledge");
  assert.ok(migration, "044_project_knowledge migration is present");
  return migration.sql;
}

function distillationMigrationSql(): string {
  const migration = loadMigrations(migrationsDir).find(
    (item) => item.id === "045_knowledge_distillation",
  );
  assert.ok(migration, "045_knowledge_distillation migration is present");
  return migration.sql;
}

test("knowledge schema is project-consistent, status-bounded, searchable, and vector-isolated", () => {
  const sql = migrationSql();

  for (const table of [
    "knowledge_bases",
    "knowledge_documents",
    "knowledge_chunks",
    "knowledge_chunk_embeddings",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }

  assert.match(sql, /FOREIGN KEY \(project_id, org_id\)\s+REFERENCES projects\(project_id, org_id\)/);
  assert.match(sql, /FOREIGN KEY \(base_id, org_id, project_id\)\s+REFERENCES knowledge_bases/);
  assert.match(sql, /FOREIGN KEY \(document_id, base_id, org_id, project_id\)\s+REFERENCES knowledge_documents/);
  assert.match(sql, /FOREIGN KEY \(chunk_id, document_id, base_id, org_id, project_id\)\s+REFERENCES knowledge_chunks/);
  assert.match(sql, /status IN \('queued', 'parsing', 'ready', 'failed'\)/);
  assert.match(sql, /uq_knowledge_documents_base_content/);
  assert.match(sql, /content_tsv\s+tsvector GENERATED ALWAYS/);
  assert.match(sql, /USING GIN\(content_tsv\)/);
  assert.match(sql, /embedding\s+vector NOT NULL/);
  assert.match(sql, /vector_dims\(embedding\) = dimensions/);
  assert.doesNotMatch(sql, /(?:ALTER|DROP|TRUNCATE) TABLE cognitive_vec/i);
  assert.doesNotMatch(sql, /\braw_(?:content|text|bytes|payload)\b/i);
});

test("knowledge distillation schema identifies derived notes and tenant-bound provenance", () => {
  const sql = distillationMigrationSql();

  assert.match(sql, /origin IN \('source', 'derived'\)/);
  assert.match(sql, /origin = 'source' AND distillation_version IS NULL/);
  assert.match(sql, /origin = 'derived' AND distillation_version > 0/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_document_provenance/);
  assert.match(sql, /FOREIGN KEY \(derived_document_id, base_id, org_id, project_id\)/);
  assert.match(sql, /FOREIGN KEY \(source_document_id, base_id, org_id, project_id\)/);
  assert.match(sql, /derived_document_id <> source_document_id/);
});

test("knowledge schema enforces tenant ancestry, per-base dedupe, status, vector dimensions, FTS, and cascades", async () => {
  const { store, url, cleanup } = await createTestStore({ vecDim: 0 });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await store.createUser("knowledge-user", "knowledge-user", "Knowledge User");
    await store.createOrganization({
      orgId: "org-knowledge-a",
      name: "Knowledge A",
      slug: "knowledge-a",
      plan: "team",
    });
    await store.createOrganization({
      orgId: "org-knowledge-b",
      name: "Knowledge B",
      slug: "knowledge-b",
      plan: "team",
    });
    await store.addOrgMember("org-knowledge-a", "knowledge-user", "owner");
    await store.addOrgMember("org-knowledge-b", "knowledge-user", "owner");
    await store.createProject({
      projectId: "project-knowledge-a",
      orgId: "org-knowledge-a",
      name: "Project A",
      slug: "project-a",
      repoUrl: null,
      restricted: false,
      createdBy: "knowledge-user",
      createdAt: new Date().toISOString(),
    });
    await store.createProject({
      projectId: "project-knowledge-b",
      orgId: "org-knowledge-b",
      name: "Project B",
      slug: "project-b",
      repoUrl: null,
      restricted: false,
      createdBy: "knowledge-user",
      createdAt: new Date().toISOString(),
    });

    await client.query(
      `INSERT INTO knowledge_bases (base_id, org_id, project_id, name, created_by)
       VALUES ('base-a', 'org-knowledge-a', 'project-knowledge-a', 'Primary', 'knowledge-user'),
              ('base-a-second', 'org-knowledge-a', 'project-knowledge-a', 'Secondary', 'knowledge-user'),
              ('base-b', 'org-knowledge-b', 'project-knowledge-b', 'Foreign', 'knowledge-user')`,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO knowledge_bases (base_id, org_id, project_id, name, created_by)
         VALUES ('base-cross-org', 'org-knowledge-b', 'project-knowledge-a', 'Cross org', 'knowledge-user')`,
      ),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );

    const hash = "a".repeat(64);
    await client.query(
      `INSERT INTO knowledge_documents
         (document_id, base_id, org_id, project_id, title, source_format, content_text,
          content_sha256, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'markdown', $6, $7, 'queued', $8)`,
      [
        "document-a",
        "base-a",
        "org-knowledge-a",
        "project-knowledge-a",
        "Architecture notes",
        "The retrieval pipeline preserves citations.",
        hash,
        "knowledge-user",
      ],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO knowledge_documents
           (document_id, base_id, org_id, project_id, title, source_format, content_text,
            content_sha256, status, created_by)
         VALUES ('document-cross-project', 'base-a', 'org-knowledge-b', 'project-knowledge-b',
                 'Cross project', 'markdown', 'foreign', $1, 'queued', 'knowledge-user')`,
        ["f".repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );
    await assert.rejects(
      client.query(
        `INSERT INTO knowledge_documents
           (document_id, base_id, org_id, project_id, title, source_format, content_text,
            content_sha256, status, created_by)
         VALUES ('document-duplicate', 'base-a', 'org-knowledge-a', 'project-knowledge-a',
                 'Duplicate', 'markdown', 'same', $1, 'queued', 'knowledge-user')`,
        [hash],
      ),
      (error: unknown) => (error as { code?: string }).code === "23505",
    );
    await client.query(
      `INSERT INTO knowledge_documents
         (document_id, base_id, org_id, project_id, title, source_format, content_text,
          content_sha256, status, created_by)
       VALUES ('document-second-base', 'base-a-second', 'org-knowledge-a', 'project-knowledge-a',
               'Same source elsewhere', 'markdown', 'same', $1, 'queued', 'knowledge-user')`,
      [hash],
    );
    await assert.rejects(
      client.query(
        `UPDATE knowledge_documents SET status = 'complete' WHERE document_id = 'document-a'`,
      ),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await client.query(
      `INSERT INTO knowledge_documents
         (document_id, base_id, org_id, project_id, title, source_format,
          content_text, content_sha256, origin, distillation_version, status, created_by)
       VALUES ('derived-a', 'base-a', 'org-knowledge-a', 'project-knowledge-a',
               'Derived note', 'markdown', 'derived', $1, 'derived', 1, 'queued',
               'knowledge-user')`,
      ["d".repeat(64)],
    );
    await client.query(
      `INSERT INTO knowledge_document_provenance
         (derived_document_id, source_document_id, base_id, org_id, project_id)
       VALUES ('derived-a', 'document-a', 'base-a', 'org-knowledge-a',
               'project-knowledge-a')`,
    );
    await assert.rejects(
      client.query(
        `UPDATE knowledge_documents SET distillation_version = 1
          WHERE document_id = 'document-a'`,
      ),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await assert.rejects(
      client.query(
        `UPDATE knowledge_documents SET origin = 'source'
          WHERE document_id = 'derived-a'`,
      ),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await assert.rejects(
      client.query(
        `INSERT INTO knowledge_document_provenance
           (derived_document_id, source_document_id, base_id, org_id, project_id)
         VALUES ('derived-a', 'derived-a', 'base-a', 'org-knowledge-a',
                 'project-knowledge-a')`,
      ),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await assert.rejects(
      client.query(
        `INSERT INTO knowledge_document_provenance
           (derived_document_id, source_document_id, base_id, org_id, project_id)
         VALUES ('derived-a', 'document-second-base', 'base-a', 'org-knowledge-a',
                 'project-knowledge-a')`,
      ),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );

    await client.query(
      `INSERT INTO knowledge_chunks
         (chunk_id, document_id, base_id, org_id, project_id, ordinal, content,
          content_sha256, token_count, char_start, char_end, locator_json)
       VALUES ('chunk-a', 'document-a', 'base-a', 'org-knowledge-a', 'project-knowledge-a',
               0, 'retrieval pipeline preserves citations', $1, 4, 0, 38, '{"section":"overview"}')`,
      ["b".repeat(64)],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO knowledge_chunks
           (chunk_id, document_id, base_id, org_id, project_id, ordinal, content, content_sha256)
         VALUES ('chunk-cross-base', 'document-a', 'base-a-second', 'org-knowledge-a',
                 'project-knowledge-a', 1, 'cross base', $1)`,
        ["c".repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );
    const fts = await client.query<{ matches: boolean }>(
      `SELECT content_tsv @@ plainto_tsquery('english', 'retrieval citations') AS matches
         FROM knowledge_chunks WHERE chunk_id = 'chunk-a'`,
    );
    assert.equal(fts.rows[0]?.matches, true);

    await client.query(
      `INSERT INTO knowledge_chunk_embeddings
         (chunk_id, document_id, base_id, org_id, project_id, embedding_model, dimensions, embedding)
       VALUES ('chunk-a', 'document-a', 'base-a', 'org-knowledge-a', 'project-knowledge-a',
               'test-model', 3, '[1,0,0]'::vector)`,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO knowledge_chunk_embeddings
           (chunk_id, document_id, base_id, org_id, project_id, embedding_model, dimensions, embedding)
         VALUES ('chunk-a', 'document-second-base', 'base-a-second', 'org-knowledge-a',
                 'project-knowledge-a', 'wrong-parent', 3, '[1,0,0]'::vector)`,
      ),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );
    await assert.rejects(
      client.query(
        `UPDATE knowledge_chunk_embeddings SET dimensions = 2
          WHERE chunk_id = 'chunk-a' AND embedding_model = 'test-model'`,
      ),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );

    await store.deleteProject("project-knowledge-a");
    const cascaded = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM knowledge_bases WHERE project_id = 'project-knowledge-a'`,
    );
    assert.equal(cascaded.rows[0]?.count, 0);
  } finally {
    await client.end().catch(() => undefined);
    await cleanup();
  }
});
