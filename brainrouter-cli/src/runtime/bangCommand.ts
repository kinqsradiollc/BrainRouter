/**
 * PARITY-B1 — parse a composer line for the `!` shell-escape prefix.
 *
 * `! <command>` runs a shell command directly from the prompt, mirroring
 * Claude Code's bang prefix. Kept pure (no I/O) so the detection + extraction
 * is unit-testable without standing up the Ink REPL.
 *
 *   - Non-`!` input            → { isBang: false }            (fall through to slash/chat)
 *   - bare `!` / `!` + spaces  → { isBang: true, command: '' } (caller shows usage)
 *   - `!  git status `         → { isBang: true, command: 'git status' }
 */
export function parseBangCommand(text: string): { isBang: boolean; command: string } {
  if (!text.startsWith('!')) return { isBang: false, command: '' };
  return { isBang: true, command: text.slice(1).trim() };
}
