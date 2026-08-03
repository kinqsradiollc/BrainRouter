/**
 * ADR-027 D4 (P8-1) — the shared document substrate: chunking with exact offsets.
 *
 * A document is parsed, structured, and indexed ONCE; each profile derives its
 * own view on top. This is the structural half — turning a document into
 * retrievable chunks that can still be pointed at.
 *
 * The rule D4 states, and the reason it matters:
 *
 *   "structure-aware chunking with a breadcrumb context header stored OUTSIDE
 *    the chunk text so offsets stay exact"
 *
 * The tempting implementation prepends the breadcrumb to the chunk — "Guide >
 * Auth > Tokens\n\n<text>" — because it improves retrieval, the embedding sees
 * the context, and it costs one line of code. It also destroys every offset:
 * the chunk no longer starts where it says it starts, so a citation resolves to
 * the wrong span, and highlighting it in the source highlights the wrong text.
 * The damage is silent, and it grows with breadcrumb length, so the deepest
 * sections — the ones most worth citing — are the most wrong.
 *
 * So the breadcrumb rides alongside as metadata. Retrieval may concatenate it
 * for embedding; the stored offsets stay true to the source.
 */

export interface DocumentSection {
  /** Heading path from the document root, e.g. ['Guide', 'Auth', 'Tokens']. */
  breadcrumb: readonly string[];
  /** Character offset of the section body in the ORIGINAL document. */
  start: number;
  end: number;
  text: string;
}

export interface DocumentChunk {
  /** Position in the document, for stable ids and ordering. */
  index: number;
  /** Chunk text EXACTLY as it appears in the source, no header prepended. */
  text: string;
  /** Offsets into the original document. `text === source.slice(start, end)`. */
  start: number;
  end: number;
  /** Context for retrieval — deliberately NOT part of `text`. */
  breadcrumb: readonly string[];
}

export interface ChunkOptions {
  /** Target chunk size in characters. */
  maxChars: number;
  /**
   * Overlap between adjacent chunks, so a fact spanning a boundary is retrievable
   * from either side. Clamped below maxChars — an overlap at or above it would
   * never advance.
   */
  overlapChars?: number;
}

/**
 * Split markdown into sections with exact offsets.
 *
 * Heading depth builds the breadcrumb: a `###` under a `##` under a `#`
 * inherits both. A heading that skips a level (an `h3` directly under an `h1`)
 * is attached where it lands rather than being "corrected" — real documents do
 * this constantly, and inventing an intermediate level would put a citation
 * under a section that does not exist.
 */
export function sectionsWithOffsets(markdown: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const stack: Array<{ depth: number; title: string }> = [];
  let inFence = false;
  let cursor = 0;
  let bodyStart = 0;
  let current: readonly string[] = [];

  const push = (end: number): void => {
    const text = markdown.slice(bodyStart, end);
    if (text.trim()) {
      sections.push({ breadcrumb: [...current], start: bodyStart, end, text });
    }
  };

  for (const line of markdown.split('\n')) {
    const lineStart = cursor;
    cursor += line.length + 1; // +1 for the newline consumed by split

    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const heading = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (!heading) continue;

    push(lineStart);
    const depth = heading[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    stack.push({ depth, title: heading[2]!.trim() });
    current = stack.map((entry) => entry.title);
    bodyStart = cursor;
  }
  push(markdown.length);

  return sections;
}

/**
 * Chunk a document, preserving exact offsets.
 *
 * Chunks never span sections: a chunk carrying text from two different parts of
 * a document has no honest breadcrumb, and a citation into it points at a place
 * that does not exist as a unit.
 *
 * Splitting prefers a paragraph break, then a sentence end, then a word
 * boundary, and only cuts mid-token as a last resort — a chunk ending
 * mid-sentence retrieves badly and reads worse when shown as a citation.
 */
export function chunkDocument(markdown: string, options: ChunkOptions): DocumentChunk[] {
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  // An overlap at or above the chunk size would never advance the cursor.
  const overlap = Math.max(0, Math.min(Math.floor(options.overlapChars ?? 0), maxChars - 1));
  const chunks: DocumentChunk[] = [];

  for (const section of sectionsWithOffsets(markdown)) {
    let offset = 0;
    while (offset < section.text.length) {
      const remaining = section.text.length - offset;
      let take = Math.min(maxChars, remaining);

      if (take < remaining) {
        const window = section.text.slice(offset, offset + take);
        const boundary = lastBoundary(window);
        if (boundary > 0) take = boundary;
      }

      const start = section.start + offset;
      const end = start + take;
      const text = markdown.slice(start, end);
      if (text.trim()) {
        chunks.push({ index: chunks.length, text, start, end, breadcrumb: section.breadcrumb });
      }

      const advance = Math.max(1, take - (take < remaining ? overlap : 0));
      offset += advance;
    }
  }

  return chunks;
}

/** Best split point in a window: paragraph, then sentence, then word. */
function lastBoundary(window: string): number {
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph > window.length * 0.5) return paragraph + 2;
  const sentence = Math.max(
    window.lastIndexOf('. '), window.lastIndexOf('.\n'),
    window.lastIndexOf('? '), window.lastIndexOf('! '),
  );
  if (sentence > window.length * 0.5) return sentence + 2;
  const space = window.lastIndexOf(' ');
  return space > window.length * 0.5 ? space + 1 : 0;
}

/**
 * The text to embed: breadcrumb prepended for retrieval quality.
 *
 * Computed on demand and never stored on the chunk, which is the whole point —
 * this string and `chunk.text` are different things, and only the latter has
 * offsets that resolve.
 */
export function embeddingText(chunk: DocumentChunk): string {
  return chunk.breadcrumb.length > 0
    ? `${chunk.breadcrumb.join(' > ')}\n\n${chunk.text}`
    : chunk.text;
}

/**
 * Verify every chunk still resolves against its source.
 *
 * Cheap, and it catches the entire class of bug this module exists to prevent:
 * any transformation that alters chunk text without adjusting offsets shows up
 * here rather than as a subtly wrong citation months later.
 */
export function verifyChunkOffsets(markdown: string, chunks: readonly DocumentChunk[]): readonly string[] {
  const problems: string[] = [];
  for (const chunk of chunks) {
    if (markdown.slice(chunk.start, chunk.end) !== chunk.text) {
      problems.push(`Chunk ${chunk.index} does not match source at [${chunk.start}, ${chunk.end})`);
    }
  }
  return problems;
}
