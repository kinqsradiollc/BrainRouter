<!--
  Strategic roadmap: competitive "steal" plan vs Claude Code / Codex, grounded in
  BrainRouter's real architecture (file pointers from a code investigation, 2026-06-21).
  Effort: S/M/L/XL. For team review — not yet committed to ROADMAP.md.
-->

# BrainRouter: What to Steal from Claude Code / Codex — Sequenced Roadmap

> **Owner decisions (2026-06-21):** Building **Phase 1 now** — #3 hooks, #4 sandbox, #5 commit-scanner. **#6** (multi-tracker sync) → **GitHub-only; deferred** (saved for later if a Jira/Linear customer materializes). **#7** (cloud/async agents) → **skipped for now** (revisit when the async model is clearer). #8 (VS Code) + Phase 0 (publish/market) remain open.
>
> Investigation correction: the hooks layer (`hooksStore.ts`) and sandbox (`exec/sandbox.ts`) are **more complete than the roadmap assumed** — both already work; #3/#4 are *enforcement-when-unattended + config surface*, not green-field.

## The bet

BrainRouter's real moat is **PM + provenance + memory**: a Jira-class Track board, a `ProvenanceRef` chain that ties requirement → plan → task → code → review → memory, and a recall pipeline with reproducible benchmark numbers (87% R-any@5 on LongMemEval, 0.90 on LoCoMo). That triad is already built and largely shipped — it just isn't *marketed* or *closed off*. The strategy is to double down there while closing three competitor-parity gaps that block adoption: **deterministic enforcement** (hooks + sandbox for unattended runs), **cloud/async background agents** (the flagship), and **IDE reach** (VS Code). The connective tissue is the git↔Track discipline (commit scanner, multi-tracker sync) that makes provenance trustworthy at scale.

What **not** to chase: don't build a first-party hosted compute platform from scratch (auth, billing, k8s) — make the cloud runner a pluggable interface. Don't extract a shared `@kinqs/brainrouter-ui` package for the VS Code MVP. Don't bolt on bespoke per-provider field-mapping UIs before the sync abstraction proves out. Resist green-fielding anything the existing `agent.ts` / `trackStore.ts` / `sandbox.ts` already does 80% of.

## Roadmap at a glance

| # | Initiative | Why (gap / edge) | Effort | Phase |
|---|------------|------------------|--------|-------|
| 1 | Publish 0.4.15 + dogfood automation | Built but unshipped; need precision baseline | M | 0 |
| 2 | Market provenance + memory moat | Differentiator is invisible to buyers | S | 0 |
| 3 | Deterministic hooks layer | Unattended/cloud runs need block-regardless-of-model | M | 1 |
| 4 | OS-level sandboxing | Cloud agents are unsafe without kernel isolation | L | 1 |
| 5 | BR-123 commit-message scanner | Makes code→Track provenance automatic & trustworthy | M | 1 |
| 6 | Track sync beyond GitHub (Jira/Linear) | PM moat only matters if it bridges existing trackers | L | 2 |
| 7 | Cloud/async background agents (flagship) | The headline parity gap vs Claude Code build-loop | XL | 3 |
| 8 | VS Code extension | Reach developers where they live | L | 3 |

## Sequenced phases

### Phase 0 — Ship and prove what's already built

**1. Publish 0.4.15 + dogfood automation** *(M)*
0.4.15 is feature-complete on `release/0.4.15` (tiered autopilot, requirements/sprints/Track automation, commits c69e7a68→c1ae3c59) but npm sits at 0.4.14 and main at 0.4.13.
- **Reuse:** `AutomationKnobs`/`ResolvedAutomationKnobs` in `packages/core/src/config/config.ts` (defaults already wired); `trackStore.ts` durable store at `<workspace-cli-state>/track.json`; `brainrouter-changelog/0.4.15.md` (already written); CLI `sync-changelog` prepublish task.
- **Build:** version bump across types/core/agent-protocol/sdk/hooks/CLI/MCP; move 0.4.15 to "Shipped" in ROADMAP.md; tag `v0.4.15`; publish workspaces; flip `cli.automation.requirements.autopilot` + `sprints.autopilot` on; run a 20-turn dogfood session; emit `dogfood-report.md` with detector precision.
- **Acceptance:** `npm view @kinqs/brainrouter-types@0.4.15` resolves; dogfood ≥20 proposals with precision ≥0.75; `/config` shows knobs live.
- **Risks/open Qs:** main is behind release — decide merge-to-main vs publish-from-branch before tagging. Define "false positive" crisply (ambiguous request wrongly marked ready vs duplicate). Automation-on may clutter the workspace — have a cleanup plan.

