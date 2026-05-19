import { describe, expect, it } from "vitest";
import { redactSensitiveMemoryText } from "../memory/redaction.js";

describe("memory redaction", () => {
  it("redacts tokens and env-style secrets before capture", () => {
    const redacted = redactSensitiveMemoryText("Bearer sk-test-key-value\nSECRET_TOKEN=abc123");
    expect(redacted).not.toContain("sk-test-key-value");
    expect(redacted).not.toContain("SECRET_TOKEN=abc123");
    expect(redacted).toContain("[REDACTED]");
  });
});
