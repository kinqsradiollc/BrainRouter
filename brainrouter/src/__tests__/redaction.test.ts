import { describe, expect, it } from "vitest";
import { redactSensitiveMemoryText } from "../memory/util/redaction.js";

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

  it("redacts the secret shapes a pentest PoC captures (JWT, cookie, Basic, cloud keys, IPv6)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.s3cr3tSignatureValue";
    const r = redactSensitiveMemoryText(
      [
        `PoC: curl https://t/api -H 'Cookie: sessionid=${jwt}'`,
        "Authorization: Basic YWRtaW46c3VwZXJzZWNyZXQ=",
        "aws AKIAIOSFODNN7EXAMPLE key AIzaSyD-1234567890abcdefghijklmnopqrstuv slack xoxb-1111-2222-abcdef",
        "host 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      ].join("\n")
    );
    expect(r).not.toContain(jwt);
    expect(r).not.toContain("sessionid=");
    expect(r).not.toContain("YWRtaW46c3VwZXJzZWNyZXQ");
    expect(r).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r).not.toContain("AIzaSyD-1234567890abcdefghijklmnopqrstuv");
    expect(r).not.toContain("xoxb-1111-2222-abcdef");
    expect(r).not.toContain("2001:0db8:85a3");
  });

  it("does not over-redact ordinary prose (timestamp, 'Basic understanding')", () => {
    const r = redactSensitiveMemoryText("Deploy finished at 12:34:56 with a Basic understanding of the flow");
    expect(r).toContain("12:34:56");
    expect(r).toContain("Basic understanding");
  });
});
