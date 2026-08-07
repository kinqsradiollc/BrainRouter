# ADR-029 — One workspace, many surfaces

**Status:** ACCEPTED — approved by the owner. Parts A–D are built; Part E is the approved extension.
**Supersedes nothing. Depends on:** ADR-028 (planner sync, panel model), ADR-021 (workspace profiles).

---

## 1. The problem

BrainRouter has six modes — Chat, Code, Track, Meetings, Planner, and now Notes — and they
share a database without sharing a **vocabulary**.

Every mode can store things. No mode can *refer* to another mode's things. A meeting produces an
action item that has to be retyped into the planner. A chat turn decides something that has to be
copied into a note. A note describes work that already exists as a Track item, and the two drift
until someone notices.

> **The modes are not integrated. They are adjacent.**

This is the same failure ADR-028 named, one level up: each surface is individually truthful about
its own contents while the *workspace* has no coherent state. You can trust any one mode and still
not know what is going on.

Adding a Notes mode makes this acute rather than incidental. A notes app that cannot link to
anything is a text editor with worse file management. The linking **is** the feature.

### 1.1 What we are actually building

Two things, and the second is the reason the first is worth doing:

1. **Notes** — a block-based, offline-first document surface backed by our own database.
2. **A reference system** — one addressing scheme every mode participates in, so anything can point
   at anything and the pointer stays live.

### 1.2 What already exists to build on

ADR-028 Part D shipped a complete offline-first sync stack for the planner: hybrid logical clocks
(D3), an ordered idempotent outbox (D2), field-level merge with conflict preservation (D4), a
server that merges rather than accepts (D11), and a `(org_id, user_id, id)` tenancy shape.

**Notes must use that stack, not a second one.** Two sync systems in one product will disagree, and
the disagreement will surface as one surface showing stale data while the other shows fresh — which
is indistinguishable from a bug in whichever one you happen to be looking at.

---

## 2. Decisions

### Part A — The reference system

#### A1 · One address space, and everything is in it

Every addressable thing in the workspace gets a stable URI:

```
brainrouter://<mode>/<kind>/<id>
brainrouter://planner/item/itm_4f2a
brainrouter://notes/block/blk_91c
brainrouter://track/work-item/BR-114
brainrouter://code/file/packages/core/src/review/prRouter.ts#L59
brainrouter://chat/turn/ses_88a/t_12
brainrouter://meetings/action/mtg_5/a_2
```

**Not a database foreign key.** A foreign key requires both ends to live in one schema, and Code
does not — a file reference points at git, not at a row. The URI is the only thing every mode can
produce and resolve.

> **A mode joins the workspace by resolving its own URIs, and by nothing else.**

That is the entire integration contract. A mode implements `resolve(uri)` and `describe(uri)` and it
is linkable from everywhere, including modes written later.

#### A2 · Links are stored once, at the source, and backlinks are derived

The classic notes-app failure is storing a link on both ends and letting them diverge. A note claims
it references a task; the task claims nothing; a migration drops one side and the other becomes a
lie.

> **The reference lives in the referring content. Backlinks are computed.**

A note block containing a reference to a planner item stores that reference in the block. The
planner item stores nothing. "What links here" is a query, and a query cannot go stale.

Cost: computing backlinks needs an index. That index is a **cache** and must be rebuildable from
content alone — if rebuilding it changes the answer, the index was the source of truth and this
decision was not implemented.

#### A3 · A reference is live, not a copy

Embedding a planner item in a note shows the item's **current** state. If you complete the task, the
note reflects it.

The alternative — snapshotting at insert time — produces documents that are quietly wrong, which is
worse than documents that are obviously empty. A note saying "TODO: ship the parser" beside a task
completed three weeks ago has actively misinformed its reader.

**When the target is gone, the reference says so** rather than rendering as though nothing happened:
*"planner item (deleted 4 Aug)"*. A dangling reference is information; a silently-vanished one is a
hole in your document you will not notice.

