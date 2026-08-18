// ADR-041 D8 Phase 35 — the concurrent-worktree lifecycle tools (ADR-042). worktree_enter
// attaches an existing worktree (read-only if a live foreign session owns it), worktree_create
// makes+attaches a new branch worktree, worktree_done removes one through the SAME destructive
// guard as a hand-typed `git worktree remove`. New host surface: the three attach/detach methods
// (optional — absent on non-Agent hosts, guarded by typeof) plus lastUserPrompt + agentAuthoredCommits
// (the destructive guard's user-intent + agent-authorship inputs). Bodies are the former switch
// cases verbatim (this.x -> ctx.host.x).

import path from 'node:path';
import { listWorktreesStructured, resolveAttachableWorktree } from '../../../worktree/concurrentWorktrees.js';
import { createNamedWorktree, removeWorktreeAt } from '../../../worktree/isolation/worktreeIsolation.impl.js';
import { liveForeignOwner, recordWorktreeOwner, clearWorktreeOwner } from '../../../worktree/ownership/worktreeOwnership.js';
import { evaluateDestructiveCommand } from '../../../exec/guard/destructiveCommandGuard.js';
import { gitHeadSha } from '../../../git/workspaceGit.js';
import type { BuiltinToolHandler } from './registry.js';

export const worktreeHandlers: Record<string, BuiltinToolHandler> = {
  worktree_enter: async ({ args, host }) => {
        if (host.reviewSourceSafety) {
          throw new Error('worktree_enter is disabled while reviewing untrusted source.');
        }
        const target = typeof args.target === 'string' ? args.target
          : typeof args.path === 'string' ? args.path
          : typeof args.branch === 'string' ? args.branch
          : '';
        const res = resolveAttachableWorktree(host.workspaceRoot, target);
        if (!res.ok) throw new Error(res.reason);
        // ADR-042 D6 — if a LIVE foreign session owns this worktree, attach it
        // read-only (writes refused, owner named) unless the user overrides.
        const override = args.override === true || args.force === true;
        const foreignOwner = !override && host.sessionKey
          ? liveForeignOwner(host.workspaceRoot, res.info.path, host.sessionKey)
          : null;
        if (foreignOwner && typeof host.attachReadOnlyWorktree === 'function') {
          host.attachReadOnlyWorktree(res.info.path, foreignOwner);
          return JSON.stringify({
            entered: res.info.path,
            branch: res.info.branch,
            readOnly: true,
            owner: foreignOwner,
            note: `Attached READ-ONLY — session ${foreignOwner} is working in this worktree. You can read it; writes are refused. Pass override:true to take it read/write anyway.`,
          });
        }
        if (typeof host.attachWorktree === 'function') host.attachWorktree(res.info.path);
        if (host.sessionKey) { try { recordWorktreeOwner(host.workspaceRoot, res.info.path, host.sessionKey); } catch { /* best-effort */ } }
        return JSON.stringify({
          entered: res.info.path,
          branch: res.info.branch,
          detached: res.info.detached || undefined,
          note: 'Attached for this repository — files under this worktree now resolve for read and edit. The exec default cwd still points at the primary root; pass an explicit cwd to run commands there.',
        });
  },

  worktree_create: async ({ args, host }) => {
        if (host.reviewSourceSafety) {
          throw new Error('worktree_create is disabled while reviewing untrusted source.');
        }
        const branch = typeof args.branch === 'string' ? args.branch
          : typeof args.name === 'string' ? args.name : '';
        const fromRef = typeof args.from === 'string' && args.from.trim() ? args.from.trim() : 'HEAD';
        const created = createNamedWorktree(host.workspaceRoot, branch, fromRef);
        if ('error' in created) throw new Error(created.error);
        if (typeof host.attachWorktree === 'function') host.attachWorktree(created.worktreeRoot);
        if (host.sessionKey) { try { recordWorktreeOwner(host.workspaceRoot, created.worktreeRoot, host.sessionKey); } catch { /* best-effort */ } }
        return JSON.stringify({
          created: created.worktreeRoot,
          branch: created.branch,
          from: fromRef,
          attached: true,
          note: 'A new worktree on this branch, attached for read and edit. Run commands there by passing cwd to run_command; finish with worktree_done once the work is committed or merged.',
        });
  },

  worktree_done: async ({ args, host }) => {
        const target = typeof args.path === 'string' ? args.path
          : typeof args.target === 'string' ? args.target : '';
        if (!target.trim()) {
          throw new Error('worktree_done requires a worktree path or branch. Run worktree_list to see them.');
        }
        const list = listWorktreesStructured(host.workspaceRoot, undefined, { withDirty: true });
        const asPath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(host.workspaceRoot, target);
        const match = list.find((w) => path.resolve(w.path) === asPath) ?? list.find((w) => w.branch === target.trim());
        if (!match) {
          throw new Error(`No git worktree of this repository matches "${target}". Run worktree_list.`);
        }
        if (match.isSelf) {
          throw new Error(`"${target}" is the current workspace root — worktree_done cannot remove it.`);
        }
        const force = args.force === true;
        // Uncommitted work is preserved by default: surface it and stop, unless
        // the caller explicitly forces (which discards it).
        if (match.dirty && !force) {
          return JSON.stringify({
            removed: false,
            path: match.path,
            branch: match.branch,
            reason: 'This worktree has uncommitted changes. Commit or push them first, or call worktree_done with force:true to discard them.',
          });
        }
        // Route the removal through the SAME destructive-command guard as a
        // hand-typed `git worktree remove` (worktree-remove rule): the user's
        // intent authorizes it, otherwise a silent agent is refused and an
        // attended one is asked.
        const verdict = evaluateDestructiveCommand(`git worktree remove ${match.path}`, {
          userIntent: host.lastUserPrompt,
          headSha: gitHeadSha(host.workspaceRoot),
          agentAuthoredCommits: host.agentAuthoredCommits,
        });
        if (verdict.decision === 'block') {
          if (host.silent || (!host.interactionPort && !host.prompter)) {
            return JSON.stringify({ removed: false, path: match.path, reason: `${verdict.rule}: ${verdict.reason}` });
          }
          const approved = host.interactionPort
            ? await host.interactionPort.confirm({ title: 'Remove worktree?', detail: `${match.path}\n\n${verdict.reason}`, dangerous: true, tool: 'worktree_done' })
            : await host.prompter.askYesNo(`${verdict.reason}\nRemove it? (y/N) `, false);
          if (!approved) return JSON.stringify({ removed: false, path: match.path, reason: 'Removal declined.' });
        }
        const removed = removeWorktreeAt(host.workspaceRoot, match.path, { force });
        if (!removed.ok) throw new Error(removed.error ?? 'git worktree remove failed.');
        if (typeof host.detachWorktree === 'function') host.detachWorktree(match.path);
        try { clearWorktreeOwner(host.workspaceRoot, match.path); } catch { /* best-effort */ }
        return JSON.stringify({ removed: true, path: match.path, branch: match.branch });
  },
};
