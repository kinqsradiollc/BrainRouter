const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "details", "dialog",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav",
  "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "ul",
]);

const OMIT_CONTENT_ELEMENTS = new Set([
  "head", "noscript", "script", "style", "template",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  emsp: " ",
  ensp: " ",
  gt: ">",
  hellip: "…",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  reg: "®",
  trade: "™",
};

/**
 * Extract visible text from an already-bounded HTML string without loading a
 * DOM, resolving resources, or retaining tag attributes. This is deliberately
 * a text extractor rather than an HTML sanitizer: markup never crosses the
 * persistence boundary.
 */
export function extractKnowledgeHtmlText(html: string): string {
  const output: string[] = [];
  const omitted: string[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    const textEnd = tagStart === -1 ? html.length : tagStart;
    if (omitted.length === 0 && textEnd > cursor) {
      output.push(decodeHtmlEntities(html.slice(cursor, textEnd)));
    }
    if (tagStart === -1) break;

    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      cursor = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(html, tagStart + 1);
    if (tagEnd === -1) break;
    const tag = parseTag(html.slice(tagStart + 1, tagEnd));
    cursor = tagEnd + 1;
    if (!tag) continue;

    if (tag.closing) {
      const omittedIndex = omitted.lastIndexOf(tag.name);
      if (omittedIndex !== -1) omitted.splice(omittedIndex, 1);
      if (omitted.length === 0 && BLOCK_ELEMENTS.has(tag.name)) output.push("\n");
      continue;
    }

    if (OMIT_CONTENT_ELEMENTS.has(tag.name) && !tag.selfClosing) {
      omitted.push(tag.name);
      continue;
    }
    if (omitted.length === 0 && BLOCK_ELEMENTS.has(tag.name)) output.push("\n");
  }

  return normalizeExtractedText(output.join(""));
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseTag(rawTag: string): { name: string; closing: boolean; selfClosing: boolean } | null {
  const trimmed = rawTag.trim();
  if (!trimmed || trimmed[0] === "!" || trimmed[0] === "?") return null;
  const closing = trimmed[0] === "/";
  const body = closing ? trimmed.slice(1).trimStart() : trimmed;
  const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(body);
  if (!nameMatch) return null;
  return {
    name: nameMatch[0].toLowerCase(),
    closing,
    selfClosing: !closing && /\/\s*$/.test(body),
  };
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi, (entity, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    const hexadecimal = body[1]?.toLowerCase() === "x";
    const digits = body.slice(hexadecimal ? 2 : 1);
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isInteger(codePoint)
      || codePoint < 0x20
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return " ";
    }
    return String.fromCodePoint(codePoint);
  });
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
