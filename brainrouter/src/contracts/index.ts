/**
 * ADR-004 Phase 1 — in-repo typed contracts for the `brainrouter/` backend.
 *
 * The shared, versionable seam between transport (HTTP routes + MCP tools) and
 * the engine: wire envelopes, DTOs, and (in later phases) the tool/route Zod
 * schemas that today live inline. Kept in-repo (no published package) so the
 * release surface is unchanged; a package can be promoted later if the CLI or
 * desktop ever need to import these directly.
 */

export * from "./http.js";
