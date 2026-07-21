/**
 * INPUT-ERGO (0.4.5) — flag suggestions for slash commands in args mode.
 *
 * The slash *command* palette closes once the buffer has a space (you're typing
 * args). This adds a second, smaller palette that fires when the trailing token
 * starts with `-`, suggesting the known flags for the command at the head of
 * the buffer. Pure — the ChatApp wiring just renders the matches and applies a
 * completion.
 *
 * COMMAND_FLAGS is a curated discoverability hint (NOT an exhaustive parser):
 * it lists the flags worth surfacing for the commands that have them. Commands
 * absent here simply show no flag palette. Keep it in sync when a command gains
 * a notable flag — it's intentionally small and hand-maintained.
 */

export interface FlagDef {
  flag: string;
  desc: string;
}

export const COMMAND_FLAGS: Record<string, FlagDef[]> = {
  "/init": [{ flag: "--edit", desc: "review and revise the saved workspace setup" }],
  "/review": [
    { flag: "--fix", desc: "apply surviving fixes in place + re-verify" },
    { flag: "--force", desc: "re-run even if the workflow looks complete" },
  ],
  "/review-auto": [
    { flag: "--threshold", desc: "confidence cutoff 0-100 (default 80)" },
    { flag: "--scope", desc: "limit to a glob/path" },
  ],
  "/simplify": [
    { flag: "--dry-run", desc: "propose only — write no edits" },
    { flag: "--plan", desc: "alias for --dry-run" },
  ],
  "/feature-dev": [{ flag: "--force", desc: "(accepted, ignored) start fresh" }],
  "/spec": [{ flag: "--force", desc: "(accepted, ignored)" }],
  "/grill-me": [{ flag: "--force", desc: "clarify again even if a spec exists" }],
  "/agents": [
    { flag: "--display", desc: "display name (create)" },
    { flag: "--when", desc: "whenToUse description (create)" },
    { flag: "--prompt", desc: "system-prompt overlay (create)" },
    { flag: "--access", desc: "read | write | shell (create)" },
    { flag: "--tools", desc: "local tools CSV (create)" },
    { flag: "--mcp", desc: "MCP tools CSV (create)" },
    { flag: "--ownership", desc: "default ownership glob (create)" },
    { flag: "--dry-run", desc: "preview the definition, write nothing (create)" },
    { flag: "--force", desc: "overwrite an existing definition (create)" },
    { flag: "--remote", desc: "list peers on the same brain" },
    { flag: "--json", desc: "raw JSON output" },
  ],
  "/skills": [{ flag: "--verbose", desc: "include descriptions" }],
  "/tools": [{ flag: "--verbose", desc: "include descriptions" }],
};

export interface FlagSuggestion {
  /** The matched command (head token), e.g. "/review". */
  command: string;
  /** The trailing partial flag token, e.g. "--fi" (may be just "-" or "--"). */
  token: string;
  /** Flags matching the token and not already present earlier in the buffer. */
  matches: FlagDef[];
}

/**
 * Inspect a composer buffer and, when the user is typing a flag in args mode,
 * return the command + partial token + matching flag suggestions. Returns null
 * when no flag palette should show (not a slash command, no args yet, the
 * trailing token isn't a flag, or the command has no known flags).
 */
export function flagSuggestions(buffer: string): FlagSuggestion | null {
  if (!buffer.startsWith("/")) return null;
  // Must be in args mode (at least one space) and NOT end with a space — a
  // trailing space means the previous token is finished, so there's no partial
  // flag to complete yet.
  if (!buffer.includes(" ") || /\s$/.test(buffer)) return null;
  const tokens = buffer.split(/\s+/);
  const command = tokens[0];
  const token = tokens[tokens.length - 1];
  if (!token.startsWith("-")) return null;
  const flags = COMMAND_FLAGS[command];
  if (!flags || flags.length === 0) return null;
  // Flags already used earlier in the buffer (exclude from suggestions so we
  // don't re-offer them). The partial trailing token is not "used" yet.
  const used = new Set(tokens.slice(1, -1).filter((t) => t.startsWith("-")));
  const lower = token.toLowerCase();
  const matches = flags.filter((f) => !used.has(f.flag) && f.flag.toLowerCase().startsWith(lower));
  if (matches.length === 0) return null;
  return { command, token, matches };
}

/**
 * Replace the trailing partial flag token with `flag`. Flags that take a value
 * (no leading `--` toggle convention here — we just always add a trailing space
 * so the user can type the value or the next token). Returns the new buffer.
 */
export function applyFlagCompletion(buffer: string, flag: string): string {
  // Rebuild from tokens (keeping separators), replacing the last non-empty
  // token with the chosen flag, then add a trailing space so the user can type
  // a value or the next token.
  const tokens = buffer.split(/(\s+)/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].trim() !== "") {
      tokens[i] = flag;
      break;
    }
  }
  return tokens.join("") + " ";
}
