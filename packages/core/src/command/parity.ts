/**
 * CMD-PARITY (T16) — a single, runtime-callable check that the command catalog
 * is internally consistent: the tab-completion list (`SLASH_COMMANDS`) and the
 * documented `/help` rows (`HELP_CATEGORIES`) name the same commands, with no
 * duplicates. Both heads (CLI + desktop) serve the SAME catalog, so a desktop
 * golden test can assert `valid === true` to catch drift the moment a command
 * is added to one list but not the other.
 *
 * Pure — composes the existing registry helpers. The desktop host appends the
 * result to its `commands-catalog` query so drift is observable at runtime, not
 * only in tests.
 */
import {
  helpPrimaryCommands,
  helpEntryRows,
  registryDrift,
  findDuplicates,
  type HelpCategoryLike,
} from './registry.js';

export interface CatalogParityResult {
  valid: boolean;
  errors: string[];
}

export function validateCatalogParity(
  slashCommands: readonly string[],
  helpCategories: HelpCategoryLike[],
): CatalogParityResult {
  const errors: string[] = [];

  const dupSlash = findDuplicates(slashCommands);
  if (dupSlash.length) errors.push(`Duplicate entries in SLASH_COMMANDS: ${dupSlash.join(', ')}`);

  const dupHelp = findDuplicates(helpEntryRows(helpCategories));
  if (dupHelp.length) errors.push(`Identical /help rows documented twice: ${dupHelp.join(', ')}`);

  const drift = registryDrift(slashCommands, helpPrimaryCommands(helpCategories));
  if (drift.inHelpNotSlash.length) errors.push(`Documented in /help but missing from tab-completion: ${drift.inHelpNotSlash.join(', ')}`);
  if (drift.inSlashNotHelp.length) errors.push(`In tab-completion but undocumented in /help: ${drift.inSlashNotHelp.join(', ')}`);

  return { valid: errors.length === 0, errors };
}
