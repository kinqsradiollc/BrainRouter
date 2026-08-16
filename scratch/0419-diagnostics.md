# 0.4.19 — confirmed diagnostics (evidence-backed)

Working notes for ADR-027. Every claim below was verified against the code on
`release/0.4.19` (branched from `main` @ v0.4.18).

## D1 — "required workflow skill not loaded" (adr-skill / planning-skill)

**Reported:** `Tool "delegate_explorer" paused until required workflow skill(s)
are loaded: adr-skill. Call get_skill for each…` — also with `planning-skill`.
User's question: *"I thought some of the skills are built in?"*

**Answer: they ARE bundled on disk — but the gate never reads them from disk.**

Chain:
1. `packages/core/src/workspace/requiredSkillActivation.ts:21`
   `resolveRequiredSkillActivation()` marks `adr-skill` / `planning-skill`
   REQUIRED from prompt heuristics (`requiresExplicitArchitectureDecision`,
   line 88 — matches `/\badr\b|architecture decision record/` plus a
   durable-surface × decision-intent cross product).
2. `packages/core/src/agent/runtime/requiredSkillPreflight.ts:40`
   `preflightRequiredSkills()` tries to auto-load each required skill.
3. It delegates to `resolveStageSkillActivation()` in
   `packages/core/src/orchestration/runtime/stageSkillActivation.ts:41`, which
   resolves in ONLY two ways:
   - `resolveWorkspaceManagedSkill(workspaceRoot, …)` — workspace `.brainrouter/` skills
   - **`input.mcpClient.callTool('get_skill', …)`** — the BRAIN over MCP
4. `packages/core/src/agent/runtime/toolAuthorizationPhase.ts:134`
   `requiredSkillsBlockingMutation()` then DENIES every mutating tool whose
   required skill id is not in `loadedSkillIds`.

**Root cause:** the W0 bundled starter skills (shipped in `packages/core/skills/`
and `brainrouter-cli/skills/`, PR #901) feed the CLI *catalog*
(`skillSearchRoots`) but are **invisible to the stage/preflight resolver**. When
the brain is unreachable, loopback-gated, rate-limited, or simply lacks the
skill, the preflight fails → mutating tools are blocked → hard stop.

**Aggravating factor:** `brainrouter-desktop/package.json` `build.files` is only
`["dist/**/*","dist-electron/**/*","package.json"]` with empty `extraResources`
— a PACKAGED desktop app ships **no** skills at all, so it can never satisfy the
gate locally.

**Fix direction:** teach `resolveStageSkillActivation` a third, FIRST-choice
source — the bundled on-disk skill catalog (same roots the CLI already
searches) — so built-in workflows resolve offline; ship `skills/` in the desktop
build; and make the gate degrade to a WARNING (not a deny) when a required skill
is unresolvable, so a missing workflow can never deadlock the agent.

## D2 — attachments are ingested but the AGENT cannot reach them

`packages/core/src/attachment/` is a complete subsystem: `format/detect.ts`
(mime/extension → kind), `format/pdfText.ts` (`extractPdf`), `ingest/ingest.ts:91`
(pdf branch), plus a store and service.

Consumers: `brainrouter-desktop/electron/host.ts`,
`brainrouter-desktop/electron/host/queries.ts`,
`brainrouter-cli/src/cli/commands/attachment/index.ts`,
`brainrouter/src/knowledge/services/documents.ts`.

**There is NO agent tool for attachments** — `grep attachment
packages/core/src/extension/builtin/` returns nothing. So the user attaches a
PDF/image, the host ingests it, and the agent still cannot read it. Identical
shape to the connectors gap (desktop-wired, agent-blind).

**Fix direction:** a first-class builtin extension exposing
list/read/search over session + workspace attachments, with images passed as
proper multimodal content parts rather than text.

## D3 — worktrees always open a NEW WINDOW and become projects

`openWorktree()` (`brainrouter-desktop/src/lib/session/hooks/useSessionActions.ts`)
does `trustWorkspace(path)` then `openWorkspaceWindow(path)`. Main's
`workspace:open-window` handler (`brainrouter-desktop/electron/main.ts`) always
opens/focuses a separate window, and the path lands in recents → it shows up as
a project. Panel wiring: `renderPanelBody.tsx:276` → `WorktreesPanel onOpen`.

That behavior was deliberate once (opening a worktree must not wipe the current
window's project list/chat), but it makes the user's real workflow impossible:
*plan in the main worktree, have the agent work in another worktree, same
session.*

**Fix direction:** decouple **agent working directory** from **window
workspace**. A session should carry an execution root that can point at a
worktree while the session, chat, and project list stay put — no new window, no
new project entry.

## D4 — parallel agent candidates

Rendered at `brainrouter-desktop/src/panels/workspace/WorktreesPanel.tsx:263`
(`candidate.adapterId` / `.status` / `.rank` / `.score`) — the UI exists; the
candidate production path is what needs verification against a live run.

## D5 — session naming + retention

- No auto-titling on turn 1. `sessionTitle` exists only as a HOOK output
  (`packages/core/src/hooks/hooksStore.ts:157,238`) — i.e. a user-configured
  hook can rename a session, but nothing names it automatically.
- No 30-day inactivity sweep and no cascade delete: `packages/core/src/session/state/*`
  only "prunes empty fields" within a record. Deleting a session/workspace does
  not reclaim transcripts, attachments, or browser partitions.

## D6 — loop → graph execution

Current turn execution is a loop with bolted-on phases
(`runTurn.impl.ts` + `agent/runtime/*Phase.ts`). Industry convergence is an
explicit directed graph with typed state, conditional routing, checkpointed
execution, and observability hooks — which is what gives durable resume,
human-in-the-loop interrupts, parallel fan-out/fan-in, and per-node retry.