#### A4 · Resolution is permission-aware, and says when it is not

A reference to something you cannot see renders as *"an item you do not have access to"* — not as
its title, and not as nothing.

Rendering the title leaks it. Rendering nothing makes the document look different to different
people with no indication why, which is how someone concludes the document is corrupted.

### Part B — Notes

#### B1 · Blocks, not documents

The unit is a block: a paragraph, a heading, a list item, a code block, an embed. A page is an
ordered tree of blocks.

This is not aesthetic. **The merge granularity IS the block.** ADR-028 D4 resolves conflicts per
field; here it resolves per block, which means two people editing different paragraphs of one page
never conflict. Document-level storage would make every concurrent edit a conflict, and D4's
conflict-preservation would fire constantly until people stopped trusting it.

#### B2 · Concurrent edits to ONE block — the honest hard case

ADR-028 D4 rejected CRDTs and kept both versions with a conflict marker. For a todo title that is
right: the loss is one short string and a human resolves it in seconds.

**For prose it is worse, and I want that stated rather than assumed away.** Two people typing in the
same paragraph produce a conflict marker mid-document, which is disruptive in a way a conflicted
todo is not.

Three options, and this ADR takes the third:

| | |
|---|---|
| **Keep D4 as-is** | Consistent, and unpleasant in a document. Conflict markers appear where you are reading. |
| **Adopt a text CRDT for block bodies** | Correct merges, no markers — and a second consistency model in one product, plus a merge that can produce a sentence neither person wrote. |
| **Block-level soft locking** *(chosen)* | A block being actively edited by another device is **read-only with an attribution**, so the conflict is prevented rather than resolved. Falls back to D4's marker when the lock is stale or the devices were offline. |

Soft locking is chosen because the common case for a personal notes app is **one person, several
devices** — where the conflict is nearly always accidental (a stale tab, a phone left open) rather
than genuine simultaneous authorship. Preventing it is better than merging it. D4 stays as the
floor for the case locking cannot cover: both devices offline.

**The lock is a LEASE WITH A FENCING EPOCH, not a flag** — see Q1. A held lock from a device that
never came back must not make a block permanently uneditable, so it expires; and an expired lock
must not let that device's delayed write land on top of an edit made while it was gone, so every
write carries the epoch it believes it holds and a stale epoch is rejected. Migration 048 exists
because we already shipped the version without the epoch.

#### B3 · Offline is the same offline

Notes reuse the planner's stack unchanged: HLC stamps (D3), the ordered per-item outbox (D2),
server-side merge (D11), age-based shedding with a loud notice (D2).

**One consequence to state plainly:** the outbox is ordered *per item*, and for notes the item is the
block. Two blocks sync in parallel; edits to one block never reorder. That is the correct
granularity and it falls out of B1 rather than needing a new rule.

#### B4 · Pages are notes with children, not a separate type

A page is a block that has children. Nesting, sub-pages and a sidebar tree are all one recursion.

A separate page type would need its own permissions, its own sync path and its own conflict rules,
and the first feature request — *"can a page be embedded in a page"* — would need them reconciled
anyway.

#### B5 · Search covers content and references

Finding a note by what it *links to* is as important as by what it says: *"the note where I wrote
about BR-114"*. The index carries both.

### Part C — Wiring the modes together

#### C1 · Every mode implements the same three verbs

```
resolve(uri)   -> the current state of the thing, or a tombstone
describe(uri)  -> a one-line label for rendering inline
create(intent) -> make a new thing of this mode's kind, from a described intent
```

`create` is what makes the wiring bidirectional. Without it a note can *point at* a task; with it a
note can *become* one — select a line, "make this a task", and the reference is written back into
the note automatically.

> **A mode that only resolves is readable. A mode that also creates is usable from everywhere else.**

#### C2 · The cross-mode moves that must work on day one

