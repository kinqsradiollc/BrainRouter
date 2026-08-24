// ADR-041 A41-7 — the CLI slash-command dispatch registry.
//
// The builtin category handlers used to be a hand-written chain of ~25
// `if (await tryHandleXCommand(ctx)) return;` lines in repl.ts. This module makes
// that chain DATA: an ordered array walked first-match-wins. Registering a new
// command category is now a one-line array insertion, not a new if-branch — the
// same "adding is data, not code" property D8/A41-7 give the other dispatchers.
//
// ORDER IS LOAD-BEARING and preserved exactly from the former chain: the 0.3.7
// init/config/login dispatchers run FIRST so they shadow the legacy /init + /config
// fallbacks that still ship inside ui.ts. Do not reorder without understanding that
// shadowing.
import type { CommandContext } from './_context.js';
import { tryHandleMemoryCommand } from './memory/index.js';
import { tryHandleLearningCommand } from './learning/index.js';
import { tryHandleUiCommand } from './ui/index.js';
import { tryHandleWorkflowCommand } from './workflow/index.js';
import { tryHandleObsCommand } from './obs/index.js';
import { tryHandleBrainCommand } from './brain/index.js';
import { tryHandleOrchestrationCommand } from './orchestration/index.js';
import { tryHandleSessionCommand } from './session/index.js';
import { tryHandleGuardCommand } from './guard/index.js';
import { tryHandleExtensionCommand } from './extension/index.js';
import { tryHandleMcpCommand } from './mcp/index.js';
import { tryHandleInitCommand } from './init/index.js';
import { tryHandleConfigCommand } from './config/index.js';
import { tryHandleLoginCommand } from './login/index.js';
import { tryHandleScheduleCommand } from './schedule/index.js';
import { tryHandleReleaseNotesCommand } from './releaseNotes/index.js';
import { tryHandleRequirementCommand } from './requirement/index.js';
import { tryHandleTrackCommand } from './track/index.js';
import { tryHandleAnnotationCommand } from './annotation/index.js';
import { tryHandleArtifactCommand } from './artifact/index.js';
import { tryHandlePlannerCommand } from './planner/index.js';
import { tryHandleRunsCommand } from './runs/index.js';
import { tryHandleAtlasCommand } from './atlas/index.js';
import { tryHandleAttachmentCommand } from './attachment/index.js';
import { tryHandleReviewsCommand } from './reviews/index.js';
import { tryHandleTrajectoryCommand } from './trajectory/index.js';
import { tryHandleInspectCommand } from './inspect/index.js';
import { tryHandlePlaybookCommand } from './playbook/index.js';

/** A category handler: returns true iff it recognized and handled the command. */
export type CommandHandler = (ctx: CommandContext) => Promise<boolean>;

/**
 * The ordered builtin slash-command handlers, walked first-match-wins. Verbatim
 * order from the former repl.ts chain — see the shadowing note above before moving
 * init/config/login off the front.
 */
export const BUILTIN_COMMAND_HANDLERS: readonly CommandHandler[] = [
  tryHandleInitCommand,
  tryHandleConfigCommand,
  tryHandleLoginCommand,
  tryHandleMemoryCommand,
  tryHandleLearningCommand,
  tryHandleUiCommand,
  tryHandleWorkflowCommand,
  tryHandleRequirementCommand,
  tryHandleTrackCommand,
  tryHandleAnnotationCommand,
  tryHandleArtifactCommand,
  tryHandlePlannerCommand,
  tryHandleRunsCommand,
  tryHandleAtlasCommand,
  tryHandleAttachmentCommand,
  tryHandleReviewsCommand,
  tryHandleTrajectoryCommand,
  tryHandleScheduleCommand,
  tryHandlePlaybookCommand,
  tryHandleInspectCommand,
  tryHandleReleaseNotesCommand,
  tryHandleObsCommand,
  tryHandleBrainCommand,
  tryHandleOrchestrationCommand,
  tryHandleSessionCommand,
  tryHandleGuardCommand,
  tryHandleExtensionCommand,
  tryHandleMcpCommand,
];

/**
 * Walk the builtin handlers first-match-wins. Returns true iff one handled the
 * command (byte-identical to the former `if (await tryHandleX) return;` chain).
 */
export async function dispatchBuiltinCommand(ctx: CommandContext): Promise<boolean> {
  for (const handle of BUILTIN_COMMAND_HANDLERS) {
    if (await handle(ctx)) return true;
  }
  return false;
}
