/**
 * `@kinqs/brainrouter-ui-test` — the headless web UI-testing engine: a
 * data-testid extractor (Layer 2), a named command layer (Layer 4), a headed
 * Playwright driver (Layer 5a), and the result normalizer (Layer 6). Consumed by
 * the Desktop "UI Tests" panel and, via a built-in extension, by the agent.
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
export { type Backend, StubBackend } from './command/backend.js';
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

// The shared per-workspace session (one browser, two consumers).
export {
  getUiTestSession,
  readManifestFromDisk,
  manifestPathFor,
  __resetUiTestSessionsForTests,
  type UiTestSession,
} from './session.js';

// Layer 5a — the headed Playwright driver client + protocol.
export { DriverClient, type DriverClientOptions } from './driver/driverClient.js';
export { encodeLine, LineDecoder, type DriverRequest, type DriverReply } from './driver/protocol.js';
export { buildSelector, cssEscapeAttr } from './driver/playwrightDriver.js';
