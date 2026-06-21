/**
 * Repeat-guard predicates (pure, unit-tested).
 *
 * The repeat-SEQUENCE guard trips when a tool-NAME sequence repeats within a
 * turn, IGNORING arguments — so 10 `write_file` calls to 10 DIFFERENT files
 * would wrongly read as a "stalled pattern". But repeating a MUTATION tool with
 * different args is productive work, not a loop. So a sequence made up entirely
 * of exempt tools must NOT trip the sequence guard. The identical-(name,args)
 * loop guard + the storm breaker still catch the real pathology (the same file
 * written with the same content over and over, or the same failing command).
 */

/** Tools where repeating with DIFFERENT args is normal forward progress. */
export const DEFAULT_SEQUENCE_GUARD_EXEMPT: readonly string[] = ['write_file', 'edit_file', 'apply_patch'];

/**
 * True iff EVERY tool in the repeated sequence is exempt — meaning the sequence
 * guard should be SKIPPED for it (repeating these with varied args is work, and
 * the identical-args guard still protects against true loops).
 */
export function isSequenceGuardExempt(names: string[], exempt: ReadonlySet<string>): boolean {
  if (names.length === 0) return false;
  return names.every((n) => exempt.has(n));
}
