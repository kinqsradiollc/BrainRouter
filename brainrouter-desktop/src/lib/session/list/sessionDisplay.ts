/**
 * Sidebar clarity (item 9) — when several sessions share the same opening
 * prompt, their rows look like duplicates. This returns the set of sessionKeys
 * whose title collides with another in the same list, so the row can append a
 * distinguisher (its age) and identical prompts stay tellable apart. Pure +
 * unit-tested.
 */
export function duplicateTitleKeys(
  sessions: Array<{ sessionKey: string; firstUserMessage?: string }>,
): Set<string> {
  const baseOf = (s: { sessionKey: string; firstUserMessage?: string }) =>
    (s.firstUserMessage || s.sessionKey).trim();
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(baseOf(s), (counts.get(baseOf(s)) ?? 0) + 1);
  const dupes = new Set<string>();
  for (const s of sessions) if ((counts.get(baseOf(s)) ?? 0) > 1) dupes.add(s.sessionKey);
  return dupes;
}
