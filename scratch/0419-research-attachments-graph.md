# 0.4.19 research — attachments + execution model

Reference projects studied read-only; NOTHING here may be named in committed
code/docs (golden rule 2).

## ⚠️ HEADLINE: the evidence does NOT support "loop → graph"

The owner's stated goal is to upgrade from "loop engineering" to "graph
engineering". The survey found the opposite trend among the most recent,
most production-oriented codebases:

- One major framework **REMOVED its graph/pipeline abstraction in its 2.0
  release**, replacing it with a **middleware chain over a single agent loop**
  plus a tool-call state machine for interrupts.
- Another leading agent library composes **middleware over one agent loop**, not
  nodes and edges.
- Two others use an explicit **finite state machine** with a legal-transition
  table — not a graph.
- Compiled graphs survive mainly where topology is **author-declared and
  non-agentic**: a Markdown-declared org graph, a visual workflow playground, and
  a classic workflow-automation DAG engine.

**The distilled rule:** if routing decisions are made by a MODEL, an
FSM + middleware shape is better supported by evidence than a compiled graph. If
topology is declared by a HUMAN (a workflow the user draws/writes), a graph is
right.

**So the real question is not "loop vs graph".** It is: what does our turn loop
LACK that people reach for graphs to get? The answer, from the survey:
1. durable checkpoint + resume
2. typed state with explicit reducers
3. human-in-the-loop interrupts that survive a restart
4. parallel fan-out with a defined fan-in rule
5. per-node retry / timeout / attempt budgets
6. anti-hang guards
7. observability per step

Every one of those can be added to a loop. **Recommended ADR position: a hybrid
— keep an FSM/middleware turn loop for agentic routing, and add a declared graph
runner ONLY for human-authored workflows.** Present this to the owner as an
explicit decision with the evidence, since it diverges from the original ask.

### Design details worth stealing regardless of shape

- **Checkpoint cost is the hidden tax.** Naive checkpointing snapshots the whole
  message list every step → O(N²) growth. One library fixes this with a delta
  channel writing diffs plus a full snapshot every 50 steps → O(N). Directly
  relevant to our DB-growth problem.
- **Replay determinism constraint**: message IDs must be assigned BEFORE the
  reducer, never inside it — a reducer also runs on replay, and a
  randomly-assigned id would differ from the checkpointed one.
- **Sandbox purity**: keep workflow-orchestration types in a module that never
  imports the ORM/framework, and never use stdlib logging inside a
  deterministic-replay context (lock acquisition → deadlock).
- **EVERY mature implementation has an anti-hang guard**: max node actions +
  explicit deadlock detection (force-skip unreachable pending nodes), recursion
  limits, per-node `max_attempts`/`timeout_seconds`, legal-transition tables with
  terminal states, exceed-max-iters events, step budgets that force a `give_up`,
  final-attempt finalize gates, loop-detection middleware. We must have one.
- **Fail-closed routing**: an unrecognized route value maps to END rather than
  guessing.
- **Runtime-enforced outcomes**: don't trust the model's self-reported status —
  a "complete" with no artifact/evidence is rewritten to "failed"; file writes
  outside a declared contract raise a policy violation.
- **Eager readiness scheduling** beats level-by-level batching: start a
  downstream node as soon as ITS deps are done, not when the whole layer is.
- **Fan-in rule worth copying**: a node is ready when every input port is
  satisfied; a port is satisfied if upstream succeeded with valid data, OR
  upstream failed/skipped BUT the port has a default. Skip when an upstream
  failed and the affected port has no default.
- **Circuit breaker** (CLOSED/OPEN/HALF_OPEN, atomic half-open admission of only
  the first caller) for flaky provider calls.
- **HITL as a first-class node/state**, resumable by an external event, rather
  than a blocking prompt.

## ATTACHMENTS — four architectures observed

| Pattern | Idea | Context cost |
|---|---|---|
| **A. Native document block** | PDF bytes → base64 → a `document` content block; the model reads the PDF itself | high, but best fidelity |
| **B. Render-to-image** | rasterize pages to JPEG → image blocks / VLM OCR | high; needed for scans |
| **C. Extract-to-text inline** | parse server-side, splice text into the message | medium |
| **D. Extract → filesystem → lazy read** | attachment becomes a PATH; agent uses read/grep tools | **lowest — recommended default** |

### The best-in-class details

**Routing by size/model/pages** (pattern A/B): inline the document when small;
switch to page-image extraction when the model lacks PDF support or the file
exceeds a size threshold; refuse to inline beyond N pages and instruct the agent
to request a page RANGE instead. Validate magic bytes (`%PDF-`) BEFORE sending —
an invalid document block poisons every subsequent call in the session.

**Concrete limits observed** (a sane starting point for us): image base64 cap
~5 MB, target raw ~3.75 MB, max dimension 2000px; PDF target raw ~20 MB, max 100
pages per request, extract-instead-of-inline above ~3 MB, max ~20 pages per read,
inline only up to ~10 pages; max ~100 media blocks per request; text file cap
256 KB with a hard token ceiling.

**Media eviction**: count image+document blocks INCLUDING those nested inside
tool results, and evict OLDEST FIRST to stay under the per-request cap — silently,
because erroring mid-session is hard to recover from.

**Vision downscale gotcha**: models downscale long edges beyond ~1568px, so a
tall page tile becomes unreadable. Tile at ~1568px, not 8192px.

**Degrade-to-text fallback**: on a vision failure, strip image parts IN PLACE
(so the degrade persists across retries) and replace with `[image: label]`
placeholders, then retry text-only.

**Never drop silently**: a file that fails to parse should appear in the prompt
as `"- name.pdf (2.1 MB) could not be read due to <reason>"`, not vanish.

**Extraction caching**: persist bytes to the artifact store BEFORE extraction so
previews outlive base64 pruning; write `extracted_text` + `extracted_chars` back
onto the record and CLEAR the base64 in place to keep DB rows lean. ← directly
answers the owner's "how do we store this, how can we control this" question.

**Outline-injection (the most context-efficient design seen)**: convert the
document to Markdown, then inject only an `<uploaded_files>` block listing the
filename, size, virtual path, and an **extracted heading outline with line
numbers**, plus instructions to use read-with-line-range / grep / glob. Falls
back to a 5-line preview when there are no headings. This gives the agent a map
without spending the tokens.

**Scanned-vs-native detection**: classify per PAGE by image-area coverage ratio
rather than character count — trusting an embedded OCR text layer is what
produces garbled retrieval content. Route native pages through layout-aware
multi-column extraction, scanned pages through VLM OCR.

**OCR cost guard**: sample a few pages; if the page budget is large, auto-disable
OCR rather than burning the budget.

**Prompt-injection surface**: filter hidden text in PDFs — it is a cheap guard
against instructions embedded invisibly in a document. We must treat extracted
document text as UNTRUSTED DATA, consistent with our existing posture.
