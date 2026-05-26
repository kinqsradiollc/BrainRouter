/**
 * `/release-notes` slash command — show the changelog for the running CLI version.
 *
 *   /release-notes            → current version's notes
 *   /release-notes <version>  → specific version
 *   /release-notes list       → every shipped version, sorted descending
 *
 * Changelog files ship inside the published package at `changelog/<version>.md`.
 * The repo-root `brainrouter-changelog/` is copied into `brainrouter-cli/changelog/`
 * by `prepublishOnly` so users who install via npm see them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import type { CommandContext } from './_context.js';

const MAX_LINES = 200;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface ReleaseNotesDeps {
  /** Override the changelog directory (tests). Defaults to bundled `changelog/`. */
  changelogDir?: string;
  /** Override the current version (tests). Defaults to package.json#version. */
  currentVersion?: string;
}

export async function tryHandleReleaseNotesCommand(
  ctx: CommandContext,
  deps: ReleaseNotesDeps = {},
): Promise<boolean> {
  if (ctx.command !== '/release-notes') return false;
  const out = runReleaseNotes(ctx.args, deps);
  console.log(out);
  return true;
}

/**
 * Pure handler — returns the rendered string. Split from `tryHandle*` so unit
 * tests can assert on the output without capturing stdout.
 */
export function runReleaseNotes(args: string[], deps: ReleaseNotesDeps = {}): string {
  const dir = deps.changelogDir ?? defaultChangelogDir();
  const sub = (args[0] ?? '').toLowerCase();

  if (sub === 'list') return renderList(dir);

  let version: string;
  if (sub) {
    if (!SEMVER_RE.test(sub)) {
      return chalk.red(`Not a valid semver: "${args[0]}". Try /release-notes list.`);
    }
    version = sub;
  } else {
    const v = deps.currentVersion ?? readCurrentVersion();
    if (!v) return chalk.red('Could not determine current CLI version.');
    version = v;
  }

  const filePath = path.join(dir, `${version}.md`);
  let body: string;
  try {
    body = fs.readFileSync(filePath, 'utf8');
  } catch {
    return chalk.yellow(`no notes shipped for ${version}`);
  }
  return truncate(body, version);
}

function renderList(dir: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return chalk.yellow('No bundled changelog directory found.');
  }
  const versions = entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .filter((v) => SEMVER_RE.test(v))
    .sort(compareSemverDesc);
  if (versions.length === 0) return chalk.yellow('No changelog versions bundled.');
  return versions.join('\n');
}

function truncate(body: string, version: string): string {
  const lines = body.split('\n');
  if (lines.length <= MAX_LINES) return body;
  const head = lines.slice(0, MAX_LINES).join('\n');
  return `${head}\n\n…truncated at ${MAX_LINES} lines. Run \`/release-notes ${version}\` on its own to scroll the full file in a fresh paginator.`;
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0].split('.').map(Number);
  const pb = b.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  // Identical core → keep pre-release sort stable by string compare (descending).
  return b.localeCompare(a);
}

// --- Package-root resolution -------------------------------------------------

/**
 * `brainrouter-cli/changelog/` — relative to this compiled file. The dist
 * layout mirrors src, so both `src/cli/commands/releaseNotes.ts` (dev/tsx)
 * and `dist/cli/commands/releaseNotes.js` (built) resolve to the same root.
 */
function defaultChangelogDir(): string {
  return fileURLToPath(new URL('../../../changelog', import.meta.url));
}

function readCurrentVersion(): string | undefined {
  try {
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}
