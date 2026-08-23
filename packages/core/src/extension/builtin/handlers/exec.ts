// ADR-041 D8 — the exec family. task_output reads incremental output from a
// background run_command; it is gated by the inherited-execution-authority guard
// (reviewed execution has no execution-owned background pids). It carries no
// approval/lease of its own, so it migrates verbatim ahead of the run_command
// keystone that will front the mutating exec tools with the shared guard pipeline.

import { readBackgroundOutput, killBackgroundShell, startBackgroundShell } from '../../../exec/runtime/backgroundShell.js';
import fs from 'node:fs';
import chalk from 'chalk';
import { getCliKnobs } from '../../../config/config.js';
import { decideExecutionPolicy } from '../../../exec/policy/execPolicy.js';
import { evaluateDestructiveCommand } from '../../../exec/guard/destructiveCommandGuard.js';
import { buildRunCommandPrompt, isDangerousCommand, resolveRunCommandApproval } from '../../../exec/guard/dangerousCommand.js';
import { resolveSandboxConfig, runShell } from '../../../exec/runtime/sandbox.js';
import { recordDenial } from '../../../exec/runtime/recentDenials.js';
import { resolvePentestSandbox, runPentestCommand } from '../../../review/pentestSandbox.js';
import { gitHeadSha } from '../../../git/workspaceGit.js';
import { readGoal } from '../../../goal/store/goalStore.js';
import { readPreferences } from '../../../session/preferences/preferencesStore.js';
import { resolveActiveMode } from '../../../session/state/sessionModeStore.js';
import { resolveWorkspacePath, resolveWorkspacePathInScope } from '../../../agent/fs/workspaceFs.js';
import type { ShellPort } from '../../../agent/shell/shellPort.js';
import type { BuiltinToolHandler } from './registry.js';

// ADR-041 D3 — default shell port: wraps runShell / startBackgroundShell verbatim, so the
// local exec path is byte-identical. An execution world (D10) injects a container/remote port.
// (Moved here from runtime.ts with run_command, its sole consumer.)
const nodeShellPort: ShellPort = { runShell, startBackgroundShell };

