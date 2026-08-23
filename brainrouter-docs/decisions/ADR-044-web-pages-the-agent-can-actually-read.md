# ADR-044 — Web pages the agent can actually read

**Status:** PROPOSED — awaiting owner acceptance. · **Builds on:** ADR-030 (documents the
agent can actually read — the `DocumentArtifact` shape, the note landing, the untrusted-content
fence), ADR-029 (notes + the `brainrouter://` address space + the C4 untrusted-content boundary),
ADR-027 D10 (which already wrote — but never wired — the HTML→markdown and page-readiness logic),
ADR-018 (the memory-native ingestion pattern). · **Supersedes:** nothing.

**Date:** 2026-08-23

> `fetch_url` fetches a page and hands the model `cheerio $('body').text()` — every heading, table,
> code block and link flattened to a run of prose, capped at 15,000 characters, then thrown away
> when the turn ends. The page cannot be re-opened, cannot be cited, and never reaches memory. This
> is the web analogue of the "scavenged PDF noise" ADR-030 fixed for local documents. The fix is
> mostly *wiring*, not invention: the table→markdown converter and the page-readiness detector
> already exist in the tree with tests and no caller. **Make a fetched page a first-class,
> structured, addressable, recallable artifact — the same shape a read local document already is.**

---

## 1. Where the code is today

`fetch_url` (`extension/builtin/handlers/websearch.ts:20-56`) routes to one of two extractors, and
**neither produces Markdown**:

- **The HTTP crawler** (`websearch/crawler.ts`). `extractHtml` (`crawler.ts:56-68`) strips
  `script/style/nav/header/footer/aside`, turns `<li>` into `"- "`, appends `\n` after block tags,
  then calls **`$('body').text()`** — which discards every remaining tag and keeps only text nodes.
  Result: headings lose their `#`, **table cells concatenate with no delimiter** (a `<tr>` gets a
  trailing newline but `<td>`/`<th>` get nothing — `crawler.ts:63`), code blocks lose their fences,
  and **every `href` is gone**. Bounded to `maxContentChars` = 15,000 (`config.ts:504`).
- **The in-app browser** (`websearch/inAppBrowser.ts`). `fetchViaInAppBrowser` returns
  `document.body.innerText` — rendered, post-JS, session-authenticated, and equally flattened. The
  one path that captures real rendered HTML, `fetchHtmlViaInAppBrowser` (`page.html` →
  `document.documentElement.outerHTML`), is wired **only** to `web_search`'s results-page parse and
  is never surfaced as fetched content.

And it is ephemeral. `fetch_url`/`web_search` return a JSON string into the turn and persist nothing
(no `ingestSource`, no artifact, no note). A page is citeable later only if the agent hand-copied a
quote into a `research_note`; the body itself is unrecoverable. (`agent.ts:273` even imports
`fetchAndExtract` and never calls it — a dead import.)

**The decisive fact: the missing capability is already half-built and unwired.** ADR-027 D10 landed
two pure, tested modules that nothing in the live path imports (confirmed — their only references are
their own files and `tests/`):

- `research/htmlTables.ts` — a conservative HTML-table → GFM-markdown converter (`tableToMarkdown`,
  `escapeCell`, `absolutizeUrl`, `unconvertibleTableNote`). Its header comment states the goal
  verbatim: *"A page read becomes a stored artifact the agent cites later … tables must survive
  HTML→markdown conversion."*
- `browser/pageCapture.ts` — `tableToMarkdown` (GFM), **`assessReadiness`** (consent-wall /
  empty-shell / JS-render detection), and `planTabLifecycle`.

This ADR is therefore small in new code and large in payoff: connect what exists, add the structured
converter the crawler lacks, and give the result somewhere durable to land.

---

## 2. What "reading a web page" actually requires

1. **Main-content isolation.** A page is mostly chrome — nav, ads, cookie walls, related-links. The
   answerable content is one subtree. Flattening the whole `<body>` buries it.
2. **Structure preserved as Markdown.** Headings as headings, tables as pipe tables, code as fenced
   blocks with a language, lists as lists, and **links with their targets** — because "the docs say
   to call `POST /v1/x`" is a link the agent must be able to follow, and a comparison table is
   worthless as space-joined cells.
3. **The JS-rendered vs static split.** Modern pages ship an empty shell and paint content with
   JavaScript; a raw fetch of those returns nothing. But rendering every page in a real browser is
   the expensive exception, not the rule.
4. **Untrusted by construction.** A fetched page is attacker-controlled bytes: an SSRF vector on the
   way in and a prompt-injection vector on the way out.
5. **Durable and citeable.** If a page was worth reading, its answer is worth recalling next session
   with a provenance trail back to the exact URL and span — not re-fetched from scratch and not lost.

---

## 3. Decisions (the part that needs approval)

**D1 · Structured Markdown is the floor, and it replaces the flatten.** `fetch_url` returns Markdown,
not `$('body').text()`. The pipeline, in order: (a) **main-content isolation** by a DOM score of
text-to-markup density with a selector floor (`[role=main]` → `<main>` → `<article>` → `<body>`) and a
*quality-scored ensemble* — run more than one extractor, score each by length-minus-boilerplate, and
discard any fallback that drops more than ~80% of the previous result (the guard that protects
non-English and unusual pages); (b) a **DOM-walk-to-Markdown** over the isolated subtree — GFM pipe
tables (wiring the existing `htmlTables.ts`), fenced code blocks with a language tag, a verbatim
depth-guard so `<pre>` content is never reflowed, and `[text](href)` / `![alt](src)` with a
caller-side toggle to strip them for token savings. **No LLM cleanup on the default path** — none of
the mature reference pipelines use one, and it would put an untrusted-input model call on the hot
path. The 15,000-char cap becomes a *structured* truncation (whole sections, with an explicit
"[N sections omitted]" marker) rather than a mid-sentence slice.

