import { describe, expect, it, vi } from "vitest";
import { MemoryEngine } from "../engine.js";

describe("authorized-assessment memory metadata", () => {
  it("does not promote retention-governed evidence into long-lived recall", async () => {
    const upsertEngineeringMemory = vi.fn(async () => ({ id: "memory-1" }));
    const setMemoryVisibility = vi.fn(async () => undefined);
    const engine = {
      upsertEngineeringMemory,
      sharing: { setMemoryVisibility },
    };

    await MemoryEngine.prototype.recordPentestFindings.call(engine as never, {
      orgId: "org-1",
      userId: "user-1",
      target: "https://example.test",
      reviewId: "review-1",
      findings: [{
        id: "finding-1",
        severity: "high",
        summary: "Authorization bypass",
        details: "retention-governed impact evidence",
        remediation: "retention-governed remediation evidence",
        poc: "retention-governed proof",
        cwe: "CWE-285",
        file: "https://user:password@example.test/private?token=sensitive#response",
      }],
    });

    const input = upsertEngineeringMemory.mock.calls[0]?.[0];
    expect(input?.content).toContain("Authorization bypass");
    expect(input?.content).toContain("CWE-285");
    expect(input?.content).not.toContain("impact evidence");
    expect(input?.content).not.toContain("remediation evidence");
    expect(input?.content).not.toContain("proof");
    expect(input?.content).toContain("https://example.test/private");
    expect(input?.content).not.toContain("sensitive");
    expect(input?.filePaths).toEqual(["https://example.test/private"]);
    expect(input?.verificationStatus).toBe("unverified");
    expect(setMemoryVisibility).toHaveBeenCalledWith(
      "memory-1",
      "user-1",
      "org-1",
      "org",
    );
  });
});
