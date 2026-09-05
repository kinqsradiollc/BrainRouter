// ADR-039 D4/D7 — barrier-pack parity.
//
// D4 requires the barrier model be "versioned alongside the code": when a
// chokepoint is renamed, moved, or deleted, its barrier row must change in the
// SAME PR, or the model silently rots into false positives (it stops recognizing
// a guard that moved) or dangling references (it names a symbol that no longer
// exists). D7 makes that a check rather than a rule a human must remember: this
// test reads each barrier symbol at its declared source file and fails the build
// if the definition is gone. A rename with no barrier-row update is a red build,
// not a latent regression.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ADR039_BARRIER_PACK,
  allBarrierSymbols,
  barrierClassForRuleId,
} from "./adr039BarrierPack.js";

// brainrouter/src/reviews/impact -> repository root is four levels up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

/** A source definition of `name` (function/const/class/let), export or not. */
function definesSymbol(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:function|const|class|let|var)\\s+${escaped}\\b`).test(source);
}

describe("ADR-039 D4/D7 barrier-pack parity", () => {
  it("every barrier symbol is still defined at its declared source file", () => {
    const missing: string[] = [];
    const fileCache = new Map<string, string>();
    for (const symbol of allBarrierSymbols()) {
      let source = fileCache.get(symbol.file);
      if (source === undefined) {
        try {
          source = readFileSync(resolve(repoRoot, symbol.file), "utf8");
        } catch {
          source = "";
        }
        fileCache.set(symbol.file, source);
      }
      if (!source || !definesSymbol(source, symbol.name)) {
        missing.push(`${symbol.name} (expected in ${symbol.file})`);
      }
    }
    // A non-empty list means a chokepoint moved/renamed without updating its
    // barrier row — D4's maintenance contract broke. Fix the pack in this PR.
    expect(missing, `barrier symbols not found at their declared files:\n${missing.join("\n")}`)
      .toEqual([]);
  });

  it("reads its files from source, never dist (dist can lag a rename)", () => {
    for (const symbol of allBarrierSymbols()) {
      expect(symbol.file, symbol.name).not.toContain("/dist/");
      expect(symbol.file, symbol.name).toMatch(/\.ts$/);
    }
  });

  it("gives every barrier a unique id and at least one class and one symbol", () => {
    const ids = ADR039_BARRIER_PACK.barriers.map((barrier) => barrier.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const barrier of ADR039_BARRIER_PACK.barriers) {
      expect(barrier.symbols.length, barrier.id).toBeGreaterThan(0);
      expect(barrier.neutralizes.length, barrier.id).toBeGreaterThan(0);
      expect(barrier.rationale.trim().length, barrier.id).toBeGreaterThan(0);
    }
  });

  it("covers the four chokepoints ADR-039 D4 names by hand", () => {
    // D4's prose calls out these four explicitly; a barrier for each must exist.
    const names = new Set(allBarrierSymbols().map((symbol) => symbol.name));
    for (const named of [
      "fetchUpstreamWithPolicy",
      "redactReviewSourceText",
      "isSafeRepositoryRelativePath",
      "asUntrustedWorkspaceText",
    ]) {
      expect(names.has(named), `${named} must be modeled as a barrier`).toBe(true);
    }
  });

  it("is versioned so a stale rendered CodeQL model is detectable", () => {
    expect(ADR039_BARRIER_PACK.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("maps the SSRF rule family to the ssrf class and leaves unknown rules unmapped", () => {
    expect(barrierClassForRuleId("js/request-forgery")).toBe("ssrf");
    expect(barrierClassForRuleId("js/clear-text-storage-of-sensitive-data")).toBe("secret-exposure");
    expect(barrierClassForRuleId("js/path-injection")).toBe("path-traversal");
    expect(barrierClassForRuleId("js/unused-local-variable")).toBeNull();
  });
});
