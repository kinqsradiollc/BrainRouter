# 09 — Docs, Skills, Agents & Plugins

Where documentation lives, how skills/ADRs/specs are authored, and the plugin +
marketplace conventions.

---

## Documentation topology

### 1. Know the three doc trees

- **`docs/`** = universal **TEMPLATES only** (contains a literal "TEMPLATE ONLY"
  marker; categories `api/design/schema/deployment/hooks/strategy` are served
  read-only via the MCP doc tools to _downstream_ projects). Do **not** put
  BrainRouter's own living docs here — that leaks internal content to clients.
- **`brainrouter-docs/`** = living deep docs (memory-engine.md, cli.md, hooks.md,
  federation.md, configuration.md, policy.md, specs/, decisions/).
- **`brainrouter-changelog/<version>.md`** = per-release notes; root `CHANGELOG.md`
  is the current-release view (Keep-a-Changelog). See [`08`](08-git-release-and-changelog.md).
- **Evidence:** `docs/TEMPLATE ONLY`, `brainrouter-docs/README.md`, `CHANGELOG.md:1`

### 2. `brainrouter-docs/README.md` is the mandatory index; top-level docs stay short

Top-level repo docs (README, BRAINROUTER, PRESENTATION) deliberately stay short;
deep dives live in `brainrouter-docs/`. **Every new deep doc, spec, or ADR must be
linked from `brainrouter-docs/README.md`** with a 1–3 line summary — the README is
the navigation surface, not an afterthought. Unindexed docs are effectively lost.

- **Evidence:** `brainrouter-docs/README.md:1,46`

### 3. `architecture-folder-structure-rules.md` is the boundary law — reference it, don't restate it

For structural questions, defer to
[`brainrouter-docs/architecture-folder-structure-rules.md`](../brainrouter-docs/architecture-folder-structure-rules.md).
Its layer model: **domain** (pure, no I/O) ← **contracts** (wire/store payloads,
type guards, stable IDs) ← **ports** (interfaces) ← **services** (use-cases
coordinating ports + domain) ← **presentation** (CLI/TUI/Desktop), with adapters
implementing ports and owning side effects; domain must be unit-testable without
mocks. Non-negotiables: memory stays central; all three apps follow the same
layered ownership; no new god files; no cosmetic folder moves; committed files
never name external reference projects nor copy their code; workflow state is
durable and linkable (requirements↔tasks↔artifacts↔reviews↔memory IDs);
branch/workspace state is read live from git, cached only with invalidation. New
convention docs link to it instead of duplicating it (this folder does exactly
that).

- **Evidence:** `brainrouter-docs/architecture-folder-structure-rules.md:7,77,216`

### 4. `task.md` and `walkthrough.md` are the living workflow artifacts at repo root

Track release work in a root `task.md`: a header block restating the binding rules
(target branch, one feature per PR, CI gates, no AI attribution), then checkbox
sections using the legend `[ ]` todo, `[x]` done, `[~]` in progress, `[U]` blocked
on user. On handover, write/update `walkthrough.md` with two sections: "## Completed
Changes" (behavior-level bullets, not raw diffs) and "## Verification" (the exact
commands run, one per line). Verify tests/lint green before writing the walkthrough.

- **Why:** these files are the contract between sessions/agents; `CLAUDE.md`'s
  workflow phases and the handover-skill assume this exact shape.
- **Evidence:** `task.md:1`, `walkthrough.md:1`, `CLAUDE.md`

### 5. Specs and ADRs live in `brainrouter-docs/` and are never deleted

- **Specs:** `brainrouter-docs/specs/<kebab-feature>.md`, titled `# Spec: …`,
  immediately followed by a `> Status:` blockquote tracking lifecycle
  ("in progress on `<branch>`" / "SHIPPED in 0.4.12" with links). Write + get
  approval on the spec **before** core code (SPECIFY→PLAN→TASKS→IMPLEMENT); retain
  it as the design of record after shipping.