**2. Market the provenance + memory moat** *(S)*
Pure docs/positioning, zero new code — highest ROI item on the board.
- **Reuse:** `brainrouter-benchmark/reports/0.4.14-recall-delta.md` (headline numbers), `memory-comparison.md` (per-split table), `packages/agent-protocol/src/index.ts` lines 37–95 (`ProvenanceRef`), `brainrouter-docs/specs/memory-accuracy.md` + `memory-engine.md`.
- **Build:** `docs/benchmark.md` ("reproduce in 3 commands"), `docs/provenance.md` (lifecycle example citing exact `index.ts`/`trackStore.ts` paths), `docs/benchmark-methodology.md` (MemBench/LoCoMo/LongMemEval rationale + caveats), a README "Memory Accuracy" section, a 1500-word blog outline.
- **Acceptance:** clean-clone reproduces numbers; provenance doc cites exact exported types; README links benchmark.
- **Risks/open Qs:** disclose the missing-per-record-timestamp caveat prominently. Verify `/sources` / `/memory view` actually surface actor/reason before claiming it — else label "coming in 0.4.16." Don't make competitor-comparison claims without third-party audit.

### Phase 1 — Enforcement + signal foundations (prerequisites for cloud)

**3. Deterministic hooks layer** *(M)*
Mirror Claude Code's exit-2 PreToolUse/PostToolUse contract so a hook can block a tool *regardless of model judgment* — non-negotiable for unattended/cloud runs.
- **Reuse:** `packages/core/src/hooks/hooksStore.ts` (pre/post-tool events, deny/allow/updatedInput contract, 5s timeout, parsing at lines 137–148 already proven); `agent.ts` `processOneToolCall` already fires pre-tool hooks and converts denial→tool error (lines 2439–2474); `execPolicy.ts` `resolveToolPolicy`; `permissionRules.ts` glob matching.
- **Build:** add `pre-tool-exit`/`pre-tool-allow`/`post-tool-audit` events; `cli.hooks` block `{ enabled, exitOnDeny:2, rewriteArgs }`; `cli.deterministicHooksExitCode` (default 2); emit `{hook_decision}` OTEL trace; extend `hook-contracts.test.ts` with exit-2 + rewrite scenarios.
- **Acceptance:** non-zero exit / JSON deny blocks the call with matching error; `updatedInput` rewrites args; exit-2 honored; hook events traced; `cli.hooks.enabled=false` disables globally.
- **Risks/open Qs:** a hanging hook stalls dispatch (keep timeout tight; add `cli.hookFailureMode` so cloud timeouts don't wedge runs). Validate rewritten args parse as JSON. Decide: do hook denials enter model context or stay silent (cloud likely wants silent).

**4. OS-level sandboxing** *(L)*
The sandbox exists and works — this is hardening + config surface, not green-field.
- **Reuse:** `packages/core/src/exec/sandbox.ts` (`resolveSandboxConfig`, `runShell`, macOS `sandbox-exec` / Linux `bwrap`/`firejail`, fail-closed `CODEX-SANDBOX-FAILCLOSED` lines 59–72, denial detection lines 80–92); `config.ts` lines 241–256 (read/write paths, network bool, unavailable mode); `configuration.md` platform matrix.
- **Build:** `cli.sandboxPerCall`; extend `SandboxConfig` with `procLimit`/`uidMap`/`seccompProfile`/`inheritParentEnv`; `cli.sandboxProfile` presets (default/strict/permissive); `/sandbox` REPL command; Linux seccomp builder with graceful fallback; `cli.sandboxNetworkPolicy` (deny/allow/allowlist) wiring the existing `egressAllowlist`; emit `{sandboxEnabled,sandboxDenied,denialReason}` traces.
- **Acceptance:** `cli.sandbox='on'` wraps `run_command` with no silent fallback; network deny-by-default; read/write allowlists enforced; denial surfaces as a distinct sandbox error; per-call config validated before dispatch.
- **Risks/open Qs:** seccomp is arch-specific — ship presets only, no custom rules. iptables may conflict with container networking — default deny (no rules), explicit opt-in. Kernel <3.10 fallback to chroot — detect and warn. Decide cloud default: `sandboxUnavailable='deny'` (fail closed) vs `'warn'`.

**5. BR-123 commit-message scanner** *(M)*
Makes the code→Track provenance link automatic, so cloud-opened PRs (Phase 3) inherit a trustworthy linkage discipline.
- **Reuse:** `agent.ts` `applyTrackCodeSignalAutomation` (lines 4597–4640) — code→track transition engine already exists; `trackStore.ts` `linkWorkItem` (deduped append), `findWorkItemsByCodeLink`, `transitionWorkItem`; `brainrouter-cli/src/runtime/gitContext.ts` git spawn helper; `githubSync.ts` `keyFromBody` regex pattern + `cli.track.*` config shape.
- **Build:** `parseCommitMessage(body, projectKey)` (strict `<KEY>-<n>` regex); `scanGitHistorySince(root, since?)` over `git log --format`; `linkCommitToWorkItems` with dedup by `kind='commit',ref=sha`; a `CommitScannerAutomation` hook on the post-`track_update` path *and* a `/track sync --commits` command; `cli.track.{commitScannerEnabled,commitKeyPattern,commitScanDepth}`; `track-commit-scanner.test.ts`.
- **Acceptance:** scan parses BR-123 → codeLink `{kind:'commit',ref:sha}`; idempotent re-runs; commit auto-advances todo→in-progress; PR commits → in-review; config gates feature + pattern override.
- **Risks/open Qs:** false positives from "BR-123" in code — strict word-boundary regex. Default to last-50 commits + `--since` to bound cost. Decide auto-on-every-track_update (latency/noise) vs manual-only (proposal: default manual). Multi-key commits ("Fixes BR-123 and BR-456") — extend automation to handle >1 link per call.

### Phase 2 — PM moat bridges to where teams already live

**6. Track sync beyond GitHub (Jira/Linear)** *(L)*
The PM moat only matters if it federates with teams' existing trackers. The GitHub sync is already a clean DI'd pure-mapper engine — this is an abstraction extraction, not a rewrite.
- **Reuse:** `githubSync.ts` `SyncOptions` + `FetchLike` DI (zero GitHub-specific network code), `exportToGithub`/`importFromGithub` control flow (fetch/error/dryRun-gate, structurally generic), `resolveGithubConfig`; `config.ts` `CliKnobs.track`; `brainrouter-cli/src/cli/commands/track.ts` `handleSync` dispatch. Pure mappers `workItemToIssue`/`issueToWorkItem` reused unchanged.
- **Build:** `TrackSyncProvider` interface (`export`/`import`/optional `importMembers`); generalized `TrackSyncOptions`; refactor existing fns into `GitHubSyncProvider` (API contract unchanged); new `JiraSyncProvider` (REST `/rest/api/3`, transition-ID workflows, custom-field mapping) and `LinearSyncProvider` (GraphQL, team-scoped states); `resolveTrackSyncConfig(provider)` reading `cli.track[provider].*`; `SyncProviderFactory`.
- **Acceptance:** `cli.track.provider` selects backend (default github, no behavior change); `/track sync --provider jira|linear --dry-run` works; pure mappers unit-pass for all three; dedup by external key; `SyncResult.errors` per-item.
- **Risks/open Qs:** Jira/Linear field+workflow models differ — start **import-only** for validation, defer export until field-mapping config stabilizes; capture unmapped fields in description/metadata. Credentials via env (`JIRA_TOKEN`/`LINEAR_TOKEN`) not config.json. Status denormalization to todo/in-progress/done needs per-provider override (`cli.track.jira.statusMapping`). Identity mapping (login≠email≠user-id) — skip-and-warn on ambiguity.

### Phase 3 — Cloud agents + surfaces (the flagship and reach)

**7. Cloud/async background agents — Fire → Managed Run → PR + Track** *(XL)*
The headline parity gap. Depends on Phase 1 (sandbox isolates remote runs; hooks enforce them; commit-scanner gives PR→Track linkage discipline).
- **Reuse:** `packages/core/src/worktree/worktreeIsolation.ts` (`cli.worktreeRoot`); `agent/agent.ts` (Agent runtime, MCP pool, `LOCAL_TOOLS`); `orchestration/orchestrator.ts` (`createSession`/`listSession`); `agentRegistry.ts` (tier system chat/reasoning/worker); `background/backgroundTaskStore.ts` (durable task records); `track/trackStore.ts` CodeLink `pull-request` kind; `session/completionInbox.ts`; `workflow/workflowRun.ts` (phase/step + childIds); `track/githubSync.ts`; `brainrouter-desktop/electron/hostCore.ts` (handle() dispatch, per-sessionKey pool, InteractionPort); `brainrouter-cli/src/runtime/bgRuns.ts` (`/ps` `/fg` `/stop`).
- **Build:** Managed Runner Service (accepts task spec → isolated Agent worktree run, streams progress); durable task queue/scheduler; PR Opener module (`gh pr create` CLI mode / GitHub API hosted mode → returns PR# for Track); Track↔PR bi-directional CodeLink + status sync (draft→ready→merged); desktop background-task monitor + "Delegate to Cloud" button; `/delegate <role> <prompt> --track-key KEY --cloud URL` CLI; `cli.cloudRunner.{endpoint,auth}` + `enableDelegation` + `defaultRunnerRole`; run auditing/resumption via WorkflowRun phases; optional GitHub PR webhook listener feeding the completion inbox.
- **Acceptance:** `/delegate reviewer 'Review PR #123' --track BR-42` → work item linked to a newly opened PR, review runs isolated; desktop live panel with phase/ETA/cancel; parent sees completion next turn via inbox; BR-42 shows PR #999, status updates on merge; runner inherits parent access mode (no escalation); interrupted run resumable via `/agents show <id>`; full audit survives CLI restart + host reload.
- **Risks/open Qs:** hosted compute cost/latency (timeouts, cancellation, queue limits). **Token management is the hard one** — config.json/env violates the secrets-in-Settings rule; design OAuth/secret-store first. Worktree GC at scale (concurrent runners × worktrees → disk exhaustion). PR merge conflicts vs concurrent parent work. Desktop↔cloud desync needs persistent run state. **Completion inbox is in-process only** — must go disk-backed if runners outlive the CLI session. Big open question: first-party hosted service vs pluggable BYO-cluster interface (recommend the latter for a small team).

**8. VS Code extension** *(L)*
Re-host the *same* runtime via the typed agent protocol — same model as Desktop.
- **Reuse:** `packages/agent-protocol/dist/index.d.ts` (`AgentCommand`/`AgentEvent`, wire-stable); `hostCore.ts` `createHostCore` (pure, no Electron deps, reusable as-is); `electron/host.ts` settings-reuse contract (same `loadConfig`, `McpClientPool`, `.brainrouter/cli/` state); `agent.d.ts` public surface; desktop `MessageRow.tsx`/`DiffPanel.tsx` React components (copy-pasted for MVP); `config.d.ts` `loadConfig`/`getCliKnobs`.
- **Build:** extension `package.json` (views for Chat/Diff/Track); extension host booting Agent via core imports; VS Code↔host IPC bridge (JSON AgentCommand / tagged AgentEventMessage); webview chat panel reusing MessageRow; diff applier via `vscode.workspace.applyEdit`; Track TreeView calling same store queries; settings sync from `~/.config/brainrouter/config.json`; model picker via endpoint `GET /models`.
- **Acceptance:** launches + prompts for API key if config missing; sidebar resumes sessions (lazy transcript); turns stream in real time; artifact → diff panel with one-click apply; model selector lists endpoint models; multi-session with no cross-talk; interrupt stops active turn cleanly.
- **Risks/open Qs:** hostCore session-pool state machine assumes synchronous callbacks — IPC must preserve ordering. Copy-pasted UI must be patched in two places (defer `@kinqs/brainrouter-ui` extraction). **Worktree isolation is impractical in VS Code** — MVP is single-process Agent (no child parallelism). Config drift if desktop + extension both write config.json — file locking or one-active-per-workspace. Marketplace privacy review (2–4 week lag).

## Dependencies & critical path

```
Phase 0:  [1 Publish 0.4.15] ──┐
          [2 Market moat] ─────┘   (independent, parallelizable, no blockers)

Phase 1:  [3 Hooks] ───────────┐
          [4 Sandbox] ─────────┤──► enforcement foundation
          [5 Commit scanner] ──┘──► trustworthy code→Track linkage

Phase 2:  [6 Multi-tracker sync]  (builds on githubSync DI; independent of 3/4)

Phase 3:  [7 CLOUD AGENTS] ◄── requires 4 (sandbox isolates remote runs)
                            ◄── requires 3 (hooks enforce unattended)
                            ◄── benefits from 5 (PR→Track discipline)
          [8 VS Code]      ◄── requires 0.4.15 published protocol (1)
```

**Critical path to the flagship (cloud agents):** `1 (publish) → {3 hooks + 4 sandbox} → 5 commit-scanner → 7 cloud`. Sandbox (L) is the long pole inside Phase 1 and the hard prerequisite — a cloud runner without kernel isolation and deterministic hooks is a security liability, so 7 cannot safely precede 3+4. Two pre-existing in-process-only systems must be hardened *before* 7: the **completion inbox** (disk-backed) and **GitHub token provisioning** (secret store, not config.json) — both should be scheduled as explicit sub-tasks at the start of Phase 3, not discovered mid-build. VS Code (8) only hard-depends on the published protocol from Phase 0, so it can run in parallel with Phase 3 if a second person is available.

## Quick wins vs big bets

**Quick wins (ship value in days–weeks):**
- **Market the moat (S)** — zero code, pure docs; surfaces the existing benchmark + provenance differentiators. Do this *first*; it's the cheapest competitive leverage on the board.
- **Publish 0.4.15 (M)** — the work is already done on a release branch; this is bump-tag-publish + a dogfood pass.
- **Hooks (M)** — `processOneToolCall` already fires hooks and converts denial to error; this is mostly config surface + exit-2 semantics + traces.
- **Commit scanner (M)** — `applyTrackCodeSignalAutomation` and `linkWorkItem` already exist; the new code is a regex parser + git-log walker.

**Big bets (months, real risk):**
- **Cloud agents (XL)** — the flagship, gated on sandbox/hooks, with unsolved token-management and durable-inbox problems. High payoff, highest risk.
- **Sandbox (L)** and **multi-tracker sync (L)** and **VS Code (L)** — each substantial but well-scoped against an existing system (sandbox.ts, githubSync.ts DI, hostCore.ts respectively).

## Recommendation

For a small team where the differentiators are real-but-unshipped, do these three first, in order:

1. **Market the moat (S) — start immediately, in parallel with everything.** It's the only item with zero code risk and the highest competitive leverage. Right now BR's strongest asset (reproducible 87% recall + a full provenance chain) is invisible to anyone evaluating the product. Caveat: verify `/sources` actually renders actor/reason before publishing the provenance doc, or scope it honestly as "coming in 0.4.16."

2. **Publish 0.4.15 + dogfood (M).** Stop sitting on shipped work. npm at 0.4.14 while a feature-complete 0.4.15 waits on a branch is pure downside. The dogfood pass also produces the *first real precision number* for the automation tiers — which you need before you can market "autopilot" honestly or build cloud agents on top of it. Resolve the merge-to-main-vs-publish-from-branch question up front.

3. **Hooks (M), then sandbox (L).** These are the gate to the flagship. Hooks are nearly free given the existing firing logic and unlock deterministic, model-independent blocking — the thing that makes *any* unattended run safe. Sandbox is the longer lift but it already exists; you're hardening and exposing config, not building from zero. Doing these before cloud agents means the XL flagship lands on a safe foundation instead of becoming a security incident.

Defer the commit-scanner to right after hooks (it's a clean M that strengthens provenance), slot multi-tracker sync whenever a Jira/Linear customer materializes, and treat cloud agents + VS Code as the Q-after deliverables. The discipline here: **ship and market what's built, lock down enforcement, then spend the XL budget on cloud** — not the reverse.
