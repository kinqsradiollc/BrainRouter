# ADR-030 — Documents the agent can actually read

**Status:** ACCEPTED — approved by the owner, who delegated the open questions. §5 answers them from a spike rather than from judgement.
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

### D2 · Adopt a published parser, and take the **WebAssembly** build everywhere

Measured, not assumed. Both were run against `presentation/BrainRouter-Investor-Deck.pdf` — 433 KB,
13 pages, one of our own documents:

| | Result |
|---|---|
| **What we ship today** | 20,000 characters of binary noise — `2 0 obj bl0$ s eI6 U"k' ;r @\` M_<2% F-x{ t6Qa …` — filling the entire cap |
| **Reference, native binding** | `TextBased`, **41 ms**, 5,104 characters of clean Markdown with real headings |
| **Reference, WebAssembly** | `TextBased`, **116 ms**, byte-identical output |

The first row is the ADR. Attach that deck today and ask a question about it, and the agent answers
from twenty thousand characters of scavenged binary.

**The native binding is rejected, and the reason is our own build matrix.** Its prebuilt platforms
are linux x64/arm64 (gnu and musl), darwin-arm64 and win32-x64 — and

> **there is no `darwin-x64` build, while our desktop ships macOS `x64` dmg and zip.**

Adopting it natively would mean Intel Mac users get the fallback while everyone else gets documents,
and a `.node` binary inside a notarised hardened-runtime app is signing work on top. WebAssembly is
one artifact for every target we have, including the Cloudflare-hosted dashboard and the browser.

**116 ms against 41 ms is not a real cost at this size**, and paying it buys the deletion of an entire
class of problem: no per-platform matrix, no postinstall binary download, no architecture that
silently degrades.

> **A document parser that is unavailable must produce a worse answer, never an error.** D1 remains
> the floor beneath it: if the module fails to load for any reason, the attachment still yields
> inflated text plus a line saying structure was unavailable.

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

   All five are enforced (`packages/core/src/attachment/document/`). The last two were not at first,
   and the shape of the miss is worth keeping: the structured engine's call is synchronous, so
   nothing could stop it once entered — a 522 KB decompression bomb reached 1.9 GB resident and held
   the process. The engine now runs on a worker thread, which is what makes terminating it possible;
   the time budget is enforced *during* the call and resident growth past `maxMemoryBytes` retires
   the thread. `resourceLimits` cap a worker's V8 heap and **not** WebAssembly linear memory, which
   is why the memory bound is a watchdog rather than an allocator limit — see `bounds.ts`.
2. **The text goes into the agent's context.** A PDF can contain "ignore your instructions" as easily
   as a web page can, and it can hide it in white-on-white text a human reviewer will not see.
   ADR-029 C4 already built the fence for exactly this class of content — extracted document text
   goes through it, and does not get its own path.

### D5 · Where the output lands

The parse produces structured Markdown, which is the same shape ADR-029's notes already store. That
suggests the natural landing places, and they should be decided together rather than one at a time:

- an **attachment** the agent reads in a turn (today's path, improved);
- a **note** — an imported document becomes a page of blocks, addressable at
  `brainrouter://notes/block/…` like anything else (ADR-029 A1). Built as
  `importDocumentAsNote` (`packages/core/src/notes/importDocument.ts`), reachable as the desktop's
  "Import as note" and as `workspace_create` with a `brainrouter://document/outline/…` reference;
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

## 5. Open questions — answered by spike

The owner delegated these. Each was settled by running the thing, and the first one **did** change
the recommendation, exactly as predicted.

### Q1 · Does the native binding survive our packaging? · **No — so we do not use it**

Prebuilts exist for linux x64/arm64 (gnu + musl), darwin-arm64 and win32-x64-msvc. **`darwin-x64` is
absent and our desktop ships it** (`build.mac.target` lists `arch: ["arm64", "x64"]` for both dmg and
zip). Windows arm64 is missing too.

That is the invalidation §5 was written to look for. WebAssembly moots it: one artifact, every
target, no matrix.

### Q2 · What is the size budget? · **4.6 MB — so it never enters the renderer**

The `.wasm` is 4,591,331 bytes. The desktop renderer's initial-JavaScript limit is 1,750,000 and
ADR-029 had to lazy-load Notes to stay under it, so this is not a question of lazy-loading harder:

> **The parser runs in the Electron MAIN process, never the renderer.** The renderer asks the host
> and gets Markdown back.

Same conclusion for the dashboard from the other direction — 4.6 MB does not belong in an edge
bundle, so the dashboard asks the backend.

### Q3 · Where does parsing run? · **Where the document already is**

- **Desktop** — in the main process, locally. The document never leaves the machine, which is the
  strongest privacy answer available and costs nothing because the parser is local anyway.
- **Hosted** — in the backend, per tenant, bounded the way ADR-027 D12 bounds other work.
- **Dashboard** — calls the backend. It is a viewer, not a parser.

### Q4 · What happens to the 20,000-character cap? · **It stops being the whole answer**

The cap exists because context is finite, not because documents are short — and today it is filled
with noise, which is the worst possible use of it.

With real structure the document becomes **an artifact with addressable parts**: the turn gets a
bounded, structured extract, and the rest stays reachable at a `brainrouter://` reference the agent
can ask for by section. That is ADR-029's reference system doing the work it exists for, rather than
a bigger number.

---

## 6. How this will be judged

Not by whether a PDF produces text. It produces text today.

**The test is a two-column research paper with a table and a scanned appendix**, and three questions
about it whose answers live in the second column, in the table, and in the appendix. Getting the
first two right is the parser working. Saying *"the appendix is a scan and I cannot read it"* —
rather than answering from nothing — is the whole ADR.
