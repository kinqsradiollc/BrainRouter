// ADR-049 — Study mode. The BROWSER-SAFE surface (pure scheduler, distractors,
// codecs, stats): the desktop renderer deep-imports this via
// `@kinqs/brainrouter-core/study`. The node-fs store is a SEPARATE subpath
// (`@kinqs/brainrouter-core/study/store`) so this barrel never pulls `node:fs`
// into the renderer bundle (see the renderer-deep-import discipline).
export * from "./srs.js";
export * from "./distractors.js";
export * from "./codecs.js";
export * from "./stats.js";
export * from "./session.js";
