import { afterEach, describe, expect, it, vi } from "vitest";
import { vecIndexDdl } from "../memory/store/postgres/PostgresMemoryStore.js";

describe("vecIndexDdl — configurable cognitive_vec ANN index", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("defaults to ivfflat lists=100 (prior behaviour)", () => {
    const ddl = vecIndexDdl()!;
    expect(ddl).toContain("USING ivfflat (embedding vector_cosine_ops)");
    expect(ddl).toContain("WITH (lists = 100)");
    expect(ddl).toContain("IF NOT EXISTS idx_cognitive_vec_cos");
  });

  it("honours a custom ivfflat lists value", () => {
    vi.stubEnv("BRAINROUTER_PGVECTOR_LISTS", "512");
    expect(vecIndexDdl()).toContain("WITH (lists = 512)");
  });

  it("builds an hnsw index with m / ef_construction", () => {
    vi.stubEnv("BRAINROUTER_PGVECTOR_INDEX", "hnsw");
    vi.stubEnv("BRAINROUTER_PGVECTOR_HNSW_M", "32");
    vi.stubEnv("BRAINROUTER_PGVECTOR_HNSW_EF_CONSTRUCTION", "128");
    const ddl = vecIndexDdl()!;
    expect(ddl).toContain("USING hnsw (embedding vector_cosine_ops)");
    expect(ddl).toContain("WITH (m = 32, ef_construction = 128)");
  });

  it("disables the index with 'none'", () => {
    vi.stubEnv("BRAINROUTER_PGVECTOR_INDEX", "none");
    expect(vecIndexDdl()).toBeNull();
  });

  it("falls back to the ivfflat default for an unknown index type / bad params", () => {
    vi.stubEnv("BRAINROUTER_PGVECTOR_INDEX", "bogus");
    vi.stubEnv("BRAINROUTER_PGVECTOR_LISTS", "-5"); // invalid → fallback 100
    const ddl = vecIndexDdl()!;
    expect(ddl).toContain("USING ivfflat");
    expect(ddl).toContain("WITH (lists = 100)");
  });
});
