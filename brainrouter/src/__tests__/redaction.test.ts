import { describe, expect, it } from "vitest";
import { redactSensitiveMemoryText } from "../memory/redaction.js";

describe("memory redaction", () => {
  it("redacts tokens and env-style secrets before capture", () => {
    const redacted = redactSensitiveMemoryText("Bearer sk-test-key-value\nSECRET_TOKEN=abc123");
    expect(redacted).not.toContain("sk-test-key-value");
    expect(redacted).not.toContain("SECRET_TOKEN=abc123");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts database connection strings and IPv4 addresses", () => {
    const redacted = redactSensitiveMemoryText(
      "Connect to postgresql://admin:s3cret@10.0.0.5:5432/app from 192.168.1.10"
    );

    expect(redacted).not.toContain("s3cret");
    expect(redacted).not.toContain("192.168.1.10");
    expect(redacted).toContain("[REDACTED_CONN_STR]");
    expect(redacted).toContain("[REDACTED_IP]");
  });
});
