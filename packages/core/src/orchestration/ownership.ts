/**
 * MAS-P3 (0.4.1) — ownership boundaries for spawned agents.
 *
 * When a parent fans out write-capable children in parallel, each child
 * must declare an `ownership` glob (e.g. `src/payments/**`) so two
 * children can't clobber the same files. Two enforcement points:
 *
 *   1. Spawn time — `ownershipRequirementError` rejects a write/shell
 *      child that declared no ownership (unless `allowOverlap`).
 *   2. Write time — `ownershipWriteViolation` refuses a file write that
 *      falls outside the child's declared glob.
 *
 * Self-contained (own glob matcher, no deps) so it unit-tests cleanly
 * and avoids an import cycle with the large `agent.ts`.
 */

import path from "node:path";
import fs from "node:fs";

const WRITE_ACCESS = new Set(["write", "shell"]);

/** Compile an ownership glob to an anchored RegExp over POSIX-relative paths. */
function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/").trim();
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` — zero or more leading segments
        } else {
          re += ".*"; // `**` — across segment boundaries
        }
      } else {
        re += "[^/]*"; // `*` — within a single segment
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when `relPath` (workspace-relative, POSIX) falls within `ownership`. */
export function pathWithinOwnership(ownership: string, relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(ownership).test(norm);
}

/**
 * Spawn-time check. Returns an error message when a write/shell child
 * declared no ownership and didn't opt out via `allowOverlap`; null when
 * the entry is allowed.
 */
export function ownershipRequirementError(
  access: string,
  ownership: string | null | undefined,
  allowOverlap: boolean | undefined,
): string | null {
  if (allowOverlap) return null;
  if (WRITE_ACCESS.has(access) && !(typeof ownership === "string" && ownership.trim())) {
    return (
      `A spawned agent with access "${access}" must declare an "ownership" glob ` +
      `(e.g. "src/feature/**") so parallel writers don't collide. ` +
      `Add "ownership" to the agent entry, or pass "allowOverlap": true to opt out.`
    );
  }
  return null;
}

/**
 * Write-time check. Returns a structured error message when a write to
 * `targetAbsPath` falls outside the agent's `ownership` glob; null when
 * the write is allowed (or no ownership is set).
 */
export function ownershipWriteViolation(
  ownership: string | null | undefined,
  workspaceRoot: string,
  targetAbsPath: string,
): string | null {
  if (!(typeof ownership === "string" && ownership.trim())) return null;
  // `resolveWorkspacePath` realpath-resolves the root before resolving the
  // target, so the target path is symlink-canonical (on macOS /tmp →
  // /private/tmp). Canonicalise the root the same way or `path.relative`
  // produces a spurious `../../` and every write looks out-of-bounds.
  let root = workspaceRoot;
  try {
    root = fs.realpathSync(workspaceRoot);
  } catch {
    /* root doesn't exist yet — fall back to the literal path */
  }
  const rel = path.relative(root, targetAbsPath).replace(/\\/g, "/");
  if (pathWithinOwnership(ownership, rel)) return null;
  return (
    `Write to "${rel}" is outside this agent's ownership boundary "${ownership}". ` +
    `A spawned agent may only modify files within its declared ownership glob. ` +
    `If this is intentional, re-spawn with "allowOverlap": true.`
  );
}
