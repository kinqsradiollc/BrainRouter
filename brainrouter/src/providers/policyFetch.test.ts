import { describe, expect, it } from "vitest";
import { policyBoundFetch } from "./policyFetch.js";

// ADR-039 — the memory-pipeline provider calls dial an org-configured endpoint.
// policyBoundFetch refuses an internal target before dialing.
describe("policyBoundFetch (ADR-039 runtime SSRF guard)", () => {
  it("refuses a target that resolves to the cloud metadata address", async () => {
    const f = policyBoundFetch({ resolve: async () => [{ address: "169.254.169.254", family: 4 }] });
    await expect(f("http://embedder.internal/v1/embeddings", { method: "POST" }))
      .rejects.toThrow(/metadata|private|policy|allowlist/i);
  });
  it("refuses a target that resolves to an RFC1918 private address (hosted default)", async () => {
    const f = policyBoundFetch({ resolve: async () => [{ address: "10.0.0.5", family: 4 }] });
    await expect(f("http://rerank.internal/v1/rerank", { method: "POST" }))
      .rejects.toThrow(/private|policy|allowlist/i);
  });
});
