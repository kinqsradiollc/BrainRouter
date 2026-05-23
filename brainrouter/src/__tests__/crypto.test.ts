import { describe, expect, it } from "vitest";
import { hashPassword, signJwt, verifyJwt, verifyPassword } from "../api/auth/crypto.js";

describe("crypto auth helpers", () => {
  it("hashPassword + verifyPassword round-trip", async () => {
    const stored = await hashPassword("S3cret123!");
    await expect(verifyPassword("S3cret123!", stored)).resolves.toBe(true);
  });

  it("verifyPassword fails with wrong password", async () => {
    const stored = await hashPassword("S3cret123!");
    await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
  });

  it("signJwt + verifyJwt round-trip", () => {
    const token = signJwt({ userId: "u1", isAdmin: true }, "secret", 60);
    const payload = verifyJwt(token, "secret");
    expect(payload).not.toBeNull();
    expect(payload?.userId).toBe("u1");
    expect(payload?.isAdmin).toBe(true);
  });

  it("verifyJwt returns null for expired token", () => {
    const token = signJwt({ userId: "u1" }, "secret", -1);
    expect(verifyJwt(token, "secret")).toBeNull();
  });

  it("verifyJwt returns null for tampered signature", () => {
    const token = signJwt({ userId: "u1" }, "secret", 60);
    // Pick a replacement char that is GUARANTEED to differ from the
    // original last char. The previous version hard-coded "x"; whenever
    // the JWT's base64url signature happened to end in "x" (~1/64 odds),
    // the "tampered" token equalled the original and verification
    // succeeded — flaky failure. See PR #22 CI run 26323691062.
    const lastChar = token.slice(-1);
    const replacement = lastChar === "A" ? "B" : "A";
    const tampered = token.slice(0, -1) + replacement;
    expect(verifyJwt(tampered, "secret")).toBeNull();
  });
});
