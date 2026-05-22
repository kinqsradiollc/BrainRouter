// ─────────────────────────────────────────────
// BrainRouter MCP Server — Shared Types
// ─────────────────────────────────────────────

export type SkillScope = 'global' | 'local';

export type DocCategory =
  | 'api'
  | 'design'
  | 'schema'
  | 'deployment'
  | 'hooks'
  | 'strategy'
  | 'other';

/**
 * Every named section extractable from a SKILL.md.
 * Ordered cheapest → most expensive by token count.
 */
export type SkillSection =
  | 'description'           // frontmatter description field only   (~50 tokens)
  | 'overview'              // ## Overview block                     (~100 tokens)
  | 'when_to_use'           // ## When to Use block                  (~150 tokens)
  | 'workflow'              // ## Workflow / Core Process (DEFAULT)  (~300 tokens)
  | 'usage'                 // ## Usage block                        (~200 tokens)
  | 'detailed_instructions' // ## Detailed Instructions block        (~500 tokens)
  | 'phases'                // All ### Phase N sub-blocks            (~400 tokens)
  | 'checklist'             // ## Verification / checklist items     (~150 tokens)
  | 'red_flags'             // ## Red Flags block                    (~150 tokens)
  | 'rationalizations'      // ## Common Rationalizations table      (~200 tokens)
  | 'full';                 // Entire SKILL.md verbatim              (variable)

// ─── Manifests ──────────────────────────────

export interface SkillManifest {
  /** kebab-case slug matching directory name and frontmatter `name` */
  name: string;
  /** subcategory folder: agent | api | devops | lifecycle | design | … */
  category: string;
  /** from YAML frontmatter `description` field */
  description: string;
  /** absolute path to SKILL.md */
  filePath: string;
  /** global = BrainRouter repo; local = downstream project repo */
  scope: SkillScope;
  /** Optional project name for project-specific skills */
  project?: string;
}

export interface DocManifest {
  /** lowercase slug e.g. "api", "design", "schema" */
  name: string;
  category: DocCategory;
  /** absolute path to the doc file */
  filePath: string;
  lastModified: Date;
}

export interface PersonaManifest {
  /** kebab-case e.g. "code-reviewer", "security-auditor" */
  name: string;
  filePath: string;
}

export interface ReferenceManifest {
  /** kebab-case e.g. "security-checklist", "testing-patterns" */
  name: string;
  filePath: string;
}

// ─── Fragment ───────────────────────────────

/** The unit returned to an agent — extracted content + provenance. */
export interface Fragment {
  /** The extracted text content */
  content: string;
  /** Relative path for traceability (e.g. "skills/agent/bootstrap/SKILL.md") */
  source: string;
  /** Only present for skill fragments */
  scope?: SkillScope;
  /** Rough token estimate: Math.ceil(content.length / 4) */
  tokenEstimate: number;
}

// ─── Config ─────────────────────────────────

export interface RegistryConfig {
  /** Absolute path to BrainRouter repo root (always resolved from __dirname) */
  globalRoot: string;
  /** Absolute path to downstream project repo root (optional) */
  localRoot?: string;
  /** Name of the local project (from brainrouter.config.json) */
  localProjectName?: string;
}

/** Shape of brainrouter.config.json in a downstream repo */
export interface BrainRouterConfig {
  project?: string;
  techStack?: string[];
  localSkillsPath?: string;
  localDocsPath?: string;
  activeCategories?: string[];
}

// ─── Tool Result Shapes ──────────────────────

export interface CreateSkillResult {
  created: true;
  path: string;
  tokenEstimate: number;
}

export interface UpdateSkillResult {
  updated: true;
  path: string;
  scope: SkillScope;
}

export interface UpdateDocResult {
  updated: true;
  path: string;
  section: string;
}
