/**
 * Quote a single argument for the platform shell that `child_process.exec` uses.
 *
 * HOTFIX (Windows clickable links): the old opener single-quoted args POSIX-style
 * (`'…'`). On Windows that shell is cmd.exe, which does NOT treat single quotes
 * specially — it passes them through literally — so `start "" '<url>'` and
 * `explorer '<path>'` arrived wrapped in literal quotes and never opened (PR/CI
 * links did nothing). cmd uses DOUBLE quotes, so on Windows we wrap in `"…"`.
 *
 * Embedded double-quotes can't be portably escaped for cmd, so they're stripped
 * on Windows; every caller's input is safe to wrap (https URLs are validated
 * quote-free; workspace paths don't contain `"`).
 */
export function shellQuoteArg(s: string, isWin: boolean = process.platform === 'win32'): string {
  return isWin ? `"${s.replace(/"/g, '')}"` : `'${s.replace(/'/g, "'\\''")}'`;
}
