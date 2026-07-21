import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../util/fs/atomicFile.js';
import {
  openWorkspaceFileParentGuard,
  type WorkspaceFileParentGuard,
} from '../workspace/fileWrite.js';

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * User-global brainrouter home. Defaults to `~/.brainrouter`. Override with
 * the `BRAINROUTER_HOME` env var — tests set this to keep their state out of
 * the real user home.
 */
export function getBrainrouterHome(): string {
  const override = process.env.BRAINROUTER_HOME?.trim();
  const target = override ?? path.join(os.homedir(), '.brainrouter');
  fs.mkdirSync(target, { recursive: true });
  // Resolve symlinks (eg. macOS /tmp → /private/tmp) so callers comparing
  // against `realpathSync(workspaceRoot)` see the same root.
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Per-workspace state root inside the global home. Encodes the absolute
 * workspace path with a readable prefix + short hash so two workspaces with
 * the same basename never collide.
 *
 *   ~/.brainrouter/workspaces/BrainRouter-3a7f9c12/
 */
export function getWorkspaceStateRoot(workspaceRoot: string): string {
  const abs = fs.realpathSync(workspaceRoot);
  const home = getBrainrouterHome();
  const encoded = encodeWorkspacePath(abs);
  const dir = path.join(home, 'workspaces', encoded);
  fs.mkdirSync(dir, { recursive: true });
  // Migration check fires here (idempotent) so hooks/ and memories/ get
  // moved over even if the caller never goes through getStateDir.
  migrateLegacyWorkspaceState(workspaceRoot, dir);
  return dir;
}

function encodeWorkspacePath(absWorkspaceRoot: string): string {
  const base = path.basename(absWorkspaceRoot).replace(/[^A-Za-z0-9._-]+/g, '_') || 'root';
  const hash = crypto.createHash('sha1').update(absWorkspaceRoot).digest('hex').slice(0, 8);
  return `${base.slice(0, 60)}-${hash}`;
}

/**
 * CLI state directory for a workspace. Defaults to
 *   ~/.brainrouter/workspaces/<encoded>/cli
 * Older builds wrote to <workspaceRoot>/.brainrouter/cli — `getWorkspaceStateRoot`
 * handles the one-time migration so transcripts/goals/plans/hooks/memories
 * follow the user instead of cluttering the project.
 */
export function getStateDir(workspaceRoot: string): string {
  const wsRoot = getWorkspaceStateRoot(workspaceRoot);
  const stateDir = path.join(wsRoot, 'cli');
  if (!isPathInside(wsRoot, stateDir)) {
    throw new Error('CLI state directory escapes workspace state root.');
  }
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

const migrationAttempted = new Set<string>();
const LEGACY_PERSONAL_STATE_ROOTS = new Set(['cli', 'hooks', 'memories']);

/** Test seam for exercising a second-process migration against one workspace. */
export function _resetLegacyWorkspaceMigrationForTests(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) migrationAttempted.clear();
  else migrationAttempted.delete(workspaceRoot);
}

function migrateLegacyWorkspaceState(workspaceRoot: string, newRoot: string): void {
  if (migrationAttempted.has(workspaceRoot)) return;
  migrationAttempted.add(workspaceRoot);
  try {
    const abs = fs.realpathSync(workspaceRoot);
    const legacyRoot = path.join(abs, '.brainrouter');
    if (!fs.existsSync(legacyRoot)) {
      // A crash can remove the final cleanup tombstone immediately before it
      // removes the trusted receipt (and the now-empty legacy root). Retire
      // cleanup-ready receipts even when no workspace-local directory remains.
      for (const sub of LEGACY_PERSONAL_STATE_ROOTS) {
        recoverInterruptedLegacyMigration(
          path.join(legacyRoot, sub),
          path.join(newRoot, sub),
        );
      }
      return;
    }
    const legacyRootStat = fs.lstatSync(legacyRoot);
    if (legacyRootStat.isSymbolicLink() || !legacyRootStat.isDirectory()) {
      process.stderr.write(`brainrouter: legacy-state migration skipped (unsafe workspace-local .brainrouter path)\n`);
      return;
    }
    // A custom BRAINROUTER_HOME may be placed inside the historical tree (or
    // vice versa). Never recurse from a source into its own destination: that
    // would repeatedly copy the newly-created `workspaces/` subtree into
    // itself. Resolve both existing directories so symlink aliases cannot hide
    // the overlap.
    const resolvedLegacyRoot = fs.realpathSync(legacyRoot);
    const resolvedNewRoot = fs.realpathSync(newRoot);
    if (isPathInside(resolvedLegacyRoot, resolvedNewRoot) ||
        isPathInside(resolvedNewRoot, resolvedLegacyRoot)) {
      process.stderr.write('brainrouter: legacy-state migration skipped (source and destination overlap)\n');
      return;
    }
    // Only three historical roots are personal state. Everything else is
    // project-owned and preserved by default, including artifact kinds added by
    // newer releases that this older migrator does not know about yet.
    const markerFile = path.join(newRoot, '.migrated-from-workspace');
    const markerStat = lstatIfPresent(markerFile);
    if (markerStat && (markerStat.isSymbolicLink() || !markerStat.isFile())) {
      process.stderr.write('brainrouter: legacy-state migration skipped (unsafe migration marker)\n');
      return;
    }
    let migrationComplete = true;
    let removedAny = false;
    for (const sub of LEGACY_PERSONAL_STATE_ROOTS) {
      const outcome = rescueLegacyPersonalStateRoot(
        path.join(legacyRoot, sub),
        path.join(newRoot, sub),
      );
      if (outcome === 'preserved') migrationComplete = false;
      if (outcome === 'removed') removedAny = true;
    }
    if (migrationComplete && !markerStat) {
      writeFileAtomic(
        markerFile,
        `Migrated from ${legacyRoot} at ${new Date().toISOString()}\n`,
        { mode: 0o600, exclusive: true },
      );
      process.stderr.write(`brainrouter: migrated legacy state from ${legacyRoot} to ${newRoot}\n`);
    }
    if (removedAny) {
      process.stderr.write(`brainrouter: removed legacy in-workspace state under ${legacyRoot} (rescued to ${newRoot})\n`);
    }
    // If the workspace-local `.brainrouter/` is now completely empty (no
    // committable artifacts to preserve), remove the empty shell so the user
    // doesn't see a stray folder reappear every session. We only delete it
    // when empty — never when it still has committable artifacts inside.
    try {
      const remaining = fs.readdirSync(legacyRoot);
      if (remaining.length === 0) {
        fs.rmdirSync(legacyRoot);
      }
    } catch {
      // best-effort cleanup
    }
  } catch (err: any) {
    // Migration is best-effort. If it fails (permissions etc.), the CLI still
    // runs against the new location and the user can copy manually.
    process.stderr.write(`brainrouter: legacy-state migration skipped (${err.message ?? err})\n`);
  }
}

/**
 * Workspace-local state directory, e.g. `<workspace>/.brainrouter/`. Reserved
 * for artifacts that are *meant* to be committed alongside the code — durable
 * workspace manifests, workflow specs, task breakdowns, walkthrough notes.
 * Everything else
 * (sessions, hooks, hookify rules, memories, preferences, transcripts) lives
 * under `getWorkspaceStateRoot` in the user-global home so the project tree
 * stays clean.
 */
export function getWorkspaceLocalDir(workspaceRoot: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const dir = path.join(root, '.brainrouter');
  if (!isPathInside(root, dir)) {
    throw new Error('Workspace-local brainrouter directory escapes workspace root.');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

type LegacyRescueOutcome = 'absent' | 'removed' | 'preserved';

interface LegacyMigrationReceipt {
  version: 1;
  phase: 'prepared' | 'cleanup-ready';
  source: string;
  destination: string;
  token: string;
  candidates: string[];
  expected: {
    mode: number;
    dev: number;
    ino: number;
  };
}

interface ActiveLegacyMigrationReceipt {
  path: string;
  value: LegacyMigrationReceipt;
}

const LEGACY_MIGRATION_RECEIPT_MAX_BYTES = 16 * 1024;
const LEGACY_MIGRATION_RECEIPT_LIMIT = 64;
const activeLegacyMigrationTokens = new Set<string>();

export interface LegacyWorkspaceMigrationTestEvent {
  stage:
    | 'before-quarantine'
    | 'after-quarantine'
    | 'before-quarantine-cleanup'
    | 'after-cleanup-tombstone'
    | 'after-cleanup-removal';
  source: string;
  quarantine: string;
  destination: string;
}

let legacyWorkspaceMigrationHookForTests:
  ((event: LegacyWorkspaceMigrationTestEvent) => void) | undefined;

/** Test seam for deterministic races around the destructive migration boundary. */
export function _setLegacyWorkspaceMigrationHookForTests(
  hook?: (event: LegacyWorkspaceMigrationTestEvent) => void,
): void {
  legacyWorkspaceMigrationHookForTests = hook;
}

/**
 * Rescue one legacy personal-state root without following links or overwriting
 * a different destination value. Source removal is allowed only after a fresh
 * recursive byte-equivalence check succeeds in this invocation.
 */
function rescueLegacyPersonalStateRoot(src: string, dst: string): LegacyRescueOutcome {
  if (!recoverInterruptedLegacyMigration(src, dst)) return 'preserved';
  let guard: WorkspaceFileParentGuard;
  try {
    guard = openLegacySourceGuard(src);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return 'preserved';
  }
  // Crash leftovers have no durable ownership receipt. Merely opening a
  // checkout must never interpret a repository-controlled matching name as
  // internal state and delete it, so preserve every recognizable leftover for
  // explicit recovery and keep the migration incomplete.
  if (hasPendingMigrationArtifact(src, path.dirname(guard.accessTarget))) {
    guard.close();
    return 'preserved';
  }

  const quarantine = path.join(
    path.dirname(src),
    `.${path.basename(src)}.migration-source.${process.pid}.${crypto.randomBytes(12).toString('hex')}`,
  );

  const initial = lstatIfPresent(guard.accessTarget);
  if (!initial) {
    guard.close();
    return 'absent';
  }
  if (initial.isSymbolicLink() || !initial.isDirectory()) {
    guard.close();
    return 'preserved';
  }
  const accessQuarantine = guard.siblingPath(path.basename(quarantine));
  const receipt = createLegacyMigrationReceipt(src, dst, quarantine, initial);

  try {
    legacyWorkspaceMigrationHookForTests?.({
      stage: 'before-quarantine',
      source: src,
      quarantine,
      destination: dst,
    });
    guard.assertStable();
    assertLegacyMigrationReceipt(receipt);
    fs.renameSync(guard.accessTarget, accessQuarantine);
    guard.fsyncParent();
    guard.assertStable();
    const quarantined = lstatIfPresent(accessQuarantine);
    if (!quarantined || quarantined.isSymbolicLink() || !quarantined.isDirectory() ||
        !sameFilesystemEntry(initial, quarantined)) {
      restoreQuarantineIfOwned(accessQuarantine, guard.accessTarget, initial, guard);
      removeLegacyMigrationReceiptIfRecovered(receipt, src, initial);
      return 'preserved';
    }

    legacyWorkspaceMigrationHookForTests?.({
      stage: 'after-quarantine',
      source: src,
      quarantine,
      destination: dst,
    });
    guard.assertStable();
    if (!rescueQuarantinedDirectory(
      accessQuarantine,
      dst,
      quarantined,
      src,
      receipt,
      guard,
      quarantine,
    )) {
      restoreQuarantineIfOwned(accessQuarantine, guard.accessTarget, quarantined, guard);
      removeLegacyMigrationReceiptIfRecovered(receipt, src, quarantined);
      return 'preserved';
    }
    removeLegacyMigrationReceipt(receipt.path);

    // An older process can recreate the canonical path after the atomic rename.
    // Its new state was not part of this rescue and must survive for a later run.
    return lstatIfPresent(src) ? 'preserved' : 'removed';
  } catch {
    restoreQuarantineIfOwned(accessQuarantine, guard.accessTarget, initial, guard);
    removeLegacyMigrationReceiptIfRecovered(receipt, src, initial);
    return 'preserved';
  } finally {
    activeLegacyMigrationTokens.delete(receipt.value.token);
    guard.close();
  }
}

function rescueQuarantinedDirectory(
  quarantine: string,
  dst: string,
  expectedSource: fs.Stats,
  canonicalSource: string,
  receipt: ActiveLegacyMigrationReceipt,
  guard?: WorkspaceFileParentGuard,
  canonicalQuarantine = quarantine,
): boolean {
  let cleanupTombstone: string | undefined;
  try {
    const touchedDirectories = new Set<string>();
    const copied = rescueDirectoryContents(quarantine, dst, touchedDirectories);
    if (!copied || !directoryContentsAreRescued(quarantine, dst)) return false;
    fsyncTouchedDirectories(touchedDirectories);

    legacyWorkspaceMigrationHookForTests?.({
      stage: 'before-quarantine-cleanup',
      source: canonicalSource,
      quarantine: canonicalQuarantine,
      destination: dst,
    });
    guard?.assertStable();
    const current = lstatIfPresent(quarantine);
    if (!current || current.isSymbolicLink() || !current.isDirectory() ||
        !sameFilesystemEntry(expectedSource, current) ||
        !directoryContentsAreRescued(quarantine, dst)) return false;

    const canonicalCleanupTombstone = path.join(
      path.dirname(canonicalQuarantine),
      `.${path.basename(canonicalSource)}.migration-cleanup.${process.pid}.${crypto.randomBytes(12).toString('hex')}`,
    );
    cleanupTombstone = guard
      ? guard.siblingPath(path.basename(canonicalCleanupTombstone))
      : canonicalCleanupTombstone;
    receipt.value.candidates = [canonicalQuarantine, canonicalCleanupTombstone];
    writeLegacyMigrationReceipt(receipt.path, receipt.value, false);
    guard?.assertStable();
    fs.renameSync(quarantine, cleanupTombstone);
    if (guard) guard.fsyncParent();
    else fsyncDirectory(path.dirname(quarantine));
    guard?.assertStable();
    legacyWorkspaceMigrationHookForTests?.({
      stage: 'after-cleanup-tombstone',
      source: canonicalSource,
      quarantine: canonicalCleanupTombstone,
      destination: dst,
    });
    guard?.assertStable();
    const moved = lstatIfPresent(cleanupTombstone);
    if (!moved || moved.isSymbolicLink() || !moved.isDirectory() ||
        !sameFilesystemEntry(expectedSource, moved) ||
        !directoryContentsAreRescued(cleanupTombstone, dst)) {
      restoreCleanupTombstoneIfOwned(cleanupTombstone, quarantine, expectedSource, guard);
      return false;
    }

    // Durable proof that cleanup is authorized must precede deletion. If the
    // process dies after rm but before receipt removal, the next run can now
    // retire the receipt without guessing whether an unverified source died.
    receipt.value.phase = 'cleanup-ready';
    writeLegacyMigrationReceipt(receipt.path, receipt.value, false);
    guard?.assertStable();
    fs.rmSync(cleanupTombstone, { recursive: true, force: true });
    if (guard) guard.fsyncParent();
    else fsyncDirectory(path.dirname(cleanupTombstone));
    guard?.assertStable();
    legacyWorkspaceMigrationHookForTests?.({
      stage: 'after-cleanup-removal',
      source: canonicalSource,
      quarantine: canonicalCleanupTombstone,
      destination: dst,
    });
    guard?.assertStable();
    return true;
  } catch {
    if (cleanupTombstone) {
      restoreCleanupTombstoneIfOwned(cleanupTombstone, quarantine, expectedSource, guard);
    }
    return false;
  }
}

function hasPendingMigrationArtifact(src: string, parent = path.dirname(src)): boolean {
  const base = path.basename(src);
  const generatedName = new RegExp(
    `^\\.${base}\\.migration-(?:source|cleanup)\\.[0-9]+\\.[0-9a-f]{24}$`,
  );
  return fs.readdirSync(parent).some((name) => generatedName.test(name));
}

function createLegacyMigrationReceipt(
  source: string,
  destination: string,
  quarantine: string,
  expected: fs.Stats,
): ActiveLegacyMigrationReceipt {
  const match = /\.migration-source\.([0-9]+\.[0-9a-f]{24})$/.exec(quarantine);
  if (!match) throw new Error(`Invalid legacy migration quarantine: ${quarantine}`);
  const token = match[1]!;
  const directory = path.dirname(destination);
  const receiptPath = path.join(
    directory,
    `.${path.basename(source)}.legacy-migration.${token}.json`,
  );
  const value: LegacyMigrationReceipt = {
    version: 1,
    phase: 'prepared',
    source,
    destination,
    token,
    candidates: [quarantine],
    expected: {
      mode: expected.mode & 0o777,
      dev: expected.dev,
      ino: expected.ino,
    },
  };
  activeLegacyMigrationTokens.add(token);
  try {
    writeLegacyMigrationReceipt(receiptPath, value, true);
  } catch (error) {
    activeLegacyMigrationTokens.delete(token);
    throw error;
  }
  return { path: receiptPath, value };
}

function writeLegacyMigrationReceipt(
  receiptPath: string,
  receipt: LegacyMigrationReceipt,
  exclusive: boolean,
): void {
  writeFileAtomic(receiptPath, `${JSON.stringify(receipt)}\n`, {
    mode: 0o600,
    exclusive,
  });
}

function assertLegacyMigrationReceipt(active: ActiveLegacyMigrationReceipt): void {
  const current = readLegacyMigrationReceipt(active.path, active.value.source, active.value.destination);
  if (!current || current.token !== active.value.token ||
      JSON.stringify(current) !== JSON.stringify(active.value)) {
    throw new Error('Legacy migration ownership receipt changed before source quarantine.');
  }
}

function recoverInterruptedLegacyMigration(source: string, destination: string): boolean {
  const directory = path.dirname(destination);
  const escapedBase = escapeRegExp(path.basename(source));
  const receiptName = new RegExp(
    `^\\.${escapedBase}\\.legacy-migration\\.([0-9]+\\.[0-9a-f]{24})\\.json$`,
  );
  let entries: Array<{ name: string; token: string }>;
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    entries = fs.readdirSync(directory)
      .map((name) => ({ name, match: receiptName.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => !!entry.match)
      .map(({ name, match }) => ({ name, token: match[1]! }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (entries.length > LEGACY_MIGRATION_RECEIPT_LIMIT) return false;

  const pending: Array<{
    entry: { name: string; token: string };
    receipt: LegacyMigrationReceipt;
  }> = [];
  for (const entry of entries) {
    const receiptPath = path.join(directory, entry.name);
    const receipt = readLegacyMigrationReceipt(receiptPath, source, destination);
    if (!receipt || receipt.token !== entry.token) return false;
    if (legacyMigrationOwnerIsActive(receipt.token)) return false;
    if (!lstatIfPresent(source) &&
        receipt.candidates.every((candidate) => !lstatIfPresent(candidate))) {
      // A second writer can persist its prepared receipt, lose the source
      // rename to the first writer, and therefore never create a candidate.
      // With no canonical source and no owned candidate there are no bytes this
      // receipt can recover; retaining it would block every future migration.
      removeLegacyMigrationReceipt(receiptPath);
      continue;
    }
    pending.push({ entry, receipt });
  }

  let guard: WorkspaceFileParentGuard | undefined;
  if (pending.length > 0) {
    try {
      guard = openLegacySourceGuard(source);
    } catch {
      return false;
    }
  }

  try {
    for (const { entry, receipt } of pending) {
      const receiptPath = path.join(directory, entry.name);
      guard!.assertStable();
      const canonical = lstatIfPresent(guard!.accessTarget);
      const ownedCandidates = receipt.candidates
        .map((candidate) => ({
          candidate,
          accessCandidate: guard!.siblingPath(path.basename(candidate)),
        }))
        .map((candidate) => ({
          ...candidate,
          stat: lstatIfPresent(candidate.accessCandidate),
        }))
        .filter((candidate): candidate is {
          candidate: string;
          accessCandidate: string;
          stat: fs.Stats;
        } => !!candidate.stat && migrationDirectoryMatchesReceipt(candidate.stat, receipt));
      guard!.assertStable();

      if (canonical && (canonical.isSymbolicLink() || !canonical.isDirectory())) return false;
      if (canonical && ownedCandidates.length === 0) {
        removeLegacyMigrationReceipt(receiptPath);
        continue;
      }
      if (ownedCandidates.length !== 1) return false;

      const active: ActiveLegacyMigrationReceipt = { path: receiptPath, value: receipt };
      activeLegacyMigrationTokens.add(receipt.token);
      try {
        if (!rescueQuarantinedDirectory(
          ownedCandidates[0]!.accessCandidate,
          destination,
          ownedCandidates[0]!.stat,
          source,
          active,
          guard,
          ownedCandidates[0]!.candidate,
        )) return false;
        removeLegacyMigrationReceipt(receiptPath);
        if (canonical) {
          // The receipt owns only the quarantined old generation. Rescue and
          // retire it now, but leave the recreated canonical generation for a
          // fresh migration pass with its own snapshot and receipt.
          return false;
        }
      } finally {
        activeLegacyMigrationTokens.delete(receipt.token);
      }
    }
  } finally {
    guard?.close();
  }
  return true;
}

function openLegacySourceGuard(source: string): WorkspaceFileParentGuard {
  const legacyRoot = path.dirname(source);
  const workspaceRoot = path.dirname(legacyRoot);
  if (path.basename(legacyRoot) !== '.brainrouter') {
    throw new Error(`Unexpected legacy migration source: ${source}`);
  }
  const guard = openWorkspaceFileParentGuard(
    workspaceRoot,
    path.join('.brainrouter', path.basename(source)),
    { targetKind: 'directory' },
  );
  if (guard.canonicalTarget !== source) {
    guard.close();
    throw new Error(`Legacy migration source changed: ${source}`);
  }
  return guard;
}

function readLegacyMigrationReceipt(
  receiptPath: string,
  source: string,
  destination: string,
): LegacyMigrationReceipt | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readRegularFileBounded(receiptPath, LEGACY_MIGRATION_RECEIPT_MAX_BYTES).toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const receipt = parsed as Partial<LegacyMigrationReceipt>;
  const expected = receipt.expected;
  if (receipt.version !== 1 ||
      (receipt.phase !== 'prepared' && receipt.phase !== 'cleanup-ready') ||
      receipt.source !== source || receipt.destination !== destination ||
      typeof receipt.token !== 'string' || !/^[0-9]+\.[0-9a-f]{24}$/.test(receipt.token) ||
      !Array.isArray(receipt.candidates) || receipt.candidates.length < 1 || receipt.candidates.length > 2 ||
      receipt.candidates.some((candidate) => !validLegacyMigrationCandidate(candidate, source)) ||
      !expected || typeof expected !== 'object' || !Number.isFinite(expected.mode) ||
      !Number.isFinite(expected.dev) || !Number.isFinite(expected.ino)) {
    return undefined;
  }
  return receipt as LegacyMigrationReceipt;
}

function validLegacyMigrationCandidate(candidate: unknown, source: string): candidate is string {
  if (typeof candidate !== 'string' || path.dirname(candidate) !== path.dirname(source)) return false;
  const escapedBase = escapeRegExp(path.basename(source));
  return new RegExp(
    `^\\.${escapedBase}\\.migration-(?:source|cleanup)\\.[0-9]+\\.[0-9a-f]{24}$`,
  ).test(path.basename(candidate));
}

function migrationDirectoryMatchesReceipt(stat: fs.Stats, receipt: LegacyMigrationReceipt): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() &&
    (stat.mode & 0o777) === receipt.expected.mode &&
    stat.dev === receipt.expected.dev && stat.ino === receipt.expected.ino;
}

function legacyMigrationOwnerIsActive(token: string): boolean {
  const ownerPid = Number(token.slice(0, token.indexOf('.')));
  if (ownerPid === process.pid) return activeLegacyMigrationTokens.has(token);
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function removeLegacyMigrationReceiptIfRecovered(
  active: ActiveLegacyMigrationReceipt,
  source: string,
  expected: fs.Stats,
): void {
  try {
    const restored = lstatIfPresent(source);
    if (!restored || restored.isSymbolicLink() || !restored.isDirectory() ||
        !sameFilesystemEntry(expected, restored) ||
        active.value.candidates.some((candidate) => {
          const candidateStat = lstatIfPresent(candidate);
          return !!candidateStat && sameFilesystemEntry(expected, candidateStat);
        })) return;
    removeLegacyMigrationReceipt(active.path);
  } catch {
    // A durable receipt is safer than guessing after an ambiguous restore.
  }
}

function removeLegacyMigrationReceipt(receiptPath: string): void {
  try {
    fs.unlinkSync(receiptPath);
    fsyncDirectory(path.dirname(receiptPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readRegularFileBounded(target: string, maxBytes: number): Buffer {
  const pathStat = fs.lstatSync(target);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > maxBytes) {
    throw new Error(`Unsafe migration receipt: ${target}`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFilesystemEntry(pathStat, opened) || opened.size > maxBytes) {
      throw new Error(`Unsafe migration receipt: ${target}`);
    }
    const contents = Buffer.alloc(opened.size);
    if (!readExactly(descriptor, contents, contents.length, 0)) {
      throw new Error(`Migration receipt changed while reading: ${target}`);
    }
    const after = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(target);
    if (!sameStableFile(opened, after) || afterPath.isSymbolicLink() || !afterPath.isFile() ||
        !sameStableFile(after, afterPath)) {
      throw new Error(`Migration receipt changed while reading: ${target}`);
    }
    return contents;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restoreCleanupTombstoneIfOwned(
  cleanupTombstone: string,
  quarantine: string,
  expected: fs.Stats,
  guard?: Pick<WorkspaceFileParentGuard, 'assertStable' | 'fsyncParent'>,
): void {
  try {
    guard?.assertStable();
    if (lstatIfPresent(quarantine)) return;
    const current = lstatIfPresent(cleanupTombstone);
    if (!current || current.isSymbolicLink() || !current.isDirectory() ||
        !sameFilesystemEntry(expected, current)) return;
    fs.renameSync(cleanupTombstone, quarantine);
    if (guard) guard.fsyncParent();
    else fsyncDirectory(path.dirname(quarantine));
    guard?.assertStable();
  } catch {
    // Preserve the tombstone when ownership or the restore target is unclear.
  }
}

function restoreQuarantineIfOwned(
  quarantine: string,
  src: string,
  expected: fs.Stats,
  guard?: Pick<WorkspaceFileParentGuard, 'assertStable' | 'fsyncParent'>,
): void {
  try {
    guard?.assertStable();
    if (lstatIfPresent(src)) return;
    const current = lstatIfPresent(quarantine);
    if (!current || current.isSymbolicLink() || !current.isDirectory() ||
        !sameFilesystemEntry(expected, current)) return;
    fs.renameSync(quarantine, src);
    if (guard) guard.fsyncParent();
    else fsyncDirectory(path.dirname(src));
    guard?.assertStable();
  } catch {
    // Both the canonical path and quarantine are safer preserved than guessed at.
  }
}

function rescueDirectoryContents(
  src: string,
  dst: string,
  touchedDirectories: Set<string>,
): boolean {
  const sourceDirectory = lstatIfPresent(src);
  if (!sourceDirectory || sourceDirectory.isSymbolicLink() || !sourceDirectory.isDirectory() ||
      !ensureRealDirectory(dst, sourceDirectory.mode & 0o777, touchedDirectories)) return false;
  let complete = true;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    const srcStat = lstatIfPresent(srcPath);
    if (!srcStat || srcStat.isSymbolicLink()) {
      complete = false;
      continue;
    }
    if (srcStat.isDirectory()) {
      if (!rescueDirectoryContents(srcPath, dstPath, touchedDirectories)) complete = false;
      continue;
    }
    if (!srcStat.isFile() ||
        !rescueRegularFile(srcPath, dstPath, srcStat, touchedDirectories)) complete = false;
  }
  return complete;
}

function directoryContentsAreRescued(src: string, dst: string): boolean {
  const srcStat = lstatIfPresent(src);
  const dstStat = lstatIfPresent(dst);
  if (!srcStat?.isDirectory() || srcStat.isSymbolicLink() ||
      !dstStat?.isDirectory() || dstStat.isSymbolicLink() ||
      (srcStat.mode & 0o777) !== (dstStat.mode & 0o777)) return false;

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    const entryStat = lstatIfPresent(srcPath);
    if (!entryStat || entryStat.isSymbolicLink()) return false;
    if (entryStat.isDirectory()) {
      if (!directoryContentsAreRescued(srcPath, dstPath)) return false;
    } else if (!entryStat.isFile() || !regularFilesEqual(srcPath, dstPath)) {
      return false;
    }
  }
  return true;
}

function ensureRealDirectory(
  dir: string,
  mode: number,
  touchedDirectories: Set<string>,
): boolean {
  let stat = lstatIfPresent(dir);
  if (!stat) {
    try {
      fs.mkdirSync(dir, { mode });
      fs.chmodSync(dir, mode);
      touchedDirectories.add(path.dirname(dir));
      touchedDirectories.add(dir);
    } catch { /* raced with another creator or failed */ }
    stat = lstatIfPresent(dir);
  }
  const valid = !!stat && stat.isDirectory() && !stat.isSymbolicLink() &&
    (stat.mode & 0o777) === mode;
  // Even an already-present collision must be made durable before its only
  // verified legacy copy is removed.
  if (valid) touchedDirectories.add(dir);
  return valid;
}

function rescueRegularFile(
  src: string,
  dst: string,
  expectedSource: fs.Stats,
  touchedDirectories: Set<string>,
): boolean {
  const destination = lstatIfPresent(dst);
  if (destination) {
    return !destination.isSymbolicLink() && destination.isFile() && regularFilesEqual(src, dst);
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const temporary = path.join(
    path.dirname(dst),
    `.${path.basename(dst)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.migration-tmp`,
  );
  let sourceFd: number | undefined;
  let temporaryFd: number | undefined;
  let temporaryVersion: fs.Stats | undefined;
  try {
    sourceFd = fs.openSync(src, fs.constants.O_RDONLY | noFollow);
    const openedSource = fs.fstatSync(sourceFd);
    if (!openedSource.isFile() || !sameFilesystemEntry(expectedSource, openedSource)) return false;

    temporaryFd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      openedSource.mode & 0o777,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < openedSource.size) {
      const requested = Math.min(buffer.length, openedSource.size - offset);
      const read = fs.readSync(sourceFd, buffer, 0, requested, offset);
      if (read <= 0) throw new Error('Legacy state source changed while it was being rescued.');
      let written = 0;
      while (written < read) {
        const count = fs.writeSync(temporaryFd, buffer, written, read - written, offset + written);
        if (count <= 0) throw new Error('Legacy state destination stopped accepting rescued bytes.');
        written += count;
      }
      offset += read;
    }
    fs.fchmodSync(temporaryFd, openedSource.mode & 0o777);
    fs.fsyncSync(temporaryFd);
    const closedSource = fs.fstatSync(sourceFd);
    if (!sameStableFile(openedSource, closedSource)) return false;

    try {
      fs.linkSync(temporary, dst);
      touchedDirectories.add(path.dirname(dst));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    // Linking updates the inode ctime. Capture the post-link version so the
    // finally block removes only this exact staging file, never a replacement.
    temporaryVersion = fs.fstatSync(temporaryFd);
    return regularFilesEqual(src, dst);
  } catch {
    return false;
  } finally {
    if (temporaryFd !== undefined) {
      // Snapshot through our still-open descriptor. Cleanup then unlinks the
      // staging name only if it still identifies this exact final version.
      try { temporaryVersion = fs.fstatSync(temporaryFd); } catch { /* preserve the copy result */ }
      try { fs.closeSync(temporaryFd); } catch { /* best-effort close */ }
    }
    if (sourceFd !== undefined) {
      try { fs.closeSync(sourceFd); } catch { /* best-effort close */ }
    }
    removeTemporaryIfOwned(temporary, temporaryVersion);
    touchedDirectories.add(path.dirname(temporary));
  }
}

function removeTemporaryIfOwned(temporary: string, expected: fs.Stats | undefined): void {
  if (!expected) return;
  try {
    const current = fs.lstatSync(temporary);
    if (current.isSymbolicLink() || !current.isFile() ||
        !sameStableFile(expected, current)) return;
    fs.rmSync(temporary, { force: true });
  } catch {
    // A stale complete temp is safer than deleting a path whose identity changed.
  }
}

function regularFilesEqual(left: string, right: string): boolean {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let leftFd: number | undefined;
  let rightFd: number | undefined;
  try {
    leftFd = fs.openSync(left, fs.constants.O_RDONLY | noFollow);
    rightFd = fs.openSync(right, fs.constants.O_RDONLY | noFollow);
    const leftBefore = fs.fstatSync(leftFd);
    const rightBefore = fs.fstatSync(rightFd);
    if (!leftBefore.isFile() || !rightBefore.isFile() ||
        leftBefore.size !== rightBefore.size ||
        (leftBefore.mode & 0o777) !== (rightBefore.mode & 0o777)) return false;
    const leftPathStat = fs.lstatSync(left);
    const rightPathStat = fs.lstatSync(right);
    if (leftPathStat.isSymbolicLink() || rightPathStat.isSymbolicLink() ||
        !sameFilesystemEntry(leftBefore, leftPathStat) || !sameFilesystemEntry(rightBefore, rightPathStat)) return false;

    const leftBuffer = Buffer.allocUnsafe(64 * 1024);
    const rightBuffer = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < leftBefore.size; offset += leftBuffer.length) {
      const length = Math.min(leftBuffer.length, leftBefore.size - offset);
      if (!readExactly(leftFd, leftBuffer, length, offset) ||
          !readExactly(rightFd, rightBuffer, length, offset) ||
          !leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))) return false;
    }
    // A byte-equivalent pre-existing collision is the destination copy we
    // rely on, so flush its inode before permitting source cleanup.
    fs.fsyncSync(rightFd);
    const leftAfter = fs.fstatSync(leftFd);
    const rightAfter = fs.fstatSync(rightFd);
    const leftAfterPath = fs.lstatSync(left);
    const rightAfterPath = fs.lstatSync(right);
    return sameStableFile(leftBefore, leftAfter) &&
      sameStableFile(rightBefore, rightAfter) &&
      !leftAfterPath.isSymbolicLink() && leftAfterPath.isFile() &&
      !rightAfterPath.isSymbolicLink() && rightAfterPath.isFile() &&
      sameStableFile(leftAfter, leftAfterPath) &&
      sameStableFile(rightAfter, rightAfterPath);
  } catch {
    return false;
  } finally {
    if (rightFd !== undefined) {
      try { fs.closeSync(rightFd); } catch { /* best-effort close */ }
    }
    if (leftFd !== undefined) {
      try { fs.closeSync(leftFd); } catch { /* best-effort close */ }
    }
  }
}

function readExactly(fd: number, buffer: Buffer, length: number, position: number): boolean {
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (read <= 0) return false;
    offset += read;
  }
  return true;
}

function lstatIfPresent(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(before: fs.Stats, after: fs.Stats): boolean {
  return sameFilesystemEntry(before, after) &&
    (before.mode & 0o777) === (after.mode & 0o777) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
}

function fsyncTouchedDirectories(directories: Set<string>): void {
  const ordered = [...directories].sort((left, right) => right.length - left.length);
  for (const directory of ordered) fsyncDirectory(directory);
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EISDIR') throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best-effort close */ }
    }
  }
}

export function getStateFile(workspaceRoot: string, fileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    throw new Error(`Invalid CLI state file name: ${fileName}`);
  }

  const stateDir = getStateDir(workspaceRoot);
  const filePath = path.join(stateDir, fileName);
  if (!isPathInside(stateDir, filePath)) {
    throw new Error(`CLI state file escapes state directory: ${fileName}`);
  }
  return filePath;
}

/**
 * Encode a sessionKey to a safe directory name. Base64url keeps it short and
 * round-trippable so listSessions can recover the original key. The 180-char
 * cap matches the previous transcript filename limit.
 */
export function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, 'utf8').toString('base64url').slice(0, 180);
}

export function decodeSessionKey(encoded: string): string {
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return encoded;
  }
}

/**
 * Per-session state bucket at `<workspace>/.brainrouter/cli/sessions/<encoded>/`.
 * Goal, plan, transcript, and any future per-session artifacts live together
 * here so users can browse one folder per chat session instead of hunting
 * across siblings.
 */
export function getSessionStateDir(workspaceRoot: string, sessionKey: string): string {
  const stateDir = getStateDir(workspaceRoot);
  const sessionsDir = path.join(stateDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionDir = path.join(sessionsDir, encodeSessionKey(sessionKey));
  if (!isPathInside(sessionsDir, sessionDir)) {
    throw new Error('Session state directory escapes CLI state dir.');
  }
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

export function getSessionStateFile(workspaceRoot: string, sessionKey: string, fileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    throw new Error(`Invalid session state file name: ${fileName}`);
  }
  const sessionDir = getSessionStateDir(workspaceRoot, sessionKey);
  const filePath = path.join(sessionDir, fileName);
  if (!isPathInside(sessionDir, filePath)) {
    throw new Error('Session state file escapes session directory.');
  }
  return filePath;
}

/**
 * List every persisted session bucket: returns `{ sessionKey, dir, modifiedAt }`
 * newest first. Used by `/sessions` to render a picker.
 */
export function listSessionDirs(workspaceRoot: string): Array<{ sessionKey: string; dir: string; modifiedAt: string }> {
  const sessionsDir = path.join(getStateDir(workspaceRoot), 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const out: Array<{ sessionKey: string; dir: string; modifiedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionsDir, entry.name);
    let mtime = new Date(0);
    try {
      const stat = fs.statSync(dir);
      mtime = stat.mtime;
      // The transcript drives "last activity" better than the dir mtime.
      const transcript = path.join(dir, 'transcript.jsonl');
      if (fs.existsSync(transcript)) {
        mtime = fs.statSync(transcript).mtime;
      }
    } catch { /* unreadable */ }
    out.push({
      sessionKey: decodeSessionKey(entry.name),
      dir,
      modifiedAt: mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch (err: any) {
    // Falling back instead of throwing means a single corrupted state file
    // (truncated JSON from Ctrl-C mid-write, partial migration, hand-edit)
    // can't prevent the REPL from booting. Quarantine the bad file so the
    // user can inspect it, then return the caller's fallback value. The
    // alternative — propagating — meant a half-byte goal.json bricked the
    // entire CLI because createSystemMessage reads it on every turn start.
    try {
      const quarantine = `${filePath}.corrupt-${Date.now()}`;
      fs.renameSync(filePath, quarantine);
      console.warn(
        `[brainrouter] could not parse ${filePath} (${err.message}); ` +
        `moved to ${quarantine} and falling back to default.`,
      );
    } catch {
      // Couldn't quarantine — just warn and continue with the fallback.
      console.warn(`[brainrouter] could not parse ${filePath}: ${err.message}; using default.`);
    }
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Temp suffix needs to be unique even when two writers run in the same
  // millisecond (e.g. goal + plan + prefs writes during a single
  // auto-continuation tick). Date.now() is millisecond-resolution so the old
  // form `${pid}.${ms}.tmp` collides under load; add a 6-byte random nonce.
  const nonce = crypto.randomBytes(6).toString('hex');
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${nonce}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}