- **ADRs:** `brainrouter-docs/decisions/ADR-NNN-<kebab-title>.md`, sequential
  three-digit numbering, header with a bold Status line + explicit `Supersedes:` /
  `Builds on:` links, a blockquote TL;DR, then Context / Decision / consequences.
  **Never delete** an ADR — write a new one that supersedes it. Match existing ADR
  style (the real files use a compact one-line header that differs slightly from
  the skill's fuller template).
- **Evidence:** `brainrouter-docs/specs/memory-accuracy.md`, `brainrouter-docs/decisions/ADR-007-postgres-memory-store.md:1`

---

## Skills & agent personas

### 6. AGENT.md is the single canonical manual; CLAUDE.md/AGENTS.md are thin pointers; develop locally, never via MCP tools

`AGENT.md` is the canonical cross-agent contributor manual (read order, scenario→
skill map, git/PR conventions). `CLAUDE.md` (auto-loaded by Claude Code) and
`AGENTS.md` (found by Codex-style agents) are **thin pointers** to it — they
carry only the pointer plus the hard rules, never duplicated content. When a dev
task matches a scenario, read the mapped `SKILL.md` **directly from the
filesystem** and follow it. **Never invoke `mcp_brainrouter_*` tools while
developing this repo** (you're building BrainRouter, not a client of it). When
you add a development-relevant skill, register it in `AGENT.md`'s Scenario
Mapping (the only map) with a relative link
`skills/<category>/<name>/SKILL.md`; don't grow the pointer files.

- **Evidence:** `AGENT.md`, `CLAUDE.md`, `AGENTS.md`

### 7. Skill layout: `skills/<category>/<kebab-name>/SKILL.md`, name matches directory

Every skill is a directory containing exactly one `SKILL.md` at
`skills/<category>/<skill-name>/SKILL.md`. The frontmatter `name` must be a
kebab-case slug **identical to the directory name**; the category is the first path
segment under the skills root (agent, api, codebase, communication, design, devops,
lifecycle, memory, qa, ux). Discovery walks max 5 levels and skips
`node_modules`/`.git`.

- **Why:** both the MCP registry and the CLI catalog derive name/category from the
  path; a mismatched frontmatter name breaks listing and resolution.
- **Evidence:** `brainrouter/src/registry.ts:61`, `brainrouter-cli/src/prompt/skillCatalog.ts:160`

### 8. SKILL.md frontmatter must stay regex-parseable — no full YAML

All frontmatter (SKILL.md, agent files, plugin `.local.md`) is parsed by small
dependency-free **regex** parsers, NOT a YAML library. Restrict frontmatter to
simple `key: value` scalars, block scalars (`key: |` with 2-space indented lines),
and simple `- item` lists. Required keys: `name`, `description`. Optional: `hints`
(agent guidance), `memory_hints` (a **separate** key the brain's
`memory_register_skill_hints` tool reads — don't confuse the two),
`allowed-tools`, `disallowed-tools`. Tool lists accept flow form
(`allowed-tools: [read_file, grep_search]`) or a simple `- item` block list; a
declared empty allowlist intentionally exposes no tools.

- **Why:** nested/advanced YAML silently fails to parse; the codebase deliberately
  avoids pulling a YAML engine.
- **Evidence:** `brainrouter/src/memory/skills/skill-hints-loader.ts:15`, `packages/core/src/plugin/localConfig.ts:11`

### 9. SKILL.md body sections are machine-addressable — use the canonical `##` headings

The MCP `get_skill`/`update_skill` tools extract sections by heading name:
`## Overview`, `## When to Use`, `## Workflow` (the DEFAULT section served to
agents), `## Usage`, `## Detailed Instructions`, `### Phase N` blocks,
`## Verification` (checklist), `## Red Flags`, `## Common Rationalizations`. Keep
these exact heading names; a skill without a `## Workflow` section serves nothing
useful by default. Skills may declare `disallowed-tools` to blacklist tools for the
turn they run, and `allowed-tools` to subtract everything except the named tools
from that turn's already-authorized surface. An allowlist never overrides access,
role, capability, agent scope, or deny rules; `disallowed-tools` still wins when a
tool appears in both lists. Stacked skills union their deny lists and intersect
the allowlists they actually declare. Slash commands map to skills via
`SLASH_TO_SKILL` in `skillRunner.ts` — author heavy workflow content in the skill
body (the single source of truth), keep the CLI prompt thin.

- **Evidence:** `brainrouter/src/types.ts:20`, `brainrouter/src/loader.ts:187`,
  `brainrouter-cli/src/prompt/skillCatalog.ts`,
  `brainrouter-cli/src/prompt/skillRunner.ts`,
  `packages/core/src/agent/runtime/runTurn.impl.ts`

### 10. Skill names are globally unique; know the shadowing precedence

Resolution is first-match-wins across ordered roots: workspace `<ws>/skills/` →
local `<ws>/.brainrouter/skills/` → plugin roots
(`.brainrouter/plugins/<name>/skills/`) → bundled (installed MCP package + monorepo
root `skills/`). A same-named skill in a lower-precedence root is **shadowed**
(surfaced as `<scope>:<name>` with a collision flag, not silently dropped). Don't
create two skills with the same name expecting both to load. `create_skill`
scaffolds with scope `global` (this repo) vs `local` (downstream project) and
refuses name collisions.

- **Evidence:** `brainrouter-cli/src/prompt/skillCatalog.ts:31,96,146`

### 11. JSON personas define domain responsibilities, not execution authority

Personas live as flat, schema-validated files at
`personas/<kebab-name>.json`. A persona defines domain responsibilities,
decision priorities, quality criteria, and bounded behavioral instructions.
It never selects a model, grants tools/access, configures delegation, or owns
execution limits. Respect the composition: **Skill** = the bounded workflow,
**Persona** = domain judgment, **Capability** = task-specific expertise,
**Orchestration role** = execution posture, and **Command** = a user-facing
entry point. Personas do not invoke personas.

Discovery is first-match-wins by source: workspace → local → enabled plugin →
bundled. Within a source, JSON wins over a same-ID legacy Markdown definition.
The legacy `agents/<id>.md` reader exists only for the migration window and must
not be extended with new features.

- **Evidence:** `packages/core/src/workspace/personaDefinitionFile.ts`,
  `packages/core/src/workspace/domainPersonas.ts`

### 11a. Executable agent JSON is a separate bounded trust boundary

An `agents/<id>.json` file defines child access, tool scope, ownership, limits,
and delegation behavior; it never creates a domain persona. Persona/executor
same-ID pairing is a legacy compatibility behavior, not a design convention.
New definitions declare `schemaVersion: 1` and
`kind: "orchestration-role"`; the compatibility parser normalizes definitions
that predate those discriminators but rejects wrong discriminator values,
persona-only fields, and unknown fields.
Executable definitions are read only from regular UTF-8 files under their
declared source root, capped at 64 KiB, validated field-by-field, and rejected
when their ID does not match the filename. Manifest v2 selects domain identity
through `persona` and independently bounds execution through
`orchestration.mode`, `availableRoles`, `disabledRoles`, and `maxParallel`.
Available never means invoked; disabled always wins. Legacy manifest
`agents.default` / `agents.enabled` is normalized through the compatibility
reader without widening its former executable surface. Missing or unreadable
manifests preserve the full legacy catalog. Project writers must validate the
exact serialized JSON through the same parser and use guarded atomic workspace
persistence; never cast arbitrary parsed JSON to `AgentDefinition`, follow
linked project/pack agent paths, or write executable definitions directly with
`writeFileSync`.

- **Why:** project and pack JSON becomes both a model-visible tool and child
  execution policy, so partial objects, path escapes, or arbitrary tool names
  would cross an execution boundary rather than merely affect display text.
- **Evidence:** `packages/core/src/orchestration/agents/agentDefinitionFile.ts`,
  `packages/core/src/orchestration/agents/agentRegistry.ts`,
  `packages/core/src/workspace/domainPersonas.ts`,
  `brainrouter-cli/src/orchestration/agentDefinitionWriter.ts`

### 11b. Compatibility readers emit reviewable diagnostics and content-free telemetry

Legacy Markdown persona use, persona collisions, legacy manifest-agent
translation, synthesized orchestration defaults, implicit same-ID pairing, and
the frontend-persona translation must be visible through typed diagnostics.
Telemetry records only the diagnostic code, surface, coarse source, and count;
never record persona ids, paths, manifest values, prompts, or file contents.
Deduplicate compatibility events per workspace/process and aggregate local
events before deciding whether a later release may remove a reader. Normal v2
manifests, including their serialized client alias, emit no migration signal.

- **Evidence:** `packages/core/src/workspace/compatibilityDiagnostics.ts`,
  `packages/core/src/workspace/domainPersonas.ts`,
  `packages/core/src/workspace/manifest.ts`,
  `packages/core/src/tests/migration-compatibility-diagnostics.test.ts`

### 11c. Orchestration profiles resolve whole definitions and fail closed

Orchestration-profile JSON resolves first-match-wins from workspace-local
`.brainrouter/orchestration-profiles/` → committable
`orchestration-profiles/` → enabled plugin contributions → bundled package
assets. Definitions never deep-merge. A higher-precedence file claims its ID
even when invalid, so a malformed override produces an unavailable diagnostic
and direct-primary fallback rather than silently activating a lower source.
Every source uses the same bounded, no-follow parser and exact role, skill,
signal, and output-contract reference catalog. Diagnostics disclose safe source
provenance and collisions without absolute paths or file contents.

- **Evidence:** `packages/core/src/orchestration/profiles/orchestrationProfileSources.ts`,
  `packages/core/src/orchestration/profiles/orchestrationProfileDefinitionFile.ts`,
  `packages/core/src/tests/orchestration-profile-sources.test.ts`

---

## Plugins & marketplace

### 12. Plugin manifest is `.brainrouter-plugin/plugin.json` — never `.claude`

A BrainRouter plugin is a folder whose manifest lives at
`.brainrouter-plugin/plugin.json` (the code repeatedly stresses: **never `.claude`
naming**). The only required field is `name` (kebab-case, validated by
`KEBAB_CASE_RE`); bad version/category produce **warnings, not hard failures**.
Component dirs are auto-discovered by convention when `contributes` omits them:
`skills/`, `personas/` (.json), `agents/` (executable JSON plus legacy Markdown
during migration), `commands/` (.md), `hooks/hooks.json`, `workflows/`,
`orchestration-profiles/`, `connectors/`, and `mcp.json` — so a skills-only
plugin is just `plugin.json` + `skills/`. Any explicit `contributes` path must
be relative and stay inside the plugin root (absolute and `..`-escaping paths
are rejected at parse **and** discovery time).

> Not to be confused with the repo's OWN `.claude-plugin/plugin.json` at the root,
> which distributes _this repo_ as a Claude Code plugin — a different artifact.

- **Why:** the installer is deliberately warn-not-fail for soft fields; the path
  guards are a security boundary.
- **Evidence:** `packages/core/src/plugin/manifest.ts:18-20,137`, `packages/core/src/plugin/discovery.ts:85`

### 13. Use `${BRAINROUTER_PLUGIN_ROOT}` for portable paths in plugin assets

Hooks, `mcp.json`, and connector assets inside a plugin must reference their own
files via the `${BRAINROUTER_PLUGIN_ROOT}` token (bare `$BRAINROUTER_PLUGIN_ROOT`
also expands), which the loader replaces with the plugin's absolute install root.
**Never hardcode absolute paths in plugin assets** (they break on install into a
different root per scope/machine).

- **Evidence:** `packages/core/src/plugin/manifest.ts:21,228`

### 14. Plugin storage scopes and sidecar files

Plugins install to exactly two scopes: user `~/.brainrouter/plugins/<name>/`
(override home with `BRAINROUTER_HOME`) and workspace
`<ws>/.brainrouter/plugins/<name>/` (committable, project-pinned). Install
provenance is `install.json` in the plugin root; installs stage atomically via
`~/.brainrouter/plugins/.staging`. Per-project plugin config is
`<ws>/.brainrouter/plugins/<name>.local.md` — YAML frontmatter (machine config) +
Markdown body (human notes), inert unless a component reads it. Marketplaces are
indexed by a `brainrouter-marketplace.json` at the source root and recorded in
`cli.plugins.marketplaces[]` in `config.json`.

- **Why:** everything plugin-related keys off `.brainrouter/` conventions +
  `config.json` knobs; inventing new locations/env vars breaks loader resolution
  and the CLI-knobs-in-config rule.
- **Evidence:** `packages/core/src/plugin/paths.ts:1`, `packages/core/src/plugin/marketplace.ts:1`

### 15. Plugins are packaging, not a runtime; loading is additive and never fatal

A plugin contributes paths that feed the **existing** subsystems (the same skill
catalog, agents, orchestration-profile resolver, hooks, MCP, connectors,
workflows) — **never build a parallel plugin runtime**. Plugin loading in
consumers must be best-effort (wrap in try/catch so config or filesystem trouble
never breaks the host feature — skill discovery explicitly swallows
plugin-loading errors). Plugin skill roots slot
between workspace roots (which still win) and bundled roots. `safeMode` disables all
skills and plugin loading entirely.

- **Evidence:** `packages/core/src/plugin/discovery.ts:1`, `brainrouter-cli/src/prompt/skillCatalog.ts:104`

### 15a. Package-owned profile plugins use the standard manifest and stay inert until selected

Workspace profile and task-time capability bundles live under
`packages/core/profile-plugins/<pack-id>/`, each with the same
`.brainrouter-plugin/plugin.json` and `skills/` conventions as an installed
plugin. Their public availability/version catalog is owned by
`packages/core/src/workspace/profilePlugins.ts`, and `packages/core/package.json`
must ship the entire `profile-plugins/` asset tree. These artifacts are not
top-level bundled skills and are never added to the ambient catalog merely
because the package is installed; a later workspace resolver must select the
pack explicitly. Profile packs contribute bounded identity through
`personas/*.json`; selecting that identity never creates a same-ID executable
child. If a profile ever needs a genuinely distinct executable policy, keep it
under `agents/` with a role-oriented ID and require separate manifest
orchestration enablement. Never add unconditional domain executors under the
package's top-level `agents/` directory.

- **Evidence:** `packages/core/src/workspace/profilePlugins.ts`, `packages/core/profile-plugins/`, `packages/core/package.json`

### 15b. Manifest skill selection is task-scoped data, not global plugin state

Resolve reviewed `skills.packs`, explicit skill enables/disables, and already
activated capabilities through `packages/core/src/workspace/skillSelection.ts`.
The resolver may expose selected package plugin roots and an ambient skill
allowlist to CLI/Desktop adapters, but it must never mutate process-wide plugin
or extension state. A missing manifest is an exact no-op. Capability plugins
such as frontend and backend require task-time capability activation; merely
adding their ID to the manifest pack list cannot activate them. Explicit skill
disables win over profile, capability, and individual enable contributions.

CLI catalog adapters insert selected package roots after workspace-authored
roots and before ordinary plugin/bundled roots. They apply the same ambient
disable and priority policy to filesystem and MCP list results, and re-resolve
task capabilities from the current prompt before keyword-trigger matching.
In a managed workspace, package profile/capability skill IDs stay hidden until
selected even if a legacy bundled root contains a same-ID copy; the selected
package plugin root wins ahead of that bundled copy.
Explicit `/skill` lookup may search every available package profile root so a
disabled skill remains intentionally invokable, but the resolved skill's
per-turn tool allow/deny policy still applies. Never add package profile roots
to a workspace with no readable manifest.

The shared Agent runtime applies that same selection at the BrainRouter MCP
skill-tool boundary. Adapt `list_skills` and `search_skills` results per Agent
turn, and serve an explicit package-owned `get_skill` from the validated package
asset so Desktop, CLI, and delegated agents cannot receive a stale same-name
global copy. Do not change the backend's process-global registry or intercept a
third-party MCP server that merely exposes a coincidentally named tool. A
workspace-local same-name skill keeps normal local precedence. Full explicit
reads retain frontmatter so the existing skill tool-policy parser remains
authoritative.

- **Evidence:** `packages/core/src/workspace/skillSelection.ts`, `packages/core/src/workspace/skillToolAdapter.ts`, `packages/core/src/tests/workspace-skill-selection.test.ts`, `packages/core/src/tests/workspace-skill-tool-adapter.test.ts`, `brainrouter-cli/src/prompt/skillCatalog.ts`, `brainrouter-cli/src/tests/workspace-skill-catalog.test.ts`

### 15c. Reviewed workspace pickers consume the Core selection catalog

Onboarding and workspace-edit surfaces must obtain tool groups, stable local
tools, skill packs, and skills from
`packages/core/src/workspace/selectionCatalog.ts`. Do not duplicate these IDs,
descriptions, provenance labels, or availability rules in CLI/Desktop code.
The catalog projects only bounded metadata from the authoritative registries:
never skill bodies, raw plugin prompts, filesystem paths, credentials, or raw
MCP discovery responses. Installed package contributions carry their stable
plugin provenance; unavailable known entries remain visible but blocked.
Ordinary installed-plugin skills must come from the same `loadPlugins` snapshot
as contributed orchestration profiles. Parse only bounded `SKILL.md`
frontmatter under no-link contained roots. Disabled plugin skills may be shown
as blocked, but only enabled plugin skill IDs may satisfy a contributed plan
reference. Stable extension tools keep their registered owner as provenance;
live MCP-advertised tool names remain non-persistable.

Dynamic MCP tool names may be displayed as live, non-persistable rows. Reviewed
tool/skill writes reject typos, unavailable entries, wrong entry kinds, and
live-only names. Rebuild the catalog immediately before write and compare its
content-free fingerprint so a stale review cannot grant a contribution that
changed after display.

- **Evidence:** `packages/core/src/workspace/selectionCatalog.ts`, `packages/core/src/workspace/onboardingSources.ts`, `packages/core/src/tests/workspace-selection-catalog.test.ts`, `packages/core/src/tests/workspace-onboarding-sources.test.ts`

### 16. ⛔ Executable plugin capabilities are consent-gated through the existing exec policy

Command-type hooks and MCP command-servers shipped by a plugin stay **disabled**
until the user approves them via `cli.plugins.approved[name].{shell,mcp}`; enabling
a plugin first produces a disclosure summary ("3 skills, 2 hooks running `<cmd>`, …")
with a `requiresConsent` flag. Managed gating uses `allowedMarketplaces`/
`blockedMarketplaces`/`allowManagedHooksOnly` knobs. Compatibility mismatches
(`compatibility.brainrouterVersion`/`agentApiVersion`) warn but never hard-fail.
Keep the trust functions **pure** (no side effects) so they stay trivially testable.

- **Why:** plugins can ship arbitrary shell commands; the consent layer decides
  whether a contribution is even registered, while the normal two-axis exec policy
  gates the runtime call.
- **Evidence:** `packages/core/src/plugin/trust.ts:1`, `packages/core/src/plugin/trust.test.ts`

### 17. Tag plugin/feature modules with their phase and colocate node tests

Every module in `packages/core/src/plugin/` opens with a doc comment tagged
`PLUGIN-MARKETPLACE P<n>` naming the phase, and cross-cutting call sites reuse the
same tag. Behavior ships with colocated `*.test.ts` in the same folder
(`plugin.test.ts`, `marketplace.test.ts`, `trust.test.ts`). Follow the same
feature-code tagging (`CC-SKILLS-D2`, `CC-CONFIG-A1`) when extending tagged
features elsewhere — the tags make a feature's slices greppable across packages.

- **Evidence:** `packages/core/src/plugin/manifest.ts:2`, `packages/core/src/plugin/plugin.test.ts`
