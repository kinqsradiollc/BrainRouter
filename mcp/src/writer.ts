// ─────────────────────────────────────────────
// BrainRouter MCP Server — Safe Writer
// Creates and updates markdown files in localRoot only.
// NEVER writes to globalRoot (BrainRouter repo skills).
// ─────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join, relative, dirname } from 'path';
import matter from 'gray-matter';
import type { SkillSection } from './types.js';

// ─── Safety Guard ────────────────────────────

/**
 * Throws if targetPath is not inside allowedRoot.
 * Prevents writes to the global BrainRouter registry.
 */
function assertInsideRoot(targetPath: string, allowedRoot: string): void {
  const rel = relative(resolve(allowedRoot), resolve(targetPath));
  if (rel.startsWith('..') || resolve(targetPath) === resolve(allowedRoot)) {
    throw new Error(
      `WRITE BLOCKED: "${targetPath}" is outside the allowed local root "${allowedRoot}". ` +
        `Global BrainRouter skills are read-only. Create a local skill instead.`,
    );
  }
}

// ─── Skill Authoring Template ────────────────

/**
 * Generates a canonical SKILL.md from the skill-authoring template structure.
 */
function buildSkillTemplate(params: {
  name: string;
  description: string;
  overview?: string;
  when_to_use?: string;
  workflow?: string[];
  usage?: string;
  checklist?: string[];
}): string {
  const { name, description, overview, when_to_use, workflow, usage, checklist } = params;

  const workflowSection = workflow?.length
    ? workflow.map((step, i) => `${i + 1}. ${step}`).join('\n')
    : '1. [Step 1]\n2. [Step 2]\n3. [Step 3]';

  const checklistSection = checklist?.length
    ? checklist.map((item) => `- [ ] ${item}`).join('\n')
    : '- [ ] [Verification item 1]\n- [ ] [Verification item 2]';

  return `---
name: ${name}
description: ${description}
---

# ${name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')}

## Overview
${overview ?? '[One-two sentences explaining what this skill does and why it matters.]'}

## When to Use
${when_to_use ?? '- [Triggering condition 1]\n- [Triggering condition 2]\n- NOT for: [exclusions]'}

## Workflow

${workflowSection}

## Usage

\`\`\`bash
# [Example command or trigger phrase]
\`\`\`

${usage ? `${usage}\n\n` : ''}## Common Rationalizations

| Rationalization | Reality |
|---|---|
| [Excuse an agent might use to skip a step] | [Why that excuse is wrong] |

## Red Flags
- [Observable sign that this skill is being violated]

## Verification
${checklistSection}
`;
}

// ─── Public API ──────────────────────────────

export interface ScaffoldSkillParams {
  name: string;
  category: string;
  description: string;
  localRoot: string;
  overview?: string;
  when_to_use?: string;
  workflow?: string[];
  usage?: string;
  checklist?: string[];
}

/**
 * Create a new SKILL.md in the local registry.
 * Returns the absolute path of the created file.
 */
export function scaffoldSkill(params: ScaffoldSkillParams): string {
  const { name, category, localRoot, ...rest } = params;
  const skillDir = join(localRoot, 'skills', category, name);
  const skillPath = join(skillDir, 'SKILL.md');

  assertInsideRoot(skillPath, localRoot);

  if (existsSync(skillPath)) {
    throw new Error(
      `Skill "${name}" already exists at "${skillPath}". Use update_skill to modify it.`,
    );
  }

  mkdirSync(skillDir, { recursive: true });
  const content = buildSkillTemplate({ name, ...rest });
  writeFileSync(skillPath, content, 'utf-8');
  return skillPath;
}

// ─── Section Update ──────────────────────────

const UPDATABLE_SECTIONS: Record<string, string[]> = {
  overview:              ['overview'],
  workflow:              ['workflow', 'core process', 'the workflow', 'steps', 'process'],
  usage:                 ['usage', 'example usage', 'examples'],
  detailed_instructions: ['detailed instructions', 'instructions'],
  checklist:             ['verification', 'required checks'],
};

/**
 * Update a named ## section in an existing SKILL.md.
 * If section is "full", replaces the entire body content.
 * Returns the absolute path of the updated file.
 */
export function updateSkillSection(
  filePath: string,
  section: Extract<SkillSection, 'overview' | 'workflow' | 'usage' | 'detailed_instructions' | 'checklist' | 'full'>,
  newContent: string,
  localRoot: string,
): string {
  assertInsideRoot(filePath, localRoot);

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);

  if (section === 'full') {
    // Replace entire body, preserve frontmatter
    const updated = matter.stringify(newContent, parsed.data);
    writeFileSync(filePath, updated, 'utf-8');
    return filePath;
  }

  const aliases = UPDATABLE_SECTIONS[section] ?? [section.replace(/_/g, ' ')];
  const lines = parsed.content.split('\n');
  const result: string[] = [];
  let inTarget = false;
  let replaced = false;

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      const heading = h2Match[1].trim().toLowerCase();
      if (aliases.some((a) => heading.includes(a))) {
        inTarget = true;
        result.push(line); // keep the heading
        result.push('');
        result.push(newContent.trim());
        result.push(''); // Ensure blank line before next section
        replaced = true;
        continue;
      } else if (inTarget) {
        inTarget = false;
      }
    }
    if (!inTarget) result.push(line);
  }

  if (!replaced) {
    // Section not found — append it
    result.push('');
    result.push(`## ${section.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`);
    result.push('');
    result.push(newContent.trim());
    result.push('');
  }

  const updatedBody = result.join('\n');
  const updatedFile = matter.stringify(updatedBody, parsed.data);
  writeFileSync(filePath, updatedFile, 'utf-8');
  return filePath;
}

// ─── Doc Update ─────────────────────────────

/**
 * Update a named ## section in a project doc (API.md, Design.md, etc.).
 * If createIfMissing is true and the section doesn't exist, it is appended.
 * Returns the absolute path of the updated file.
 */
export function updateDocSection(
  filePath: string,
  sectionHeading: string,
  newContent: string,
  localRoot: string,
  createIfMissing = true,
): string {
  assertInsideRoot(filePath, localRoot);

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const result: string[] = [];
  let inTarget = false;
  let replaced = false;

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      const heading = h2Match[1].trim().toLowerCase();
      if (heading.includes(sectionHeading.toLowerCase())) {
        inTarget = true;
        result.push(line);
        result.push('');
        result.push(newContent.trim());
        result.push(''); // Ensure blank line before next section
        replaced = true;
        continue;
      } else if (inTarget) {
        inTarget = false;
      }
    }
    if (!inTarget) result.push(line);
  }

  if (!replaced) {
    if (!createIfMissing) {
      throw new Error(`Section "${sectionHeading}" not found in "${filePath}".`);
    }
    result.push('');
    result.push(`## ${sectionHeading}`);
    result.push('');
    result.push(newContent.trim());
    result.push('');
  }

  writeFileSync(filePath, result.join('\n'), 'utf-8');

  // Ensure the directory for the file exists (already should, but safe)
  mkdirSync(dirname(filePath), { recursive: true });
  return filePath;
}
