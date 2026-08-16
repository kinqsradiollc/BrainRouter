# ADR-042 — Worktrees the agent can enter: multi-root workspaces, worktree-aware tools, and a sandbox that lets git work

**Status:** PROPOSED

**Builds on:** ADR-025 (runtime boundary modernization), ADR-040 (one runtime, graphs of bounded
loops), the existing `worktree/` module (isolation + passive awareness) and the exec sandbox.

**Date:** 2026-08-16

---

## 0. The decision in one page

Users work feature-per-worktree. The agent cannot. Every filesystem tool is jailed to exactly one
`workspaceRoot`; worktrees are deliberately created **outside** that root
(`~/.brainrouter/worktrees/<repo>/<child>`), and the two in-repo places worktrees commonly live
(`.claude/`, `.brainrouter/`) are on the glob/grep ignore list. The result is the reported symptom
set: `read_file` on a worktree path throws `Path escapes workspace root`, `glob_files`/`grep_search`
never surface a worktree so the agent cannot even *see* it, `run_command` is cwd-pinned to the
primary root, and when the sandbox is on, git inside a worktree dies with `operation not permitted`
because a linked worktree's `.git` is a pointer into the **main** repo's `.git/worktrees/<id>` —
which the sandbox profile never grants.

The only escape hatch today is the user-facing `/cd`, which is all-or-nothing: it moves the single
root and wipes the read-before-edit ledger and child bookkeeping. The worktree module itself is
one-directional — it can *mint* a fresh detached-HEAD worktree for a child, and it can passively
warn "other worktrees exist, stay away" — but it cannot **attach to an existing one**.

This decision makes worktrees a first-class navigable surface:

> **A session's workspace becomes a small, explicit set of attached roots instead of one root.
> Worktrees of the current repository are attachable by derivation (same repo, same trust).
> The agent gets `worktree` tools to list, enter, create-on-a-branch, and hand off worktrees;
> `run_command` accepts a cwd bound to an attached root; and the sandbox grants the repo's common
> git directory so git actually works inside a linked worktree. Ownership stays enforced — one
> writing session per worktree, destructive guards unchanged.**

Seven decisions, six implementation slices. Each slice is one pull request.

---

## 1. Where the code is today

