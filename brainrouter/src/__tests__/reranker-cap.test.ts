import { describe, it, expect } from "vitest";
import { rerankerMaxDocChars } from "../memory/store/reranker.js";

// MEM-RERANK (0.4.14) — configurable per-doc truncation so the cross-encoder
// scores a whole chunk instead of the old hardcoded 700-char window.
describe("rerankerMaxDocChars", () => {
  it("defaults to 1500 (covers a MEM-CHUNK chunk, within a 512-token reranker)", () => {
    expect(rerankerMaxDocChars({})).toBe(1500);
    expect(rerankerMaxDocChars({ BRAINROUTER_RERANKER_MAX_DOC_CHARS: "" })).toBe(1500);
  });
  it("parses a valid override", () => {
    expect(rerankerMaxDocChars({ BRAINROUTER_RERANKER_MAX_DOC_CHARS: "700" })).toBe(700);
    expect(rerankerMaxDocChars({ BRAINROUTER_RERANKER_MAX_DOC_CHARS: "2000" })).toBe(2000);
  });
  it("clamps to 8000 and rejects below-100 / junk (→ default)", () => {
    expect(rerankerMaxDocChars({ BRAINROUTER_RERANKER_MAX_DOC_CHARS: "99999" })).toBe(8000);
    expect(rerankerMaxDocChars({ BRAINROUTER_RERANKER_MAX_DOC_CHARS: "50" })).toBe(1500);
    expect(rerankerMaxDocChars({ BRAINROUTER_RERANKER_MAX_DOC_CHARS: "junk" })).toBe(1500);
  });
});
