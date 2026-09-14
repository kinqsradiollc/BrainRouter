/**
 * ADR-049 S1 / D5 / D7 — the Study store: workspace-root files under
 * `<workspaceRoot>/.brainrouter/study/` (the ADR-047 `.brainrouter/` convention).
 * Node fs — main-process side only; the renderer reads/writes through host queries.
 *
 *  - `decks/<id>.json` — deck content, written COMMIT-CLEAN (canonical key order,
 *    two-space indent, trailing newline) so a `git commit` is a stable diff.
 *  - `progress/<user>.json` — one person's scheduling state, keyed per user so
 *    teammates reviewing the same committed deck never collide (recommend
 *    git-ignoring `progress/`).
 */
import fs from "node:fs";
import path from "node:path";
import {
  STUDY_SCHEMA_VERSION,
  isStudyDeck,
  type StudyDeck,
  type StudyProgress,
} from "@kinqs/brainrouter-types";

export function studyDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".brainrouter", "study");
}
export function decksDir(workspaceRoot: string): string {
  return path.join(studyDir(workspaceRoot), "decks");
}
export function progressDir(workspaceRoot: string): string {
  return path.join(studyDir(workspaceRoot), "progress");
}

/** Deck ids and per-user filenames are constrained to a safe slug. */
function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
    || "unnamed";
}

/** Canonical JSON: keys sorted recursively → a byte-stable file for git. */
function stableStringify(value: unknown): string {
  const seen = new WeakSet();
  const canon = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return undefined;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(canon);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = canon((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(canon(value), null, 2) + "\n";
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// --- decks -----------------------------------------------------------------

/** Every deck in the workspace, sorted by name then id. Malformed files skipped. */
export function listStudyDecks(workspaceRoot: string): StudyDeck[] {
  const dir = decksDir(workspaceRoot);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const decks: StudyDeck[] = [];
  for (const name of names) {
    const raw = readJson<unknown>(path.join(dir, name));
    if (isStudyDeck(raw)) decks.push(raw);
  }
  return decks.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** One deck by id, or null when absent/malformed. */
export function readStudyDeck(workspaceRoot: string, id: string): StudyDeck | null {
  const raw = readJson<unknown>(path.join(decksDir(workspaceRoot), `${safeSlug(id)}.json`));
  return isStudyDeck(raw) ? raw : null;
}

/** Persist a deck commit-clean (overwrites the file for its id). */
export function saveStudyDeck(workspaceRoot: string, deck: StudyDeck): void {
  const dir = decksDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const normalized: StudyDeck = { ...deck, schemaVersion: deck.schemaVersion || STUDY_SCHEMA_VERSION };
  fs.writeFileSync(path.join(dir, `${safeSlug(deck.id)}.json`), stableStringify(normalized), "utf8");
}

/** Remove a deck file. Idempotent. */
export function deleteStudyDeck(workspaceRoot: string, id: string): void {
  try {
    fs.unlinkSync(path.join(decksDir(workspaceRoot), `${safeSlug(id)}.json`));
  } catch {
    // already gone
  }
}

// --- progress --------------------------------------------------------------

function emptyProgress(user: string): StudyProgress {
  return {
    schemaVersion: STUDY_SCHEMA_VERSION,
    user,
    schedules: {},
    reviewsByDay: {},
    updatedAt: new Date(0).toISOString(),
  };
}

/** One user's progress, or a fresh empty one when none exists. */
export function readStudyProgress(workspaceRoot: string, user: string): StudyProgress {
  const raw = readJson<StudyProgress>(path.join(progressDir(workspaceRoot), `${safeSlug(user)}.json`));
  if (!raw || typeof raw !== "object" || typeof raw.schedules !== "object") return emptyProgress(user);
  return {
    schemaVersion: raw.schemaVersion || STUDY_SCHEMA_VERSION,
    user,
    schedules: raw.schedules ?? {},
    reviewsByDay: raw.reviewsByDay ?? {},
    updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
  };
}

/** Persist a user's progress (personal — recommend git-ignoring `progress/`). */
export function saveStudyProgress(workspaceRoot: string, progress: StudyProgress): void {
  const dir = progressDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${safeSlug(progress.user)}.json`), stableStringify(progress), "utf8");
}
