// Turn capture + cognitive extraction. Split by concern into ./capture/*:
//   base       — construction + shared pipeline state
//   persistence — source ingest, chunk provenance, blackboard admission
//   extraction  — the extract → dedup → admit → commit cognitive chain
//   entry       — public MemoryCapturePipeline (captureTurn / processBacklog)
// This file is a thin re-export barrel; the public surface is unchanged.
export { MemoryCapturePipeline } from "./capture/entry.js";
