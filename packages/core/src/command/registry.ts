/**
 * CMD-REGISTRY (0.4.5) — one source of truth for the slash-command surface.
 *
 * Two lists describe commands: `SLASH_COMMANDS` (the flat name list driving
 * tab-completion + the inline palette) and `HELP_CATEGORIES` (the categorized
 * `/help` entries with descriptions). They are easy to drift — a command added
 * to one but not the other shows up in completion-without-help or
 * help-without-completion. These pure helpers let a test detect duplicate rows
 * and cross-list drift so the two stay in lockstep.
 */

export interface HelpEntryLike { cmd: string; desc: string }
export interface HelpCategoryLike { entries: HelpEntryLike[] }

/** Pull the slash-command tokens out of a help entry's `cmd` string. One entry
 *  may list several (e.g. "/side <q>  /btw <q>"); non-slash entries (e.g.
 *  "! <command>") contribute none. Arg hints like "[key]" are dropped. */
export function helpEntryTokens(cmd: string): string[] {
  return cmd
    .split(/\s+/)
    .filter((t) => t.startsWith("/"))
    .map((t) => t.trim())
    .filter(Boolean);
}

/** All slash-command tokens documented across the help categories. A command
 *  with documented subcommands (e.g. "/brain run", "/agents tree") legitimately
 *  contributes its primary token several times — dedupe with a Set when you
 *  want the unique command surface (see {@link helpPrimaryCommands}). */
export function helpCommandTokens(categories: HelpCategoryLike[]): string[] {
  const out: string[] = [];
  for (const cat of categories) {
    for (const entry of cat.entries) out.push(...helpEntryTokens(entry.cmd));
  }
  return out;
}

/** The unique set of primary commands documented in /help. */
export function helpPrimaryCommands(categories: HelpCategoryLike[]): string[] {
  return [...new Set(helpCommandTokens(categories))].sort();
}

/** The full `cmd` strings of every help row — to detect truly identical rows
 *  (the same command+args documented twice), as opposed to legit subcommands. */
export function helpEntryRows(categories: HelpCategoryLike[]): string[] {
  const out: string[] = [];
  for (const cat of categories) for (const entry of cat.entries) out.push(entry.cmd);
  return out;
}

/** Names appearing more than once in a list (case-sensitive, order-stable). */
export function findDuplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
  }
  return [...dupes];
}

export interface RegistryDrift {
  /** Documented in /help but missing from the completion list. */
  inHelpNotSlash: string[];
  /** In the completion list but undocumented in /help. */
  inSlashNotHelp: string[];
}

/** Compare the completion list against the documented help tokens. */
export function registryDrift(slashCommands: readonly string[], helpTokens: readonly string[]): RegistryDrift {
  const slash = new Set(slashCommands);
  const help = new Set(helpTokens);
  return {
    inHelpNotSlash: [...help].filter((c) => !slash.has(c)).sort(),
    inSlashNotHelp: [...slash].filter((c) => !help.has(c)).sort(),
  };
}