| Seam | Current shape | Why the agent gets rejected |
|---|---|---|
| Path jail | `resolveWorkspacePath` in `packages/core/src/agent/fs/workspaceFs.ts` (@38–95) throws `Path escapes workspace root` (@68–69) for anything outside the single root; realpath checks also drop symlinked entries during walks (@158, @249) | Worktrees live at `~/.brainrouter/worktrees/…` (see next row) — outside every repo root — so **every** `read_file` / `write_file` / `apply_patch` on a worktree path is rejected. All builtin fs tools funnel through this one function (`packages/core/src/extension/builtin/runtime.ts` @282). |
| Worktree placement | `worktreeBase()` in `packages/core/src/worktree/isolation/worktreeIsolation.impl.ts` (@48–57) → `<BRAINROUTER_HOME>/worktrees/<repo>/<childId>`, overridable via `cli.worktreeRoot` | Placement outside the repo was chosen (A5, 0.4.11) to avoid dirtying the tree — but combined with the single-root jail it makes every worktree unreachable from the parent session. |
| Discovery blindness | `IGNORED_DIRS` in `workspaceFs.ts` (@18–21) skips `.claude` and `.brainrouter` — the comment says why: they "can hold full repo COPIES under `.claude/worktrees/`" | Even worktrees placed *inside* the repo are invisible to `glob_files`/`grep_search`. The agent cannot discover a worktree it was asked to work in; the perf-motivated skip became a capability hole. |
| Attach-to-existing | `prepareChildWorkspace` (same file, @77–121) always mints a **new detached-HEAD** worktree named after the child id (@99–108) | There is no code path that resolves "the worktree for feature X" to an existing checkout. A feature's worktree with its branch and WIP cannot be resumed by a child or entered by the parent. |
| Awareness is passive | `concurrentWorktrees.ts` (@1–8): "the agent's Runtime Context lists the OTHER worktrees so it knows to **stay in its own** and not touch a branch/tree it doesn't own" | Awareness exists but is framed purely as avoidance. `listOtherWorktrees` returns display strings (`"<path> (<branch>)"`), not structured data a tool could act on. |
| Exec cwd | `runShell` in `packages/core/src/exec/runtime/sandbox.ts` (@235–238): "Always pin cwd to the workspace root"; `cwd = config.workspaceRoot` (@238 area) | `run_command` cannot run in a worktree. `cd <worktree> && …` inside the command string sidesteps the pin unsandboxed but breaks under sandbox (next row) — the worst of both worlds. |
| Sandbox write grants | `writeMacSandboxProfile` (@437–466): writes allowed only for `workspaceRoot`, tmp dirs, and `cli.sandboxWritePaths`; bwrap/firejail mirror this | A linked worktree's `.git` **file** points at `<main-repo>/.git/worktrees/<id>` (index, HEAD, locks live there; objects/refs in the shared `.git`). Neither is granted, so `git add/commit/status` inside a worktree fails with sandbox denials — reported by users as "the tool keeps rejecting". Isolated children get `workspaceRoot = worktree` but still no grant for the shared gitdir. |
| The only escape hatch | `Agent.changeWorkspace` in `packages/core/src/agent/agent.ts` (@1920–1955) — the `/cd` slash command | User-driven, not a model tool; single-root (replaces, never adds); resets the read ledger, authored-commit set, and pending-child bookkeeping on every move (@1945–1951). Ping-ponging between main tree and a worktree costs all session file-state each hop. |

### 1.1 What already works

