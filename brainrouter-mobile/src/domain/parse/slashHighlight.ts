/**
 * §slash-highlight — pure helper deciding which leading "/command" token in the
 * composer draft should be tinted accent-blue, mirroring Claude's "you're in a
 * command" cue. Lives in lib/ (no React) so the Composer stays thin and this
 * logic is unit-testable in isolation.
 */
import type { DeskCommand } from '../commands/commands.js';

/**
 * Returns the leading "/command" substring to highlight, or null.
 *
 * - While the user is still typing the token (no whitespace yet) it lights up as
 *   soon as the slash popup has a prefix match (`slashActive` + matches).
 * - Once an argument follows (a space), only an EXACT command match keeps it
 *   blue — so "/goal do a comparison" highlights just "/goal", while a non-command
 *   like "/notes to self" stays plain.
 */
export function recognizedCommandToken(
  draft: string,
  slashActive: boolean,
  slashMatches: DeskCommand[],
  commands: DeskCommand[],
): string | null {
  if (!draft.startsWith('/')) return null;
  const token = draft.match(/^\/\S*/)?.[0];
  if (!token) return null;
  if (!/\s/.test(draft)) return slashActive && slashMatches.length ? token : null;
  const base = token.toLowerCase();
  return commands.some((c) => c.base.toLowerCase() === base) ? token : null;
}
