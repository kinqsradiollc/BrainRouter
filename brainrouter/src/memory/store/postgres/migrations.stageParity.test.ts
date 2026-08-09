/**
 * The assurance stage CHECK constraint must accept every stage the code writes.
 *
 * This exists because it did not, and the failure was expensive out of all
 * proportion to its size. `ASSURANCE_STAGE_NAMES` has eleven entries; migration
 * 046 wrote a CHECK naming ten. The missing one was `cleanup`, which
 * `repository-context/session.ts` runs at the END of every review — so every
 * review reached its last stage and was refused by the database.
 *
 * What made it costly was the aftermath rather than the rejection: a run that
 * dies mid-stage leaves that stage `running`, `terminalStage()` reads `running`
 * as "unfinished, retry it", the retry reuses the same attempt number, and the
 * store refuses a second receipt id for one attempt. The run becomes
 * permanently unretryable. One absent enum value stopped PR review for days and
 * left deep review with no completed index to preflight against.
 *
 * No database is needed to catch it, which is the point — the unit tests all
 * passed, because they exercise an in-memory store that has no CHECK at all.
 * Parity between a TypeScript union and the SQL that stores it is a property of
 * the two files, so it is checked from the two files.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASSURANCE_STAGE_NAMES,
  ASSURANCE_STAGE_STATUSES,
} from "@kinqs/brainrouter-types/review";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Every migration, oldest first — a later one may redefine an earlier CHECK. */
function migrationsInOrder(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((name) => readFileSync(new URL(name, `file://${MIGRATIONS_DIR}`), "utf8"));
}

/**
 * The values the LAST definition of `constraint` admits.
 *
 * Comment bodies are stripped first: these migrations document their own
 * rollback in `--` comments, and a rollback comment necessarily contains the
 * older, narrower list. Reading that as the live constraint would make this
 * test fail on a migration that is correct.
 */
function admittedValues(constraint: string): string[] | undefined {
  let found: string[] | undefined;
  for (const raw of migrationsInOrder()) {
    const sql = raw.replace(/^\s*--.*$/gm, "");
    const pattern = new RegExp(`${constraint}[\\s\\S]*?CHECK\\s*\\([\\s\\S]*?IN\\s*\\(([\\s\\S]*?)\\)`, "gi");
    for (const match of sql.matchAll(pattern)) {
      found = [...match[1]!.matchAll(/'([^']+)'/g)].map((value) => value[1]!);
    }
  }
  return found;
}

describe("assurance schema parity", () => {
  it("accepts every stage name the code can write", () => {
    const admitted = admittedValues("repository_assurance_stages_stage_check");
    expect(admitted, "no stage CHECK found in any migration").toBeDefined();
    const missing = ASSURANCE_STAGE_NAMES.filter((stage) => !admitted!.includes(stage));
    expect(missing, `stages the database would reject: ${missing.join(", ")}`).toEqual([]);
  });

  it("accepts every stage status the code can write", () => {
    const admitted = admittedValues("repository_assurance_stages_status_check");
    expect(admitted, "no status CHECK found in any migration").toBeDefined();
    const missing = ASSURANCE_STAGE_STATUSES.filter((status) => !admitted!.includes(status));
    expect(missing, `statuses the database would reject: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not admit values the code has no name for", () => {
    // The other direction matters too: a value in SQL that the union dropped is
    // either dead or a rename nobody finished, and both are worth seeing.
    const admitted = admittedValues("repository_assurance_stages_stage_check")!;
    const unknown = admitted.filter((stage) => !(ASSURANCE_STAGE_NAMES as readonly string[]).includes(stage));
    expect(unknown, `SQL admits stages the code cannot produce: ${unknown.join(", ")}`).toEqual([]);
  });
});
