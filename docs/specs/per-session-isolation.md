# Spec: Per-Session Workspace Isolation

> Status: **DRAFT — design only, not yet approved.** No code until sign-off.
> Target: 0.4.11+ (sequenced after the child-isolation merge-back work that
> shipped on `release/0.4.11`). Owner: TBD.

## Objective

Let two or more independent BrainRouter CLI sessions work the **same git repo at
the same time** — two terminals, two people, or one human plus a scheduled run —
without stepping on each other's files.

Today, every top-level CLI process edits the **shared** working tree directly.
The 0.4.11 worktree work isolates *spawned child agents within one session*, but
the **session itself** (the agent you chat with) is not isolated, and two
separate processes have no awareness of each other. Result: concurrent sessions
race on the same files, last-write-wins, with no warning.

This spec designs **opt-in session-level isolation**: each isolated session works
in its own git worktree + branch, merges back on exit, and a cross-process
registry makes concurrent sessions visible to one another.

### Why this is separate from child isolation

| | Child isolation (shipped) | Session isolation (this spec) |
|---|---|---|
| What's isolated | spawned write/shell children | the top-level session itself |
| Who's editing | background agents | **the user**, directly |
| Safe to default on? | yes (`auto`) — edits are background, merge-back is invisible-but-correct | **no** — isolating the user's *own* edits behind a merge step is surprising → **default `off`, opt-in, loud banner** |
| Coordination scope | in-process (one parent) | **cross-process** (needs a registry/lock) |

## Current Behavior (what is NOT isolated)

- The top-level agent edits `ctx.workspaceRoot` (the real repo) directly.
- Two `brainrouter` processes on one repo both write the real tree; neither knows
  the other exists.
- `childWorkspaceIsolation` only wraps `spawn_agent` children.

## Proposed Design

Three components, layered. (a) is the foundation and ships first; (b)+(c) are the
isolation itself.

### (a) Cross-process session registry + advisory lock — *foundation*

A per-repo record of live sessions under the BrainRouter home (NOT the repo):

```
~/.brainrouter/workspaces/<encoded-repo>/sessions-active.json
  [{ sessionId, pid, branch, worktreePath?, startedAt, isolated: bool }]
```

- Written on CLI boot, removed on clean exit, **reconciled on boot** (dead pids
  pruned — mirrors `reconcileStale` / `reconcileStaleWorkers`).
- On boot, if another **live** session targets the same repo, surface a banner:
  `⚠ 2 BrainRouter sessions active on this repo (pid 1234 on branch …).`
- Value on its own: even with isolation `off`, users get a collision warning.

### (b) Session worktree + branch — *the isolation*

When `cli.sessionIsolation` is `auto`/`worktree` and the repo is git:

- On boot: `git worktree add -b brainrouter/session/<sessionId>
  $TMPDIR/brainrouter-session-worktrees/<repo>/<sessionId> HEAD`.
- The session's `workspaceRoot` (and therefore its children) resolve to that
  worktree. A **persistent, loud** banner shows the isolated branch.
