import fs from 'node:fs';
import path from 'node:path';
import {
  WORKSPACE_SELECTION_CATALOG_MAX_ENTRIES,
  WORKSPACE_SELECTION_STABLE_ID,
} from './types.js';
import { labelForId, safeCatalogText } from './safety.js';

const MAX_SKILL_FILE_BYTES = 256 * 1024;

export interface SafeSkillDescriptor {
  id: string;
  label: string;
  description: string;
  category: string;
}

/** Read only bounded frontmatter metadata from a fixed, trusted skill root. */
export function readSkillCatalogRoot(root: string): SafeSkillDescriptor[] {
  const result: SafeSkillDescriptor[] = [];
  let realRoot: string;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return result;
    realRoot = fs.realpathSync(root);
    if (!fs.lstatSync(realRoot).isDirectory()) return result;
  } catch {
    return result;
  }
  for (const category of readDirectories(realRoot)) {
    for (const skill of readDirectories(path.join(realRoot, category))) {
      const descriptor = readSkillFile(
        path.join(realRoot, category, skill, 'SKILL.md'),
        skill,
        category,
        realRoot,
      );
      if (descriptor) result.push(descriptor);
      if (result.length >= WORKSPACE_SELECTION_CATALOG_MAX_ENTRIES) return result;
    }
  }
  return result;
}

export function readSkillFile(
  filePath: string,
  expectedId: string,
  fallbackCategory: string,
  containmentRoot?: string,
): SafeSkillDescriptor | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_FILE_BYTES) return undefined;
    const realFile = fs.realpathSync(filePath);
    if (containmentRoot) {
      const realContainmentRoot = fs.realpathSync(containmentRoot);
      const relative = path.relative(realContainmentRoot, realFile);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    }
    const raw = fs.readFileSync(realFile, 'utf8');
    const frontmatter = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!frontmatter || frontmatterScalar(frontmatter, 'name') !== expectedId) return undefined;
    return {
      id: expectedId,
      label: safeCatalogText(frontmatterScalar(frontmatter, 'label'), labelForId(expectedId)),
      description: safeCatalogText(frontmatterScalar(frontmatter, 'description'), 'No description available.'),
      category: safeCatalogText(frontmatterScalar(frontmatter, 'category'), fallbackCategory),
    };
  } catch {
    return undefined;
  }
}

function readDirectories(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) =>
        entry.isDirectory()
        && !entry.isSymbolicLink()
        && WORKSPACE_SELECTION_STABLE_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, 256);
  } catch {
    return [];
  }
}

function frontmatterScalar(frontmatter: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = frontmatter.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'));
  if (!match) return undefined;
  const value = match[1].trim();
  if (value === '|' || value === '>') return undefined;
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
