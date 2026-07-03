/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 *
 * Thin dispatcher for the UI / status / preference slash commands. The
 * actual `case` bodies live in cohesive sibling modules (byte-identical
 * to the original single switch); this file just tries each in order and
 * returns true as soon as one matches `ctx.command`.
 *
 *   status.ts       /status /workspace /policy /doctor /where
 *   model.ts        /model /effort /tier /profile
 *   preferences.ts  /vim /statusline /theme /title /personality /raw /quiet /experimental /keymap
 *   info.ts         /copy /apps /plugins /mention /ide /help
 */

import type { CommandContext } from '../_context.js';
import { tryHandleUiStatusCommand } from './status.js';
import { tryHandleUiModelCommand } from './model.js';
import { tryHandleUiPreferencesCommand } from './preferences.js';
import { tryHandleUiInfoCommand } from './info.js';

export async function tryHandleUiCommand(ctx: CommandContext): Promise<boolean> {
  return (
    (await tryHandleUiStatusCommand(ctx)) ||
    (await tryHandleUiModelCommand(ctx)) ||
    (await tryHandleUiPreferencesCommand(ctx)) ||
    (await tryHandleUiInfoCommand(ctx))
  );
}
