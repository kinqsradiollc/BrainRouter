// Cognitive-capture concern: extract cognitive memories from a turn, then guard
// against duplicates (LLM/embedding pass + deterministic apply-time hash/cosine)
// and detect contradictions before records land in the store.
export * from "./cognitive-extractor.js";
export * from "./cognitive-dedup.js";
export * from "./cognitive-contradiction.js";
export * from "./apply-dedup.js";
