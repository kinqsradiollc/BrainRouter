/**
 * ADR-027 D10 (P7-1/P7-2) — a page read becomes a durable, citable artifact.
 *
 * Today a page read is scraped into the transcript as plain text. That has two
 * costs the debt program cares about: the same page is re-fetched every session
 * (knowledge debt — nothing accumulates), and a claim derived from it cannot be
 * checked, because there is nothing stable to point at.
 *
 * An artifact fixes both. It carries provenance — title, source URL, fetch time
 * — and splits into ADDRESSABLE SECTIONS, so a research claim cites
 * `artifactId#anchor` and a reader can go straight to the sentence it came
 * from. "Every research claim must carry a reference" is only enforceable once
 * a reference is a thing that exists.
 *
 * Two conversion defects this module exists to prevent, both named in D10:
 *
 *   - RELATIVE URLS. A link captured as `/docs/auth` is worthless once the page
 *     is stored away from its origin, and silently so — it still looks like a
 *     link. Absolutization happens at capture, while the base URL is known.
 *   - ANCHOR COLLISIONS. Two sections named "Overview" that resolve to the same
 *     anchor make a citation ambiguous, which is worse than having no anchor:
 *     it points confidently at possibly the wrong place.
 */

export interface PageSection {
  /** Stable, unique slug for citing this section. */
  anchor: string;
  /** Heading text, or the document title for content before the first heading. */
  heading: string;
  /** Heading depth; 0 for the lead section. */
  depth: number;
  /** Markdown body of this section, excluding its own heading line. */
  content: string;
}

export interface PageArtifact {
  title: string;
  /** Absolute source URL. */
  url: string;
  /** ISO timestamp of capture — supplied by the caller, never invented here. */
  fetchedAt: string;
  markdown: string;
  sections: readonly PageSection[];
}

/** Slugify a heading for use as an anchor. */
function slugify(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'section';
}

/**
 * Rewrite relative links and image sources against the page's own URL.
 *
 * Left alone: absolute URLs, protocol-relative URLs, and non-navigational
 * schemes (`mailto:`, `tel:`, `data:`, in-page `#fragments`). Rewriting a
 * `data:` URI against a base would corrupt it.
 */
export function absolutizeUrls(markdown: string, baseUrl: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    // Without a usable base we cannot resolve anything; returning the input
    // unchanged is honest, whereas guessing a base would fabricate links.
    return markdown;
  }

  return markdown.replace(
    /(!?\[[^\]]*\])\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
    (match, label: string, href: string, title: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
        return match;
      }
      try {
        return `${label}(${new URL(href, base).href}${title})`;
      } catch {
        return match;
      }
    },
  );
}

/**
 * Split markdown into addressable sections on ATX headings.
 *
 * Content before the first heading becomes the lead section at depth 0, so a
 * page whose substance sits above its first `##` is still citable. Fenced code
 * is respected — a `#` comment inside a shell block is not a heading, and
 * treating it as one would shatter the document at arbitrary points.
 */
export function sliceIntoSections(markdown: string, documentTitle = 'Introduction'): PageSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: PageSection[] = [];
  const used = new Map<string, number>();

  const anchorFor = (heading: string): string => {
    const base = slugify(heading);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    // Collisions get a suffix rather than sharing an anchor: an ambiguous
    // citation points confidently at possibly the wrong place.
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };

  let current: PageSection = {
    anchor: anchorFor(documentTitle),
    heading: documentTitle,
    depth: 0,
    content: '',
  };
  const body: string[] = [];
  let inFence = false;

  const flush = (): void => {
    current.content = body.join('\n').trim();
    // Keep the lead section only if it actually holds something.
    if (current.depth > 0 || current.content) sections.push(current);
    body.length = 0;
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence ? line.match(/^(#{1,6})\s+(.*\S)\s*$/) : null;
    if (heading) {
      flush();
      const text = heading[2]!.trim();
      current = { anchor: anchorFor(text), heading: text, depth: heading[1]!.length, content: '' };
      continue;
    }
    body.push(line);
  }
  flush();

  return sections;
}

/**
 * Build a citable artifact from a captured page.
 *
 * `fetchedAt` is required rather than defaulted to now: an artifact records
 * when the page WAS read, and a module that invents that timestamp will
 * eventually stamp a cached read with the wrong time.
 */
export function buildPageArtifact(input: {
  title: string;
  url: string;
  markdown: string;
  fetchedAt: string;
}): PageArtifact {
  const title = input.title.trim() || input.url;
  const markdown = absolutizeUrls(input.markdown, input.url);
  return {
    title,
    url: input.url,
    fetchedAt: input.fetchedAt,
    markdown,
    sections: sliceIntoSections(markdown, title),
  };
}

/**
 * Resolve a citation of the form `#anchor` against an artifact.
 *
 * Returns null for an unknown anchor rather than the nearest match: a citation
 * that silently resolves to a different section is exactly the failure the
 * anchors exist to prevent.
 */
export function resolveCitation(artifact: PageArtifact, anchor: string): PageSection | null {
  const wanted = anchor.replace(/^#/, '');
  return artifact.sections.find((section) => section.anchor === wanted) ?? null;
}
