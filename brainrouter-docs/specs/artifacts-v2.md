# Spec: Artifacts v2 — live, versioned artifacts

**Status:** in progress (0.4.15) · **Owner:** BrainRouter core
**Tracks:** §AV-1 … §AV-8

## Problem

BrainRouter already has a durable artifact system — `ArtifactRecord`
(typed kinds, markdown/html/text, file-backed or inline, status,
memory-linked, provenance), a desktop `ArtifactsPanel` (markdown +
sandboxed HTML), CLI `/artifact`, and `artifact-event` protocol
plumbing. What's missing is what makes an artifact feel *live*: there is
no version history/revert, no rich rendering (code/SVG/Mermaid/diff), no
in-band authoring tool for the agent, no streaming preview, and no
export/sharing. This spec closes that gap.

## Goals / non-goals

- **Goal:** artifacts are typed, versioned objects with revert; the
  agent authors them in-band; they render richly (code⇄preview) and
  stream as they're written; they export to portable files; CLI and
  desktop reach parity.
- **Non-goal — capture, not an application:** artifacts stay
  self-contained single pages: no backend, no outbound network, size
  cap. This boundary keeps them portable, diffable, and safe.

## Tracks

### §AV-1 — Versioned artifacts (foundation)
- `ArtifactVersion[]` snapshots on the record (`v`, `content`/`path`,
  `contentHash`, `editedBy`, `editedAt`, `sourceEventId`),
  `currentVersion`, `schemaVersion`. `updateArtifact` appends a snapshot
  instead of clobbering; migrate legacy records → v1 on read.
- Store: `revertArtifact`, `listArtifactVersions`, `getArtifactVersion`.
- Protocol: `artifact-event.version` + `reverted` action.
- CLI: `/artifact versions|revert|diff`. Desktop: version selector +
  revert + diff. **Acceptance:** every content edit creates a version;
  revert restores prior content as a new version; legacy records load.

### §AV-2 — Typed kinds + unified renderer (code ⇄ preview)
- Formats: add `svg`, `mermaid`, `code` (+ `language?`). Cached
  `renderedPreview?`.
- Desktop `ArtifactViewer`: code⇄preview toggle, syntax-highlighted
  source, markdown/html/SVG/Mermaid/diff renderers.
- CLI `/artifact open <id>`: write a self-contained preview file + open.
  **Acceptance:** each format renders + has a source view; review-export
  shows a diff.

### §AV-3 — Live streaming preview
- Protocol `artifact-delta` event; authoring tool streams chunks; final
  delta finalizes a §AV-1 version.
- Desktop live artifact side-column re-renders as deltas arrive; CLI
  shows a compact "writing…" row. **Acceptance:** preview updates mid-turn.

### §AV-4 — In-band authoring + promotion + cross-session id
- Agent/local tool `artifact_write` (create or update-by-id). System
  prompt promotion heuristic, tunable via `cli.artifactPromotion` knob
  (config, not env). `artifact_write(id)` targets an existing artifact
  across sessions/sub-agents. **Acceptance:** the model can create + grow
  an artifact by id without `/artifact create`.

### §AV-5 — Result-back-to-session + trusted interactivity
- Desktop "Send to chat" on an artifact/region. Per-artifact
  "Enable interactivity" toggle relaxes the iframe sandbox (scripts,
  strict CSP, no network) on explicit approval. **Acceptance:** locked by
  default; loop works.

### §AV-6 — Design-token styling
- Read a `Design system` block from CLAUDE.md / theme / config; expose to
  the agent. Precedence: user prompt > project tokens > default.

### §AV-7 — Export + scoped sharing + governance
- `artifact export <id> --format pdf|html|md|zip` (standalone single-file
  HTML, portable archive of artifact + versions + annotations). Optional
  federation publish: workspace-scoped, view-only, version-pinned, audit
  event, retention. **Acceptance:** export produces a self-contained file.

### §AV-8 — Dashboard gallery + search/tags
- Read-only dashboard browser (gallery, version timeline, preview).
  Full-text search + tags (user + memory-derived). **Acceptance:** browse
  + search artifacts on the web.

### Cross-cutting
- Schema `schemaVersion` + migrate-on-read (§AV-1).
- Mutability: `status:'final'` ⇒ read-only unless unlocked (§AV-1).
- Version-aware annotation staleness via §6 `contentHash` (§AV-2).

## Sequencing
§AV-1 → §AV-2 → §AV-3 is the high-leverage trio. §AV-4 makes artifacts a
natural output. §AV-5–8 interleave. UI-heavy tracks (§AV-2/3/5/8) are
screenshot-reviewed before commit.
