/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 *
 * Behavior-preserving breakdown (god-file campaign): the original single
 * `switch` over UI slash commands now lives in cohesive per-domain
 * handlers under ./ui/. This file stays the public entrypoint —
 * `tryHandleUiCommand` — and dispatches to each handler in the original
 * case order. Each handler returns true iff it matched `ctx.command`;
 * because commands are mutually exclusive the order is a no-op for
 * correctness and the original fall-through `return false` is preserved.
 */

import type { CommandContext } from './_context.js';
import { tryHandleUiStatusCommand } from './ui/status.js';
import { tryHandleUiModelCommand } from './ui/model.js';
import { tryHandleUiPreferencesCommand } from './ui/preferences.js';
import { tryHandleUiInfoCommand } from './ui/info.js';

export async function tryHandleUiCommand(ctx: CommandContext): Promise<boolean> {
  if (await tryHandleUiStatusCommand(ctx)) return true;
  if (await tryHandleUiModelCommand(ctx)) return true;
  if (await tryHandleUiPreferencesCommand(ctx)) return true;
  if (await tryHandleUiInfoCommand(ctx)) return true;
  return false;
}