These are the concrete flows the design is judged against. If a decision makes one of these
awkward, the decision is wrong:

| From | To | The move |
|---|---|---|
| Meetings | Planner | An action item becomes a task, linked back to the meeting |
| Meetings | Notes | The summary becomes a page, transcript referenced not copied |
| Chat | Notes | A turn's conclusion becomes a note block, citing the turn |
| Chat | Planner | "remind me to…" becomes a task |
| Notes | Track | A checklist line becomes a work item |
| Notes | Code | A reference to a file/symbol that survives the file moving |
| Planner | Notes | A task's notes field opens as a real page |
| Code | Notes | A review finding becomes a note for later |

#### C3 · The agent uses the same verbs, not a private path

The agent gets `workspace_resolve`, `workspace_create` and `workspace_link` — the same three verbs
the UI uses.

A separate agent path would drift from the UI path, and the drift shows up as the agent creating
things that look subtly wrong in the surface that owns them. **One vocabulary or none.**

ADR-028 D6's discipline carries over: what the agent sees of the workspace is **bounded and
summarised**, never everything. A workspace with 400 notes must not put 400 titles in the context —
it puts what the current work references.

#### C4 · A reference the agent follows is UNTRUSTED content

A note can contain text written by anyone — pasted from a webpage, synced from a shared source,
imported from a meeting transcript.

When the agent resolves a reference and reads the content, that content is **data, not
instructions**, and it is fenced exactly as ADR-028 D6 fences planner content. A note saying
*"ignore previous instructions"* is a note about prompt injection, not a prompt injection.

This is not hypothetical: the whole point of C1 is that content flows between modes, so any mode
becomes a delivery vector for every other.

#### C5 · Deleting the target of a link never deletes the link

Cascade deletion across modes is how one careless cleanup removes half a workspace.

