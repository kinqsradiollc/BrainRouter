/**
 * Teams data access for the Meetings Share popover (ADR-018 `team` scope). The
 * renderer never holds the account bearer, so the team list is proxied through
 * the host bridge (`window.brainrouter.teams.list()` → host `teams:list` →
 * backend `GET /api/teams`). Degrades to an empty list when signed out, when the
 * host bridge is absent (dev / sample), or when the caller has no teams.
 */

export interface TeamOption {
  id: string;
  name: string;
}

interface TeamsBridge {
  list(): Promise<unknown>;
}

function bridge(): TeamsBridge | null {
  const w = globalThis as unknown as { brainrouter?: { teams?: TeamsBridge } };
  return w.brainrouter?.teams ?? null;
}

/**
 * Normalize the host bridge's raw `/api/teams` payload into selectable picker
 * rows. Tolerates a non-array payload and missing/non-string fields so the
 * picker shows an empty list rather than throwing. Pure — unit-testable without
 * Electron.
 */
export function toTeamOptions(raw: unknown): TeamOption[] {
  if (!Array.isArray(raw)) return [];
  const out: TeamOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !id) continue;
    const name = (entry as { name?: unknown }).name;
    out.push({ id, name: typeof name === "string" && name.trim() ? name : id });
  }
  return out;
}

/** Fetch the caller's teams for the Share popover picker. Empty array on any
 *  failure (signed out, no host bridge, no teams) so the UI degrades gracefully. */
export async function listTeams(): Promise<TeamOption[]> {
  const b = bridge();
  if (!b) return [];
  try {
    return toTeamOptions(await b.list());
  } catch {
    return [];
  }
}
