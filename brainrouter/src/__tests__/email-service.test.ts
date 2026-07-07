import { describe, expect, it } from "vitest";
import { hashToken, generateToken, expiryFrom, notExpired } from "../tenancy/tokens.js";
import { isSmtpConfigured, emailServiceFor, NoopEmailService, type SmtpConfig } from "../services/email/emailService.js";

describe("TOKENS (invite/verify secret pattern)", () => {
  it("generateToken returns a raw token whose hash matches hashToken(raw)", () => {
    const { raw, hash } = generateToken();
    expect(raw.length).toBeGreaterThan(20);
    expect(hash).toBe(hashToken(raw));
    expect(hash).not.toBe(raw); // only the hash is stored
  });

  it("distinct tokens produce distinct hashes", () => {
    expect(generateToken().hash).not.toBe(generateToken().hash);
  });

  it("expiryFrom + notExpired form a consistent window", () => {
    const now = "2026-07-07T00:00:00.000Z";
    const exp = expiryFrom(now, 3600_000); // +1h
    expect(notExpired(exp, now)).toBe(true);
    expect(notExpired(exp, "2026-07-07T02:00:00.000Z")).toBe(false); // 2h later
  });
});

describe("EMAIL-SERVICE selection", () => {
  const full: SmtpConfig = { enabled: true, host: "smtp.test", port: 587, from: "a@test" };

  it("isSmtpConfigured requires enabled + host + from + port", () => {
    expect(isSmtpConfigured(full)).toBe(true);
    expect(isSmtpConfigured({ ...full, enabled: false })).toBe(false);
    expect(isSmtpConfigured({ ...full, host: "" })).toBe(false);
    expect(isSmtpConfigured(null)).toBe(false);
  });

  it("emailServiceFor picks SMTP when configured, else Noop", () => {
    expect(emailServiceFor(full).kind).toBe("smtp");
    expect(emailServiceFor(null).kind).toBe("noop");
    expect(emailServiceFor({ ...full, enabled: false }).kind).toBe("noop");
  });

  it("NoopEmailService never throws and reports not-delivered", async () => {
    const r = await new NoopEmailService().send({ to: "x@test", subject: "s", text: "t" });
    expect(r.ok).toBe(false);
  });
});
