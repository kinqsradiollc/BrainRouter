// Public entrypoint for the memory `pipeline` subsystem. The flat modules were
// grouped into per-concern subfolders (cognitive / focus / graph / identity /
// skill / ingest); this barrel re-exports them so the subsystem's file layout
// stays an internal detail and consumers can import from `../pipeline` instead
// of deep per-file paths.
export * from "./cognitive/index.js";
export * from "./focus/index.js";
export * from "./graph/index.js";
export * from "./identity/index.js";
export * from "./skill/index.js";
export * from "./ingest/index.js";
