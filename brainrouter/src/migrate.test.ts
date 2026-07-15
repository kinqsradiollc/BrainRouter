import { describe, expect, it } from "vitest";
import { postgresDatabaseUrl } from "./migrate.js";

describe("one-shot Postgres migrator", () => {
  it("requires an explicit database URL without echoing credentials", () => {
    expect(() => postgresDatabaseUrl({})).toThrow("BRAINROUTER_DATABASE_URL is required");
    expect(() => postgresDatabaseUrl({ BRAINROUTER_DATABASE_URL: "secret-value" })).toThrow("valid PostgreSQL URL");
  });

  it("accepts only PostgreSQL connection URLs", () => {
    expect(postgresDatabaseUrl({ BRAINROUTER_DATABASE_URL: "postgres://user:secret@db/brainrouter" }))
      .toBe("postgres://user:secret@db/brainrouter");
    expect(() => postgresDatabaseUrl({ BRAINROUTER_DATABASE_URL: "https://db.example/brainrouter" }))
      .toThrow("valid PostgreSQL URL");
  });
});