**D2 · Static first; render on a cheap signal.** Keep the HTTP crawler as the default fetcher. Escalate
to the rendered DOM (the desktop `browserControlPort`'s already-captured post-JS `page.html`, routed
through the *same* D1 converter) only when a pre-check fires: an SPA-shell marker in the raw HTML
(`__NEXT_DATA__`, `data-reactroot`, `id="root"`, an `enable JavaScript` `<noscript>`, …) **or**
isolated content below a small length floor. `assessReadiness` (already built) is that gate. Hosts
without a browser (CLI, server) stay on the crawler — structured markdown from static HTML is still
the large win over today's flatten. `looksStructuredUrl` keeps JSON/XML/CSV/feed/`/api/` URLs on the
crawler untouched (Markdown conversion would corrupt them).

**D3 · A fetched page is untrusted and hostile — reuse the existing fences, add none.** Bytes come in
only through the shared SSRF chokepoint (`net/guardedFetch.ts` — per-hop private/loopback/metadata
block, byte and redirect caps); this ADR forks none of it. The produced Markdown is wrapped in the
ADR-029 **C4 untrusted-content boundary** (the same fence a read document gets), so page text can
never be read as instructions. Obey `robots`. On an anti-bot interstitial (Cloudflare/403 markers)
**detect and degrade with a clear reason** — never attempt to defeat a CAPTCHA or a paywall.

**D4 · Where the output lands — turn, then optionally durable.** Every fetch improves the *turn*
(D1). Beyond that, a fetch may land as a first-class artifact using ADR-030's `DocumentArtifact`
shape (addressable parts under `brainrouter://document/…`) and, on request, as a note via the
existing `importDocumentAsNote`. The durable landing is opt-in per fetch, not automatic — most fetches
are transient lookups.

**D5 · Recall + provenance, on the memory spine that already exists — no new table.** A durable web
capture follows the ADR-018 pattern exactly: raw Markdown → one `SourceDocument` via `ingestSource()`
(chunked, citeable, idempotent by content hash; reuse `SourceDocumentKind`); a small set of summary
`CognitiveRecord`s written through the single redaction/length chokepoint (`upsertEngineeringMemory`)
tagged `metadata.kind:"web"`; and `store.linkRecordSources(...)` binding each summary to its source
chunks so a recalled claim traces back to the **URL and the exact span**. Distillation runs on the
existing deferred pipeline (`captureTurn` backgrounds it) so no reply blocks. No `web_pages` schema —
`memory` + `memory_jobs` already cover it (ADR-018's central discipline).

---

## 4. What this is not

- **Not a site crawler or archiver.** One page per fetch, on demand. No link-following, no sitemap
  walk, no offline mirror.
- **Not a JS-app automation framework.** D2 renders to *read* content; driving a web app is
  `computer_use` / the browser's own controls, not `fetch_url`.
- **Not a CAPTCHA/paywall defeater.** Blocked is reported, never bypassed (D3).
- **Not every non-HTML format at once.** PDFs and office documents fetched by URL are the *document*
  plane's job (ADR-030); this ADR routes them there rather than re-implementing extraction.
- **Not an LLM-rewrite cleaner.** Structure comes from the DOM, deterministically (D1).

---

## 5. Dependency-ordered delivery board

Each row is one pull request. M1 is the whole point and stands alone; the rest are additive.

- **M1 — Structured markdown in the turn.** Wire `htmlTables.ts` + a main-content isolator + a
  DOM-walk converter into `crawler.ts`/`fetch_url`, replacing `$('body').text()`. Structured
  truncation. Byte-for-byte no change to the SSRF path or the tool's shape — only the `text` field
  gets better. *This is the 80% of the value.*
- **M2 — Rendered-DOM escalation.** Route the desktop `page.html` through the M1 converter; gate
  static→rendered on `assessReadiness` + the SPA/length pre-check.
- **M3 — Durable landing.** A fetched page can become a `DocumentArtifact` / note (ADR-030 machinery).
- **M4 — Memory-native ingest + provenance recall.** `ingestSource` + summary records +
  `linkRecordSources` + deferred distillation (ADR-018 pattern); recall a page next session, cite the
  span.
- **M5 — Robustness tail.** `robots`, anti-bot detect-and-degrade, and routing fetched PDFs/office
  files to the ADR-030 document plane.

---

## 6. How this will be judged

Pick one real, structure-heavy page — an API reference with a **parameters table**, a **fenced code
example**, and **in-body links** to other endpoints. Ask questions whose answers live *in* that
structure:

1. "What type is the `limit` parameter, and what is its default?" — answerable only if the table's
   columns survived (today they concatenate into noise).
2. "Give me the exact example request." — answerable only if the code block kept its fences.
3. "What endpoint does 'see pagination' link to?" — answerable only if the `href` survived (today it
   is gone).

Then, for M4: fetch the page, open a **new session**, and ask the same questions. The answer must come
from recall, and its provenance must resolve to the page's URL and the specific span — not a
re-fetch, not a hallucination. A fetch that cannot pass (1)–(3) is the flatten this ADR exists to
retire.
