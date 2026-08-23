/**
 * ADR-044 M1 — the structured-markdown floor for fetched pages.
 *
 * `fetch_url` used to flatten a page with cheerio's `$('body').text()`: every
 * table became a run of words, every link lost its href, every code block lost
 * its fences. A model then cited that mush confidently, and the error was
 * invisible because the prose still read fluently — the exact failure ADR-027
 * D10 named and ADR-044 exists to close.
 *
 * This walks the parsed DOM instead of stringifying it, emitting GitHub-flavored
 * markdown: headings as `#`, links as `[text](abs-url)`, code as fenced blocks,
 * lists as `-`/`1.`, and — the load-bearing part — tables through
 * `research/htmlTables`, which refuses to flatten a table it cannot represent as
 * a rectangle rather than shifting values under the wrong headers. Content is
 * isolated to the page's main region first (`[role=main]` → `main` → `article`
 * → `body`) so site chrome does not drown the article.
 *
 * The converter is deliberately a *floor*, not a general HTML→markdown engine:
 * it degrades unknown nodes to their text, bounds output to `maxContentChars`,
 * and never throws — the caller keeps a regex fallback for the pages this cannot
 * parse. Rendered-DOM escalation (JS-heavy pages) is ADR-044 M2.
 */

import { load, type CheerioAPI } from 'cheerio';
import {
  tableToMarkdown,
  unconvertibleTableNote,
  absolutizeUrl,
  type ParsedTable,
  type TableCell,
} from '../research/htmlTables.js';

/**
 * A minimal structural view of a parsed DOM node. cheerio's elements are
 * `domhandler` nodes at runtime, but `domhandler` is only a transitive
 * dependency here — depending on its types directly would add an undeclared
 * dependency for no gain. We touch only these five fields, all present at
 * runtime, so a local shape is both honest and dependency-clean.
 */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
  attribs?: Record<string, string>;
}

/**
 * Inline elements — rendered into the surrounding paragraph rather than
 * breaking a block. `br` is inline but emits a newline. Anything not listed
 * here and not a known block is treated as a generic block and recursed, so an
 * unknown wrapper never swallows its contents.
 */
const INLINE = new Set([
  'a', 'span', 'strong', 'b', 'em', 'i', 'code', 'small', 'sub', 'sup', 'mark',
  'abbr', 'label', 'cite', 'q', 'time', 'u', 's', 'strike', 'del', 'ins', 'var',
  'kbd', 'samp', 'wbr', 'bdi', 'bdo', 'font', 'br', 'img',
]);

/** Non-content subtrees removed before the walk (parity with the old flatten). */
const STRIP_SELECTOR =
  'script,style,noscript,svg,canvas,template,iframe,form,button,input,select,textarea,nav,header,footer,aside';

interface Ctx {
  pageUrl: string;
}

function attr(node: DomNode, key: string): string {
  return node.attribs?.[key] ?? '';
}

function isTag(node: DomNode, name?: string): boolean {
  return node.type === 'tag' && (name === undefined || node.name === name);
}

/** Concatenate all descendant text verbatim — for `<pre>`, where collapsing whitespace would corrupt code. */
function rawText(node: DomNode): string {
  if (node.type === 'text') return node.data ?? '';
  if (!node.children) return '';
  return node.children.map(rawText).join('');
}

function firstDescendant(node: DomNode, name: string): DomNode | null {
  if (isTag(node, name)) return node;
  for (const child of node.children ?? []) {
    const found = firstDescendant(child, name);
    if (found) return found;
  }
  return null;
}

