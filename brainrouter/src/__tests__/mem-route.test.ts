import { describe, expect, it } from "vitest";
import { isReflectiveQuery, readQueryRoutingEnabled } from "../memory/recall.js";

// MEM-ROUTE (0.4.14) — reflective/analytical queries skip the cross-encoder
// (it demotes their low-overlap gold); factual/conversational keep it.
describe("isReflectiveQuery", () => {
  it("flags reflective / analytical questions", () => {
    for (const q of [
      "What is the most likely user sentiment around '2024-10-01 08:07' Tuesday",
      "How does she usually feel about deadlines?",
      "What is the overall pattern in how I handle conflict?",
      "Summarize their attitude toward the project",
      "What's his general mood lately?",
    ]) {
      expect(isReflectiveQuery(q)).toBe(true);
    }
  });

  it("does NOT flag direct factual lookups (keeps the reranker)", () => {
    for (const q of [
      "What is the name of my niece's company?",
      "What is the email address of my cousin?",
      "What hobby does my brother have?",
      "When did I last deploy the API?",
      "Which restaurant did we book for Friday?",
    ]) {
      expect(isReflectiveQuery(q)).toBe(false);
    }
  });

  it("is null/empty safe", () => {
    expect(isReflectiveQuery("")).toBe(false);
    expect(isReflectiveQuery(undefined as unknown as string)).toBe(false);
  });
});

describe("readQueryRoutingEnabled", () => {
  it("defaults on; only 'off' disables (case/space tolerant)", () => {
    expect(readQueryRoutingEnabled({})).toBe(true);
    expect(readQueryRoutingEnabled({ BRAINROUTER_RECALL_QUERY_ROUTING: "" })).toBe(true);
    expect(readQueryRoutingEnabled({ BRAINROUTER_RECALL_QUERY_ROUTING: "heuristic" })).toBe(true);
    expect(readQueryRoutingEnabled({ BRAINROUTER_RECALL_QUERY_ROUTING: "off" })).toBe(false);
    expect(readQueryRoutingEnabled({ BRAINROUTER_RECALL_QUERY_ROUTING: " OFF " })).toBe(false);
  });
});
