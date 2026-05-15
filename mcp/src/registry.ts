// ─────────────────────────────────────────────
// BrainRouter MCP Server — Dual Registry
// Scans global + local roots, merges manifests.
// Local always shadows global on name conflict.
// ─────────────────────────────────────────────

import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, relative, basename, dirname } from 'path';
import matter from 'gray-matter';
import type {
  SkillManifest,
  DocManifest,
  PersonaManifest,
  ReferenceManifest,
  RegistryConfig,
  SkillScope,
  DocCategory,
} from './types.js';

// ─── Helpers ────────────────────────────────

/**
 * Recursively find all files matching a filename in a directory.
 */
function findFiles(dir: string, filename: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];

  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry === filename) {
          results.push(full);
        }
      } catch {
        // Skip unreadable entries
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Find all direct .md files in a directory (non-recursive).
 */
function findMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

/**
 * Derive the category from a skill file path.
 * e.g. .../skills/agent/bootstrap-skill/SKILL.md → "agent"
 */
function deriveCategory(filePath: string, skillsRoot: string): string {
  const rel = relative(skillsRoot, filePath);
  const parts = rel.split('/');
  return parts.length >= 2 ? parts[0] : 'uncategorized';
}

/**
 * Parse frontmatter from a SKILL.md. Returns name + description.
 */
function parseSkillFrontmatter(filePath: string): { name: string; description: string } | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const { data } = matter(raw);
    if (data.name && data.description) {
      return { name: String(data.name), description: String(data.description) };
    }
  } catch {
    // Skip unparseable files
  }
  return null;
}

/**
 * Derive the doc category from its file path.
 * e.g. .../docs/api/API.md → "api"
 */
function deriveDocCategory(filePath: string, docsRoot: string): DocCategory {
  const rel = relative(docsRoot, filePath);
  const parts = rel.split('/');
  const cat = parts.length >= 2 ? parts[0].toLowerCase() : 'other';
  const valid: DocCategory[] = ['api', 'design', 'schema', 'deployment', 'hooks', 'strategy'];
  return valid.includes(cat as DocCategory) ? (cat as DocCategory) : 'other';
}

/**
 * Derive a doc name from its file path.
 * e.g. .../docs/api/API.md → "api"
 */
function deriveDocName(filePath: string): string {
  return basename(filePath, '.md').toLowerCase();
}

// ─── Registry Class ──────────────────────────

export class Registry {
  private skills = new Map<string, SkillManifest>();
  private docs = new Map<string, DocManifest>();
  private personas = new Map<string, PersonaManifest>();
  private references = new Map<string, ReferenceManifest>();

  private config: RegistryConfig;

  constructor(config: RegistryConfig) {
    this.config = config;
  }

  // ─── Build ──────────────────────────────

  /** Scan all roots and populate the in-memory manifests. */
  build(): void {
    this.skills.clear();
    this.docs.clear();
    this.personas.clear();
    this.references.clear();

    // 1. Index global skills (BrainRouter repo) first
    this.indexSkills(this.config.globalRoot, 'global');
    this.indexPersonas(this.config.globalRoot);
    this.indexReferences(this.config.globalRoot);

    // 2. Index local skills — these shadow global on name conflict
    if (this.config.localRoot && this.config.localRoot !== this.config.globalRoot) {
      this.indexSkills(this.config.localRoot, 'local');
      this.indexPersonas(this.config.localRoot);
      this.indexReferences(this.config.localRoot);
      // Local docs (project-specific source-of-truth)
      this.indexDocs(this.config.localRoot);
    }
  }

  // ─── Indexing ───────────────────────────

  private indexSkills(root: string, scope: SkillScope): void {
    const skillsDir = join(root, 'skills');
    const skillFiles = findFiles(skillsDir, 'SKILL.md');

    for (const filePath of skillFiles) {
      const meta = parseSkillFrontmatter(filePath);
      if (!meta) continue; // Skip skills without valid frontmatter

      const category = deriveCategory(filePath, skillsDir);
      const manifest: SkillManifest = {
        name: meta.name,
        category,
        description: meta.description,
        filePath,
        scope,
      };

      this.skills.set(meta.name, manifest);
    }
  }

  private indexPersonas(root: string): void {
    const agentsDir = join(root, 'agents');
    const files = findMdFiles(agentsDir);
    for (const filePath of files) {
      const name = basename(filePath, '.md');
      if (name === 'README') continue;
      this.personas.set(name, { name, filePath });
    }
  }

  private indexReferences(root: string): void {
    const refsDir = join(root, 'references');
    const files = findMdFiles(refsDir);
    for (const filePath of files) {
      const name = basename(filePath, '.md');
      this.references.set(name, { name, filePath });
    }
  }

  private indexDocs(root: string): void {
    const docsDir = join(root, 'docs');
    if (!existsSync(docsDir)) return;

    // Recursively find all .md files under docs/
    function walkDocs(dir: string, results: string[]) {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walkDocs(full, results);
          } else if (entry.endsWith('.md')) {
            results.push(full);
          }
        } catch { /* skip */ }
      }
    }

    const docFiles: string[] = [];
    walkDocs(docsDir, docFiles);

    for (const filePath of docFiles) {
      const name = deriveDocName(filePath);
      const category = deriveDocCategory(filePath, docsDir);
      const stat = statSync(filePath);
      this.docs.set(name, {
        name,
        category,
        filePath,
        lastModified: stat.mtime,
      });
    }
  }

  // ─── Refresh ────────────────────────────

  /** Re-scan after a write operation. */
  refresh(): void {
    this.build();
  }

  // ─── Queries ────────────────────────────

  getSkill(name: string): SkillManifest | undefined {
    return this.skills.get(name);
  }

  listSkills(category?: string, scope?: SkillScope | 'all'): SkillManifest[] {
    let all = Array.from(this.skills.values());
    if (category) all = all.filter((s) => s.category === category);
    if (scope && scope !== 'all') all = all.filter((s) => s.scope === scope);
    return all.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  searchSkills(query: string, scope?: SkillScope | 'all'): Array<SkillManifest & { relevance: string }> {
    const q = query.toLowerCase();
    let all = Array.from(this.skills.values());
    if (scope && scope !== 'all') all = all.filter((s) => s.scope === scope);

    return all
      .filter(
        (s) =>
          s.name.includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.category.includes(q),
      )
      .map((s) => ({
        ...s,
        relevance: s.name.includes(q) ? 'name match' : s.description.toLowerCase().includes(q) ? 'description match' : 'category match',
      }));
  }

  getDoc(name: string): DocManifest | undefined {
    return this.docs.get(name);
  }

  listDocs(category?: DocCategory): DocManifest[] {
    let all = Array.from(this.docs.values());
    if (category) all = all.filter((d) => d.category === category);
    return all.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  getPersona(name: string): PersonaManifest | undefined {
    return this.personas.get(name);
  }

  listPersonas(): PersonaManifest[] {
    return Array.from(this.personas.values());
  }

  getReference(name: string): ReferenceManifest | undefined {
    return this.references.get(name);
  }

  listReferences(): ReferenceManifest[] {
    return Array.from(this.references.values());
  }

  /** The resolved local root (for write operations). */
  getLocalRoot(): string | undefined {
    return this.config.localRoot;
  }

  /** The global root (BrainRouter repo). */
  getGlobalRoot(): string {
    return this.config.globalRoot;
  }
}
