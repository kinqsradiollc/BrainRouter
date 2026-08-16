/**
 * ADR-029 E1 — `/` opens the menu, and what picking from it does.
 *
 * E1 puts the slash menu and the input rules ahead of every new block kind, on
 * the argument that a kind reachable only through a dropdown is a kind nobody
 * uses. The dropdown already existed; this file is the half that makes the
 * keyboard reach the same list.
 *
 * **The list itself is not here.** It comes from core's catalog through the
 * host's `notes-slash-menu`, ranked there, so the desktop, the dashboard and the
 * CLI offer the same commands in the same order (Q5). What is decided here is
 * the part the catalog cannot know: when a `/` someone typed is a command and
 * when it is a slash in a sentence, and what a picked command does to the block
 * it was typed in.
 */
import { holdsProse, type NoteBlockKind } from '@kinqs/brainrouter-core/notes/editing';

// The wrap rule is quick find's, imported rather than respelled: two keyboard
// menus in one mode that wrapped differently at the ends would be a difference
// nobody could explain and everybody would notice.
export { moveQuickFindSelection as moveMenuSelection } from './quickFind.js';

/** One row of `notes-slash-menu`, which is core's `SlashCommand` over the wire. */
export interface SlashCommandDto {
  id: string;
  label: string;
  kind: string;
  level?: number;
  aliases?: readonly string[];
  group?: string;
  hint: string;
  marker?: string;
}

export interface SlashTrigger {
  /** Where the `/` is. */
  at: number;
  /** What has been typed after it, which filters the menu. */
  query: string;
}

/**
 * A query stops being one at some length.
 *
 * Long enough for every command's name, short enough that a URL someone pasted
 * does not leave a menu open over the rest of their sentence.
 */
export const MAX_SLASH_QUERY = 24;

/**
 * Is the caret in a slash command?
 *
 * The `/` must start the block or follow a space — otherwise `and/or`, a date
 * like `4/8`, and every file path anyone pastes would open a command menu in the
 * middle of a sentence. A space after the `/` ends it, because a command's name
 * has no spaces and the person has clearly moved on.
 */
export function slashTrigger(text: string, caret: number): SlashTrigger | null {
  if (typeof text !== 'string') return null;
  const at = Math.min(Math.max(Math.trunc(caret), 0), text.length);
  const before = text.slice(0, at);
  const slash = before.lastIndexOf('/');
  if (slash < 0) return null;
  const preceding = slash === 0 ? '' : text[slash - 1]!;
  if (slash > 0 && !/\s/.test(preceding)) return null;

  const query = before.slice(slash + 1);
  if (query.length > MAX_SLASH_QUERY) return null;
  if (/[\s/]/.test(query)) return null;
  return { at: slash, query };
}

/**
 * The `/` and its query taken back out.
 *
 * Escape does NOT call this: closing the menu leaves the `/` as the literal
 * text someone typed, because they may have been typing a fraction. Only a pick
 * consumes the marker.
 */
export function clearSlashTrigger(text: string, trigger: SlashTrigger): { text: string; caret: number } {
  const after = trigger.at + 1 + trigger.query.length;
  return { text: text.slice(0, trigger.at) + text.slice(after), caret: trigger.at };
}

export type SlashPlan =
  /** This block becomes the thing — the line keeps whatever else was on it. */
  | { action: 'set-kind'; kind: string; level?: number }
  /** A new block after this one, because this one's text would be destroyed. */
  | { action: 'create-after'; kind: string; level?: number }
  /** A sub-page, which is created and opened rather than typed into here (B4). */
  | { action: 'create-page' };

/**
 * What picking this command does.
 *
 * A prose kind converts the block, because that is what the person means by
 * turning a line into a heading — the words stay. A kind with no prose (a
 * divider, an image, a table) converts an EMPTY line and otherwise arrives as a
 * new block: converting a written line into a divider would delete the sentence
 * the command was typed at the end of.
 */
export function slashPlan(command: SlashCommandDto, remainingText: string): SlashPlan {
  if (command.kind === 'page') return { action: 'create-page' };
  const level = command.level === undefined ? {} : { level: command.level };
  if (holdsProse(command.kind as NoteBlockKind)) return { action: 'set-kind', kind: command.kind, ...level };
  if (remainingText.trim().length === 0) return { action: 'set-kind', kind: command.kind, ...level };
  return { action: 'create-after', kind: command.kind, ...level };
}