A deleted target leaves a tombstone (ADR-028 D4's rule, applied across modes). The reference renders
as a tombstone. Restoring the target restores the reference.

### Part D — Storage and scope

#### D1 · Notes are user-scoped, org-visible — the same partition as everything else

`(org_id, user_id, id)` with a visibility column, matching the planner and meetings. A personal note
is private by default; sharing widens visibility rather than moving the row.

**Not workspace-scoped.** ADR-028 D9 recorded getting exactly this wrong for the planner: notes are
personal and cross-project, and scoping them per-repository would mean the same note is invisible
from a different checkout.

#### D2 · One migration, three tables

`notes_blocks`, `notes_refs`, `notes_index` — content, references, and the derived search/backlink
index. The third is rebuildable from the first two by definition (A2).

#### D3 · Attachments are content-addressed and stored once

An image pasted into three notes is one object with three references. Otherwise a workspace's
storage grows with how often people paste rather than with what they have.

---

### Part E — Parity with the app people are comparing this to

Parts A–D describe a correct block store. They do not describe a notes app anyone would choose.
The owner's instruction after seeing it working was exact: **the note should be exactly the same as
Notion — everything.** That is a scope decision, and this Part records it rather than letting the
gap be discovered later.

#### E1 · The benchmark is the editing gesture, not the feature list

A features table can be satisfied without the product becoming usable. What makes Notion Notion is
that **you never leave the keyboard to change what a line is**: `/` opens a command menu, `# ` turns
the line into a heading as you type it, Enter splits a block at the caret, Backspace at column zero
merges it into the one above, Tab nests it.

> **The parity test is that a person who uses Notion can type a page here without being taught
> anything.**

So the ordering is deliberate: input rules and the slash menu come before any new block kind, because
a block kind you can only reach through a dropdown is a block kind nobody uses.

#### E2 · Rich text is stored in the text, not beside it

Notion stores rich text as an array of styled segments. We store a block's body as one
`Stamped<string>` because B1's merge granularity is the block and D4 merges per field.

> **Inline marks are encoded IN the string as a restricted markdown subset, and parsed for
> rendering.**

A parallel `Stamped<InlineMark[]>` holding offsets into a separately-stamped string is two fields
that must agree about lengths and merge independently — and the first concurrent edit desynchronises
them, producing bold that starts mid-word in a sentence neither person wrote. One field cannot
disagree with itself. The cost is that a `*` someone typed literally needs escaping, which is a
known, visible, local problem rather than a silent corruption.

#### E3 · Databases are real, and this reverses §3

The first draft ruled out "a formula/database view over notes" on the grounds that Track already
models structured records. That reasoning was about avoiding two models of one thing — and it was
wrong about which thing. Track models **work**: items with an assignee, a status, a sprint. A Notion
database models **anything a page can be a row of** — a reading list, a CRM, a recipe index. They are
not the same noun, and refusing the second does not prevent duplication, it prevents the feature.

> **A database row IS a page.** Not a record that links to one — the same block, with properties.

That is the decision that keeps this from becoming a second store: a database is a *view over pages
with a shared property schema*, so everything in Part A–D (sync, merge, references, permissions)
applies to rows for free. Views (table, board, list, calendar, gallery), filters, sorts and grouping
are projections computed from the same blocks.

Formulas and rollups are **not** in this pass — they need an expression language and a dependency
graph, and shipping half of one produces a column that is wrong rather than absent (§B1's argument,
applied to cells).

#### E4 · What "everything" explicitly includes

Judged as built or not built, per row, by the table in §5:

| | |
|---|---|
| **Editor** | slash menu, markdown input rules, inline marks (bold/italic/strike/code/link), `@`-mention, `[[`page link, split/merge on Enter/Backspace, Tab nesting, duplicate, move up/down, multi-block selection |
| **Blocks** | heading 1–3, paragraph, bullet, numbered, todo, toggle, quote, callout, code with language, divider, image, bookmark, embed, table, sub-page |
| **Pages** | icon, cover, title as its own field, breadcrumbs, sidebar tree with drag-to-reparent, favourites, trash with restore |
| **Databases** | property types (title, text, number, select, multi-select, date, checkbox, URL, person, relation), table/board/list/calendar/gallery views, filter, sort, group |
| **Finding things** | ⌘K quick find across pages and blocks, backlinks panel, in-page search |

#### E5 · Notion's own missing half is our A-part, and we keep it

Notion has no addressing scheme that reaches outside Notion. Parity is the floor here, not the
ceiling: every one of the above keeps working with Part A references, so a database row can cite a
pull request, a callout can embed a planner item, and a `@`-mention can address a meeting. Dropping
that to match Notion exactly would be copying a limitation.

---

## 3. Out of scope

- Real-time collaborative cursors. B2's soft locking covers the multi-device case; live
  co-authoring is a different product with different infrastructure.
- Public publishing of notes.
- Importing from other note apps. Worth doing, not worth blocking this on.
- Formulas and rollups inside database properties — see E3 for why the rest of databases is now in
  scope and these two are not.

---

## 4. Open questions — answered

Each of these was left open in the first draft and is now answered against the code. Where the
evidence changed my mind, that is recorded rather than quietly corrected.

### Q1 · Is B2's soft locking worth its complexity?

**Yes — and the complexity is smaller than I estimated, because the pattern already exists and we
have already got it wrong once.**

`brainrouter/src/memory/store/postgres/migrations/048_job_lease_fencing.sql` is a lease
implementation with a `lease_epoch` fencing token, written after a real defect: a worker held a
lease, a sweeper released it, a second worker claimed the job, and the first wrote its stale result
over the new run. The migration's own comment states the rule — *a lease without a fencing token is
not a lock.*

That changes the answer. Soft locking is not new machinery to design and get wrong; it is an
existing pattern to reuse, whose specific failure mode is already documented in this repository.

**Decision:** block locks are leases with an epoch, following 048. A write carries the epoch it
believes it holds; the server rejects a write whose epoch is stale. Without that, a device that
went to sleep holding a lock wakes and overwrites an edit made while it was gone — the exact defect
048 exists to prevent, reproduced one layer up.

**Lease duration: 30 seconds, renewed while typing.** Long enough that a pause does not drop the
lock mid-sentence, short enough that a closed laptop frees the block before anyone notices.

### Q2 · Should `create` be synchronous?

**Yes, and the concern that made me hesitate does not apply here.**

I worried that one mode writing into another's store weakens the ownership model. Inspecting the
code, that is not what happens: every mode already writes through its own host handler — the
planner through `'planner-add'` (`queries.ts:2136`), meetings and Track through theirs. A
cross-mode `create` **calls the owning mode's handler**; it does not reach into its tables.

Ownership is preserved by construction, because the handler is the only writer either way.

**Decision:** `create` is synchronous and returns the new URI. The caller writes that reference into
its own content — which is the half that must not be split, since an async create that fails after
the note was saved leaves a note claiming a task that does not exist.

**The one asynchronous case, named so it is not discovered later:** creating something that requires
a network round trip the owning mode does not control — a Track item that must exist on GitHub
first. Those return a *pending* reference that resolves to a tombstone-with-reason until it lands,
rather than blocking the editor.

### Q3 · How much of a note goes into the agent's context?

**The referenced block, plus its heading ancestry, plus a count. Never the page.**

ADR-028 D6 already set this precedent and it should not be re-litigated per mode:
`agentContext.ts:64` caps listed items at seven and renders the remainder as a count, on the
evidence that fifty low-signal lines make a model worse at the five that matter.

A page is unbounded — someone's meeting notes can be thousands of words — so "include the page"
has no upper bound and would silently consume the context belonging to the actual task.

**Decision:** resolving a note reference yields the block itself, the chain of headings above it
(so the block has a place), and `"+N more blocks on this page"`. The agent can ask for more by
resolving a specific child; it never gets a page by accident.

Heading ancestry rather than neighbouring blocks, because a heading tells you what the block is
*about* while an adjacent paragraph only tells you what happens to sit next to it.

### Q4 · Does Code need `create`?

**No, and adding it would be actively harmful.**

The agent already writes files through its normal tool path. A `create` verb for Code would be a
second way to write a file with different validation, different permissions, and a different audit
trail — and the two would drift, which is the failure this whole ADR is organised against.

**Decision:** Code implements `resolve` and `describe` only. It is fully linkable and not creatable.
"Turn this note into a file" is a normal agent turn that happens to cite a note, not a new writer.

This is the same reasoning that keeps plugin publish out of the stacked-PR router in ADR-028 H2: a
path that genuinely differs should stay separate rather than be forced through a shared seam it
does not fit.

### Q5 · Is the URI scheme over-engineered for six modes in one process?

**They are not in one process, and that is the answer.**

`WorkspaceMode` is a five-value union in the desktop renderer
(`ActivityBar.tsx:15`) — but the dashboard is a separate Next.js application reading the same
backend, and the CLI is a third process. A note referencing a planner item has to resolve in all
three.

An in-process object reference cannot cross that boundary; a string can. The URI is not
future-proofing for modes we have not written — it is the minimum that works for the three clients
that exist today.

**Decision:** keep it. One refinement from the inspection: the scheme must be resolvable
**server-side**, because the dashboard has no local store to resolve against. That makes
`resolve(uri)` a backend capability with client caches in front of it, rather than a client-side
lookup — a constraint worth fixing now, since discovering it after the desktop implementation
would mean writing resolution twice.

---

## 5. How this will be judged

Not by whether the mode exists. ADR-028's whole lesson was that a surface can exist, compile, pass
tests, and still be unreachable.

**The test is C2's table.** Each row is a flow a person performs end to end. A row that needs
copy-paste has not been implemented, however much code was written for it.
