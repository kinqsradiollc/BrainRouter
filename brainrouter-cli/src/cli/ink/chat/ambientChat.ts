import type { ReactElement } from 'react';

/**
 * Process-wide reference to the chat REPL's ChatController, set when
 * `runChat` mounts and cleared when it unmounts. Lets `runPicker` /
 * `runTextField` detect "I'm being called from inside the Ink chat
 * REPL" and route their UI through the chat's overlay slot instead of
 * mounting a SECOND Ink instance on the same stdin.
 *
 * Why a module-level ref rather than React context: the call site is
 * `cli/commands/config.ts` -> `runHomePanel(ctx)` -> `runPicker(opts)`,
 * which is a plain async function chain — there's no React tree at the
 * dispatch entry. The ChatController lives inside the chat React tree
 * but the slash-command dispatcher is outside it. A module-level
 * ambient binding bridges the two without forcing every dispatcher to
 * thread a controller argument through every command handler.
 *
 * Mutual exclusion: only ONE chat instance should ever be mounted at a
 * time, so a single global is sufficient. setAmbientChat(undefined)
 * MUST be called on unmount, otherwise a later standalone runPicker
 * call would try to render into a dead controller.
 */

export interface AmbientChatController {
  /**
   * Render `node` as an overlay above the chat composer. The promise
   * resolves when `clearOverlay()` is called. Callers typically wire
   * `<Picker onResolve={...}>` to a callback that resolves the outer
   * promise and immediately calls clearOverlay().
   */
  showOverlay(node: ReactElement): Promise<void>;
  /** Remove whatever overlay is currently shown; safe to call when none is set. */
  clearOverlay(): void;
}

let ambient: AmbientChatController | undefined;

export function setAmbientChat(controller: AmbientChatController | undefined): void {
  ambient = controller;
}

export function getAmbientChat(): AmbientChatController | undefined {
  return ambient;
}
