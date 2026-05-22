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
    const tampered = `${token.slice(0, -1)}x`;
    expect(verifyJwt(tampered, "secret")).toBeNull();
  });
});