The pieces exist; they are just not connected. `git worktree list --porcelain` parsing is pure and
tested (`parseWorktreePorcelain`). Worktree creation, change capture, and removal live behind a host
adapter (`nodeWorktreeIsolationHost`). The destructive-command guard already protects
`git worktree remove` and branch switches (`packages/core/src/exec/guard/destructiveCommandGuard.ts`
@128–155) and even *suggests* worktrees ("or I'll work on an isolated worktree instead so your tree
stays put") — a suggestion the agent currently cannot follow through on. The sandbox already
supports extra `writePaths`; nothing computes the right ones for a worktree.

---

## 2. Decisions

### D1 — A workspace is a set of attached roots

Introduce a session-scoped `WorkspaceScope`: one **primary root** (unchanged semantics — prompts,
memory bucket, code index anchor) plus zero or more **attached roots**. `resolveWorkspacePath`
accepts the scope and resolves a path when it is inside *any* attached root; the escape error is
kept verbatim for everything else. Attachment is explicit, logged, and enumerable — this is a
widening of the jail's door list, not a removal of the jail. The read-before-edit ledger is already
keyed by absolute path, so it survives attachment; only `/cd` (which *replaces* the primary root)
keeps its reset behavior.

### D2 — Worktrees of the current repo are attachable by derivation

A path is auto-attachable **without a user prompt** iff `git worktree list --porcelain`, run in the
primary root, lists it. Same repository, same objects, same trust domain — reading a linked worktree
exposes nothing the primary root does not. Anything else (sibling repos, arbitrary directories)
still requires the explicit user-level `/cd` or a config grant. This single rule fixes "agent can't
view the worktree of an existing project" without opening the filesystem.

The rule is deliberately **location- and creator-independent**. Git registers every linked worktree
at `git worktree add` time, wherever it lives and whoever ran it — the user by hand at
`~/dev/repo-feature-x`, another coding tool under `.claude/worktrees/` or its own conventions, or
BrainRouter under `worktreeBase()`. Porcelain output is the sole membership test;
`~/.brainrouter/worktrees` is merely where *BrainRouter-created* worktrees default to, never a gate.
Two corollaries:

- **The primary root may itself be a linked worktree.** `git worktree list` already reports the full
  set from any member (it reads the shared gitdir), so sibling discovery works no matter which
  checkout the session started in; the parser keeps excluding `selfPath` as today.
- **Stale entries are surfaced, not attached.** A porcelain block whose directory is gone (moved or
  deleted without `worktree remove`) is listed by `worktree_list` with a `prunable` flag and refused
  by `worktree_enter` with a pointer to `git worktree prune` — never silently skipped.

### D3 — First-class worktree tools

Four tools, thin wrappers over the existing hosts:

- `worktree_list` — structured output per worktree: path, branch (or detached), dirty flag, locked
  flag, and the owning session if the ownership registry (D6) knows one. Replaces the display-string
  API as the agent-facing surface; `listOtherWorktrees` stays for the prompt line.
- `worktree_enter <path|branch>` — validates against `worktree_list`, attaches the root (D1/D2), and
  re-points the exec default cwd at it. Unlike `/cd`, non-destructive and reversible.
- `worktree_create <branch> [--from <ref>]` — creates a **named-branch** worktree under
  `worktreeBase()` (today's isolation path can only mint detached HEADs for children). This is what
  "a feature is in a worktree" needs: branch first, worktree as its home.
- `worktree_done <path>` — the finish flow: surfaces uncommitted work, then routes removal through
  the existing destructive-command guard (`worktree-remove` rule unchanged).

### D4 — Exec follows the root you are working in

`run_command` gains an optional `cwd` parameter validated against the attached-root set (reject with
the same escape error otherwise). The cwd pin stays as the default — the bug it fixed (drifted
`process.cwd()` writing into `~/.brainrouter`) stays fixed; the parameter is a validated override,
not an unpin.

Sandbox: when the effective cwd (or the workspaceRoot of an isolated child) is a **linked
worktree**, the resolver adds two write grants computed via `git rev-parse --git-common-dir` and
`--git-dir`: the repo's shared `.git` and the worktree's private gitdir
(`.git/worktrees/<id>`). Both are realpath'd like every other grant. This is the direct fix for
`operation not permitted` on `git commit` inside a worktree, and it is the *only* sandbox widening —
network posture, fail-closed behavior, and env scrubbing are untouched.

### D5 — Discovery without walking

`IGNORED_DIRS` stays as-is: walking repo copies during glob/grep was a real 20-second regression and
we do not reintroduce it. Discovery instead comes from `worktree_list` (authoritative, milliseconds)
plus an upgraded Runtime Context block: instead of a "stay away" line, the prompt carries a
**feature map** — `branch → worktree path → owner` — assembled from the porcelain output and the
ownership registry. Glob/grep scoped *inside* an attached worktree root operate on that root
directly (D1 makes the paths resolvable), so content search works where the agent is actually
working.

### D6 — One writing session per worktree, enforced by registry not vibes

Reuse the runtime state store to record `worktree path → session key` on enter/create and clear it
on `worktree_done` or session end (stale entries expire by liveness check). `worktree_enter` on a
worktree owned by a live foreign session attaches **read-only** (write/patch calls into that root
are rejected with the owner named) unless the user overrides. The passive-awareness module keeps
feeding the prompt; the registry is the enforcement it never had.

### D7 — Children can resume a feature's worktree

`prepareChildWorkspace` gains `attachTo?: { path?: string; branch?: string }`. When set and the
target is listed by `git worktree list` (and not owned by a live foreign session, per D6), the child
gets `workspaceRoot = that worktree` instead of a freshly minted detached copy. Fan-out of N
features onto N existing worktrees becomes one spawn parameter. Given the known
disk-pressure constraint on mass worktree fan-out, resuming existing worktrees is also the cheaper
default — creation remains the fallback, not the rule.

---

## 3. Implementation slices

Each slice compiles and ships alone, in order:

1. **S1 — `WorkspaceScope` + multi-root `resolveWorkspacePath`** (D1). Pure refactor plus the
   attached-roots check; single-root callers unchanged via a default scope. Unit tests: escape
   messages byte-identical for unattached paths; symlink write-guard runs per-root.
2. **S2 — derivation rule + `worktree_list` / `worktree_enter`** (D2, D3 first half). Structured
   porcelain parse (extend the tested parser), auto-attach validation, tool registration in the
   builtin runtime.
3. **S3 — exec cwd + sandbox git-common-dir grants** (D4). The user-visible "rejection" fix. Tests:
   profile contains the common gitdir iff cwd is a linked worktree; bwrap/firejail arg parity.
4. **S4 — `worktree_create` / `worktree_done`** (D3 second half). Named-branch creation on the
   isolation host; finish flow through the destructive guard.
5. **S5 — ownership registry + read-only foreign attach** (D6) and the Runtime Context feature map
   (D5).
6. **S6 — `attachTo` on child spawn** (D7), threading through `spawn_agent` and the fan-out store.

---

## 4. What does not change, and alternatives rejected

- **The jail itself.** Multi-root is a widened allowlist, not `allowAnyPath`. Rejected: a blanket
  "trust anything under `worktreeBase()`" — that directory is shared across repos and sessions;
  derivation from the *current repo's* porcelain output is the narrowest sufficient rule.
- **Worktree placement.** They stay outside the repo (dirty-tree and watcher reasons from A5 hold).
  Rejected: moving worktrees into the repo and un-ignoring them — reintroduces the glob/grep
  crawl regression and fights file watchers.
- **`/cd` semantics.** Unchanged for users. Rejected: making `/cd` additive — its reset-everything
  contract is load-bearing for true workspace moves; attachment is the additive path.
- **Sandbox posture.** Only the two git-dir grants are added, computed not configured. Rejected:
  telling users to hand-maintain `cli.sandboxWritePaths` per worktree — it works today as a
  workaround but rots the moment a worktree is added.
- **Ignore-list surgery.** `IGNORED_DIRS` untouched (D5 explains the substitute).
- **Process placement.** Worktrees are filesystem state, so the whole capability — `WorkspaceScope`
  resolution, the `worktree_*` tools, and the sandbox grants — binds to the host that owns the
  working tree: it lives inside ADR-041's execution world, **not** in a control-plane service.
  Under a D12 service split (ADR-041), a remote brain reaches worktrees only *through* the
  execution world's seam (or ADR-043's reverse channels for a user-machine tree); the worktree
  seam itself is declared not remote-capable, so a profile cannot accidentally split the tools
  from the filesystem they manage.

---

## 5. Edge-case catalog

Every case below has a decided behavior; slice tests cite this table.

### 5.1 Membership and discovery

| # | Edge case | Decided behavior |
|---|---|---|
| E1 | Worktree at an arbitrary path outside the repo and outside `worktreeBase()` (created manually by the user, or by another coding tool) | Attachable. Membership = porcelain listing, never path prefix (D2). |
| E2 | Worktree created by another tool *inside* the repo (e.g. `.claude/worktrees/…`) | Attachable via `worktree_enter`; still hidden from glob/grep walks (`IGNORED_DIRS` unchanged) until entered, at which point scoped search runs against the attached root directly. |
| E3 | The session's primary root is itself a linked worktree | Listing runs against the shared gitdir, so all siblings (including the main checkout) appear; `selfPath` exclusion unchanged. |
| E4 | Stale/prunable entry — directory deleted or moved without `git worktree remove` | Listed with `prunable` flag; `worktree_enter` refuses and points at `git worktree prune`. Never silently skipped. |
| E5 | Worktree moved with `git worktree move` while attached | Scope revalidates against porcelain on each `worktree_*` call; the old root is detached and the new path offered. Mid-turn fs calls to the dead path fail with ENOENT, not the escape error. |
| E6 | Broken gitdir pointer (worktree moved by `mv`, needs `git worktree repair`) | Listed as broken; `worktree_enter` refuses with the repair command. |
| E7 | Worktree of a *different* repo colocated under the shared `worktreeBase()` | Not attachable — porcelain of the current repo is the sole test; blanket base-dir trust was rejected (§4). |
| E8 | Locked worktree (`git worktree lock`, e.g. on removable media) | Enterable; `locked` flag + reason surfaced; `worktree_done` refuses while locked. |
| E9 | Detached-HEAD worktree (today's child isolation output) | Listed as `detached`; feature map shows the short SHA instead of a branch. |
| E10 | Repo with more worktrees than the 12-entry prompt cap | Prompt map stays capped; `worktree_list` (the tool) is uncapped and authoritative. |
| E11 | Not a git repo / git too old for worktrees / porcelain call fails | Tools return the explicit notice (mirrors `prepareChildWorkspace` today); awareness stays empty; nothing throws into prompt assembly. |

### 5.2 Path resolution

| # | Edge case | Decided behavior |
|---|---|---|
| E12 | Porcelain path vs realpath drift (`/var`→`/private/var`, symlinked homes) | Membership and jail checks compare **realpaths** on both sides, matching the existing realpath discipline in `workspaceFs.ts` and `realpathOrSelf` in the sandbox. |
| E13 | Case-insensitive filesystems (macOS APFS) | Paths normalized via realpath before comparison; no case-sensitive string equality anywhere in scope checks. |
| E14 | Worktree nested inside the primary root — path resolves under two attached roots | Resolution picks the **deepest** matching root so root-relative semantics (read ledger, diff capture) bind to the worktree, not the parent. |
| E15 | Same relative path exists in two attached roots | No cross-root bleed: the read-before-edit ledger is keyed by absolute path already; edits in root B never satisfy a read done in root A. |
| E16 | Paths with spaces/unicode in sandbox profiles and bwrap args | Covered by existing `escapeSb` + array-arg spawning; S3 adds worktree-path cases to those tests. |
| E17 | `.git` is a *file* (linked worktree), not a directory | All git-location logic uses `git rev-parse --git-dir/--git-common-dir`; nothing may assume a `.git` directory. |

### 5.3 Exec and sandbox

| # | Edge case | Decided behavior |
|---|---|---|
| E18 | `git commit` in a linked worktree under `cli.sandbox: 'on'` | Write grants added for the shared `.git` and the worktree's private gitdir, computed per E17 (D4). Applies equally to manually created worktrees. |
| E19 | Linux/bwrap and firejail parity | The worktree root and both gitdirs are bind-mounted rw; the ro-rest posture is unchanged. WSL plan maps all three through `/mnt/<drive>`. |
| E20 | Submodules inside a worktree | Submodule gitdirs live under the shared `.git/modules` — covered by the common-gitdir grant. Submodules are separate repos: **not** attachable by derivation; entering one requires `/cd`. |
| E21 | Git hooks (`core.hooksPath`, hooks in the common gitdir) firing on commit | Reads are permissive and `process-exec` is already allowed; hook *writes* outside granted roots still fail closed — by design. |
| E22 | Shallow/partial clone needs a network fetch to materialize objects during a worktree operation | Sandbox network posture unchanged (deny). The denial is mapped to a clear "partial clone needs network; rerun unsandboxed or allow network" error instead of a bare `operation not permitted`. |
| E23 | Command sets `GIT_DIR`/`GIT_WORK_TREE` to sidestep cwd validation | Env can redirect git, but write grants and the destructive-command guard are unchanged, so blast radius is identical to running in the primary root. No extra parsing attempted. |
| E24 | Worktree on another mount/external volume (`/Volumes/…`) | Grants are computed from realpaths so they land on the true mount; OS-level permission failures surface as ordinary EACCES with the path named. |
| E25 | Worktree owned by a different OS user (sudo-created) | EACCES surfaces with the owner named; no elevation attempted. |

### 5.4 Concurrency and ownership

| # | Edge case | Decided behavior |
|---|---|---|
| E26 | Worktree owned by a live foreign BrainRouter session | Attach read-only; writes rejected with the owner named; `--force` requires the user (D6). |
| E27 | Owner session crashed and left a stale registry entry | Liveness check + expiry frees it; until expiry, `--force` is the escape hatch. |
| E28 | External tool (user's editor, another CLI agent) concurrently using a worktree it created | No registry entry exists — attach is read-write by default, with the dirty flag and last-modified time surfaced so the agent (and user) see live foreign activity. Advisory only; the destructive guard is the backstop. |
| E29 | Two BrainRouter sessions race to enter the same unowned worktree | Registry write is first-wins through the runtime state store; the loser attaches read-only. |
| E30 | Uncommitted work (anyone's) present on enter or on `worktree_done` | Enter: surfaced, never touched. Done: routed through the existing `worktree-remove` destructive rule — refuse unless the user confirms the work is disposable. |
| E31 | `worktree_create` for a branch already checked out in another worktree | Git refuses; the tool catches it and answers "enter the existing worktree instead", with its path. Never `--force`. |

### 5.5 Lifecycle and identity

| # | Edge case | Decided behavior |
|---|---|---|
| E32 | Session memory/artifact identity when entering a worktree | Attachment does **not** fork the memory bucket or session key — the primary root stays the identity anchor; only `/cd` re-anchors. Session-scoped artifacts/annotations keep working across enters. |
| E33 | Worktree removed externally while attached | Same as E5: revalidation detaches it; pending child bookkeeping referencing it is cleared with a notice, mirroring `changeWorkspace`'s reset semantics but scoped to the one root. |
| E34 | Child spawned with `attachTo` targeting a foreign-owned or prunable worktree | Spawn fails fast with the D6/E4 reason before any agent turns run — never silently falls back to minting a copy unless the caller passes `fallback: 'create'`. |
| E35 | Disk pressure | Attach-first is the default (D7); `worktree_create` reports the projected checkout size when the repo exceeds a threshold, honoring the known constraint against mass fan-out. |

## 6. Risks

- **Ownership staleness** — a crashed session could hold a worktree read-only. Mitigation: liveness
  check + expiry on the registry entry; `worktree_enter --force` surfaces the override to the user.
- **Sandbox grant breadth** — granting the shared `.git` allows a sandboxed command to touch refs of
  *other* branches. Accepted: identical blast radius to running in the primary root today, and the
  destructive-command guard still fronts ref-destroying commands.
- **Windows/WSL path mapping** — the common-gitdir grant must survive the `/mnt/<drive>` mapping in
  the WSL bwrap plan; covered by S3 parity tests.
- **Prompt growth** — the feature map is capped at the existing 12-worktree awareness limit.

---

## 7. Acceptance

The ADR is done when, in a repo with an existing feature worktree:

1. `worktree_list` shows it with branch, dirty state, and owner;
2. `worktree_enter` + `read_file`/`grep_search` on its files succeed with no escape errors — **including
   a worktree created manually (or by another tool) at an arbitrary path outside `worktreeBase()`** (E1/E2);
3. `run_command {cwd: <worktree>} git commit` succeeds **with `cli.sandbox: 'on'`**, on macOS and
   Linux sandboxers (E18/E19);
4. a spawned child with `attachTo: {branch}` lands in that worktree and its diff is captured by the
   existing change-capture flow;
5. a second session entering the same worktree is read-only and names the owner;
6. a session whose primary root is itself a worktree still lists and enters its siblings (E3), and a
   prunable entry is refused with the repair/prune hint rather than skipped (E4/E6);
7. every pre-existing single-root test passes unmodified.
