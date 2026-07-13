/**
 * The data contracts for the UI-testing system — Layer 3 (the UI manifest) and
 * Layer 6 (the normalized command result), expressed as Zod schemas so every
 * manifest write and every driver reply is validated at the boundary (house
 * style — see brainrouter/src/api/middleware/validate.ts). Derived TS types live
 * in `types.ts` via `z.infer`.
 *
 * Schemas are kept to the v3/v4-common Zod surface (object/string/array/enum/
 * union/literal/optional/nullable/parse/safeParse) so they resolve cleanly
 * against whichever Zod the host realm hoists.
 */
import { z } from 'zod';

/** What kind of control an element is — drives the panel icon + default action. */
export const ElementTypeSchema = z.enum(['button', 'input', 'link', 'select', 'element']);

/** The per-element default action the extractor infers. */
export const ElementActionSchema = z.enum(['tap', 'type', 'assertVisible', 'navigate']);

/** The source construct an element is defined in — drives the panel's kind icon.
 *  component = Capitalized fn/arrow (React), function = lowercase fn/arrow,
 *  class = class declaration, feature = no enclosing named symbol (top-level). */
export const SymbolKindSchema = z.enum(['component', 'function', 'class', 'feature']);

/** A single interactive element, derived from one `data-testid` site in source. */
export const ElementSchema = z.object({
  /** Stable, human-readable reference — equals `testID` in v1. */
  id: z.string(),
  testID: z.string(),
  type: ElementTypeSchema,
  action: ElementActionSchema,
  /** Optional human label (e.g. button text) for the panel + agent. */
  label: z.string().optional(),
  /** Provenance — the source file + line the testID was found at. */
  filePath: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  /** The kind of source symbol the element is defined in (component/function/class/feature). */
  kind: SymbolKindSchema.optional(),
  /** Name of the enclosing component/function/class, when known. */
  component: z.string().optional(),
});

/** A screen = one route/source file's worth of elements (screen inference v1). */
export const ScreenSchema = z.object({
  id: z.string(),
  title: z.string(),
  platform: z.enum(['web', 'native', 'both']).default('web'),
  /** Inferred route (e.g. `/login`) or null when unknown. */
  route: z.string().nullable().optional(),
  filePath: z.string().optional(),
  elements: z.array(ElementSchema),
});

/** The generated UI manifest (`ui-map.json`). Generated only — never hand-edited. */
export const UiMapSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  /** True when the optional `typescript` peer was unavailable (no AST walk). */
  degraded: z.boolean().optional(),
  screens: z.array(ScreenSchema),
});

/** A device/viewport preset (web = viewport size). */
export const DeviceSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().optional(),
  isMobile: z.boolean().optional(),
});

/**
 * Layer 4 command surface — one discriminated union both consumers (panel +
 * agent) speak, and the stdio protocol the driver reads. `screen` is an optional
 * hint so the backend can navigate-then-act to guarantee the element is mounted.
 */
export const CommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), screen: z.string().optional(), url: z.string().optional() }),
  z.object({ kind: z.literal('tap'), testID: z.string(), screen: z.string().optional() }),
  z.object({ kind: z.literal('type'), testID: z.string(), text: z.string(), screen: z.string().optional() }),
  z.object({ kind: z.literal('assertVisible'), testID: z.string(), screen: z.string().optional() }),
  z.object({ kind: z.literal('setDevice'), device: DeviceSchema }),
  z.object({ kind: z.literal('shutdown') }),
]);

/** Artifacts produced by a run, bucketed by kind (mirrors browserVerify). */
export const ArtifactsSchema = z.object({
  screenshots: z.array(z.string()),
  videos: z.array(z.string()),
  logs: z.array(z.string()),
  other: z.array(z.string()),
});

/**
 * Layer 6 — the single normalized result shape every command returns, whether
 * it ran on the real Playwright backend or a stub. `a11y` is an opaque
 * pass-through tree (Playwright's accessibility snapshot) fed to the agent;
 * `screenshot` is a path, never inline bytes.
 */
export const UiCommandResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['ok', 'fail', 'error']),
  /** The command kind that ran, e.g. `tap`. */
  command: z.string(),
  testID: z.string().optional(),
  screen: z.string().optional(),
  /** Optional payload — e.g. the text typed, or an asserted value. */
  value: z.unknown().optional(),
  durationMs: z.number().nonnegative(),
  /** Filesystem path to a screenshot PNG (not inlined into agent context). */
  screenshot: z.string().optional(),
  /** Opaque accessibility tree for the agent. */
  a11y: z.unknown().optional(),
  error: z.string().nullable().optional(),
  artifacts: ArtifactsSchema.optional(),
});
