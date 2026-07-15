/**
 * Home "slides" narrative data — the validated memory-science copy that grounds
 * the landing presentation, plus its science→architecture mapping.
 *
 * Every claim here is anchored to a published source (see SOURCES) and mapped to
 * a concrete BrainRouter layer / pipeline stage so the page explains *where* a
 * memory lives, *what* layer owns it, and *what process* moves it — exactly the
 * "validate the where/what/process" the narrative promises.
 *
 * Sources:
 *  - Human memory model (stages + encode/store/retrieve + decay): Verywell Mind,
 *    "What Is Memory?" — the classic multi-store account.
 *  - Consolidation via offline replay reduces forgetting: Tadros, Krishnan,
 *    Ramyaa & Bazhenov, "Sleep-like unsupervised replay reduces catastrophic
 *    forgetting in artificial neural networks," Nature Communications (2022).
 *  - Memory stream, retrieval by recency/importance/relevance, and reflection:
 *    Park, O'Brien, Cai, Morris, Liang & Bernstein, "Generative Agents:
 *    Interactive Simulacra of Human Behavior," arXiv:2304.03442 (2023).
 */

export interface Source {
  id: string;
  short: string;
  url: string;
}

export const SOURCES: Record<"verywell" | "replay" | "genagents", Source> = {
  verywell: {
    id: "verywell",
    short: "Verywell Mind · “What Is Memory?”",
    url: "https://www.verywellmind.com/what-is-memory-2795006",
  },
  replay: {
    id: "replay",
    short: "Tadros et al., Nature Communications (2022)",
    url: "https://www.nature.com/articles/s41467-022-34938-7",
  },
  genagents: {
    id: "genagents",
    short: "Park et al., “Generative Agents” (2023)",
    url: "https://arxiv.org/abs/2304.03442",
  },
};

/** The three classic stores of human memory (Verywell Mind). */
export const MEMORY_STAGES = [
  {
    key: "sensory",
    tag: "STAGE 01",
    name: "Sensory memory",
    duration: "≈ 0.25–4 seconds",
    blurb:
      "A raw, high-fidelity buffer of everything just perceived. Almost all of it fades before it ever reaches awareness.",
  },
  {
    key: "short",
    tag: "STAGE 02",
    name: "Short-term / working memory",
    duration: "≈ 15–30 seconds · ~7 items",
    blurb:
      "The small, active set you can hold and manipulate right now. Rehearse it and it consolidates deeper; ignore it and it is gone.",
  },
  {
    key: "long",
    tag: "STAGE 03",
    name: "Long-term memory",
    duration: "Hours → a lifetime",
    blurb:
      "Consolidated, durable storage with effectively unlimited capacity — strengthened by use, weakened by neglect.",
  },
] as const;

/** The three processes that move information between the stores. */
export const MEMORY_PROCESSES = [
  { key: "encode", name: "Encoding", blurb: "Turn perception into a storable trace." },
  { key: "store", name: "Storage", blurb: "Consolidate and hold it over time." },
  { key: "retrieve", name: "Retrieval", blurb: "Bring it back the moment it’s relevant." },
] as const;

/**
 * The mapping the page is really about: each human-memory concept on the left,
 * the BrainRouter layer that implements it on the right, and the process that
 * owns the hand-off.
 */
export const MAPPING = [
  {
    sci: "Sensory memory",
    sciSub: "raw perceptual buffer",
    process: "Encoding",
    layer: "SensoryStream",
    layerSub: "Every dialogue turn, captured verbatim, before anything is judged or kept.",
  },
  {
    sci: "Working memory",
    sciSub: "the active set, ~7 items",
    process: "Attention",
    layer: "ContextualFocus",
    layerSub: "Heat-scored scenes clustered around the active task — what matters right now.",
  },
  {
    sci: "Long-term memory",
    sciSub: "consolidated & durable",
    process: "Storage",
    layer: "CognitiveRecord",
    layerSub: "Classified facts with a priority and a decay clock — the lasting store.",
  },
  {
    sci: "Semantic self / identity",
    sciSub: "a stable schema of you",
    process: "Schema",
    layer: "CoreIdentity",
    layerSub: "A distilled profile and hard rules that anchor behaviour across every session.",
  },
] as const;

/**
 * Recall pipeline — the four real stages of src/memory/recall.ts, framed in the
 * Generative Agents vocabulary (retrieval scored by recency + importance +
 * relevance; reflection synthesises higher-level memories).
 */
export const RECALL_PIPELINE = [
  {
    n: "01",
    name: "Retrieve",
    detail: "Keyword, vector and filepath search run in parallel across the store.",
  },
  {
    n: "02",
    name: "Fuse & rank",
    detail:
      "Reciprocal Rank Fusion, then a rerank by decayed priority, citation boost and freshness — the same recency · importance · relevance signals Generative Agents score memories on.",
  },
  {
    n: "03",
    name: "Expand",
    detail:
      "A 2-hop knowledge-graph walk pulls in related facts — reflection that synthesises a richer, connected context.",
  },
] as const;

/** The two background loops that keep the store high-fidelity over time. */
export const FEEDBACK_LOOPS = [
  {
    key: "reinforce",
    kind: "REINFORCE",
    title: "Cited memories grow",
    blurb:
      "When the agent cites a memory in its answer, that memory’s priority is boosted (up to +30%) and its decay clock resets — the recall equivalent of replaying a trace to consolidate it.",
  },
  {
    key: "prune",
    kind: "PRUNE",
    title: "Unused memories fade",
    blurb:
      "A memory surfaced 10+ times but never cited is archived. Decay siphons off the noise so the index stays sharp — the difference from a flat vector DB.",
  },
] as const;

/** Lines printed by the CLI slide (auto-typed on scroll). */
export const CLI_SESSION = [
  { prompt: "brainrouter ›", cmd: '/spawn explorer "map the auth flow"', note: "memory_search → graph_query → file history" },
  { prompt: "brainrouter ›", cmd: '/spawn architect "propose token rotation"', note: "grounded in cited memories" },
  { prompt: "brainrouter ›", cmd: "/run_workflow review-wide", note: "fan out · barrier-wait · synthesize" },
  { prompt: "brainrouter ›", cmd: "/memories consolidate", note: "wrote MEMORY.md · user.md · project.md" },
] as const;
