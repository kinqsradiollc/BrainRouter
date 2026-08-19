// Internal implementation port for required core capability extensions.
// Public/user/workspace extensions never receive this runtime object.
import fs from 'node:fs';
// ADR-041 D8 — the builtin-tool handler registry. Importing the barrel runs each
// migrated tool's registration side effect; `builtinToolHandler` is consulted at
// the top of the switch so a migrated tool dispatches by lookup, not a case.
import { builtinToolHandler } from './handlers/index.js';
import path from 'node:path';
import chalk from 'chalk';
import { NoTTYError } from '../../agent/support/prompter.js';
import { getCliKnobs } from '../../config/config.js';

import { startBackgroundShell } from '../../exec/runtime/backgroundShell.js';
import { buildRunCommandPrompt, isDangerousCommand, resolveRunCommandApproval } from '../../exec/guard/dangerousCommand.js';
import { evaluateDestructiveCommand } from '../../exec/guard/destructiveCommandGuard.js';
import { evaluatePermissionRules, primaryArgText } from '../../exec/policy/permissionRules.js';
import { decideExecutionPolicy } from '../../exec/policy/execPolicy.js';
import { resolveSandboxConfig, runShell } from '../../exec/runtime/sandbox.js';
import { resolvePentestSandbox, runPentestCommand } from '../../review/pentestSandbox.js';
import { recordDenial } from '../../exec/runtime/recentDenials.js';
import { gitHeadSha } from '../../git/workspaceGit.js';
import { readGoal } from '../../goal/store/goalStore.js';
import { extractToolText } from '../../mcp/mcpUtils.js';
import { ownershipWriteViolation } from '../../orchestration/ownership/ownership.js';
import { spawnWorkerThread } from '../../orchestration/agents/workerTools.js';
import { readPreferences } from '../../session/preferences/preferencesStore.js';
import { resolveActiveMode } from '../../session/state/sessionModeStore.js';
import { isTelemetryEnabled } from '../../telemetry/recorder/telemetry.js';
import { recordDailyUsage } from '../../usage/usageHistoryStore.js';
import { applyFederationIdentity } from '../../util/agentloop/federationIdentity.js';
import { runPostEditCheck } from '../../util/agentloop/postEditCheck.js';
import { estimateTokens as estimateTokensContentAware } from '../../util/tokens/tokenEstimate.js';
import { canSpawnWorker } from '../../worker/workerStore.js';
import { redactReviewSourceText, assertSafeReviewerFilesystemPath } from '../../review/sourceSafety.js';
import { nestArguments } from '../../agent/repair/flatten.js';
import { shrinkOversizedToolResults } from '../../agent/guards/turnEndShrink.js';
import { resolveWorkspacePath, resolveWorkspacePathInScope, singleRootScope } from '../../agent/fs/workspaceFs.js';
import { nodeFilesystemPort, type FilesystemPort } from '../../agent/fs/filesystemPort.js';
import type { SubprocessPort } from '../../agent/subprocess/subprocessPort.js';
import type { ShellPort } from '../../agent/shell/shellPort.js';

// ADR-041 D3 — default subprocess port: wraps `spawnWorkerThread` verbatim, so
// the local worker-spawn path is byte-identical. An execution world (D10) injects
// a port that spawns the worker in a container/remote.
const nodeSubprocessPort: SubprocessPort = { spawnWorker: spawnWorkerThread };

// ADR-041 D3 — default shell port: wraps runShell / startBackgroundShell verbatim,
// so the local exec path is byte-identical. An execution world (D10) injects a
// port that runs the command in a container/remote.
const nodeShellPort: ShellPort = { runShell, startBackgroundShell };


/** Reviewer reads never follow aliases: policy is evaluated on lexical and canonical paths. */

