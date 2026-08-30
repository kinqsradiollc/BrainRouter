# ADR-051 — Notebooks the agent can read and the human can see

**Status:** PROPOSED — awaiting owner review. · **Builds on:** ADR-041 D8 (the builtin-tool handler
registry that `notebook_edit` and `read_file` already live in), ADR-047 (tool honesty: a tool that
cannot do the job says so), and the Editor's markdown mode (the precedent for a file-type-specific
rendered experience inside an existing panel). · **Informed by:** a study of contemporary
agent-harness file surfaces (2026-08) — notebooks are rendered as cells with outputs, edited
cell-by-cell, and approved with the cell's real content on screen; no external project is named or
copied.

**Date:** 2026-08-30

> A Jupyter notebook is one JSON file wearing three faces: prose (markdown cells), code (source
> lines), and evidence (outputs — text, tables, base64 images). We already ship the WRITE face:
> the `notebook_edit` builtin edits cells by index. But the READ face is raw nbformat JSON — for
> the agent *and* for the human. The agent burns tokens on escaped line arrays and inline base64
> plots, then guesses cell indices by counting `{` blocks; the desktop File view shows the same
> wall of JSON to a person who just wants to see their analysis. This ADR gives the notebook its
> cell-shaped reading in every seat that already touches it, and puts the cell being changed in
> front of the human who approves the change.

---

## 1. Where the code is today

- **The write half shipped; the read half never did.** `notebook_edit`
  (`packages/core/src/extension/builtin/toolSpecs.ts:421`, handler in
  `extension/builtin/handlers/fsWrite.ts:96`, pure logic in `agent/fs/notebookEdit.ts`) replaces /
  inserts / deletes cells by 0-based index and preserves every untouched nbformat field. Its own
  description instructs: *"Read the notebook first to get cell indices."* But `read_file`
  (`extension/builtin/handlers/fsRead.ts:17`) has **no notebook awareness** — the agent receives
  raw nbformat JSON: `source` as arrays of `\n`-suffixed strings, outputs inline **including
  base64-encoded images**, and indices it must infer by counting objects.
- **The read cap makes it worse, honestly.** `read_file` bounds a full read via
  `truncateFullRead`, so a notebook whose *first* plot embeds a large base64 PNG can truncate
  before the agent ever sees the later cells. The tool is behaving correctly; the FORMAT is the
  problem — a 40-cell notebook is mostly payload the agent should see *named*, not *inlined*.
- **Editing a cell leaves its stale output standing.** `applyNotebookEdit` on `replace` rewrites
  `source` but keeps the old `outputs`/`execution_count` (they reset only when the cell *type*
  changes — `notebookEdit.ts:56-64`). The next read shows an output the current source never
  produced — a small honesty bug with real misleading power.
- **The desktop shows a person the same JSON.** `FileViewerPanel.tsx` renders every file through
  `CodeBlock` + `langForPath` — a `.ipynb` is a wall of syntax-highlighted JSON (screenshot-verified
  on a real assignment notebook). There is no rendered view anywhere on the desktop.
- **The precedent already exists in-tree.** The Editor's markdown mode
  (`panels/editing/EditorPanel.tsx:97-101` gating `panels/editor/markdownMode.tsx`) is exactly the
  shape needed: a file-extension-gated rendered experience hosted inside an existing panel, with
  the raw text one toggle away.
- **Approval is blind at the cell level.** A `notebook_edit` runs through the same write-approval
  chain as any edit, but the prompt shows the *tool arguments* (an index and new source) — not the
  cell currently at that index. The human approves a replacement without seeing what it replaces.

---

## 2. Decisions

