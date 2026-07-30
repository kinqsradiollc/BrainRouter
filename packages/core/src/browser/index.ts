/**
 * `@kinqs/brainrouter-core/browser` — the headless web UI-testing engine: a
 * data-testid extractor, the legacy named command layer, the first-class
 * embedded-browser control protocol, and result normalizers. Production agent
 * browsing uses an injected Desktop port; Playwright is explicit test tooling.
 *
 * The barrel grows one phase at a time: P0 the data contracts, P1 the extractor.
 */
export * from './schema.js';
export * from './types.js';

// Layer 2 — the extractor.
export {
  extractFile,
  buildManifest,
  assembleManifest,
  __setForceNoTsForTests,
  type SourceFile,
  type TestIdSite,
  type ExtractFileResult,
  type FileSites,
} from './extractor/extract.js';
export { inferTypeAndAction, type InferInput, type InferResult } from './extractor/infer.js';
export {
  classifyScreen,
  kebab,
  humanize,
  SHARED_SCREEN_ID,
  SHARED_SCREEN_TITLE,
  type ScreenClass,
} from './extractor/screen.js';
export {
  hashContent,
  diffFiles,
  updateCache,
  type CacheState,
  type FileDiff,
} from './extractor/cache.js';
export { diffManifests, type ManifestDiff } from './extractor/diff.js';

// Layer 4/6 — the command layer + result normalizer.
export { CommandLayer, type ElementRef } from './command/commands.js';
export { type Backend, StubBackend, UnavailableBackend } from './command/backend.js';
export * from './control.js';
export {
  normalizeResult,
  errorResult,
  classifyArtifacts,
  emptyArtifacts,
  type NormalizeFallback,
} from './command/normalize.js';
export { runFlow, type Flow, type FlowStep, type RunFlowOptions } from './command/flow.js';
export { parseFlowYaml, serializeFlowYaml, FlowSchema, FlowStepSchema, type ParsedFlow } from './flow/flowSchema.js';
export { parseStoryYaml, serializeStoryYaml, parseStoriesJson, StorySchema, type Story } from './flow/storySchema.js';
export { buildStoryPrompt, validateStories, STORY_TOOL_SCHEMA, type StoryPrompt } from './story/generate.js';

// Per-workspace UI-map session (no implicit browser process).
export {
  getUiTestSession,
  readManifestFromDisk,
  manifestPathFor,
  __resetUiTestSessionsForTests,
  type UiTestSession,
} from './session.js';

// Explicit headless/test adapter only — never selected by the production session.
export { DriverClient, type DriverClientOptions } from './driver/driverClient.js';
export { encodeLine, LineDecoder, type DriverRequest, type DriverReply } from './driver/protocol.js';
export { buildSelector, cssEscapeAttr } from './driver/playwrightDriver.js';