export async function invokeBuiltinToolRuntime(
  this: any,
  name: string,
  args: Record<string, any>,
  authorizeMcpTarget?: (
    name: string,
    args: Record<string, unknown>,
    descriptor: unknown,
  ) => void,
): Promise<string> {
    // Bind path resolution to this agent's workspace, never to process.cwd().
    // The Agent might have been constructed with a workspace different from
    // the launching shell's cwd (e.g. /resume from another dir), and cwd can
    // drift in unexpected ways. Explicit beats implicit here.
    const resolveHere = (p: string, opts: { forWrite?: boolean } = {}) =>
      resolveWorkspacePathInScope(
        // `this` is the Agent; its scope carries any entered worktrees (ADR-042
        // D1). Falls back to a single-root scope for any non-Agent caller.
        this.workspaceScope ?? singleRootScope(this.workspaceRoot),
        p,
        opts,
      );
    // ADR-042 D6 — a write into a worktree owned by a live foreign session is
    // refused with the owner named, BEFORE resolveHere (edit/notebook resolve
    // for read, so the escape guard alone would not catch them).
    const readOnlyGuard = (p: string) => {
      const owner = typeof this.readOnlyWorktreeOwner === 'function' ? this.readOnlyWorktreeOwner(p) : null;
      if (owner) {
        throw new Error(`Cannot write ${p}: it is in a worktree owned by session ${owner} (attached read-only). Coordinate with them, or re-enter it with override once they are done.`);
      }
    };
    // ADR-041 D3 — filesystem side effects go through the injected capability
    // port (default `nodeFilesystemPort` = the previous inline `node:fs`), so an
    // execution world (D10) can back them with container/remote I/O.
    const fsPort: FilesystemPort = this.filesystemPort ?? nodeFilesystemPort;
    // ADR-041 D8 — strangler dispatch: a migrated tool resolves to a registered
    // handler and returns here; everything else falls through to the switch below
    // unchanged. As tools migrate, the switch shrinks one case at a time.
    const migratedHandler = builtinToolHandler(name);
    if (migratedHandler) {
      return migratedHandler({
        args,
        invokedName: name,
        host: this,
        resolveHere,
        readOnlyGuard,
        fsPort,
        authorizeMcpTarget,
      });
    }
    switch (name) {
      case 'run_command': {
        const cmd = args.command;
        // ADR-042 D4 — an optional validated `cwd`. The default stays the
        // workspace root (the pin that stopped a drifted process.cwd() writing
        // into ~/.brainrouter); a passed cwd is validated against the workspace
        // SCOPE (primary + entered worktrees) and rejected with the same escape
        // error otherwise. It is a validated override, never an unpin.
        let cwdOverride: string | undefined;
        if (typeof args.cwd === 'string' && args.cwd.trim() !== '') {
          cwdOverride = this.workspaceScope
            ? resolveWorkspacePathInScope(this.workspaceScope, args.cwd)
            : resolveWorkspacePath(this.workspaceRoot, args.cwd);
          if (!fs.existsSync(cwdOverride) || !fs.statSync(cwdOverride).isDirectory()) {
            throw new Error(`run_command cwd is not a directory: ${args.cwd}`);
          }
        }
        const effectiveCwd = cwdOverride ?? this.workspaceRoot;
        // CLI-11 — route the shell gate through the unified execution policy
        // (same outcome as the previous `accessMode !== 'shell'` check).
        const shellPolicy = decideExecutionPolicy('shell', this.accessMode);
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
            userIntent: this.lastUserPrompt,
            headSha: gitHeadSha(this.workspaceRoot),
            agentAuthoredCommits: this.agentAuthoredCommits,
          });
          if (verdict.decision === 'block') {
            // CC-SAFETY-B2 — the destructive-command guard's reason flows into the
            // session's recent-denials ring (best-effort) so `/recent-denials` can
            // surface WHY the command was blocked.
            const recordBlocked = () => {
              try { recordDenial(this.workspaceRoot, this.sessionKey, 'run_command', `${verdict.rule}: ${verdict.reason}`); } catch { /* best-effort */ }
            };
            if (this.silent || (!this.interactionPort && !this.prompter)) {
              recordBlocked();
              return `Command blocked (${verdict.rule}): ${verdict.reason}`;
            }
            const approved = this.interactionPort
              ? await this.interactionPort.confirm({ title: 'Run destructive command?', detail: `${cmd}\n\n${verdict.reason}`, dangerous: true, tool: 'run_command' })
              : await this.prompter.askYesNo(`${verdict.reason}\nRun it anyway? (y/N) `, false);
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
        const prefs = readPreferences(this.workspaceRoot);
        // Gate from the ACTIVE SESSION's executionMode (session override >
        // workspace pref) so two chats in the same workspace can sit in
        // different modes — a `fast` chat auto-approves safe commands while a
        // `planning` chat still confirms.
        const baseMode = resolveActiveMode(this.workspaceRoot, this.sessionKey);
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
        const activeMode = this.silent && this.parentExecutionMode
          ? { ...baseMode, executionMode: this.parentExecutionMode }
          : baseMode;
        // 0.3.9 — pass `goalActive` so the resolver can auto-approve
        // SAFE commands when a /goal is active. Without this, the very
        // first run_command of a goal-mode session blocks the auto-
        // continuation on the askYesNo prompt, defeating the purpose of
        // "type a goal, walk away". Dangerous commands still ask.
        const goalForApproval = readGoal(this.workspaceRoot, this.sessionKey);
        const goalIsActive = !!(goalForApproval?.text && goalForApproval.status === 'active');
        const approval = destructiveOverride
          ? ('auto-approve' as const) // user already authorized the destructive command above — don't double-prompt
          : resolveRunCommandApproval(activeMode, cmd, { silent: this.silent, goalActive: goalIsActive, allowlist: getCliKnobs().commandAllowlist });
        let parentApproved = false;
        if (approval === 'deny-silent') {
          const dangerous = isDangerousCommand(cmd);
          if (this.confirmToolApproval) {
            const approved = await this.confirmToolApproval({
              tool: 'run_command',
              command: cmd,
              dangerous,
              reason: dangerous
                ? 'dangerous command requested by a silent child agent'
                : 'silent child agent shell command requires parent approval',
            });
            this.assertInheritedExecutionAuthorityCurrent();
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
          const tag = this.silent
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
          const approved = this.interactionPort
            ? await this.interactionPort.confirm({ title: 'Run shell command?', detail: cmd, dangerous, tool: 'run_command' })
            : await this.prompter.askYesNo(question, false);
          this.assertInheritedExecutionAuthorityCurrent();
          if (!approved) {
            return 'Command execution rejected by user.';
          }
        }

        // CC-P11.1 — background run: same approval gating as foreground (we are
        // past it here), but detach instead of blocking the turn. v1 runs
        // unsandboxed, so it is refused while cli.sandbox=on.
        if (args.background === true) {
          this.assertInheritedExecutionAuthorityCurrent();
          if (this.inheritedExecutionAuthorityGuard()) {
            return 'Background run_command is unavailable inside reviewed execution until detached processes have an execution-owned revocation lease.';
          }
          if (this.pentestMode) return 'Background run_command is disabled for pentests; commands must remain in the Docker/proxy perimeter.';
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
            (this.silent && (this.sandboxEnforceWhenSilent || this.forceFleetSandbox));
          if (sandboxActive) {
            return 'Background run_command is not supported while the sandbox is active (v1) — run it foreground or disable the sandbox.';
          }
          const bg = (this.shellPort ?? nodeShellPort).startBackgroundShell({ command: cmd, cwd: cwdOverride ?? this.launchCwd, workspaceRoot: this.workspaceRoot });
          return JSON.stringify({
            id: bg.id,
            status: bg.status,
            logPath: bg.logPath,
            note: 'Detached. Poll with task_output({ id }) — pass back nextOffset as fromByte to read incrementally. The turn is NOT blocked.',
          });
        }
        if (this.pentestMode) {
          this.assertInheritedExecutionAuthorityCurrent();
          const result = runPentestCommand(cmd, this.pentestSandbox
            ? { ...this.pentestSandbox, workspaceRoot: this.workspaceRoot }
            : resolvePentestSandbox(this.workspaceRoot));
          return `[pentest Docker/proxy sandbox] Exit Code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
        }
        // The sandbox is rooted at the EFFECTIVE cwd (the entered worktree, if
        // any); the rest of the scope (primary + other attached roots) is granted
        // write so a command run in a worktree can still touch the primary tree.
        const scopeWriteGrants = [this.workspaceRoot, ...(this.attachedRoots ?? [])].filter((r: string) => r !== effectiveCwd);
        const sandboxConfig = resolveSandboxConfig(
          effectiveCwd,
          { readPaths: prefs.sandboxReadPaths, writePaths: [...prefs.sandboxWritePaths, ...scopeWriteGrants] },
          { silent: this.silent, enforceWhenSilent: this.sandboxEnforceWhenSilent, forceEnforce: this.forceFleetSandbox, scopeSecrets: this.forceFleetSandbox },
        );
        this.assertInheritedExecutionAuthorityCurrent();
        // ADR-041 D3 — the bare exec runs through the injected shell port; the
        // sandbox config was already resolved (approval/policy/guards) above.
        const result = await (this.shellPort ?? nodeShellPort).runShell(cmd, sandboxConfig, undefined, this.turnAbort?.signal);
        // WS5 — remember commits WE authored this session, so a later
        // `git commit --amend` of one of them is allowed (vs. amending a
        // pre-existing/user commit, which the guard blocks).
        if (result.exitCode === 0 && /\bgit\b[^|;&]*\bcommit\b/i.test(cmd)) {
          const head = gitHeadSha(this.workspaceRoot);
          if (head) this.agentAuthoredCommits.add(head);
        }
        const enforcedTag = sandboxConfig.enforcedUnattended ? ' (enforced: unattended)' : '';
        const sandboxBadge = result.sandboxed
          ? `[sandboxed via ${result.sandboxTool}${enforcedTag}] `
          : sandboxConfig.enabled
            ? `[sandbox requested but unavailable${enforcedTag}] `
            : '';
        const notice = result.notice ? `${result.notice}\n` : '';
        return `${notice}${sandboxBadge}Exit Code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
      }
      case 'mcp_call': {
        const target = String(args.name ?? '').trim();
        if (!target) throw new Error('mcp_call requires a tool `name` (use mcp_search to find one).');
        const tool = await this.findVisibleMcpTool(target);
        this.assertInheritedExecutionAuthorityCurrent();
        if (!tool) throw new Error(`mcp_call: "${target}" is not an available MCP tool. Use mcp_search to find the exact name.`);
        const callArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
          ? (args.args as Record<string, any>)
          : {};
        const toolName = String(tool.name);
        const mcpArgs = applyFederationIdentity(toolName, callArgs, this.federationSessionKey) as Record<string, any>;
        authorizeMcpTarget?.(toolName, mcpArgs, tool);
        const permissionNames = [
          toolName,
          String(tool.__rawName ?? '').trim(),
        ].filter((name, index, names) => name && names.indexOf(name) === index);
        if (permissionNames.some((permissionName) => evaluatePermissionRules(
          getCliKnobs().permissions,
          permissionName,
          primaryArgText(permissionName, mcpArgs),
          { workspace: this.workspaceRoot },
        ) === 'deny')) {
          throw new Error(`mcp_call target "${toolName}" denied by cli.permissions.`);
        }
        await this.approveMcpToolCall(toolName, tool, mcpArgs);
        this.assertInheritedExecutionAuthorityCurrent();
        const mcpRes = await this.mcpClient.callTool(toolName, mcpArgs, { signal: this.turnAbort?.signal });
        return extractToolText(mcpRes);
      }
      case 'spawn_worker_thread': {
        if (!canSpawnWorker(this.agentDepth)) {
          throw new Error('Workers cannot spawn workers (MAX_WORKER_DEPTH=1).');
        }
        const goal = String(args.goal ?? '').trim();
        if (!goal) throw new Error('spawn_worker_thread requires a goal.');
        // ADR-041 D3 — spawn via the injected subprocess port (default wraps
        // spawnWorkerThread; an execution world can spawn in a container/remote).
        const worker = (this.subprocessPort ?? nodeSubprocessPort).spawnWorker(this.mcpClient, this.llmConfig, {
          workspaceRoot: this.workspaceRoot,
          launchCwd: this.launchCwd,
          role: String(args.role ?? 'worker'),
          goal,
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          ownership: typeof args.ownership === 'string' ? args.ownership : (this.ownership ?? null),
          parentSessionKey: this.sessionKey,
          parentAccessMode: this.accessMode,
          spawnerDepth: this.agentDepth,
          effortOverride: this.effortOverride,
          ancestorFleet: this.forceFleetSandbox, // HONK-H0 — cascade fleet lockdown
        });
        return JSON.stringify({ id: worker.id, status: worker.status, goal: worker.goal });
      }
      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
  }
