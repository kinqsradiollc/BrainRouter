// ─────────────────────────────────────────────
// BrainRouter MCP Server — Markdown Loader
// Reads and extracts sections from any markdown file on demand.
// ─────────────────────────────────────────────

import { readFileSync } from 'fs';
import matter from 'gray-matter';
import type { Fragment, SkillSection, SkillScope } from './types.js';

/** Estimate token count: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Heading aliases: maps SkillSection keys → possible ## heading strings.
 * We match case-insensitively. First match wins.
 */
const SECTION_HEADINGS: Record<Exclude<SkillSection, 'description' | 'full' | 'phases' | 'checklist'>, string[]> = {
  overview:              ['overview'],
  when_to_use:           ['when to use', 'when to invoke', 'triggers'],
  workflow:              ['workflow', 'core process', 'the workflow', 'steps', 'process', 'checklist', 'methodology', 'routine', 'guidelines', 'patterns', 'template', 'structure', 'lifecycle'],
  usage:                 ['usage', 'example usage', 'examples'],
  detailed_instructions: ['detailed instructions', 'instructions', 'detailed guide'],
  red_flags:             ['red flags', 'warning signs'],
  rationalizations:      ['common rationalizations', 'rationalizations'],
};

/**
 * Split a markdown body (after frontmatter) into { heading, content } blocks.
 * Only splits on ## level headings.
 */
function splitSections(body: string): Array<{ heading: string; content: string }> {
  const lines = body.split('\n');
  const sections: Array<{ heading: string; content: string }> = [];
  let currentHeading = '__preamble__';
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      sections.push({ heading: currentHeading, content: currentLines.join('\n').trim() });
      currentHeading = h2Match[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  sections.push({ heading: currentHeading, content: currentLines.join('\n').trim() });
  return sections;
}

/**
 * Extract all ### Phase N sub-blocks from a body string.
 */
function extractPhases(body: string): string {
  const lines = body.split('\n');
  const phaseLines: string[] = [];
  let inPhase = false;

  for (const line of lines) {
    if (/^###\s+phase/i.test(line)) {
      inPhase = true;
    } else if (/^##\s/.test(line)) {
      inPhase = false;
    }
    if (inPhase) phaseLines.push(line);
  }

  return phaseLines.join('\n').trim();
}

/**
 * Extract all checklist items (- [ ] or - [x]) from a body string.
 */
function extractChecklist(body: string): string {
  return body
    .split('\n')
    .filter((l) => /^- \[[ x]\]/.test(l))
    .join('\n')
    .trim();
}

// ─── Public API ─────────────────────────────

/**
 * Load the entire file verbatim (minus frontmatter, which is prepended cleanly).
 */
export function loadFull(filePath: string, scope?: SkillScope): Fragment {
  const raw = readFileSync(filePath, 'utf-8');
  const { content } = matter(raw);
  return {
    content: content.trim(),
    source: filePath,
    scope,
    tokenEstimate: estimateTokens(content),
  };
}

/**
 * Load only the frontmatter description field.
 */
export function loadDescription(filePath: string, scope?: SkillScope): Fragment {
  const raw = readFileSync(filePath, 'utf-8');
  const { data } = matter(raw);
  const content = (data.description as string) ?? '';
  return {
    content,
    source: filePath,
    scope,
    tokenEstimate: estimateTokens(content),
  };
}

/**
 * Load a named ## section from a markdown file.
 */
export function loadSection(
  filePath: string,
  sectionKey: Exclude<SkillSection, 'description' | 'full' | 'phases' | 'checklist'>,
  scope?: SkillScope,
): Fragment {
  const raw = readFileSync(filePath, 'utf-8');
  const { content } = matter(raw);
  const sections = splitSections(content);
  const aliases = SECTION_HEADINGS[sectionKey];

  let match = sections.find((s) =>
    aliases.some((alias) => s.heading.toLowerCase().includes(alias)),
  );

  // FALLBACK for Overview: If ## Overview is missing, use the preamble (text before first ##)
  if (!match && sectionKey === 'overview') {
    const preamble = sections.find(s => s.heading === '__preamble__');
    if (preamble && preamble.content.length > 20) {
      match = { heading: 'Overview', content: preamble.content };
    }
  }

  const extracted = match
    ? `## ${match.heading}\n\n${match.content}`
    : `<!-- Section "${sectionKey}" not found in ${filePath} -->`;

  return {
    content: extracted.trim(),
    source: filePath,
    scope,
    tokenEstimate: estimateTokens(extracted),
  };
}

/**
 * Load all ### Phase N sub-blocks.
 */
export function loadPhases(filePath: string, scope?: SkillScope): Fragment {
  const raw = readFileSync(filePath, 'utf-8');
  const { content } = matter(raw);
  const phases = extractPhases(content);
  const result = phases || `<!-- No phase blocks found in ${filePath} -->`;
  return {
    content: result,
    source: filePath,
    scope,
    tokenEstimate: estimateTokens(result),
  };
}

/**
 * Load all checklist items from the file.
 */
export function loadChecklist(filePath: string, scope?: SkillScope): Fragment {
  const raw = readFileSync(filePath, 'utf-8');
  const { content } = matter(raw);
  const checklist = extractChecklist(content);
  const result = checklist || `<!-- No checklist items found in ${filePath} -->`;
  return {
    content: result,
    source: filePath,
    scope,
    tokenEstimate: estimateTokens(result),
  };
}

/**
 * Master dispatcher: load the correct fragment based on SkillSection.
 */
export function loadSkillSection(
  filePath: string,
  section: SkillSection,
  scope?: SkillScope,
): Fragment {
  switch (section) {
    case 'description':
      return loadDescription(filePath, scope);
    case 'full':
      return loadFull(filePath, scope);
    case 'phases':
      return loadPhases(filePath, scope);
    case 'checklist':
      return loadChecklist(filePath, scope);
    default:
      return loadSection(filePath, section, scope);
  }
}

/**
 * Load a named ## heading from any markdown doc file (used for get_template_doc).
 */
export function loadDocSection(filePath: string, sectionHeading?: string): Fragment {
  const raw = readFileSync(filePath, 'utf-8');
  const { content } = matter(raw);

  if (!sectionHeading) {
    return {
      content: content.trim(),
      source: filePath,
      tokenEstimate: estimateTokens(content),
    };
  }

  const sections = splitSections(content);
  const match = sections.find((s) =>
    s.heading.toLowerCase().includes(sectionHeading.toLowerCase()),
  );

  const extracted = match
    ? `## ${match.heading}\n\n${match.content}`
    : `<!-- Section "${sectionHeading}" not found in ${filePath} -->`;

  return {
    content: extracted.trim(),
    source: filePath,
    tokenEstimate: estimateTokens(extracted),
  };
}
