# ADR-030 — Documents the agent can actually read

**Status:** PROPOSED — planning only. Nothing here is built, and nothing should be until this is approved.
**Depends on:** ADR-027 (attachments, input modality), ADR-029 (notes, the workspace address space).

---

## 1. The problem

Someone attaches a PDF and asks a question about it. What the agent receives is, for most real
documents, **printable ASCII runs scavenged out of the file's binary.**

That is not a characterisation, it is what the code says it does. `attachment/format/pdfText.ts:4-12`
states the design plainly:

> Real-world PDFs are a mess: most content streams are FlateDecode-compressed, which we cannot
> inflate without a dependency. […] when nothing usable is found, it falls back to printable ASCII
> runs harvested from the text-ish regions of the file.

So the pipeline is honest with itself and the failure is still invisible where it matters. The
extracted string flows through `attachment/ingest/ingest.ts:113` into `extractedText`, and from there
into the turn. The agent cannot tell scavenged noise from a document, so it answers anyway — and an
answer built on noise is indistinguishable from an answer built on the file, right up until it is
wrong about something that mattered.

> **This is B1's rule from ADR-028, applied to input rather than output: do not present a state you
> have not established.** We present "here is the document" when what we have is a guess.

### 1.1 One premise in that comment is false

**`node:zlib` is a Node builtin, and it inflates FlateDecode.** Nothing needed to be added to the
dependency tree; `packages/core/src` never imports `node:zlib` anywhere. The single sentence that
shaped this module — *we cannot inflate without a dependency* — was wrong when it was written, and
everything downstream inherited it.

That makes the first decision below unusually cheap, and it is also a warning about the rest: the
reason this shipped is that nobody tried a real PDF and read what came out.

---

## 2. What "reading a document" actually requires

Inflating the streams gets us *characters*. It does not get us a document. A PDF stores glyphs at
coordinates; it does not store paragraphs, headings, reading order, or tables. Everything a reader
perceives has to be reconstructed:

| | |
|---|---|
| **Classification** | Is this text, or is it a scan? A scanned page has no text to extract at any effort, and treating one as empty is a silent wrong answer. |
| **Reading order** | Two-column layouts interleave into nonsense when read by Y-position alone. |
| **Structure** | Headings are font-size ratios, lists are glyph prefixes, code is a monospace run. None of it is tagged. |
| **Tables** | Either ruled rectangles from drawing operators, or inferred from column alignment. A table flattened into prose is worse than a table omitted, because the numbers survive and their meaning does not. |
| **Encodings** | CID/Type0 fonts need `ToUnicode` CMap decoding. Without it the characters come out as plausible-looking wrong letters — the worst failure mode available, because it reads as text. |

We have **none** of these. We also have no OCR anywhere in the repository, so a scanned document has
no path at all.

---

## 3. Decisions to make (this is the part needing approval)

### D1 · Inflate the streams — do this regardless

Use `node:zlib` for FlateDecode (and the other standard filters where they are one call). This is
small, has no supply-chain cost, and moves the common case from *scavenged noise* to *real
characters in roughly the right order*.

It does **not** give reading order, tables, or headings. It should not be described as solving this
ADR — it removes the most embarrassing failure while the real decision is made.

### D2 · Build the document model, or adopt one

The honest options:

| | |
|---|---|
| **Build it in TypeScript** | Full control, no native artifacts, and we own every encoding bug. This is a year of other people's accumulated edge cases — CMaps, Type0 fonts, malformed xrefs, column detection — and we would be learning them in production. |
| **Adopt a published parser** *(recommended)* | A mature Rust implementation with Node and WebAssembly bindings exists under a permissive licence, benchmarked well ahead of the common Python tooling on reading order and table structure. We would get classification, positioned extraction, and Markdown conversion at once. |

**The cost of adopting is native artifacts**, and that is a real cost for us specifically, because we
ship four ways: an npm CLI, an Electron desktop app on three platforms, a Docker backend, and a
Cloudflare-hosted dashboard. A native binding is fine in the first three and impossible in the
fourth; the WebAssembly build covers the fourth and the browser. **Whatever we choose must degrade to
D1 when the binary for a platform is absent**, rather than failing the attachment.