- Child isolation **nests** beneath the session worktree (a child worktree is
  added from the session worktree; child merge-back targets the session
  worktree; the session merge-back targets the user's branch on exit).
- `auto` falls back to the shared root on a non-git repo (like child `auto`);
  `worktree` is strict (errors if it can't isolate).

### (c) Merge-back on exit — *reuse the child machinery, branch-aware*

On session end (clean exit, `/quit`, or detected dead-pid reconcile):

1. If the session branch has **no commits and no working changes** → remove the
   worktree + delete the branch (nothing to merge).
2. If there are changes → **do not auto-apply** (unlike children — this is the
   user's own larger body of work). Instead:
   - Offer: `git merge` / fast-forward into the original branch when clean.
   - On conflict or when declined → **leave the branch** `brainrouter/session/<id>`
     intact and print the merge command. The work is never lost.
3. Reuse `applyPatchFile` / `git apply --check` semantics from
   `worktreeIsolation.ts` for the "apply a captured diff" path; prefer real
   branch merges for committed work.

## Architecture Changes

- **New** `brainrouter-cli/src/orchestration/sessionIsolation.ts` — session
  worktree lifecycle (`prepareSessionWorkspace`, `teardownSessionWorkspace`),
  built on the existing `worktreeIsolation.ts` git primitives (`runGit`,
  `gitRoot`, `defaultWorktreePath`, `applyPatchFile`).
- **New** `brainrouter-cli/src/state/sessionRegistry.ts` — the active-session
  registry + lock + `reconcileActiveSessions(pid)`.
- **Hook** CLI boot (where `applyWorkspaceRoot` / the Agent is constructed) to
  prepare the session workspace + register; hook exit/`/quit` to teardown.
- **Config** new knob `cli.sessionIsolation: 'off' | 'auto' | 'worktree'`
  (default `'off'`), plus interface doc + `resolveCliKnobs` default + `/debug-config`.
- **Banner** a persistent statusline/banner segment when isolated.
- **Reuse**, do not duplicate, the child worktree GC + patch-retention from A3.

## In Scope

- Opt-in per-session git-worktree isolation + branch.
- Cross-process active-session registry, lock, boot reconcile, collision banner.
- Branch-aware merge-back on exit with a no-loss fallback (leave the branch).
- Nesting with `childWorkspaceIsolation`.

## Out of Scope

- Non-git workspaces (fall back to shared root; no isolation).
- Real-time multi-writer conflict resolution / OT/CRDT. We isolate + merge, not
  live co-edit.
- Remote/distributed sessions across machines (single-host only).
- Auto-applying a session's edits without user confirmation.

## Boundaries

- **Always:** keep `sessionIsolation` default `off`; show a loud, persistent
  banner whenever a session is isolated; reconcile dead sessions on boot; on any
  merge ambiguity preserve the branch rather than risk the user's work.
- **Ask first:** before merging an isolated session's branch back into the user's
  working branch; before deleting a session branch that still has unmerged commits.
- **Never:** silently relocate the user's working tree without the banner; auto-
  apply a session's changes over a dirty/conflicting target; isolate when the repo
  isn't git (degrade instead); leave orphaned worktrees/branches after a clean exit.

## Success Criteria (Definition of Done)

- [ ] With `sessionIsolation: 'off'` (default), behavior is byte-for-byte today's
      — verified by the existing suite staying green.
- [ ] With `'auto'` in a git repo, a session's top-level edits land in
      `brainrouter/session/<id>` worktree, not the user's working tree; a banner
      shows the branch.
- [ ] Two sessions editing the **same file** concurrently never corrupt it; each
      sees only its own worktree; the registry banner warns about the other.
- [ ] On clean exit with changes, the user is offered a merge; declining leaves
      branch `brainrouter/session/<id>` and prints the exact `git merge` command.
- [ ] A killed session's worktree + registry entry are reconciled on the next boot
      (dead pid), its branch preserved if it had changes.
- [ ] `'auto'` on a non-git workspace falls back to the shared root with a notice.
- [ ] Deterministic tests for: prepare/teardown, registry reconcile, merge-back
      clean + conflict (branch preserved), nesting with child isolation.

## Risks & Mitigations

- **Surprise** (user can't find their edits) → default off + loud persistent
  banner + `/debug-config` shows the mode + the merge command on exit.
- **Branch sprawl** (`brainrouter/session/*` accumulates) → GC on boot reconcile;
  delete on clean no-change exit; list via `/agents` or a new `/sessions`.
- **Nested-worktree edge cases** (child worktrees under a session worktree) →
  covered by tests; `git worktree` supports linked worktrees off a linked worktree.
- **Detached vs branch** — children use `--detach`; sessions use a named branch so
  commits are recoverable. Keep the distinction explicit.

## Open Questions

1. Granularity: one isolated worktree **per process**, or per **named** session
   (so `brainrouter --session foo` re-attaches the same worktree across runs)?
2. Should merge-back default to a real `git merge` (commit-based) or to the
   working-tree `git apply` path? (Leaning: commit-based when the session has
   commits, apply-path otherwise.)
3. Does the registry belong in SQLite (brain) or a JSON file (CLI state)? JSON
   keeps it CLI-local + offline; SQLite enables a dashboard view.
4. Interaction with `BRAINROUTER_HOME` relocation and multi-instance MCP profiles.

## Phased Plan

1. **P1 — Registry + lock + collision banner** (ship even with isolation off).
2. **P2 — Session worktree + branch + banner** behind `sessionIsolation`.
3. **P3 — Merge-back on exit** (branch-aware, no-loss fallback) + `/sessions`.
4. **P4 — Nesting** with `childWorkspaceIsolation` + full test matrix.