/** A fenced-code language hint from `class="language-ts"` / `class="lang-ts"`, or ''. */
function langFromClass(node: DomNode | null): string {
  if (!node) return '';
  const match = attr(node, 'class').match(/\b(?:language|lang)-([A-Za-z0-9+#.-]+)/);
  return match ? match[1] : '';
}

/** A colspan/rowspan value, clamped to >= 1 (markdown has no spanning cells; htmlTables rejects > 1). */
function spanAttr(node: DomNode, key: string): number {
  const value = Number.parseInt(attr(node, key), 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Collapse runs of whitespace to a single space — inline text only, never code. */
function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function inlineChildren(node: DomNode, ctx: Ctx): string {
  return (node.children ?? []).map((child) => inline(child, ctx)).join('');
}

function inline(node: DomNode, ctx: Ctx): string {
  if (node.type === 'text') return normalizeSpace(node.data ?? '');
  if (!isTag(node)) return '';

  switch (node.name) {
    case 'br':
      return '\n';
    case 'img': {
      const src = attr(node, 'src');
      const alt = normalizeSpace(attr(node, 'alt')).trim();
      if (!src) return alt;
      return `![${alt}](${absolutizeUrl(src, ctx.pageUrl)})`;
    }
    case 'a': {
      const inner = inlineChildren(node, ctx).trim();
      const href = attr(node, 'href');
      if (!href || href.startsWith('javascript:')) return inner;
      const abs = absolutizeUrl(href, ctx.pageUrl);
      return inner ? `[${inner}](${abs})` : abs;
    }
    case 'code': {
      const text = rawText(node).replace(/\s+/g, ' ').trim();
      return text ? `\`${text}\`` : '';
    }
    case 'strong':
    case 'b': {
      const text = inlineChildren(node, ctx).trim();
      return text ? `**${text}**` : '';
    }
    case 'em':
    case 'i': {
      const text = inlineChildren(node, ctx).trim();
      return text ? `*${text}*` : '';
    }
    case 'del':
    case 's':
    case 'strike': {
      const text = inlineChildren(node, ctx).trim();
      return text ? `~~${text}~~` : '';
    }
    default:
      // Generic / unknown inline wrapper — keep its contents, drop the tag.
      return inlineChildren(node, ctx);
  }
}

function isInlineNode(node: DomNode): boolean {
  if (node.type === 'text') return true;
  return isTag(node) && node.name !== undefined && INLINE.has(node.name);
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

/** Render a sequence of sibling nodes at block level, coalescing inline runs into paragraphs. */
function blocks(nodes: readonly DomNode[], ctx: Ctx, depth: number): string {
  const parts: string[] = [];
  let inlineBuf: string[] = [];
  const flush = (): void => {
    const text = inlineBuf.join('').replace(/[ \t]+/g, ' ').trim();
    if (text) parts.push(text);
    inlineBuf = [];
  };
  for (const node of nodes) {
    if (isInlineNode(node)) {
      inlineBuf.push(inline(node, ctx));
      continue;
    }
    flush();
    const rendered = block(node, ctx, depth);
    if (rendered) parts.push(rendered);
  }
  flush();
  return parts.join('\n\n');
}

function block(node: DomNode, ctx: Ctx, depth: number): string {
  if (node.type === 'text') return normalizeSpace(node.data ?? '').trim();
  if (!isTag(node) || node.name === undefined) return '';

  const name = node.name;
  const heading = /^h([1-6])$/.exec(name);
  if (heading) {
    const text = inlineChildren(node, ctx).replace(/\s+/g, ' ').trim();
    return text ? `${'#'.repeat(Number(heading[1]))} ${text}` : '';
  }

  switch (name) {
    case 'p':
      return inlineChildren(node, ctx).replace(/[ \t]+/g, ' ').trim();
    case 'ul':
      return listBlock(node, ctx, depth, false);
    case 'ol':
      return listBlock(node, ctx, depth, true);
    case 'blockquote': {
      const inner = blocks(node.children ?? [], ctx, depth).trim();
      return inner
        ? inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')
        : '';
    }
    case 'pre':
      return preBlock(node);
    case 'table':
      return tableBlock(node, ctx);
    case 'hr':
      return '---';
    default:
      // section / article / main / div / figure / details / … — recurse.
      return blocks(node.children ?? [], ctx, depth);
  }
}

function listBlock(node: DomNode, ctx: Ctx, depth: number, ordered: boolean): string {
  const items = (node.children ?? []).filter((c) => isTag(c, 'li'));
  const pad = '  '.repeat(depth);
  const lines = items.map((li, index) => {
    const marker = ordered ? `${index + 1}.` : '-';
    const content = blocks(li.children ?? [], ctx, depth + 1).trim();
    if (!content) return `${pad}${marker}`;
    const [first, ...rest] = content.split('\n');
    if (rest.length === 0) return `${pad}${marker} ${first}`;
    const contIndent = pad + ' '.repeat(marker.length + 1);
    const continued = rest.map((line) => (line ? contIndent + line : line)).join('\n');
    return `${pad}${marker} ${first}\n${continued}`;
  });
  return lines.join('\n');
}

function preBlock(node: DomNode): string {
  const codeEl = firstDescendant(node, 'code');
  const lang = langFromClass(codeEl ?? node);
  const body = rawText(node).replace(/\n+$/, '');
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function tableBlock(node: DomNode, ctx: Ctx): string {
  const parsed = parseTable(node, ctx);
  if (!parsed) return '';
  const conversion = tableToMarkdown(parsed);
  return conversion.ok ? conversion.markdown : unconvertibleTableNote(conversion.reason, ctx.pageUrl);
}

function parseTable(table: DomNode, ctx: Ctx): ParsedTable | null {
  const trs: DomNode[] = [];
  const collect = (n: DomNode): void => {
    for (const child of n.children ?? []) {
      if (!isTag(child)) continue;
      if (child.name === 'tr') trs.push(child);
      else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot') collect(child);
    }
  };
  collect(table);
  if (trs.length === 0) return null;

  let head: TableCell[] | null = null;
  const rows: TableCell[][] = [];
  trs.forEach((tr, index) => {
    const cells = (tr.children ?? []).filter((c) => isTag(c, 'td') || isTag(c, 'th'));
    if (cells.length === 0) return;
    const parsedCells: TableCell[] = cells.map((c) => ({
      text: inlineChildren(c, ctx).replace(/\s+/g, ' ').trim(),
      colSpan: spanAttr(c, 'colspan'),
      rowSpan: spanAttr(c, 'rowspan'),
    }));
    const allHeader = cells.every((c) => c.name === 'th');
    if (index === 0 && allHeader && head === null) head = parsedCells;
    else rows.push(parsedCells);
  });
  return { head, rows };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Pick the page's main-content root, so site chrome (menus, promos, related
 * links that survived the strip) does not dilute the article. Falls back to
 * `<body>` when no semantic main region carries enough text to be the article,
 * and to the document root when there is no body at all.
 */
function pickMainRoot($: CheerioAPI): DomNode {
  for (const selector of ['[role="main"]', 'main', 'article']) {
    const el = $(selector).first();
    if (el.length > 0 && el.text().trim().length >= 200) {
      return el.get(0) as unknown as DomNode;
    }
  }
  const body = $('body').first();
  if (body.length > 0) return body.get(0) as unknown as DomNode;
  return $.root().get(0) as unknown as DomNode;
}

/** Trim trailing line whitespace and collapse blank-line runs, without touching code indentation. */
function tidy(markdown: string, maxContentChars: number): string {
  return markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxContentChars);
}

/**
 * Convert an HTML document to bounded markdown plus its `<title>`.
 *
 * Never throws: a malformed document yields an empty `markdown`, which the
 * crawler reads as a signal to fall back to its regex extractor.
 */
export function htmlToMarkdown(
  html: string,
  pageUrl: string,
  maxContentChars: number,
): { title: string; markdown: string } {
  const $ = load(html);
  const title = $('title').first().text().trim();
  $(STRIP_SELECTOR).remove();
  const root = pickMainRoot($);
  const markdown = tidy(blocks(root.children ?? [], { pageUrl }, 0), maxContentChars);
  return { title, markdown };
}