export const execHandlers: Record<string, BuiltinToolHandler> = {
  task_output: async ({ args, host }) => {
    // CC-P11.1 — incremental output of a background run_command.
    if (host.inheritedExecutionAuthorityGuard()) {
      throw new Error('task_output is unavailable inside reviewed execution because background process ids are not execution-owned.');
    }
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('task_output requires an id (from run_command background:true).');
    const fromByte = typeof args.fromByte === 'number' && args.fromByte >= 0 ? Math.floor(args.fromByte) : 0;
    const out = readBackgroundOutput(id, fromByte);
    if (!out) return JSON.stringify({ id, found: false, note: 'Unknown background run (it dies with the CLI process).' });
    return JSON.stringify(out);
  },

  kill_command: async ({ args, host }) => {
    if (host.inheritedExecutionAuthorityGuard()) {
      throw new Error('kill_command is unavailable inside reviewed execution because background process ids are not execution-owned.');
    }
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('kill_command requires an id (from run_command background:true).');
    const signal = args.signal === 'SIGKILL' || args.signal === 'SIGINT' ? args.signal : 'SIGTERM';
    const killed = killBackgroundShell(id, signal);
    return JSON.stringify({ id, killed, signal, ...(killed ? {} : { note: 'No running background command with that id (already exited, or unknown id).' }) });
  },

  run_command: async ({ args, host }) => {
        const cmd = args.command;
        // ADR-042 D4 — an optional validated `cwd`. The default stays the
        // workspace root (the pin that stopped a drifted process.cwd() writing
        // into ~/.brainrouter); a passed cwd is validated against the workspace
        // SCOPE (primary + entered worktrees) and rejected with the same escape
        // error otherwise. It is a validated override, never an unpin.
        let cwdOverride: string | undefined;
        if (typeof args.cwd === 'string' && args.cwd.trim() !== '') {
          cwdOverride = host.workspaceScope
            ? resolveWorkspacePathInScope(host.workspaceScope, args.cwd)
            : resolveWorkspacePath(host.workspaceRoot, args.cwd);
          if (!fs.existsSync(cwdOverride) || !fs.statSync(cwdOverride).isDirectory()) {
            throw new Error(`run_command cwd is not a directory: ${args.cwd}`);
          }
        }
        const effectiveCwd = cwdOverride ?? host.workspaceRoot;
        // CLI-11 — route the shell gate through the unified execution policy
        // (same outcome as the previous `accessMode !== 'shell'` check).
        const shellPolicy = decideExecutionPolicy('shell', host.accessMode);
        if (shellPolicy.decision === 'deny') {
          return `Command execution denied: ${shellPolicy.reason}.`;
        }
        // WS5 — destructive-command guard: BLOCK git/IaC actions the user didn't
        // ask for (reset --hard / checkout -- / clean -f / stash drop, an --amend
        // of a commit we didn't author this session, or an IaC destroy without the
        // stack named). Attended users can override via a confirm; silent/headless
        // agents are refused outright (they can't answer a prompt).
        let destructiveOverride = false;
        {
          const verdict = evaluateDestructiveCommand(cmd, {
            userIntent: host.lastUserPrompt,
            headSha: gitHeadSha(host.workspaceRoot),
            agentAuthoredCommits: host.agentAuthoredCommits,
          });
          if (verdict.decision === 'block') {
            // CC-SAFETY-B2 — the destructive-command guard's reason flows into the
            // session's recent-denials ring (best-effort) so `/recent-denials` can
            // surface WHY the command was blocked.
            const recordBlocked = () => {
              try { recordDenial(host.workspaceRoot, host.sessionKey, 'run_command', `${verdict.rule}: ${verdict.reason}`); } catch { /* best-effort */ }
            };
            if (host.silent || (!host.interactionPort && !host.prompter)) {
              recordBlocked();
              return `Command blocked (${verdict.rule}): ${verdict.reason}`;
            }
            const approved = host.interactionPort
              ? await host.interactionPort.confirm({ title: 'Run destructive command?', detail: `${cmd}\n\n${verdict.reason}`, dangerous: true, tool: 'run_command' })
              : await host.prompter.askYesNo(`${verdict.reason}\nRun it anyway? (y/N) `, false);
            if (!approved) { recordBlocked(); return `Command blocked (${verdict.rule}): ${verdict.reason}`; }
            destructiveOverride = true; // user explicitly authorized — skip the redundant approval below
          }
        }
        // Approval gating routes through the pure resolver in
        // runtime/dangerousCommand.ts. Three outcomes:
        //   • auto-approve: fast mode + safe command (or silent child whose
        //     parent has opted in via fast mode).
        //   • ask: planning mode, OR fast mode but the command matched the
        //     dangerous heuristic (rm -rf, sudo, force-push, …).
        //   • deny-silent: silent child agents can't answer y/N, so safe
        //     commands need parent opt-in (fast mode) and dangerous commands
        //     are always denied.
        const prefs = readPreferences(host.workspaceRoot);
        // Gate from the ACTIVE SESSION's executionMode (session override >
        // workspace pref) so two chats in the same workspace can sit in
        // different modes — a `fast` chat auto-approves safe commands while a
        // `planning` chat still confirms.
        const baseMode = resolveActiveMode(host.workspaceRoot, host.sessionKey);
        // CHILD-EXEC-INHERIT — a silent child runs under its OWN childKey session
        // (orchestration/tools.ts), which carries no `/mode` override, so
        // resolveActiveMode falls back to the WORKSPACE default (often
        // `planning`) even when the PARENT is in fast/YOLO. That made a fast/YOLO
        // parent's workers stall on a parent-approval card for SAFE commands
        // (e.g. `ls`) despite "all permissions on". Mirror DESK-5n (which threads
        // `parentReviewPolicy` for the write/edit/patch gate): a silent child
        // inherits the parent's executionMode so it auto-approves SAFE commands
        // under fast/YOLO. The dangerous-command floor is UNCHANGED —
        // resolveRunCommandApproval still returns 'deny-silent' for dangerous
        // commands, which gates/denies below.
        const activeMode = host.silent && host.parentExecutionMode
          ? { ...baseMode, executionMode: host.parentExecutionMode }
          : baseMode;
        // 0.3.9 — pass `goalActive` so the resolver can auto-approve
        // SAFE commands when a /goal is active. Without this, the very
        // first run_command of a goal-mode session blocks the auto-
        // continuation on the askYesNo prompt, defeating the purpose of
        // "type a goal, walk away". Dangerous commands still ask.
        const goalForApproval = readGoal(host.workspaceRoot, host.sessionKey);
        const goalIsActive = !!(goalForApproval?.text && goalForApproval.status === 'active');
        const approval = destructiveOverride
          ? ('auto-approve' as const) // user already authorized the destructive command above — don't double-prompt
          : resolveRunCommandApproval(activeMode, cmd, { silent: host.silent, goalActive: goalIsActive, allowlist: getCliKnobs().commandAllowlist });
        let parentApproved = false;
        if (approval === 'deny-silent') {
          const dangerous = isDangerousCommand(cmd);
          if (host.confirmToolApproval) {
            const approved = await host.confirmToolApproval({
              tool: 'run_command',
              command: cmd,
              dangerous,
              reason: dangerous
                ? 'dangerous command requested by a silent child agent'
                : 'silent child agent shell command requires parent approval',
            });
            host.assertInheritedExecutionAuthorityCurrent();
            if (!approved) return 'Command execution rejected by parent approval.';
            parentApproved = true;
          } else if (dangerous) {
            return (
              `Command execution denied: dangerous command in a silent child agent. ` +
              `Silent children can't answer the y/N prompt, so destructive commands ` +
              `(rm -rf, sudo, force-push, …) are refused regardless of /mode. ` +
              `Have a parent agent run this command, or split it into a safer ` +
              `equivalent.`
            );
          } else {
            return (
              `Command execution denied: silent child agents may not run shell ` +
              `without parent opt-in. Switch the session to \`/mode fast\` (or set ` +
              `the legacy \`autoApproveShell\` pref) to let silent children run ` +
              `safe commands, or have a parent agent run this command.`
            );
          }
        }
        if (approval === 'auto-approve' || parentApproved) {
          const tag = host.silent
            ? (parentApproved ? 'Parent-approved (silent child)' : 'Auto-approved (silent child)')
            : goalIsActive && activeMode.executionMode !== 'fast'
              ? 'Auto-approved (/goal active)'
              : 'Auto-approved';
          console.log(chalk.gray(`▶  ${tag}: ${chalk.cyan(cmd)}`));
        } else {
          // approval === 'ask' — interactive y/N. Use the parent REPL's
          // readline interface; spinning up an inquirer prompt opens a second
          // readline against the same stdin and dumps a stray "line" event
          // back into the parent rl when it exits, which used to surface as
          // the bogus "A previous turn is still running" warning.
          //
          // The question we hand to `askYesNo` ALWAYS includes the command
          // itself. The legacy split — print command via `console.log`, then
          // ask "Allow execution? (y/N)" — works in the readline path because
          // both land on the same stream, but the Ink overlay (`runInkYesNo`)
          // only sees the question string. Without the command embedded here
          // the modal renders "Allow execution? (y/N)" with no context, and
          // the user has to take it on faith. Embedding the command keeps
          // both surfaces honest. (Fix flagged on 2026-05-27.)
          const dangerous = isDangerousCommand(cmd);
          // Legacy console.log kept so the readline path also has a visible
          // record above the prompt; the Ink path renders the same content
          // inside the modal title via the helper's structured string.
          // No leading `\n` — patchConsole already inserts a row boundary
          // when promoting this above the Ink frame, and adding our own
          // newline pushes the frame down an extra row every approval,
          // contributing to the "frame keeps growing / viewport scrolls
          // up" feel in main-screen mode. (0.3.9 — 2026-05-27)
          console.log(`${chalk.yellow('⚠️  Command execution request:')} ${chalk.cyan(cmd)}${dangerous ? chalk.red(' (potentially destructive)') : ''}`);
          const question = buildRunCommandPrompt(cmd);
          const approved = host.interactionPort
            ? await host.interactionPort.confirm({ title: 'Run shell command?', detail: cmd, dangerous, tool: 'run_command' })
            : await host.prompter.askYesNo(question, false);
          host.assertInheritedExecutionAuthorityCurrent();
          if (!approved) {
            return 'Command execution rejected by user.';
          }
        }

        // CC-P11.1 — background run: same approval gating as foreground (we are
        // past it here), but detach instead of blocking the turn. v1 runs
        // unsandboxed, so it is refused while cli.sandbox=on.
        if (args.background === true) {
          host.assertInheritedExecutionAuthorityCurrent();
          if (host.inheritedExecutionAuthorityGuard()) {
            return 'Background run_command is unavailable inside reviewed execution until detached processes have an execution-owned revocation lease.';
          }
          if (host.pentestMode) return 'Background run_command is disabled for pentests; commands must remain in the Docker/proxy perimeter.';
          // CODEX-SANDBOX-UNATTENDED — background runs are unsandboxed (v1), so
          // they are refused whenever the sandbox is active: either the user
          // turned it on, or this is a silent/unattended agent where the
          // sandbox is enforced regardless of the global knob.
          // HONK-H0 — a fleet/background executor's `forceFleetSandbox` also makes
          // the detached (unsandboxed) background path off-limits, so it can't be
          // used to escape the forced sandbox + network-deny the foreground path
          // applies — even when the operator opted out of silent enforcement.
          const sandboxActive =
            getCliKnobs().sandbox === 'on' ||
            (host.silent && (host.sandboxEnforceWhenSilent || host.forceFleetSandbox));
          if (sandboxActive) {
            return 'Background run_command is not supported while the sandbox is active (v1) — run it foreground or disable the sandbox.';
          }
          const bg = (host.shellPort ?? nodeShellPort).startBackgroundShell({ command: cmd, cwd: cwdOverride ?? host.launchCwd, workspaceRoot: host.workspaceRoot });
          return JSON.stringify({
            id: bg.id,
            status: bg.status,
            logPath: bg.logPath,
            note: 'Detached. Poll with task_output({ id }) — pass back nextOffset as fromByte to read incrementally. The turn is NOT blocked.',
          });
        }
        if (host.pentestMode) {
          host.assertInheritedExecutionAuthorityCurrent();
          const result = runPentestCommand(cmd, host.pentestSandbox
            ? { ...host.pentestSandbox, workspaceRoot: host.workspaceRoot }
            : resolvePentestSandbox(host.workspaceRoot));
          return `[pentest Docker/proxy sandbox] Exit Code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
        }
        // The sandbox is rooted at the EFFECTIVE cwd (the entered worktree, if
        // any); the rest of the scope (primary + other attached roots) is granted
        // write so a command run in a worktree can still touch the primary tree.
        const scopeWriteGrants = [host.workspaceRoot, ...(host.attachedRoots ?? [])].filter((r: string) => r !== effectiveCwd);
        const sandboxConfig = resolveSandboxConfig(
          effectiveCwd,
          { readPaths: prefs.sandboxReadPaths, writePaths: [...prefs.sandboxWritePaths, ...scopeWriteGrants] },
          { silent: host.silent, enforceWhenSilent: host.sandboxEnforceWhenSilent, forceEnforce: host.forceFleetSandbox, scopeSecrets: host.forceFleetSandbox },
        );
        host.assertInheritedExecutionAuthorityCurrent();
        // ADR-041 D3 — the bare exec runs through the injected shell port; the
        // sandbox config was already resolved (approval/policy/guards) above.
        const result = await (host.shellPort ?? nodeShellPort).runShell(cmd, sandboxConfig, undefined, host.turnAbort?.signal);
        // WS5 — remember commits WE authored this session, so a later
        // `git commit --amend` of one of them is allowed (vs. amending a
        // pre-existing/user commit, which the guard blocks).
        if (result.exitCode === 0 && /\bgit\b[^|;&]*\bcommit\b/i.test(cmd)) {
          const head = gitHeadSha(host.workspaceRoot);
          if (head) host.agentAuthoredCommits.add(head);
        }
        const enforcedTag = sandboxConfig.enforcedUnattended ? ' (enforced: unattended)' : '';
        const sandboxBadge = result.sandboxed
          ? `[sandboxed via ${result.sandboxTool}${enforcedTag}] `
          : sandboxConfig.enabled
            ? `[sandbox requested but unavailable${enforcedTag}] `
            : '';
        const notice = result.notice ? `${result.notice}\n` : '';
        return `${notice}${sandboxBadge}Exit Code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
  },
};
