/**
 * PLUGIN-MARKETPLACE P5 — `brainrouter plugin publish` (plan §4/P5).
 *
 * Publishing a plugin = contributing an entry to a COMMUNITY registry repo (a PR,
 * à la Agency Agents). This module is PURE + side-effect-light so it's testable:
 *
 *   1. validate the plugin (reuse P1 `discoverPlugin`),
 *   2. compute the deterministic tree `integrity` (reuse P3 `hashDirectory`),
 *   3. build a `RegistryEntry` (id/name/repo/version/category/tags/provides/
 *      integrity/lastUpdated) from the manifest + disclosure counts,
 *   4. produce the PUBLISH PLAN: the branch name, the registry-entry JSON, and
 *      either the exact `gh` PR instructions (when `cli.plugins.publishRepo` is
 *      set) or a note that the entry was written to stdout + a local file.
 *
 * Whether a PR is actually opened is left to the CLI (it shells `gh`); this
 * module never touches the network. BrainRouter conventions only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverPlugin } from './discovery.js';
import { summarizeProvides } from './discovery.js';
import { hashDirectory } from './integrity.js';
import { slugifyBranchPart } from '../track/git/index.js';
import type { RegistryEntry } from './registry.js';

export interface BuildRegistryEntryOptions {
  /** Today (YYYY-MM-DD) for `lastUpdated`. Defaults to the current UTC date. */
  now?: Date;
  /** Star count seed (a fresh publish has none). Defaults to 0. */
  stars?: number;
}

/** ISO calendar date (YYYY-MM-DD) in UTC — matches the registry `lastUpdated` shape. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build a registry entry from a validated plugin at `pluginRoot`. The integrity
 * is the deterministic tree digest (`sha256-<base64>`) so a consumer can pin the
 * exact source. `repo` comes from the manifest's `repository`/`homepage`.
 */
export function buildRegistryEntry(
  pluginRoot: string,
  opts: BuildRegistryEntryOptions = {},
): { ok: true; entry: RegistryEntry; integrity: string } | { ok: false; error: string; errors?: string[] } {
  const disc = discoverPlugin(pluginRoot);
  if (!disc.ok) return { ok: false, error: `invalid plugin: ${disc.error.errors.join('; ')}`, errors: disc.error.errors };
  const { manifest } = disc.plugin;
  const provides = summarizeProvides(disc.plugin);
  const integrity = hashDirectory(disc.plugin.root);

  const entry: RegistryEntry = {
    id: manifest.name,
    name: manifest.name,
    repo: (manifest.repository ?? manifest.homepage ?? '').trim(),
    tags: manifest.keywords ?? [],
    stars: typeof opts.stars === 'number' && opts.stars >= 0 ? Math.floor(opts.stars) : 0,
    lastUpdated: isoDate(opts.now ?? new Date()),
    integrity,
    provides: {
      skills: provides.skills,
      personas: provides.personas,
      agents: provides.agents,
      hooks: provides.hooks,
      mcpServers: provides.mcpServers,
      connectors: provides.connectors,
      workflows: provides.workflows,
    },
  };
  if (manifest.version) entry.version = manifest.version;
  if (manifest.category) entry.category = manifest.category;
  if (manifest.author?.name) entry.author = manifest.author.name;
  if (manifest.description) entry.description = manifest.description;

  return { ok: true, entry, integrity };
}

export interface PublishPlan {
  /** The plugin name being published. */
  name: string;
  /** The computed tree integrity (`sha256-<base64>`). */
  integrity: string;
  /** The registry entry to add (pretty-printed JSON in `entryJson`). */
  entry: RegistryEntry;
  entryJson: string;
  /** A stable branch name for the publish PR. */
  branch: string;
  /** The community registry repo the PR targets (empty when unset). */
  publishRepo: string;
  /** When no `publishRepo` is configured: the local file the entry was written to
   *  (the CLI writes it; this is the intended path). */
  localFile: string;
  /** Human-readable next-step instructions (gh PR flow, or the local fallback). */
  instructions: string[];
  /** Validation warnings surfaced from discovery (non-fatal). */
  warnings: string[];
}

export type PublishResult = { ok: true; plan: PublishPlan } | { ok: false; error: string; errors?: string[] };

/** Normalize a `publishRepo` (`owner/repo`, a full https url, or a git url) to an
 *  `owner/repo` slug for `gh` when possible; else return the raw string. */
export function normalizePublishRepo(repo: string): string {
  const s = repo.trim();
  if (!s) return '';
  // owner/repo already
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s.replace(/\.git$/, '');
  const m = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  return s;
}

/**
 * Produce the full publish PLAN for a plugin dir. Validates + hashes + builds the
 * registry entry, then lays out the PR/branch instructions. When `publishRepo` is
 * blank the plan describes the stdout + local-file fallback (never hard-requires a
 * repo). Deterministic (inject `now` for tests).
 */
export function planPublish(
  pluginDir: string,
  opts: {
    publishRepo?: string;
    now?: Date;
    stars?: number;
    /** Where the CLI would write the local entry file. Default: `<pluginDir>/registry-entry.json`. */
    localFile?: string;
  } = {},
): PublishResult {
  const built = buildRegistryEntry(pluginDir, { now: opts.now, stars: opts.stars });
  if (!built.ok) return built;
  const disc = discoverPlugin(pluginDir);
  const warnings = disc.ok ? disc.plugin.warnings : [];

  const entry = built.entry;
  const entryJson = JSON.stringify(entry, null, 2);
  const publishRepo = normalizePublishRepo(opts.publishRepo ?? '');
  const branch = `plugin-publish/${slugifyBranchPart(entry.id)}${entry.version ? `-${slugifyBranchPart(entry.version)}` : ''}`;
  const localFile = opts.localFile
    ? path.resolve(opts.localFile)
    : path.resolve(pluginDir, 'registry-entry.json');

  const instructions: string[] = [];
  if (publishRepo) {
    instructions.push(
      `# Open a PR adding this entry to ${publishRepo}/registry.json:`,
      `gh repo fork ${publishRepo} --clone --remote 2>/dev/null || gh repo clone ${publishRepo}`,
      `cd ${publishRepo.split('/').pop()}`,
      `git checkout -b ${branch}`,
      `# add the entry to the "plugins" array in registry.json, then:`,
      `git add registry.json && git commit -m "plugin: publish ${entry.id}${entry.version ? ` v${entry.version}` : ''}"`,
      `git push -u origin ${branch}`,
      `gh pr create --repo ${publishRepo} --title "Publish ${entry.id}${entry.version ? ` v${entry.version}` : ''}" --body "Adds ${entry.id} to the registry (integrity ${entry.integrity})."`,
    );
  } else {
    instructions.push(
      `# No cli.plugins.publishRepo configured — the registry entry was written to:`,
      `#   ${localFile}`,
      `# Set a repo and re-run to get PR instructions:`,
      `brainrouter config set cli.plugins.publishRepo <owner/repo>`,
      `# Or open a PR manually against your community registry adding the entry above.`,
    );
  }

  return {
    ok: true,
    plan: { name: entry.id, integrity: entry.integrity!, entry, entryJson, branch, publishRepo, localFile, instructions, warnings },
  };
}

/** Write the registry-entry JSON to a local file (used by the no-repo fallback). Never throws. */
export function writeRegistryEntryFile(plan: PublishPlan): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(path.dirname(plan.localFile), { recursive: true });
    fs.writeFileSync(plan.localFile, plan.entryJson + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
