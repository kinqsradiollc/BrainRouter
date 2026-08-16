# 0.4.19 research — security gates + page→markdown

Working notes for ADR-027. Reference projects studied read-only; NOTHING here
may be named in committed code/docs (golden rule 2) — ship BrainRouter-native.

## Two OPPOSITE security-review philosophies (they compose well)

**Philosophy A — subtractive.** One discovery pass over the PR diff, then noise
is removed by denylists:
- Prompt bar: only flag issues at **>80% confidence of actual exploitability**;
  confidence <0.7 is unreportable; exclusions stated TWICE (sandwiched).
- Deterministic regex hard-exclusions (DOS, rate limiting, resource leaks, open
  redirect, regex injection) — with **language-conditional** rules, e.g.
  memory-safety findings dropped unless the file is `.c/.cc/.cpp/.h`; SSRF
  dropped in `.html`. Encodes "buffer overflow in Python is nonsense" as a
  filesystem check instead of asking the model.
- Per-finding LLM adjudication (ONE call per finding, not batched), given the
  finding + the WHOLE file re-read from disk, returning
  `{confidence_score 1-10, keep_finding, exclusion_reason, justification}`.
- A **PRECEDENTS list** (~17 codified adjudications) is the most reusable
  artifact: UUIDs are unguessable; env vars/CLI flags are trusted; React/Angular
  are XSS-safe absent `dangerouslySetInnerHTML`; client-side authz is not a vuln;
  path-traversal doesn't apply in `.js/.ts/.tsx`; "lack of hardening is not a
  vulnerability"; "only include MEDIUM if obvious and concrete".
- Fail-OPEN: if the filter call errors, the finding is KEPT.
- Weakness: dedup is a literal string match on an existing comment marker; no
  finding identity, no baseline, no cross-run tracking.

**Philosophy B — additive proof.** Phased pipeline (threat-model →
finding-discovery → validation → attack-path-analysis → finalize) where the
model may not read ahead, and noise is suppressed by REQUIRING evidence:
- **Candidate ledger** (`candidate_ledger.jsonl`): rows carry cwe_ids,
  locations with `role ∈ {entrypoint, source, root_control, sink, evidence}`,
  summary, evidence. Normalizer merges duplicates and assigns deterministic ids;
  later phases may only APPEND nested records, never rewrite.
- **Evidence tuple required**: source, control, sink, reachable path, boundary,
  counterevidence, proof gaps. "Do not treat dependency presence, string
  matches, or a partial call chain as a complete assessment."
- **Validation ladder pins confidence to METHOD**: crashing PoC 1.0 >
  valgrind/ASan 0.9 > debugger trace 0.8 > … > static understanding 0.3.
  "Calibrate confidence from the strongest evidence actually obtained, not the
  scariness of the bug class."
- **Mandatory counterevidence pass** — actively look for proof the path is out
  of scope / internal-only / unreachable.
- **Suppression must close the specific row**: "A safe neighboring path does not
  prove this path is safe." Missing runtime setup is a PROOF GAP, not
  counterevidence.
- **`deferred` is a first-class disposition** — uncertain findings are recorded
  with a proof gap instead of dropped.
- **Severity is mechanical**: impact × likelihood matrix applied after facts are
  set ("do not re-argue severity afterward"); hard suppressions first
  (self-only, unachievable preconditions, privileged-only → ignore).
  "Do not discard an otherwise reportable finding solely because impact or
  likelihood is low; downgrade its severity instead."
- **Stable identity** — `fingerprint = sha256(algo, target_id, rule_id, anchor,
  instance)`; `findingId` stable ACROSS scans, `occurrenceId` per-scan. A
  deterministic finalizer recomputes and REJECTS mismatches, so the model cannot
  forge identity. THIS is what makes dedup/suppression/coverage auditable.
- **The model never writes the report** — it authors validated JSON
  (manifest/findings/coverage); a deterministic script projects markdown+SARIF.
- **`coverage.json`** with dispositions `{reported, no_issue_found, rejected,
  not_applicable, needs_follow_up}` + receipts + explicit exclusions, rendered
  as a "Reviewed Surfaces" table so an auditor sees why something did NOT become
  a finding.
- **3-layer isolation**: permission profile (repo read-only, only scan+state
  writable, approvals never) → non-root pinned container with 3 mounts → seccomp
  with cap_drop ALL + no-new-privileges, deliberately re-allowing ptrace (so the
  validation phase can run gdb/valgrind) and unshare/mount (nested sandbox).
  Git credentials injected via env-only credential helper bound to ONE host.
- Cross-scan matching is a separate hardened LLM call that matches by ROOT CAUSE
  and deliberately ignores fingerprints/titles/locations, run with
  network disabled and `*KEY*/*SECRET*/*TOKEN*` excluded from env.

**Adoption plan for our TWO gates:** take the PRECEDENTS list + language-
conditional exclusions + the >80% bar (cheap, immediate precision win) for the
DESKTOP gate; take the ledger + fingerprint identity + coverage dispositions +
deterministic finalizer for the BACKEND GitHub gate (durable, auditable,
dedupes across runs). Our existing review-finding lifecycle already fingerprints
findings across commits — extend rather than replace.

## Page → Markdown (replaces browser scraping)

Pipeline is tiny and high-leverage:
- Extractor: a Readability-successor that normalizes highlighter markup
  (Prism/hljs/Shiki span soup) into clean `<pre><code>` BEFORE markdown
  conversion — this is the main reason it beats Readability for our use.
- Converter: HTML→Markdown library.
- Fallback when extraction is empty: strip `script/style/link/noscript/svg/
  [aria-hidden]`, then cascade `[role="main"]` → `<main>` → `<article>` →
  `<body>`. NOTE: their fallback MUTATES the live DOM — we must not.
- **Provenance**: a metadata block (Title/Author/Date) + `**Source:** [url](url)`.
  That self-link is the ONLY provenance mechanism; per-element source anchors are
  NOT preserved. For our "everything must have references" requirement we need to
  go further — per-section anchors.
- **Page structure map**: regex the generated markdown for `^#{1,6}` and render
  an ASCII heading tree in a fenced block. Excellent for LLM consumption —
  cheap to copy.
- Defaults are token-efficient: images OFF, links OFF, page-info ON, map ON,
  source URL ON.

**Gaps we must fix in our native version:**
1. **GFM tables are NOT handled** (no table plugin registered) — tables flatten
   to concatenated text. Biggest single defect; we must register table support.
2. No base-URL resolution — relative/lazy `src`/`href` pass through broken. We
   must absolutize against the page URL.
3. No fenced-code style set (defaults to indented).
4. No shadow-DOM piercing, no iframe traversal, no virtualized-list expansion.
5. No SPA readiness wait — mitigated only because extraction is user-triggered;
   our agent triggers programmatically, so WE need a settle/readiness wait.

Two browser-quirk lessons worth keeping: clipboard writes must happen in a
focused page context (an offscreen document never has focus → NotAllowedError),
and downloads should use Blob + anchor rather than `data:` URLs.
