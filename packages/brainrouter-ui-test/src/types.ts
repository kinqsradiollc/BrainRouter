/**
 * The shared contract types — inferred from the Zod schemas in `schema.ts` so
 * the validated runtime shapes and the compile-time types can never drift.
 */
import type { z } from 'zod';
import type {
  ElementTypeSchema,
  ElementActionSchema,
  SymbolKindSchema,
  ElementSchema,
  ScreenSchema,
  UiMapSchema,
  DeviceSchema,
  CommandSchema,
  ArtifactsSchema,
  UiCommandResultSchema,
} from './schema.js';

export type ElementType = z.infer<typeof ElementTypeSchema>;
export type ElementAction = z.infer<typeof ElementActionSchema>;
export type SymbolKind = z.infer<typeof SymbolKindSchema>;
export type UiElement = z.infer<typeof ElementSchema>;
export type Screen = z.infer<typeof ScreenSchema>;
export type UiMap = z.infer<typeof UiMapSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type Artifacts = z.infer<typeof ArtifactsSchema>;
export type UiCommandResult = z.infer<typeof UiCommandResultSchema>;

/** A compact screen summary for the agent's `ui_list_screens` query helper. */
export interface ScreenSummary {
  id: string;
  title: string;
  route?: string | null;
  elementCount: number;
}