> **A document parser that is unavailable on one platform must produce a worse answer there, never an
> error.** Someone on an unsupported architecture attaching a PDF should get inflated text and a note
> saying structure was unavailable.

### D3 · Classification decides routing, and the answer is stated

Classify before extracting: text / scanned / image / mixed, per page. Then:

- **text** — extract locally, no external call, no cost;
- **scanned** — say so. Do not return an empty string that reads as an empty document. If OCR is
  configured, route to it; if not, the honest output is *"this document is a scan; no text layer
  exists"*, which lets the person decide.

The per-page split matters: a report with three scanned exhibits at the back is *mixed*, and treating
the whole file as either kind is wrong in one direction or the other.

### D4 · Extracted text is UNTRUSTED, and PDFs are hostile input

Two separate risks, and neither is hypothetical.

1. **A PDF is attacker-controlled.** It arrives by upload, by connector sync, by a URL the agent
   fetched. A parser is an attack surface — malformed xref tables, decompression bombs, deeply nested
   object graphs. Any parser we adopt or build gets a byte cap, a page cap, a time budget, and a
   memory bound, and it runs where a crash is contained.
2. **The text goes into the agent's context.** A PDF can contain "ignore your instructions" as easily
   as a web page can, and it can hide it in white-on-white text a human reviewer will not see.
   ADR-029 C4 already built the fence for exactly this class of content — extracted document text
   goes through it, and does not get its own path.

### D5 · Where the output lands

The parse produces structured Markdown, which is the same shape ADR-029's notes already store. That
suggests the natural landing places, and they should be decided together rather than one at a time:

- an **attachment** the agent reads in a turn (today's path, improved);
- a **note** — an imported document becomes a page of blocks, addressable at
  `brainrouter://notes/block/…` like anything else (ADR-029 A1);
- **memory** — a document worth remembering is distilled through the existing pipeline rather than a
  new one.

The reference system is what makes this worth doing beyond "better text": a cited paragraph of a
contract can be linked from a planner item, a Track work item, or a meeting.

---

## 4. What this is not

- **Not an OCR service.** D3 routes to one if configured; building one is a different ADR.
- **Not a document editor.** Notes edit blocks; this produces them.
- **Not every format at once.** PDF is the one that is silently broken today. DOCX, XLSX and slides
  are real gaps with a different shape — they are structured formats where the structure is *present*
  and merely unread, which is a much smaller problem than reconstructing one that was never recorded.

---

## 5. Open questions

1. **Does the native binding survive our packaging?** The Electron build, the npm publish, and the
   Docker image all have to carry or fetch a per-platform artifact. This needs a real spike, not an
   assumption — it is the question most likely to invalidate D2's recommendation.
2. **What is the size budget?** The dashboard is Cloudflare-hosted and the desktop renderer has a
   1,750,000-byte initial-JavaScript limit that ADR-029 already had to lazy-load Notes to stay under.
   A WebAssembly parser must be lazy and must be measured before it is adopted.
3. **Where does parsing run for the hosted product?** In the backend, per tenant, with the same
   bounded-queue treatment ADR-027 D12 gave other work — or in the client, which keeps the document
   off our infrastructure entirely. These have different privacy stories and the answer should be
   chosen deliberately.
4. **What happens to the 20,000-character cap?** It exists because context is finite, not because
   documents are short. With real structure available, the better answer is probably a summary plus
   addressable sections the agent can ask for — which is ADR-029's reference system doing work.

---

## 6. How this will be judged

Not by whether a PDF produces text. It produces text today.

**The test is a two-column research paper with a table and a scanned appendix**, and three questions
about it whose answers live in the second column, in the table, and in the appendix. Getting the
first two right is the parser working. Saying *"the appendix is a scan and I cannot read it"* —
rather than answering from nothing — is the whole ADR.
