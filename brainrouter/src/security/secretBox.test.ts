import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { sealWith, openWith, parseMasterKey, isSealed } from "./secretBox.js";

const KEY = crypto.randomBytes(32);

describe("secretBox — AES-256-GCM envelope encryption (ADR-010 §4)", () => {
  it("seals then opens round-trips a secret", () => {
    const secret = "sk-abc123-super-secret-provider-key";
    const sealed = sealWith(KEY, secret);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).toContain("v1:");
    expect(sealed).not.toContain(secret); // ciphertext, not plaintext
    expect(openWith(KEY, sealed)).toBe(secret);
  });

  it("produces a different ciphertext each time (random iv) but opens to the same plaintext", () => {
    const a = sealWith(KEY, "same");
    const b = sealWith(KEY, "same");
    expect(a).not.toBe(b);
    expect(openWith(KEY, a)).toBe("same");
    expect(openWith(KEY, b)).toBe("same");
  });

  it("fails to open under the wrong key (GCM auth tag rejects tampering)", () => {
    const sealed = sealWith(KEY, "secret");
    expect(() => openWith(crypto.randomBytes(32), sealed)).toThrow();
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = sealWith(KEY, "secret");
    // Flip a byte in the base64 body.
    const body = sealed.slice(3);
    const buf = Buffer.from(body, "base64");
    buf[buf.length - 1] ^= 0xff;
    const tampered = `v1:${buf.toString("base64")}`;
    expect(() => openWith(KEY, tampered)).toThrow();
  });

  it("passes legacy plaintext through open() unchanged (rollout: env-seeded values)", () => {
    expect(openWith(KEY, "plain-env-key")).toBe("plain-env-key");
    expect(isSealed("plain-env-key")).toBe(false);
  });

  it("parseMasterKey accepts base64 / hex / 32-char utf8 and rejects wrong lengths", () => {
    const raw = crypto.randomBytes(32);
    expect(parseMasterKey(raw.toString("base64"))?.equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString("hex"))?.equals(raw)).toBe(true);
    expect(parseMasterKey("x".repeat(32))?.length).toBe(32); // utf8 fallback
    expect(parseMasterKey("too-short")).toBe(null);
    expect(parseMasterKey("")).toBe(null);
    expect(parseMasterKey(undefined)).toBe(null);
  });

  it("rejects a non-32-byte key at seal time", () => {
    expect(() => sealWith(Buffer.alloc(16), "x")).toThrow();
  });
});
