/**
 * ADR-029 F3 — templates, as the surface offers them.
 *
 * A template is a page (B4/E3), so there is nothing here about a template TYPE:
 * the questions this file answers are which pages may be marked, what the menu
 * entry reads, and what a person is told about the references inside a template
 * after it has been instantiated.
 *
 * The COPY itself is core's `instantiateTemplate`, including the rule about
 * references — a reference pointing inside the template is rewritten to the
 * copy, one pointing outside is left alone — and including the sentence that
 * says so. That sentence is not re-derived here on purpose: a surface that
 * explained the rewrite in its own words would eventually explain a rule the
 * store no longer implements.
 */

export interface TemplateRowDto {
  id: string;
  title: string;
  icon: string | null;
  /** How many blocks it will bring, so "New page from…" is not a surprise. */
  blocks: number;
}

/**
 * Which blocks may be marked as a template.
 *
 * A container only. Marking a paragraph would offer "new page from this
 * paragraph", which makes a page containing one line — technically a copy,
 * practically a way to discover that the feature does not do what it sounded
 * like.
 */
export function canBeTemplate(kind: string): boolean {
  return kind === 'page' || kind === 'database';
}

export function templateActionLabel(isTemplate: boolean): string {
  return isTemplate ? 'Stop using as a template' : 'Save as a template';
}

/** The row's secondary line: what you get, before you get it. */
export function templateRowHint(row: TemplateRowDto): string {
  if (row.blocks <= 1) return 'An empty page';
  return `${row.blocks} blocks`;
}

/**
 * What the picker says when nothing has been marked.
 *
 * Names the gesture rather than the absence. "No templates" is true and leaves
 * the person no way to make the list non-empty, which is the same dead end F1
 * is about.
 */
export function templatesEmptyNote(): string {
  return 'No templates yet — open a page you want to start from again and choose "Save as a template".';
}

/**
 * The sentence after instantiating, defaulted only when the host said nothing.
 *
 * Core writes it (`describeInstantiation`) because core performed the rewrite
 * and knows how many links moved. The fallback exists so a dropped answer still
 * confirms that something happened, rather than leaving a new page to appear
 * silently and look like a bug.
 */
export function instantiationNote(line: string | null | undefined): string {
  return (line ?? '').trim() || 'New page from the template.';
}
