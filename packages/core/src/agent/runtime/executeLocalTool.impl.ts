// executeLocalToolLegacy — the built-in local-tool dispatcher, split out of
// agent.ts (god-file breakdown). Byte-identical body; a free function bound to
// `this: Agent` and assigned onto Agent.prototype so all instance state +
// private helpers resolve exactly as before.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import type { Agent } from '../agent.js';
import { NoTTYError } from '../support/prompter.js';
import { runHooks } from '../../hooks/hooksStore.js';
import { getCliKnobs, loadOrInitConfig } from '../../config/config.js';
import { createArtifact, updateArtifact, getArtifact } from '../../artifact/artifactStore.js';

// Per-turn computer_use action cap — module const in the original agent.ts; kept
// here (byte-identical value) since executeLocalToolLegacy is its only consumer.
const MAX_COMPUTER_ACTIONS_PER_TURN = 20;
import {
  listConnectors, runConnectorCheckpointCore, exportConnectorDocumentsForMemory,
  githubTokenClient, defaultEnvTokenResolver,
  type McpConnectorClient, type McpConnectorResource,
} from '../../connectors/index.js';
import { startBackgroundShell, readBackgroundOutput } from '../../exec/runtime/backgroundShell.js';
import { buildRunCommandPrompt, isDangerousCommand, resolveRunCommandApproval } from '../../exec/guard/dangerousCommand.js';
import { evaluateDestructiveCommand } from '../../exec/guard/destructiveCommandGuard.js';
import { decideExecutionPolicy, egressDecision } from '../../exec/policy/execPolicy.js';
import { resolveSandboxConfig, runShell } from '../../exec/runtime/sandbox.js';
import { resolvePentestSandbox, runPentestCommand } from '../../review/pentestSandbox.js';
import { proxyControl } from '../../review/pentestProxy.js';
import { buildPentestDedupeMessages, findingKey, parsePentestDedupeDecision } from '../../review/reviewSynthesis.js';
import { callOpenAI } from '../transport/llmTransport.js';
import { enforceTaskBudget } from '../../provider/budget.js';
import { recordDenial } from '../../exec/runtime/recentDenials.js';
import { gitHeadSha } from '../../git/workspaceGit.js';
import { readGoal, blockGoal, completeGoal } from '../../goal/store/goalStore.js';
import { searchMcpCatalog } from '../../mcp/discovery/discovery.js';
import { extractToolText } from '../../mcp/mcpUtils.js';
import { ownershipWriteViolation } from '../../orchestration/ownership/ownership.js';
import { spawnWorkerThread, waitWorker } from '../../orchestration/agents/workerTools.js';
import { summarizeLedger, formatBrief } from '../../research/evidenceLedger.js';
import { appendEvidence, setQuestion, readLedger } from '../../research/researchStore.js';
import { CHAPTER_ENTRY_NAME, chapterEntryContent } from '../../session/transcript/chapterMarks.js';
import { acknowledgeCompletions } from '../../session/completion/completionInbox.js';
import { readPreferences } from '../../session/preferences/preferencesStore.js';
import { resolveActiveMode, setSessionMode } from '../../session/state/sessionModeStore.js';
import { setSessionRuntime } from '../../session/state/sessionRuntimeStore.js';
import { resolveProfileSwitch } from '../../provider/llmProfiles.js';
import { buildModelRegistry, resolveRoutes } from '../../router/index.js';
import { formatPlan, updatePlan, readPlan } from '../../task/taskStore.js';
import { isTelemetryEnabled } from '../../telemetry/recorder/telemetry.js';
import { traceEvent } from '../../telemetry/tracing/tracing.js';
import { localToolExecutor } from '../../tool/registry/executors.js';
import { runExtractResult } from '../../tool/result/extractResult.js';
import { parseTrackQuery } from '../../track/query/index.js';
import {
  ensureProject as trackEnsureProject,
  getProject as trackGetProject,
  listWorkItems as trackListWorkItems,
  getWorkItem as trackGetWorkItem,
  createWorkItem as trackCreateWorkItem,
  transitionWorkItem as trackTransitionWorkItem,
  updateWorkItem as trackUpdateWorkItem,
  addComment as trackAddComment,
  linkWorkItem as trackLinkWorkItem,
  createSprint as trackCreateSprint,
  listSprints as trackListSprints,
  setSprintState as trackSetSprintState,
  updateSprint as trackUpdateSprint,
  sprintVelocity as trackSprintVelocity,
} from '../../track/trackStore.js';
import { recordDailyUsage } from '../../usage/usageHistoryStore.js';
import { applyFederationIdentity } from '../../util/agentloop/federationIdentity.js';
import { runPostEditCheck } from '../../util/agentloop/postEditCheck.js';
import { estimateTokens as estimateTokensContentAware } from '../../util/tokens/tokenEstimate.js';
import { waitUntilCondition } from '../../util/agentloop/waitUntil.js';
import { fetchAndExtract } from '../../websearch/crawler.js';
import { buildSearchProvider } from '../../websearch/factory.js';
import { readWorkerMeta, readWorkerSummary, closeWorker, canSpawnWorker } from '../../worker/workerStore.js';
import { listWorkers } from '../../worker/workerStore.js';
import { getLatestReview, saveReview } from '../../review/reviewStore.js';
import { validatePentestFinding } from '../../review/pentestFinding.js';
import { getCurrentWorkflow } from '../../workflow/run/workflowArtifacts.js';
import { advanceRunStep, summarizeRun } from '../../workflow/run/workflowRun.js';
import { applyPatchEnvelope, assessPatchSafety, parsePatchEnvelope } from '../fs/applyPatch.js';
import { evaluateDestructiveAction, isComputerActionMutating, validateComputerAction } from '../fs/computerUse.js';
import { truncateFullRead } from '../fs/readTruncation.js';
import { nestArguments } from '../repair/flatten.js';
import { shrinkOversizedToolResults } from '../guards/turnEndShrink.js';
import { resolveWorkspacePath, globFiles, grepSearch } from '../fs/workspaceFs.js';
import { isArtifactKind, isArtifactFormat, isWorkItemType, isWorkItemPriority, type ArtifactKind, type ArtifactFormat } from '@kinqs/brainrouter-types';