**D1 · `read_file` renders a notebook as cells, by default.** When the resolved path ends in
`.ipynb`, `read_file` returns a **cell-indexed digest** instead of raw JSON: each cell as
`[cell N] code|markdown (executed: K)` followed by its joined source; outputs rendered honestly —
text/stream outputs included (per-output truncation), errors as `ename: evalue` plus a trimmed
traceback, and **binary/image outputs named, never inlined** (`[image output: image/png, ~45 KB]`).
Indices in the digest are the SAME indices `notebook_edit` takes, closing the loop its description
promises. `startLine`/`endLine` slice the digest like any other file. A `raw: true` argument (and
any parse failure) falls back to today's raw JSON read — the digest is a rendering, never a gate.
*Acceptance: reading a notebook whose first cell embeds a large plot shows every later cell, and
the index the agent reads is the index `notebook_edit` edits.*

**D2 · Replacing a code cell clears its evidence.** `applyNotebookEdit` on `replace` of a code
cell resets `outputs: []` and `execution_count: null` — the notebook convention that an unexecuted
source has no output. Untouched cells stay byte-faithful as they do today. *Acceptance: after a
replace, a re-read shows the new source with no stale output attached.*

**D3 · The desktop renders the notebook a person came to see.** `FileViewerPanel` gains a
notebook branch for `.ipynb`: markdown cells through the existing chat `Markdown` renderer, code
cells through `CodeBlock`, image outputs decoded from their base64 payloads, text outputs as
preformatted blocks — read-only, with a **Raw JSON toggle** (the markdown-mode pattern: rendered
first, source one click away). The chat File view (the screenshot's surface) is this same panel,
so it inherits the fix. *Acceptance: opening a real `.ipynb` shows prose, code, and plots — not
JSON — and the toggle shows the exact bytes.*

**D4 · Approval shows the cell, not the index.** The `notebook_edit` approval surface renders the
target cell's CURRENT content beside the replacement (delete shows what dies; insert shows the
neighbors), and says plainly when the notebook or cell cannot be read rather than showing an empty
pane. No new approval semantics — the same chain, now with the evidence on screen. *Acceptance: a
human can decline a wrong-index edit because they SAW the wrong cell.*

---

## 3. What this is not

- **Not execution.** No kernels, no run-cell, no output generation. BrainRouter renders and edits
  the file; running it stays in Jupyter (an execution integration would be its own ADR with its
  own sandbox story).
- **Not a notebook IDE.** The Editor keeps opening `.ipynb` as raw JSON (Monaco is the wrong tool
  for cell UX, and the File view + agent loop is the product loop). A cell-native editing surface
  is future product work, not this decision.
- **Not a new tool.** No `notebook_read` — `read_file` learning the format keeps one read tool,
  one description, one habit (ADR-041's registry discipline: extend the handler, don't mint a
  sibling).
- **Not a format migration.** nbformat 4 in, nbformat 4 out, unknown fields preserved verbatim —
  `applyNotebookEdit`'s existing fidelity contract is the floor everywhere.

---

## 4. Dependency-ordered delivery board

- **P1 — The digest** (D1): notebook rendering in `read_file` (`agent/fs/` pure function +
  handler branch), `raw` opt-out, parse-failure fallback; tests pin digest shape, image-output
  naming, index parity with `notebook_edit`, and truncation behavior.
- **P2 — Output honesty** (D2): `applyNotebookEdit` replace clears `outputs`/`execution_count`;
  `notebook_edit` description updated to promise it; tests.
- **P3 — The rendered view** (D3): `FileViewerPanel` notebook branch + Raw toggle; reuses the
  chat `Markdown` renderer and `CodeBlock`; no new dependencies.
- **P4 — The approval cell** (D4): approval surface for `notebook_edit` shows current-vs-proposed
  cell content, with the read-failure notice.

---

## 5. How this will be judged

1. An agent asked about a 40-cell notebook with plots answers from **every** cell, and its first
   `notebook_edit` lands on the right index without a correction round.
2. A replaced code cell never shows an output its source did not produce.
3. A person opening a `.ipynb` on the desktop sees their analysis — prose, code, plots — and can
   still get the raw bytes in one click.
4. A notebook edit is approved or declined with the affected cell's real content on screen.
5. `git diff` of an agent-edited notebook shows only the edited cell (fidelity held).
