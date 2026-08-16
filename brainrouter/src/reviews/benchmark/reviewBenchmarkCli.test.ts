/** ADR-033 §6 — even setup failures leave a private machine-readable receipt. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BRAINROUTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("review benchmark CLI", () => {
  it("writes a mode-0600 bootstrap failure artifact when provider config is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainrouter-review-bench-"));
    const output = join(directory, "failed.json");
    try {
      const run = spawnSync(
        process.execPath,
        ["--import", "tsx", "benchmark/review-bench.ts", `--output=${output}`],
        { cwd: BRAINROUTER_ROOT, encoding: "utf8", timeout: 30_000 },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("failed artifact");
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        schemaVersion: 1,
        status: "failed",
        phase: "bootstrap",
        completedCases: [],
        modelCalls: [],
        failure: {
          message: "--provider-config=/absolute/path/review-provider.json is required.",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