export async function executeLocalToolLegacy(this: Agent, name: string, args: Record<string, any>): Promise<string> {
    // Bind path resolution to this agent's workspace, never to process.cwd().
    // The Agent might have been constructed with a workspace different from
    // the launching shell's cwd (e.g. /resume from another dir), and cwd can
    // drift in unexpected ways. Explicit beats implicit here.
    const resolveHere = (p: string, opts: { forWrite?: boolean } = {}) =>
      resolveWorkspacePath(this.workspaceRoot, p, opts);
    switch (name) {
      case 'read_file': {
        const resolved = resolveHere(args.path);
        if (!fs.existsSync(resolved)) {
          throw new Error(`File not found: ${args.path}`);
        }
        const content = fs.readFileSync(resolved, 'utf8');
        this.filesReadThisSession.add(resolved); // CC-P6.4 — read-before-edit ledger
        // CLI-REINDEX — keep the code index fresh on read; fire-and-forget so
        // reads stay snappy, and guarded so a rejection never escapes.
        void this.maybeReindexSource(resolved, content).catch(() => {});
        const startLine = args.startLine ? Number(args.startLine) : 1;
        const endLine = args.endLine ? Number(args.endLine) : undefined;

        if (startLine === 1 && endLine === undefined) {
          // CC-P7.3 — cap an unbounded full-file read so a huge file can't blow
          // the context window; the model gets an explicit reread affordance.
          return truncateFullRead(content, String(args.path)).text;
        }

        const lines = content.split('\n');
        const endIdx = endLine !== undefined ? Math.min(endLine, lines.length) : lines.length;
        const startIdx = Math.max(1, Math.min(startLine, lines.length));
        
        if (startIdx > endIdx) {
          return '';
        }
        
        return lines.slice(startIdx - 1, endIdx).join('\n');
      }
      case 'write_file': {
        const resolved = resolveHere(args.path, { forWrite: true });
        const ownErr = ownershipWriteViolation(this.ownership, this.workspaceRoot, resolved);
        if (ownErr) throw new Error(ownErr);
        // CC-P6.4 — read-before-overwrite. Creating a NEW file is fine, but
        // overwriting an EXISTING one the agent hasn't read this session would
        // blow away content it never saw. Require a read_file first in that case.
        if (fs.existsSync(resolved) && !this.filesReadThisSession.has(resolved)) {
          throw new Error(`Read-before-overwrite: "${args.path}" already exists and you have not read it this session. read_file("${args.path}") first (then write_file replaces it intentionally), or use edit_file for a targeted change.`);
        }
        const parentDenial = await this.confirmSilentChildToolApproval({
          tool: 'write_file',
          path: String(args.path ?? ''),
          summary: `write ${String(args.content ?? '').length} chars`,
          reason: 'silent child agent requested a file write',
        });
        if (parentDenial) return parentDenial;
        // A successful overwrite means the on-disk content is now what the agent
        // wrote — keep the read ledger accurate so a follow-up edit is allowed.
        this.filesReadThisSession.add(resolved);
        this.captureFileSnapshot(resolved); // 0.4.x-3b — undo log for /rewind --files
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolved, args.content, 'utf8');
        const writeNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: resolved, cwd: this.workspaceRoot });
        const reindexNotice = await this.maybeReindexSource(resolved, args.content);
        return `Successfully wrote file: ${args.path}` + writeNotice + reindexNotice;
      }
      case 'edit_file': {
        const resolved = resolveHere(args.path);
        const ownErr = ownershipWriteViolation(this.ownership, this.workspaceRoot, resolved);
        if (ownErr) throw new Error(ownErr);
        if (!fs.existsSync(resolved)) {
          throw new Error(`File not found: ${args.path}`);
        }
        // CC-P6.4 — read-before-edit. Editing a file the agent hasn't read this
        // session risks clobbering content it can't see (stale assumptions,
        // mismatched indentation). Require a read_file first.
        if (!this.filesReadThisSession.has(resolved)) {
          throw new Error(`Read-before-edit: you must read_file("${args.path}") before editing it — you have not read this file this session. Read it first, then edit with targetContent that matches the current contents.`);
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const target = args.targetContent;
        const replacement = args.replacementContent;

        const occurrences = content.split(target).length - 1;
        if (occurrences === 0) {
          throw new Error(`Target content not found in ${args.path}. Ensure targetContent matches exact indentation and newlines.`);
        }
        if (occurrences > 1) {
          throw new Error(`Target content found ${occurrences} times in ${args.path}. Specify more surrounding context to target uniquely.`);
        }

        const updated = content.replace(target, replacement);
        const parentDenial = await this.confirmSilentChildToolApproval({
          tool: 'edit_file',
          path: String(args.path ?? ''),
          summary: `replace ${String(target ?? '').length} chars with ${String(replacement ?? '').length} chars`,
          reason: 'silent child agent requested a file edit',
        });
        if (parentDenial) return parentDenial;
        this.captureFileSnapshot(resolved); // 0.4.x-3b — undo log for /rewind --files
        fs.writeFileSync(resolved, updated, 'utf8');
        const editNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: resolved, cwd: this.workspaceRoot });
        const editReindex = await this.maybeReindexSource(resolved, updated);
        return `Successfully edited ${args.path}` + editNotice + editReindex;
      }
      case 'list_dir': {
        const targetDir = resolveHere(args.path || '.');
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
          throw new Error(`Directory not found: ${args.path || '.'}`);
        }
        const items = fs.readdirSync(targetDir);
        const list = items.map(item => {
          const full = path.join(targetDir, item);
          const stat = fs.statSync(full);
          return {
            name: item,
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.isFile() ? stat.size : undefined
          };
        });
        return JSON.stringify(list, null, 2);
      }
      case 'grep_search': {
        const wsRoot = fs.realpathSync(this.workspaceRoot);
        const root = resolveHere(args.path || '.');
        const query = String(args.query ?? '');
        if (!query) throw new Error('Missing parameter "query" for grep_search.');
        // grepSearch: regex match (not literal `includes`) + accepts a file OR a
        // directory (the old inline version crashed with ENOTDIR on a file path).
        return JSON.stringify(grepSearch(query, root, wsRoot), null, 2);
      }
      case 'glob_files': {
        const pattern = args.pattern;
        if (!pattern) {
          throw new Error('Missing parameter "pattern" for glob_files.');
        }
        const matches = globFiles(pattern, this.workspaceRoot);
        return JSON.stringify(matches, null, 2);
      }
      case 'run_command': {
        const cmd = args.command;
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
          if (!approved) {
            return 'Command execution rejected by user.';
          }
        }

        // CC-P11.1 — background run: same approval gating as foreground (we are
        // past it here), but detach instead of blocking the turn. v1 runs
        // unsandboxed, so it is refused while cli.sandbox=on.
        if (args.background === true) {
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
          const bg = startBackgroundShell({ command: cmd, cwd: this.launchCwd, workspaceRoot: this.workspaceRoot });
          return JSON.stringify({
            id: bg.id,
            status: bg.status,
            logPath: bg.logPath,
            note: 'Detached. Poll with task_output({ id }) — pass back nextOffset as fromByte to read incrementally. The turn is NOT blocked.',
          });
        }
        if (this.pentestMode) {
          const result = runPentestCommand(cmd, this.pentestSandbox
            ? { ...this.pentestSandbox, workspaceRoot: this.workspaceRoot }
            : resolvePentestSandbox(this.workspaceRoot));
          return `[pentest Docker/proxy sandbox] Exit Code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
        }
        const sandboxConfig = resolveSandboxConfig(
          this.workspaceRoot,
          { readPaths: prefs.sandboxReadPaths, writePaths: prefs.sandboxWritePaths },
          { silent: this.silent, enforceWhenSilent: this.sandboxEnforceWhenSilent, forceEnforce: this.forceFleetSandbox, scopeSecrets: this.forceFleetSandbox },
        );
        const result = await runShell(cmd, sandboxConfig, undefined, this.turnAbort?.signal);
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
      case 'computer_use': {
        if (!getCliKnobs().computerUse.enabled) return 'computer_use is disabled. Set cli.computerUse.enabled=true to enable it.';
        if (!this.computerUsePort) return 'computer_use is unavailable in this runtime.';
        if (this.silent) return 'computer_use denied: silent child agents cannot control the desktop.';
        if (getCliKnobs().brainUrl) return 'computer_use denied: remote-brain sessions cannot control the local desktop.';
        if (this.computerActionsThisTurn >= MAX_COMPUTER_ACTIONS_PER_TURN) {
          return `computer_use denied: per-turn action cap (${MAX_COMPUTER_ACTIONS_PER_TURN}) reached.`;
        }
        const validation = validateComputerAction(args);
        if (!validation.ok) return `computer_use invalid action: ${validation.error}`;
        const action = validation.action;
        this.computerActionsThisTurn += 1;

        if (action.action === 'screenshot') {
          try {
            const image = await this.computerUsePort.screenshot();
            return JSON.stringify({
              success: true,
              action: 'screenshot',
              image,
              note: 'Screenshot captured at full logical resolution.',
            }, null, 2);
          } catch (err: any) {
            return JSON.stringify({
              success: false,
              action: 'screenshot',
              permissionDenied: /permission|screen recording|accessibility/i.test(String(err?.message ?? err)),
              error: err?.message ?? String(err),
            }, null, 2);
          }
        }

        const destructive = evaluateDestructiveAction(action, { userIntent: this.lastUserPrompt });
        const activeMode = resolveActiveMode(this.workspaceRoot, this.sessionKey);
        const shouldAsk = destructive.dangerous || (isComputerActionMutating(action.action) && activeMode.executionMode !== 'fast');
        if (shouldAsk) {
          const detail = `${JSON.stringify(action, null, 2)}${destructive.reason ? `\n\n${destructive.reason}` : ''}`;
          const approved = this.interactionPort
            ? await this.interactionPort.confirm({ title: 'Allow computer control?', detail, dangerous: destructive.dangerous, tool: 'computer_use' })
            : await this.prompter.askYesNo(`${detail}\nAllow computer control? (y/N) `, false);
          if (!approved) return 'computer_use rejected by user.';
        }

        const result = await this.computerUsePort.act(action);
        return JSON.stringify({ action: action.action, ...result }, null, 2);
      }
      case 'fetch_url': {
        const url = args.url;
        // POLICY-3 — per-host egress allowlist (empty = unrestricted).
        const egress = egressDecision(url, getCliKnobs().egressAllowlist);
        if (egress.decision === 'deny') {
          return `fetch_url blocked by egress policy: ${egress.reason}.`;
        }
        const knobs = getCliKnobs();
        const result = await fetchAndExtract(String(url), {
          ...knobs.webSearch.crawler,
          signal: this.turnAbort?.signal,
        });
        return JSON.stringify(result, null, 2);
      }
      case 'web_search': {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('web_search requires a non-empty query.');
        const knobs = getCliKnobs();
        const maxResults = Math.max(1, Math.min(10, Number(args.maxResults ?? knobs.webSearch.maxResults)));
        try {
          const provider = buildSearchProvider(knobs);
          const results = await provider.search(query, maxResults, this.turnAbort?.signal);
          return JSON.stringify(results.slice(0, maxResults), null, 2);
        } catch (err: any) {
          return `web_search failed: ${err?.message ?? err}`;
        }
      }
      case 'research_note': {
        const claim = String(args.claim ?? '').trim();
        if (!claim) throw new Error('research_note requires a non-empty `claim`.');
        const sources = Array.isArray(args.sources) ? args.sources.map((s: any) => String(s)) : [];
        const stance = ['support', 'refute', 'unclear'].includes(String(args.stance))
          ? (String(args.stance) as 'support' | 'refute' | 'unclear')
          : undefined;
        const confidence = ['high', 'medium', 'low'].includes(String(args.confidence))
          ? (String(args.confidence) as 'high' | 'medium' | 'low')
          : undefined;
        const note = typeof args.note === 'string' ? args.note : undefined;
        const ledger = appendEvidence(this.workspaceRoot, this.sessionKey, { claim, sources, stance, confidence, note });
        const s = summarizeLedger(ledger);
        return `Recorded. Ledger: ${s.total} finding${s.total === 1 ? '' : 's'} (${s.corroborated} corroborated, ${s.conflicting} conflicting, ${s.singleSource} single-source).`;
      }
      case 'research_brief': {
        if (typeof args.question === 'string' && args.question.trim()) {
          setQuestion(this.workspaceRoot, this.sessionKey, args.question);
        }
        const ledger = readLedger(this.workspaceRoot, this.sessionKey);
        if (!ledger) return 'No research ledger yet — record evidence with research_note first.';
        return formatBrief(ledger);
      }
      case 'list_mcp_resources': {
        const client = this.mcpClient as any;
        if (typeof client.listResources !== 'function') {
          throw new Error('MCP resources are not supported by the active MCP client.');
        }
        const result = await client.listResources({
          cursor: typeof args.cursor === 'string' && args.cursor.trim() ? args.cursor.trim() : undefined,
          server: typeof args.server === 'string' && args.server.trim() ? args.server.trim() : undefined,
        }, { signal: this.turnAbort?.signal });
        return JSON.stringify(result, null, 2);
      }
      case 'list_mcp_resource_templates': {
        const client = this.mcpClient as any;
        if (typeof client.listResourceTemplates !== 'function') {
          throw new Error('MCP resource templates are not supported by the active MCP client.');
        }
        const result = await client.listResourceTemplates({
          cursor: typeof args.cursor === 'string' && args.cursor.trim() ? args.cursor.trim() : undefined,
          server: typeof args.server === 'string' && args.server.trim() ? args.server.trim() : undefined,
        }, { signal: this.turnAbort?.signal });
        return JSON.stringify(result, null, 2);
      }
      case 'read_mcp_resource': {
        const client = this.mcpClient as any;
        if (typeof client.readResource !== 'function') {
          throw new Error('MCP resource reads are not supported by the active MCP client.');
        }
        const server = String(args.server ?? '').trim();
        const uri = String(args.uri ?? '').trim();
        if (!server) throw new Error('read_mcp_resource requires a server.');
        if (!uri) throw new Error('read_mcp_resource requires a uri.');
        const result = await client.readResource({ server, uri }, { signal: this.turnAbort?.signal });
        return JSON.stringify(result, null, 2);
      }
      case 'mcp_search': {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('mcp_search requires a non-empty `query`.');
        const maxResults = Math.max(1, Math.min(25, Number(args.maxResults ?? 8)));
        const tools = await this.visibleMcpToolList();
        const matches = searchMcpCatalog(tools, query, maxResults);
        return JSON.stringify({ query, count: matches.length, tools: matches }, null, 2);
      }
      case 'mcp_describe': {
        const names: string[] = Array.isArray(args.names)
          ? args.names.map((n: any) => String(n))
          : args.name != null ? [String(args.name)] : [];
        if (names.length === 0) throw new Error('mcp_describe requires `name` or `names`.');
        const out: Array<Record<string, unknown>> = [];
        for (const target of names) {
          const tool = await this.findVisibleMcpTool(target);
          if (!tool) {
            out.push({ name: target, error: 'not found or not an available MCP tool' });
            continue;
          }
          out.push({ name: String(tool.name), description: tool.description ?? '', inputSchema: tool.inputSchema ?? {} });
        }
        return JSON.stringify(out, null, 2);
      }
      case 'mcp_call': {
        const target = String(args.name ?? '').trim();
        if (!target) throw new Error('mcp_call requires a tool `name` (use mcp_search to find one).');
        const tool = await this.findVisibleMcpTool(target);
        if (!tool) throw new Error(`mcp_call: "${target}" is not an available MCP tool. Use mcp_search to find the exact name.`);
        const callArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
          ? (args.args as Record<string, any>)
          : {};
        const toolName = String(tool.name);
        const mcpArgs = applyFederationIdentity(toolName, callArgs, this.federationSessionKey) as Record<string, any>;
        await this.approveMcpToolCall(toolName, tool, mcpArgs);
        const mcpRes = await this.mcpClient.callTool(toolName, mcpArgs, { signal: this.turnAbort?.signal });
        return extractToolText(mcpRes);
      }
      case 'mcp_refresh_catalog': {
        const tools = await this.visibleMcpToolList();
        const byServer: Record<string, number> = {};
        for (const t of tools) {
          const server = String(t?.__serverId ?? this.serverIdFromMcpToolName(String(t?.name ?? '')) ?? 'unknown');
          byServer[server] = (byServer[server] ?? 0) + 1;
        }
        return JSON.stringify({ totalTools: tools.length, servers: byServer }, null, 2);
      }
      case 'lsp': {
        // CLI-19 — semantic navigation via a language server.
        const action = String(args.action ?? '').trim() as 'definition' | 'references' | 'hover' | 'symbols';
        if (!['definition', 'references', 'hover', 'symbols'].includes(action)) {
          throw new Error('lsp: action must be definition | references | hover | symbols.');
        }
        if (!args.file) throw new Error('lsp requires a `file`.');
        const resolved = resolveHere(String(args.file));
        const { runLspQuery } = await import('../../lsp/manager.js');
        return await runLspQuery({
          action,
          file: resolved,
          line: args.line != null ? Number(args.line) : undefined,
          character: args.character != null ? Number(args.character) : undefined,
          cwd: this.workspaceRoot,
          servers: getCliKnobs().lspServers,
        });
      }
      case 'extract_result': {
        const resultRef = String(args.resultRef ?? '').trim();
        if (!resultRef) throw new Error('extract_result requires a resultRef.');
        const out = runExtractResult(
          {
            resultRef,
            query: typeof args.query === 'string' ? args.query : undefined,
            maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
          },
          this.resultCache,
        );
        return out.returned;
      }
      case 'spawn_worker_thread': {
        if (!canSpawnWorker(this.agentDepth)) {
          throw new Error('Workers cannot spawn workers (MAX_WORKER_DEPTH=1).');
        }
        const goal = String(args.goal ?? '').trim();
        if (!goal) throw new Error('spawn_worker_thread requires a goal.');
        const worker = spawnWorkerThread(this.mcpClient, this.llmConfig, {
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
      case 'wait_worker': {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('wait_worker requires an id.');
        const meta = await waitWorker(this.workspaceRoot, id, typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined);
        if (!meta) return JSON.stringify({ id, found: false });
        // Terminal → delivered in-turn; drop any pending next-turn feedback.
        // A timeout leaves status 'running', so its completion still reports later.
        if (meta.status !== 'running') acknowledgeCompletions(this.sessionKey, [id]);
        return JSON.stringify({ id, status: meta.status, summary: readWorkerSummary(this.workspaceRoot, id) ?? null });
      }
      case 'read_worker_summary': {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('read_worker_summary requires an id.');
        const meta = readWorkerMeta(this.workspaceRoot, id);
        if (!meta) return `No worker "${id}".`;
        return readWorkerSummary(this.workspaceRoot, id) ?? `Worker ${id} (${meta.status}) has no summary yet.`;
      }
      case 'close_worker': {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('close_worker requires an id.');
        const meta = closeWorker(this.workspaceRoot, id);
        return JSON.stringify({ id, status: meta?.status ?? 'unknown', closed: !!meta });
      }
      case 'mark_chapter': {
        // CC-P12.3 — persist a chapter marker into the session transcript.
        const title = String(args.title ?? '').trim();
        if (!title) throw new Error('mark_chapter requires a non-empty title.');
        if (title.length > 60) throw new Error('mark_chapter title must be under 60 chars.');
        const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : undefined;
        const marker = { role: 'system', name: CHAPTER_ENTRY_NAME, content: chapterEntryContent(title, summary) };
        this.recordTranscript(marker);
        return JSON.stringify({ marked: true, title, note: 'Chapter recorded — the user can browse with /chapters.' });
      }
      case 'switch_model': {
        // MC-D3 — agent-initiated switch to a named LLM profile: the explicit
        // sibling of the first-line tier self-escalation marker. Validated
        // against the configured profiles + the availableModels enforcement
        // gate (always enforced in Fast mode, mirroring `/model`). On success
        // the live LLM config is overlaid immediately — every subsequent model
        // call this turn and after uses the new profile — and the choice is
        // persisted to the session runtime so a resumed session keeps it.
        // Deliberately NOT applied here: a profile's `fast` preference (an
        // agent must never loosen its own approval posture).
        const knobs = getCliKnobs();
        const inFastMode = resolveActiveMode(this.workspaceRoot, this.sessionKey).executionMode === 'fast';
        const profileName = String(args.profile ?? '');
        const rawProfile = knobs.llmProfiles?.[profileName.trim()];
        const routeProfileModel = knobs.router.enabled && !rawProfile?.endpoint;
        const result = resolveProfileSwitch(String(args.profile ?? ''), knobs.llmProfiles, this.llmConfig, {
          availableModels: knobs.availableModels,
          enforceAvailableModels: routeProfileModel ? false : knobs.enforceAvailableModels,
          fastMode: routeProfileModel ? false : inFastMode,
        });
        if (!result.ok) return JSON.stringify({ switched: false, error: result.error });
        const before = this.llmConfig.model;
        let nextLlm = result.llm;
        let resolvedRoute = '';
        if (routeProfileModel) {
          const config = loadOrInitConfig();
          const baseName = config.providers?.base ? 'base-config' : 'base';
          const registry = buildModelRegistry(
            { ...(config.providers ?? {}), [baseName]: this.llmConfig },
            {
              aliases: knobs.router.aliases,
              chain: [...knobs.router.chain, ...knobs.fallbackModels, `${baseName}/${this.llmConfig.model}`],
              order: knobs.router.order,
              strategy: knobs.router.strategy,
              passThrough: knobs.router.passThrough,
              availableModels: knobs.availableModels,
              enforceAvailableModels: knobs.enforceAvailableModels || inFastMode,
            },
          );
          const route = resolveRoutes(registry, result.profile.model, { withFallbacks: true })[0];
          if (!route) {
            return JSON.stringify({
              switched: false,
              error: `Router could not resolve profile "${result.name}" model "${result.profile.model}".`,
            });
          }
          nextLlm = { ...route.llm };
          resolvedRoute = route.slug;
        }
        this.llmConfig = nextLlm;
        try {
          setSessionRuntime(this.workspaceRoot, this.sessionKey, {
            model: routeProfileModel ? result.profile.model : nextLlm.model,
            endpoint: result.profile.endpoint ?? '',
            llmProfile: result.name,
          });
          if (result.profile.reasoningEffort) {
            setSessionMode(this.workspaceRoot, this.sessionKey, { effort: result.profile.reasoningEffort });
          }
        } catch { /* persistence is best-effort; the live switch already applied */ }
        traceEvent('model.profile_switch', {
          from: before,
          to: nextLlm.model,
          profile: result.name,
          route: resolvedRoute || null,
          reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null,
        });
        return JSON.stringify({
          switched: true,
          profile: result.name,
          from: before,
          to: nextLlm.model,
          route: resolvedRoute || undefined,
          note: 'Applies from the next model call onward in this session.',
        });
      }
      case 'task_output': {
        // CC-P11.1 — incremental output of a background run_command.
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('task_output requires an id (from run_command background:true).');
        const fromByte = typeof args.fromByte === 'number' && args.fromByte >= 0 ? Math.floor(args.fromByte) : 0;
        const out = readBackgroundOutput(id, fromByte);
        if (!out) return JSON.stringify({ id, found: false, note: 'Unknown background run (it dies with the CLI process).' });
        return JSON.stringify(out);
      }
      case 'wait_until': {
        // CC-P11.2 — block until a workspace file condition holds (or timeout).
        const condition = String(args.condition ?? '');
        if (condition !== 'file_exists' && condition !== 'file_contains') {
          throw new Error('wait_until requires condition "file_exists" or "file_contains".');
        }
        const watchPath = String(args.path ?? '').trim();
        if (!watchPath) throw new Error('wait_until requires a path.');
        if (condition === 'file_contains' && !String(args.text ?? '').trim()) {
          throw new Error('wait_until with file_contains requires `text`.');
        }
        const resolvedWatch = resolveHere(watchPath);
        const result = await waitUntilCondition({
          condition,
          resolvedPath: resolvedWatch,
          text: typeof args.text === 'string' ? args.text : undefined,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          pollMs: typeof args.pollMs === 'number' ? args.pollMs : undefined,
        });
        return JSON.stringify({ ...result, condition, path: watchPath });
      }
      case 'apply_patch': {
        const patch = String(args.patch ?? '');
        if (!patch.trim()) throw new Error('apply_patch requires a non-empty patch.');
        const ops = parsePatchEnvelope(patch);
        const safety = assessPatchSafety(ops);
        const parentDenial = await this.confirmSilentChildToolApproval({
          tool: 'apply_patch',
          summary: `${safety.adds} add, ${safety.updates} update, ${safety.deletes} delete, ${safety.renames} rename`,
          reason: safety.touchesVcs
            ? 'silent child agent requested a patch touching VCS metadata'
            : 'silent child agent requested a patch',
          dangerous: safety.touchesVcs || safety.deletes > 0,
        });
        if (parentDenial) return parentDenial;
        // 0.4.x-3b — capture each target file's prior content before the patch
        // applies (undo log for /rewind --files). Parse the envelope's file
        // headers (`*** Add/Update/Delete File: <path>`).
        for (const m of patch.matchAll(/^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+)\s*$/gm)) {
          const p = m[1].trim();
          if (p) { try { this.captureFileSnapshot(path.resolve(this.workspaceRoot, p)); } catch { /* noop */ } }
        }
        {
          const result = applyPatchEnvelope(patch, this.workspaceRoot, this.ownership);
          const firstFile = patch.match(/^\*\*\*\s+(?:Add|Update) File:\s*(.+)\s*$/m)?.[1]?.trim();
          const checkFile = firstFile ? path.resolve(this.workspaceRoot, firstFile) : this.workspaceRoot;
          const patchNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: checkFile, cwd: this.workspaceRoot });
          let patchReindex = '';
          if (firstFile) {
            try { patchReindex = await this.maybeReindexSource(checkFile, fs.readFileSync(checkFile, 'utf8')); } catch { /* file may have been deleted */ }
          }
          return result + patchNotice + patchReindex;
        }
      }
      case 'update_plan': {
        const state = updatePlan(this.workspaceRoot, {
          explanation: args.explanation,
          plan: args.plan,
        }, this.sessionKey);
        // Auto mode has no approval prompt — record an auto-approval into the
        // plan history when this establishes a new plan version.
        this.maybeAutoApprovePlan(state);
        return formatPlan(state);
      }
      case 'track_query': {
        const action = String(args.action ?? 'list');
        if (action === 'board') {
          const project = trackGetProject(this.workspaceRoot) ?? trackEnsureProject(this.workspaceRoot);
          const items = trackListWorkItems(this.workspaceRoot);
          const columns = project.workflowStates.map((s) => ({
            state: s.name, id: s.id,
            items: items.filter((w) => w.status === s.id).map((w) => ({ key: w.key, type: w.type, title: w.title, priority: w.priority, assignee: w.assignee })),
          }));
          return JSON.stringify({ project: { key: project.key, name: project.name }, columns }, null, 2);
        }
        if (action === 'get') {
          const item = trackGetWorkItem(this.workspaceRoot, String(args.key ?? ''));
          return item ? JSON.stringify(item, null, 2) : `No work item "${args.key}".`;
        }
        if (action === 'sprints') {
          return JSON.stringify(trackListSprints(this.workspaceRoot), null, 2);
        }
        if (action === 'sprint-detail') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          return JSON.stringify({ sprint, items: trackListWorkItems(this.workspaceRoot, { sprintId }) }, null, 2);
        }
        if (action === 'velocity') {
          const sprintId = typeof args.sprintId === 'string' ? args.sprintId : undefined;
          if (sprintId) {
            const velocity = trackSprintVelocity(this.workspaceRoot, sprintId);
            return velocity === undefined ? `No sprint "${sprintId}".` : JSON.stringify({ sprintId, velocity });
          }
          return JSON.stringify(trackListSprints(this.workspaceRoot).map((sprint) => ({
            sprintId: sprint.id,
            velocity: trackSprintVelocity(this.workspaceRoot, sprint.id) ?? 0,
          })), null, 2);
        }
        const items = trackListWorkItems(this.workspaceRoot, {
          status: typeof args.status === 'string' ? args.status : undefined,
          type: isWorkItemType(args.type) ? args.type : undefined,
          assignee: typeof args.assignee === 'string' ? args.assignee : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
        });
        return JSON.stringify(items.map((w) => ({ key: w.key, type: w.type, status: w.status, statusCategory: w.statusCategory, priority: w.priority, title: w.title, assignee: w.assignee })), null, 2);
      }
      case 'track_update': {
        const action = String(args.action ?? '');
        if (action === 'create') {
          const item = trackCreateWorkItem(this.workspaceRoot, {
            title: String(args.title ?? 'Untitled'),
            type: isWorkItemType(args.type) ? args.type : 'task',
            status: typeof args.status === 'string' ? args.status : undefined,
            priority: isWorkItemPriority(args.priority) ? args.priority : undefined,
            sessionKey: this.sessionKey, actor: 'agent',
          });
          return `Created ${item.key} [${item.status}]: ${item.title}`;
        }
        if (action === 'transition') {
          try {
            const item = trackTransitionWorkItem(this.workspaceRoot, String(args.key ?? ''), String(args.toStatus ?? ''), 'agent');
            return item ? `${item.key} → ${item.status}` : `No work item "${args.key}".`;
          } catch (e) { return (e as Error).message; }
        }
        if (action === 'comment') {
          const item = trackAddComment(this.workspaceRoot, String(args.key ?? ''), 'agent', String(args.body ?? ''));
          return item ? `Commented on ${item.key}.` : `No work item "${args.key}".`;
        }
        if (action === 'link') {
          const item = trackLinkWorkItem(this.workspaceRoot, String(args.key ?? ''), {
            codeLinks: Array.isArray(args.codeLinks) ? (args.codeLinks as Array<{ kind: 'branch' | 'commit' | 'pull-request' | 'file'; ref: string }>) : undefined,
            linkedMemoryIds: Array.isArray(args.linkedMemoryIds) ? (args.linkedMemoryIds as string[]) : undefined,
            links: typeof args.blocks === 'string' ? [{ type: 'blocks', targetId: args.blocks }] : undefined,
          });
          return item ? `Linked ${item.key}.` : `No work item "${args.key}".`;
        }
        if (action === 'assign-sprint') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          const item = trackUpdateWorkItem(this.workspaceRoot, String(args.key ?? ''), { sprintId }, 'agent');
          return item ? `Assigned ${item.key} to ${sprint.name}.` : `No work item "${args.key}".`;
        }
        if (action === 'sprint-create') {
          const name = String(args.name ?? '').trim();
          if (!name) return 'sprint-create requires a name.';
          const sprint = trackCreateSprint(this.workspaceRoot, {
            name,
            goal: typeof args.goal === 'string' ? args.goal : undefined,
          });
          return `Created ${sprint.name} (${sprint.id}).`;
        }
        if (action === 'batch-transition') {
          const query = String(args.query ?? '').trim();
          if (!query) return 'batch-transition requires a query.';
          const parsed = parseTrackQuery(query);
          if (!parsed.ok) return `Bad query: ${parsed.error}`;
          const toStatus = String(args.toStatus ?? '');
          const project = trackGetProject(this.workspaceRoot) ?? trackEnsureProject(this.workspaceRoot);
          if (!project.workflowStates.some((state) => state.id === toStatus)) {
            return `Unknown workflow state "${toStatus}". Valid: ${project.workflowStates.map((state) => state.id).join(', ')}`;
          }
          const items = trackListWorkItems(this.workspaceRoot, { query }).filter((item) => item.status !== toStatus);
          for (const item of items) trackTransitionWorkItem(this.workspaceRoot, item.key, toStatus, 'agent');
          return `Transitioned ${items.length} work item${items.length === 1 ? '' : 's'} to ${toStatus}.`;
        }
        if (action === 'sprint-start') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          if (args.capacity !== undefined && (typeof args.capacity !== 'number' || !Number.isFinite(args.capacity) || args.capacity < 0)) {
            return 'Sprint capacity must be a non-negative number.';
          }
          try {
            trackSetSprintState(this.workspaceRoot, sprintId, 'active');
          } catch (error) {
            return (error as Error).message;
          }
          const updated = trackUpdateSprint(this.workspaceRoot, sprintId, {
            startDate: sprint.startDate ?? new Date().toISOString(),
            ...(typeof args.capacity === 'number' ? { capacity: args.capacity } : {}),
          })!;
          return `Started ${updated.name}.`;
        }
        if (action === 'sprint-complete') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          const velocity = trackSprintVelocity(this.workspaceRoot, sprintId)!;
          trackUpdateSprint(this.workspaceRoot, sprintId, { velocity });
          trackSetSprintState(this.workspaceRoot, sprintId, 'completed');
          return `Completed ${sprint.name} (velocity: ${velocity}).`;
        }
        return `Unknown track_update action "${action}". Use create · transition · comment · link · sprint-create · assign-sprint · batch-transition · sprint-start · sprint-complete.`;
      }
      case 'connector_list': {
        const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : undefined;
        const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : undefined;
        const connectors = listConnectors(this.workspaceRoot, {
          source: source as never,
          status: status as never,
        }).map((connector) => ({
          id: connector.id,
          source: connector.source,
          status: connector.status,
          lastRunAt: connector.lastRunAt ?? null,
          lastError: connector.lastError ?? null,
        }));
        return JSON.stringify(connectors, null, 2);
      }
      case 'connector_run': {
        const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
        if (!connectorId) throw new Error('connector_run requires a `connectorId` (see connector_list).');
        // Agent deps: static/dynamic-token GitHub client (NO keychain — oauth
        // github without a token throws the desktop-only guidance in the runner),
        // the agent's own MCP client for the `mcp` source, and env-token creds.
        const runResult = await runConnectorCheckpointCore(this.workspaceRoot, connectorId, {
          envToken: defaultEnvTokenResolver,
          githubClient: (connector) => {
            const cred = defaultEnvTokenResolver(connector, 'GitHub');
            if (!cred.token) return undefined; // → runner throws the OAuth/keychain guidance
            const apiBase = typeof connector.config.baseUrl === 'string' ? connector.config.baseUrl : undefined;
            return githubTokenClient(cred.token, { apiBase });
          },
          mcpClient: () => this.agentMcpConnectorClient(),
        });
        // Import the freshly-persisted documents into memory so future recall can
        // cite them — mirror the host's `indexConnectorMemory` via `memory_import`.
        let importedRecords = 0;
        let importError: string | undefined;
        if (runResult.documents.length > 0) {
          try {
            // Omit sessionKey (mirror the desktop host): connector documents are
            // workspace knowledge, not session-scoped, so future recall in any
            // session can cite them.
            const bundle = exportConnectorDocumentsForMemory(this.workspaceRoot, { connectorId });
            if (bundle.recordCount > 0) {
              const res = await this.mcpClient.callTool('memory_import', { data: bundle.data }, { signal: this.turnAbort?.signal });
              if ((res as { isError?: boolean })?.isError) {
                const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
                importError = typeof text === 'string' ? text : 'memory_import failed.';
              } else {
                importedRecords = bundle.recordCount;
              }
            }
          } catch (err) {
            importError = err instanceof Error ? err.message : String(err);
          }
        }
        const lines = [
          `Connector ${connectorId}: ${runResult.ok ? 'ran' : 'ran with failures'}.`,
          `Documents seen: ${runResult.run.documentsSeen ?? runResult.documents.length}; persisted: ${runResult.documents.length}; imported to memory: ${importedRecords}.`,
        ];
        // Failures are already source-sanitized by the runtimes (repo/channel +
        // HTTP status, never tokens). Cap the list so a broad failure set can't
        // flood the transcript.
        if (runResult.failures.length) {
          lines.push(`Failures (${runResult.failures.length}):`);
          for (const failure of runResult.failures.slice(0, 10)) lines.push(`  - ${failure}`);
          if (runResult.failures.length > 10) lines.push(`  … and ${runResult.failures.length - 10} more.`);
        }
        if (importError) lines.push(`Memory import error: ${importError}`);
        return lines.join('\n');
      }
      case 'file_vulnerability': {
        const run = getLatestReview(this.workspaceRoot);
        if (!run || run.status !== 'running') throw new Error('file_vulnerability requires an active pentest review run.');
        const input = validatePentestFinding({
          file: String(args.file ?? ''), line: Number.isInteger(args.line) ? Number(args.line) : undefined,
          endLine: Number.isInteger(args.endLine) ? Number(args.endLine) : undefined,
          summary: String(args.summary ?? ''), details: typeof args.details === 'string' ? args.details : undefined,
          confidence: Math.max(0, Math.min(100, Number(args.confidence) || 0)),
          cvssVector: String(args.cvssVector ?? ''), cwe: String(args.cwe ?? ''),
          cve: typeof args.cve === 'string' ? args.cve : undefined,
          poc: String(args.poc ?? ''), remediation: String(args.remediation ?? ''),
        });
        const key = findingKey({ file: input.file, line: input.line, lineEnd: input.endLine, severity: input.severity, confidence: input.confidence, summary: input.summary, rootCause: input.cwe });
        const duplicate = run.findings.find((existing) => findingKey({ file: existing.file, line: existing.line, lineEnd: existing.endLine, severity: existing.severity, confidence: existing.confidence, summary: existing.summary, rootCause: existing.cwe }) === key);
        if (duplicate) return JSON.stringify({ accepted: false, duplicate_of: duplicate.id, reason: 'Same file, location, and root cause already recorded.' });
        if (run.findings.length) {
          try {
            const judged: any = await callOpenAI(this.llmConfig, buildPentestDedupeMessages(input, run.findings.map((finding) => ({ id: finding.id, file: finding.file, line: finding.line, endLine: finding.endLine, summary: finding.summary, details: finding.details, cwe: finding.cwe, poc: finding.poc }))), [], { effort: 'low', signal: this.turnAbort?.signal });
            if (judged?.usage) {
              this.lastTurnUsage.promptTokens += judged.usage.prompt_tokens ?? 0;
              this.lastTurnUsage.completionTokens += judged.usage.completion_tokens ?? 0;
              this.lastTurnUsage.calls += 1;
              enforceTaskBudget({ caps: this.taskBudgetCaps ?? getCliKnobs().budget, modelId: this.llmConfig.model, usage: { promptTokens: this.sessionUsage.promptTokens + this.lastTurnUsage.promptTokens, completionTokens: this.sessionUsage.completionTokens + this.lastTurnUsage.completionTokens, cachedTokens: this.sessionUsage.cachedTokens + this.lastTurnUsage.cachedTokens, missedTokens: this.sessionUsage.missedTokens + this.lastTurnUsage.missedTokens } });
            }
            const decision = parsePentestDedupeDecision(String(judged?.content ?? ''));
            if (decision?.is_duplicate && decision.duplicate_id && decision.confidence >= 0.75 && run.findings.some((finding) => finding.id === decision.duplicate_id)) {
              return JSON.stringify({ accepted: false, duplicate_of: decision.duplicate_id, confidence: decision.confidence, reason: decision.reason });
            }
          } catch (error) {
            // Deterministic same-location/root-cause protection above remains
            // authoritative if the optional semantic judge is unavailable.
            if (error instanceof Error && error.name === 'BudgetExceededError') throw error;
          }
        }
        const finding = { ...input, id: `pentest_${randomUUID().slice(0, 12)}` };
        saveReview(this.workspaceRoot, { ...run, updatedAt: new Date().toISOString(), findings: [...run.findings, finding] });
        return JSON.stringify({ accepted: true, finding: { id: finding.id, severity: finding.severity, cvss: finding.cvss } });
      }
      case 'finish_scan': {
        const activeWorkers = listWorkers(this.workspaceRoot).filter((worker) => worker.status === 'running');
        if (activeWorkers.length) throw new Error(`finish_scan refused while ${activeWorkers.length} worker(s) are still running: ${activeWorkers.map((worker) => worker.id).join(', ')}`);
        const run = getLatestReview(this.workspaceRoot);
        if (!run || run.status !== 'running') throw new Error('finish_scan requires an active pentest review run.');
        const executiveSummary = String(args.executiveSummary ?? '').trim();
        const methodology = String(args.methodology ?? '').trim();
        const limitations = String(args.limitations ?? '').trim();
        if (!executiveSummary || !methodology || !limitations) throw new Error('finish_scan requires executiveSummary, methodology, and limitations.');
        const summary = `${executiveSummary}\n\nMethodology: ${methodology}\n\nLimitations: ${limitations}`;
        saveReview(this.workspaceRoot, { ...run, status: 'completed', updatedAt: new Date().toISOString(), summary });
        return JSON.stringify({ completed: true, findings: run.findings.length, sarif: '.brainrouter/findings.sarif' });
      }
      case 'list_requests':
        return JSON.stringify(await proxyControl('requests', { method: 'GET' }, this.pentestProxyApiUrl ? { apiUrl: this.pentestProxyApiUrl } : undefined));
      case 'view_request': {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('view_request requires an id.');
        return JSON.stringify(await proxyControl(`requests/${encodeURIComponent(id)}`, { method: 'GET' }, this.pentestProxyApiUrl ? { apiUrl: this.pentestProxyApiUrl } : undefined));
      }
      case 'repeat_request': {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('repeat_request requires an id.');
        return JSON.stringify(await proxyControl(`requests/${encodeURIComponent(id)}/repeat`, { method: 'POST', body: JSON.stringify({ mutation: args.mutation ?? null }) }, this.pentestProxyApiUrl ? { apiUrl: this.pentestProxyApiUrl } : undefined));
      }
      case 'list_sitemap':
        return JSON.stringify(await proxyControl('sitemap', { method: 'GET' }, this.pentestProxyApiUrl ? { apiUrl: this.pentestProxyApiUrl } : undefined));
      case 'scope_rules': {
        const action = args.action === 'set' ? 'set' : 'get';
        if (action === 'set' && (!Array.isArray(args.rules) || !args.rules.every((rule: unknown) => typeof rule === 'string'))) throw new Error('scope_rules set requires a string rules array.');
        return JSON.stringify(await proxyControl('scope', action === 'set' ? { method: 'PUT', body: JSON.stringify({ rules: args.rules }) } : { method: 'GET' }, this.pentestProxyApiUrl ? { apiUrl: this.pentestProxyApiUrl } : undefined));
      }
      case 'artifact_write': {
        // §AV-4 — in-band artifact authoring. With `id` it grows an EXISTING
        // artifact (a new version, editedBy 'agent') — this is how a later turn
        // or a sub-agent targets the same artifact across sessions. Without `id`
        // it creates one. Content edits are versioned by the store (§AV-1).
        const content = typeof args.content === 'string' ? args.content : '';
        if (!content.trim() && !args.id) {
          throw new Error('artifact_write: `content` is required when creating a new artifact.');
        }
        const format: ArtifactFormat = isArtifactFormat(args.format) ? args.format : 'markdown';
        const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '';
        if (id) {
          if (!getArtifact(this.workspaceRoot, id)) throw new Error(`artifact_write: no artifact "${id}" to update.`);
          const patch: Record<string, unknown> = { content, format };
          if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
          if (typeof args.summary === 'string') patch.summary = args.summary;
          if (typeof args.language === 'string' && args.language.trim()) patch.language = args.language.trim();
          const updated = updateArtifact(this.workspaceRoot, id, patch, { editedBy: 'agent', note: typeof args.note === 'string' ? args.note : undefined });
          if (!updated) throw new Error(`artifact_write: failed to update "${id}".`);
          await this.captureArtifactToMemory(updated);
          return `Updated artifact ${updated.id} → v${updated.currentVersion} (${updated.kind}, ${updated.format}): ${updated.title}`;
        }
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        if (!title) throw new Error('artifact_write: `title` is required when creating a new artifact.');
        const kind: ArtifactKind = isArtifactKind(args.kind) ? args.kind : 'markdown-report';
        const created = createArtifact(this.workspaceRoot, {
          kind, title, format, content,
          language: typeof args.language === 'string' ? args.language : undefined,
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          sessionKey: this.sessionKey,
          editedBy: 'agent',
        });
        await this.captureArtifactToMemory(created);
        return `Created artifact ${created.id} (v1, ${created.kind}, ${created.format}): ${created.title}. Update it later with artifact_write({ id: "${created.id}", content }).`;
      }
      case 'workflow_progress': {
        const slug = getCurrentWorkflow(this.workspaceRoot, this.sessionKey);
        if (!slug) {
          return 'No active workflow — nothing to track. (Bind one with /review, /simplify, /feature-dev, /spec, or /implement-plan.)';
        }
        const step = String(args.step ?? '').trim();
        const status = String(args.status ?? '').trim() as 'running' | 'done' | 'failed' | 'skipped';
        if (!step) throw new Error('workflow_progress requires a non-empty `step` id.');
        if (!['running', 'done', 'failed', 'skipped'].includes(status)) {
          throw new Error(`workflow_progress: status must be running|done|failed|skipped (got "${status}").`);
        }
        const run = advanceRunStep(this.workspaceRoot, slug, step, status, {
          note: args.note ? String(args.note) : undefined,
          sessionKey: this.sessionKey,
          pid: process.pid,
        });
        const { done, total } = summarizeRun(run);
        return `Workflow "${slug}": step "${step}" → ${status} (${done}/${total} done, run ${run.status}).`;
      }
      case 'ask_user_choice': {
        // PARITY — accept either the single-question fields or a batched
        // `questions[]` array (asked in turn, answers returned together). The
        // single form keeps its `{answer}` shape; batched returns `{answers}`.
        const rawQuestions: any[] = Array.isArray(args.questions) && args.questions.length
          ? args.questions
          : [{ question: args.question, header: args.header, options: args.options, multiSelect: args.multiSelect }];
        const specs = rawQuestions.map((rq, qi) => {
          const where = rawQuestions.length > 1 ? ` (question ${qi + 1})` : '';
          const q = String(rq?.question ?? '').trim();
          const h = String(rq?.header ?? '').trim();
          const rawOptions: any[] = Array.isArray(rq?.options) ? rq.options : [];
          if (!q) throw new Error(`ask_user_choice requires a non-empty \`question\`${where}.`);
          if (!h) throw new Error(`ask_user_choice requires a non-empty \`header\`${where}.`);
          if (rawOptions.length < 2 || rawOptions.length > 4) {
            throw new Error(`ask_user_choice requires 2–4 options${where}; received ${rawOptions.length}.`);
          }
          const options = rawOptions.map((o, i) => {
            const label = String(o?.label ?? '').trim();
            const description = String(o?.description ?? '').trim();
            if (!label) throw new Error(`ask_user_choice option ${i + 1}${where} is missing "label".`);
            if (!description) throw new Error(`ask_user_choice option ${i + 1}${where} is missing "description".`);
            return { label, description };
          });
          return { question: q, header: h, options, multiSelect: !!rq?.multiSelect };
        });
        const batched = specs.length > 1;
        // Back-compat aliases for the guard/trace code below (single-question).
        const question = specs[0].question;
        const options = specs[0].options;
        // Silent child agents have no parent stdin/REPL bridge, so the
        // helper's TTY check would error anyway — but giving a clearer message
        // up front saves the LLM an iteration.
        if (this.silent) {
          throw new NoTTYError(
            'ask_user_choice is not available to silent child agents. Decide the answer yourself, ' +
            'state which option you picked and why, and return that as your final answer to the parent.',
          );
        }
        // Autonomy bypass. The picker is suppressed in two cases:
        //
        //   1. /yolo on (executionMode=fast AND reviewPolicy=proceed) —
        //      the user has explicitly opted out of in-turn prompts.
        //   2. /goal active — the user has typed a goal and the auto-
        //      continuation loop is running; blocking on a picker
        //      stalls the whole reason /goal exists. The model decides
        //      itself and states which option in its reply.
        //
        // Both refusal messages use NoTTYError so the existing model
        // contract ("fall back to deciding yourself") fires verbatim.
        // A trace event records which axis triggered the bypass.
        const yoloPrefs = resolveActiveMode(this.workspaceRoot, this.sessionKey);
        const yoloOn = yoloPrefs.executionMode === 'fast' && yoloPrefs.reviewPolicy === 'proceed';
        const goalForPicker = readGoal(this.workspaceRoot, this.sessionKey);
        const goalActiveForPicker = !!(goalForPicker?.text && goalForPicker.status === 'active');
        if (yoloOn || goalActiveForPicker) {
          const reason = yoloOn && goalActiveForPicker ? 'yolo+goal' : yoloOn ? 'yolo' : 'goal';
          traceEvent('ask_user_choice.bypass', {
            reason,
            question,
            optionLabels: options.map((o) => o.label),
          });
          const triggerNote = yoloOn
            ? '/yolo (executionMode=fast + reviewPolicy=proceed)'
            : `the active /goal "${goalForPicker!.text.slice(0, 80)}${goalForPicker!.text.length > 80 ? '…' : ''}"`;
          throw new NoTTYError(
            `ask_user_choice was suppressed by ${triggerNote}. ` +
            'The user has explicitly opted out of in-turn prompts — pick the option you would pick, ' +
            'state which one you picked and why in your reply, and keep going. ' +
            (yoloOn
              ? 'Toggle off with /yolo off if you actually need to ask.'
              : 'Stop the goal with /goal pause or /goal clear if you actually need to ask.'),
          );
        }
        // Eager TTY check so we fail without disturbing the screen. askChoice
        // also checks (defense-in-depth for direct callers), but doing it here
        // means the LLM gets a clean error before the picker tries to render.
        // DESK-3 — UI dialog path: no TTY needed when an interaction port is
        // attached. A dismissed dialog mirrors the NoTTY contract verbatim.
        // Ask ONE spec, returning the chosen label(s). Same gates for every
        // spec — the DESK-3 UI dialog path when a port is attached, else the
        // TTY picker.
        const askOne = async (spec: { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }): Promise<string | string[]> => {
          // CC-hooks parity — the agent is about to BLOCK awaiting the user's
          // choice: fire `notification-agent-needs-input` so a user can wire a
          // desktop/OS notifier (the terminal is likely backgrounded). Advisory
          // and best-effort — a failing notifier must never break the picker.
          if (this.hookNotifyActive()) {
            try {
              runHooks(this.workspaceRoot, 'notification-agent-needs-input', {
                payload: { sessionKey: this.sessionKey, question: spec.question, header: spec.header, optionLabels: spec.options.map((o) => o.label) },
              });
            } catch { /* advisory */ }
          }
          if (this.interactionPort) {
            const labels = await this.interactionPort.choice({
              question: spec.question, header: spec.header, options: spec.options, multiSelect: spec.multiSelect,
            });
            if (!labels || labels.length === 0) {
              throw new NoTTYError(
                'The user dismissed the choice dialog. ' +
                'Fall back to deciding yourself and state which option you picked and why.',
              );
            }
            return spec.multiSelect ? labels : labels[0];
          }
          if (!this.prompter.getActiveReadline() || !process.stdin.isTTY) {
            throw new NoTTYError(
              'ask_user_choice requires an interactive TTY. ' +
              'Fall back to deciding yourself and state which option you picked and why.',
            );
          }
          // header is rendered by the picker itself (chip line at the top of
          // the frame), so we just thread it through opts.
          return await this.prompter.askChoice(spec.question, spec.options, { multiSelect: spec.multiSelect, header: spec.header });
        };

        if (!batched) {
          return JSON.stringify({ answer: await askOne(specs[0]) });
        }
        // Batched: ask each in turn, key answers by header (fallback question).
        const answers: Record<string, string | string[]> = {};
        for (const spec of specs) {
          answers[spec.header || spec.question] = await askOne(spec);
        }
        return JSON.stringify({ answers });
      }
      case 'goal_complete': {
        const proof = String(args.proof ?? '').trim();
        if (!proof) throw new Error('goal_complete requires a non-empty proof.');
        // Plan-honesty guard: refuse to mark the goal complete while the
        // active plan still has pending / in_progress items. The model
        // built that plan as its own contract — declaring done while items
        // remain open is misleading (this is the exact bug the user hit
        // when /goal analyze fired with 3 of 4 plan items still ☐). The
        // model must either finish the work, explicitly mark dropped
        // items completed via update_plan (creating an audit trail), or
        // switch to goal_blocked.
        const plan = readPlan(this.workspaceRoot, this.sessionKey);
        const open = plan.items.filter((i) => i.status !== 'completed');
        if (open.length > 0) {
          const open_summary = open
            .map((i) => `  - [${i.status === 'in_progress' ? '⏳' : '☐'}] ${i.step}`)
            .join('\n');
          throw new Error(
            `goal_complete refused: the active plan still has ${open.length} incomplete item(s):\n${open_summary}\n\n` +
            `Do ONE of:\n` +
            `  1. Finish the remaining work, then call update_plan to mark those items completed.\n` +
            `  2. If you decided to drop them, call update_plan FIRST and mark them completed with a brief explanation (the plan is your honest record — leaving items pending while declaring done is misleading).\n` +
            `  3. Call goal_blocked instead if no defensible path remains.\n\n` +
            `Then retry goal_complete in the same response as the user-visible prose summary.`
          );
        }
        const goal = completeGoal(this.workspaceRoot, this.sessionKey, proof);
        if (!goal) return 'No active goal to complete.';
        this.lastGoalTransition = 'complete';
        return `Goal marked complete. Proof: ${proof}`;
      }
      case 'goal_blocked': {
        const reason = String(args.reason ?? '').trim();
        if (!reason) throw new Error('goal_blocked requires a non-empty reason.');
        const needed = String(args.needed ?? '').trim();
        const note = needed ? `${reason} (needed: ${needed})` : reason;
        const goal = blockGoal(this.workspaceRoot, this.sessionKey, note);
        if (!goal) return 'No active goal to block.';
        this.lastGoalTransition = 'blocked';
        return `Goal marked blocked. Reason: ${note}`;
      }
      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
  }
