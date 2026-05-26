import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

export interface SkillListItem {
  name: string;
  scope?: string;
  category?: string;
  description?: string;
  source?: 'mcp' | 'filesystem';
}

const WORKSPACE_SKILL_ROOTS = ['skills', '.brainrouter/skills'];

export function listFilesystemSkills(workspaceRoot: string): SkillListItem[] {
  const seen = new Map<string, SkillListItem>();
  for (const root of skillSearchRoots(workspaceRoot)) {
    if (!fs.existsSync(root)) continue;
    const scope = inferRootScope(root, workspaceRoot);
    for (const filePath of findSkillFiles(root)) {
      const parsed = parseSkillFile(filePath);
      if (!parsed) continue;
      const rel = path.relative(root, filePath);
      const category = rel.split(path.sep)[0] || 'uncategorized';
      if (!seen.has(parsed.name)) {
        seen.set(parsed.name, {
          name: parsed.name,
          category,
          description: parsed.description,
          scope,
          source: 'filesystem',
        });
      }
    }
  }
  return Array.from(seen.values()).sort(sortSkills);
}

export function mergeSkillLists(primary: SkillListItem[], fallback: SkillListItem[]): SkillListItem[] {
  const merged = new Map<string, SkillListItem>();
  for (const skill of primary) {
    merged.set(skill.name, { ...skill, source: skill.source ?? 'mcp' });
  }
  for (const skill of fallback) {
    if (!merged.has(skill.name)) merged.set(skill.name, skill);
  }
  return Array.from(merged.values()).sort(sortSkills);
}

export function sortSkills(a: SkillListItem, b: SkillListItem): number {
  return (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name);
}

export function skillSearchRoots(workspaceRoot: string): string[] {
  const roots: string[] = [];
  for (const sub of WORKSPACE_SKILL_ROOTS) roots.push(path.join(workspaceRoot, sub));

  const mcpPkgDir = resolveInstalledMcpPackageDir();
  if (mcpPkgDir) {
    roots.push(path.join(mcpPkgDir, 'skills'));
    const monorepoRoot = path.dirname(mcpPkgDir);
    roots.push(path.join(monorepoRoot, 'skills'));
  }

  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function resolveInstalledMcpPackageDir(): string | undefined {
  try {
    const pkgJsonPath = requireFromHere.resolve('@kinqs/brainrouter-mcp-server/package.json');
    return path.dirname(pkgJsonPath);
  } catch {
    return undefined;
  }
}

function inferRootScope(root: string, workspaceRoot: string): string {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot.startsWith(path.join(resolvedWorkspace, '.brainrouter'))) return 'local';
  if (isBrainRouterRepoRoot(path.dirname(resolvedRoot))) return 'global';
  return resolvedRoot.startsWith(resolvedWorkspace) ? 'local' : 'global';
}

function isBrainRouterRepoRoot(root: string): boolean {
  return (
    fs.existsSync(path.join(root, 'brainrouter', 'package.json')) &&
    fs.existsSync(path.join(root, 'brainrouter-cli', 'package.json')) &&
    fs.existsSync(path.join(root, 'skills'))
  );
}

function findSkillFiles(root: string): string[] {
  const results: string[] = [];
  function walk(current: string, depth: number): void {
    if (depth < 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth - 1);
      else if (entry.isFile() && entry.name === 'SKILL.md') results.push(full);
    }
  }
  walk(root, 5);
  return results;
}

function parseSkillFile(filePath: string): { name: string; description?: string } | undefined {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }

  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = frontmatter?.[1] ?? '';
  const name = readYamlScalar(block, 'name') ?? path.basename(path.dirname(filePath));
  const description = readYamlScalar(block, 'description') ?? firstParagraph(raw);
  if (!name) return undefined;
  return { name, description };
}

function readYamlScalar(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match?.[1]) return undefined;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function firstParagraph(raw: string): string | undefined {
  const withoutFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
  const line = withoutFrontmatter
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('#'));
  return line;
}
