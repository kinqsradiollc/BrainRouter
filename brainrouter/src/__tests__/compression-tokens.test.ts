import { describe, expect, it } from "vitest";
import { estimateTokens, estimateTokensForJson } from "../memory/compression/tokens.js";

describe("compression token estimates", () => {
  it("uses the documented four-characters-per-token ceiling", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("estimates serialized JSON rather than object coercion", () => {
    const value = { records: [{ id: 1, message: "database failed" }] };
    expect(estimateTokensForJson(value)).toBe(estimateTokens(JSON.stringify(value)));
  });
});
