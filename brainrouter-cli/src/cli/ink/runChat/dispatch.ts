import type readline from 'node:readline';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import { readPreferences } from '@kinqs/brainrouter-core/session';
import { resolveSandboxConfig, runShell } from '@kinqs/brainrouter-core/exec';
import { SLASH_COMMANDS } from '@kinqs/brainrouter-core/command';
import { parseBangCommand, parseNoteCommand } from '../../../runtime/exec/bangCommand.js';
import { handleSlashCommand } from '../../prompt/repl.js';
import {
  parseStackedSkillTokens,
  resolveStackedSkills,
  buildStackedSkillPrompt,
  matchTriggeredSkills,
  type TriggeredSkillHit,
} from '../../../prompt/skillRunner.js';
import { listFilesystemSkills } from '../../../prompt/skillCatalog.js';
import { captureConsoleOutput } from '../terminal/consoleCapture.js';
import type { PushScrollback } from '../ChatApp.js';
import type { RunChatContext } from './context.js';

/**
 * Slash-command dispatch + the composer submit handler. `dispatchSlash`
 * routes a `/command` through the shared readline-shim so the existing slash
 * handlers work unchanged under the Ink REPL, capturing their console output
 * into scrollback and refreshing footer/panels afterwards. `createOnSubmit`
 * builds the composer's per-line dispatcher (goal/auto-resume cancellation,
 * askYesNo routing, `?`/`#`/`!` inline handling, `/queue`, turn queueing).
 */
export function installDispatch(ctx: RunChatContext): void {
  const { agent, mcpClient, config, shim } = ctx;

  ctx.dispatchSlash = async function dispatchSlash(command: string, args: string[], rl: any): Promise<void> {
    if (!ctx.controller) return;
    try {
      const captured = await captureConsoleOutput(() =>
        handleSlashCommand(command, args, agent, mcpClient, config, rl as readline.Interface, {
          refreshPromptForMode: ctx.refreshFooter,
          replaceBanner: (text: string) => ctx.controller?.replaceBanner(text),
          isProcessing: () => ctx.isProcessing,
          runAgentTurn: (prompt: string) => { void ctx.runChatTurn(prompt); },
          runAgentTurnAsync: (prompt: string) => ctx.runChatTurn(prompt),
        }),
      );
      const output = captured.output.trimEnd();
      if (output) {
        ctx.controller.push.raw(output);
      }
    } catch (err: any) {
      ctx.controller.push.notice(`Slash command "${command}" failed: ${err?.message ?? err}`, 'error');
    } finally {
      // Pull any preferences / model / branch / effort changes the
      // command made (e.g. /effort, /model, /theme, /statusline) so
      // the footer reflects them immediately rather than waiting for
      // the next chat turn to refresh.
      ctx.refreshFooter();
      // Refresh the boxed banner in place when slash commands changed
      // banner-visible state (model, MCP profile, workflow, goal).
      // Diff-based so /theme, /effort, /quiet, etc. stay silent.
      // Uses controller.replaceBanner — overwrites the original banner
      // entry in scrollback rather than pushing a new copy, so there's
      // only ever one banner box on screen.
      // Banner updates disabled since the boxed banner is no longer needed
      /*
      try {
        const fresh = renderBanner(buildBannerInputs(config, agent, mcpClient), theme);
        if (fresh !== lastRenderedBanner) {
          controller.replaceBanner('\n' + fresh);
          lastRenderedBanner = fresh;
        }
      } catch { }
      */
      // BG-TASKS-PANEL — commands like /bg, /spawn, /workflow, /loop start
      // background actors WITHOUT a chat turn, so arm the ticker + refresh the
      // panel here too (the turn path does this in runChatTurn's finally).
      ctx.ensureChildRefreshTimer();
      ctx.refreshBackgroundTasks();
    }
  };
}

/**
 * The composer submit handler passed to `<ChatApp onSubmit>`. Extracted so
 * the mounted component stays a thin composition; behaviour is identical to
 * the previous inline arrow.
 */
export function createOnSubmit(ctx: RunChatContext): (text: string, push: PushScrollback) => Promise<void> {
  const { agent, mcpClient, shim, inputQueue } = ctx;
  return async (text, push) => {
    // Any in-flight goal continuation is cancelled by user input,
    // regardless of whether the input is a slash or a prompt.
    if (ctx.pendingContinuation) {
      ctx.pendingContinuation = false;
      push.notice('(goal continuation cancelled by user input)');
    }
    // C1 — likewise cancel an armed child auto-resume watch.
    if (ctx.cancelChildResume()) {
      push.notice('(auto-resume cancelled by user input)');
    }
    ctx.clearIdleHint();

    // If a slash command's handler had called `rl.question(cb)`,
    // the very next submission belongs to `cb` — not the dispatcher.
    if (ctx.questionCallback) {
      const cb = ctx.questionCallback;
      ctx.questionCallback = undefined;
      cb(text);
      return;
    }

    // Bare `?` → help (mirrors the readline REPL — the idle hint
    // advertises it, so make it actually work).
    if (text === '?') {
      await ctx.dispatchSlash('/help', [], shim);
      return;
    }

    // CC-P4.4 — `# <note>` quick memory capture: save a note straight to the
    // brain without an LLM turn (Claude Code's # memorize shortcut). Sent as a
    // user-note + synthetic ack pair so the extractor sees its usual shape;
    // shows the brain's capture verdict (or a clear offline notice).
    const noteCmd = parseNoteCommand(text);
    if (noteCmd.isNote) {
      if (!noteCmd.note) {
        push.notice('Usage: # <note to remember>   (e.g.  # deploys happen Fridays only)', 'warn');
        return;
      }
      try {
        const res = await mcpClient.callTool('memory_capture_turn', {
          sessionKey: agent.sessionKey,
          workspaceRoot: agent.workspaceRoot,
          messages: [
            { role: 'user', content: `[user note — remember this] ${noteCmd.note}`, timestamp: Date.now() },
            { role: 'assistant', content: 'Noted and saved to memory.', timestamp: Date.now() },
          ],
        });
        const raw = (res as any)?.content?.[0]?.text ?? '';
        let captured = '';
        try { const p = JSON.parse(raw); captured = p?.cognitiveRecords !== undefined ? ` (${p.cognitiveRecords} record(s))` : ''; } catch { /* non-JSON ack */ }
        push.notice(`💾 Remembered${captured}: ${noteCmd.note.slice(0, 80)}${noteCmd.note.length > 80 ? '…' : ''}`, 'info');
      } catch (err: any) {
        push.notice(`✗ Could not save the note (brain offline?): ${err?.message ?? err}`, 'warn');
      }
      return;
    }

    // `! <command>` shell escape (PARITY-B1) — run a shell command
    // directly from the composer, mirroring Claude Code's bang prefix.
    // The user typed the command explicitly, so there's no askYesNo
    // gate (that guards model-initiated commands); the `cli.sandbox`
    // knob still wraps it for blast-radius control. Output lands in
    // scrollback as raw monospace text. Synchronous + bounded by the
    // runShell timeout — a backgrounded variant ships with /bg.
    const bang = parseBangCommand(text);
    if (bang.isBang) {
      if (!bang.command) {
        push.notice('Usage: ! <shell command>   (e.g.  ! git status)', 'warn');
        return;
      }
      push.notice(`! ${bang.command}`, 'info');
      try {
        const prefs = readPreferences(agent.workspaceRoot);
        const sandboxConfig = resolveSandboxConfig(agent.workspaceRoot, {
          readPaths: prefs.sandboxReadPaths,
          writePaths: prefs.sandboxWritePaths,
        });
        const result = await runShell(bang.command, sandboxConfig);
        if (result.notice) push.notice(result.notice, 'warn');
        const body = [result.stdout, result.stderr]
          .filter((s) => s && s.trim().length)
          .join('\n')
          .replace(/\s+$/, '');
        if (body.length) {
          push.raw(body, { noWrap: true });
        } else if (result.exitCode === 0) {
          push.notice('(no output)', 'info');
        }
        if (result.exitCode !== 0) {
          const badge = result.sandboxed ? `, sandboxed via ${result.sandboxTool}` : '';
          push.notice(`(exit ${result.exitCode}${badge})`, 'warn');
        }
      } catch (err: any) {
        push.notice(`✗ shell failed: ${err?.message ?? err}`, 'error');
      }
      return;
    }

    if (text.startsWith('/')) {
      const parts = text.trim().split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);
      // CC-SKILLS-D1 — STACKED skill invocation: a run of 2+ leading `/skill`
      // tokens whose HEAD is not a real slash command (`/a /b do X`) composes
      // those skills' bodies into a multi-phase prompt ahead of the input. A
      // genuine single command (`/spec do X`) or a known command head falls
      // through to the normal dispatcher untouched.
      if (!(SLASH_COMMANDS as readonly string[]).includes(command) && !ctx.isProcessing) {
        const stacked = parseStackedSkillTokens(text);
        if (stacked.skills.length >= 2) {
          // MC-E2 — keyword triggers COMPOSE with an explicit stack: dormant
          // skills whose trigger word appears in the remaining input fill the
          // stack's leftover slots (same skillsStackMax cap, explicit first).
          const triggered = scanKeywordTriggers(
            stacked.rest,
            agent.workspaceRoot,
            stacked.skills,
            agent.workspaceAgentId,
          );
          const names = [...stacked.skills, ...triggered.map((h) => h.name)];
          const { resolved, disallowedTools, allowedTools } = await resolveStackedSkills(mcpClient, names, agent.workspaceRoot)
            .catch(() => ({ resolved: [], disallowedTools: [] as string[], allowedTools: undefined }));
          if (resolved.length >= 1) {
            agent.activeSkill = resolved[0].name;
            agent.activeSkillDisallowedTools = disallowedTools;
            agent.activeSkillAllowedTools = allowedTools;
            const allowedNote = allowedTools === undefined ? '' : `  (allowed: ${allowedTools.join(', ') || 'none'})`;
            push.notice(`Stacked skills: ${resolved.map((s) => s.name).join(' → ')}${allowedNote}${disallowedTools.length ? `  (disallowed: ${disallowedTools.join(', ')})` : ''}`, 'info');
            noticeSkillReady(push, triggered, resolved.map((s) => s.name));
            const prompt = buildStackedSkillPrompt(resolved, { input: stacked.rest });
            await ctx.runChatTurn(prompt);
            return;
          }
          push.notice(`No known skills matched: ${stacked.skills.map((s) => '/' + s).join(' ')}`, 'warn');
        }
      }
      // C2 — `/queue` is handled inline so it works mid-turn (the slash
      // dispatcher itself is fine to run while a turn is in flight).
      if (command === '/queue') { ctx.handleQueueCommand(args); return; }
      if (command === '/steer') {
        const steering = args.join(' ').trim();
        if (!steering) {
          push.notice('Usage: /steer <message>', 'warn');
          return;
        }
        if (!ctx.isProcessing) {
          push.notice('(no active turn — running the message normally)', 'info');
          await ctx.runChatTurn(steering);
          return;
        }
        const accepted = agent.requestSteer(steering, { source: 'user' });
        push.notice(`(Steer pending · ${accepted.id.slice(0, 8)} — applies at the next safe model boundary)`, 'info');
        return;
      }
      await ctx.dispatchSlash(command, args, shim);
      return;
    }

    // C2 — a prompt typed while a turn is running is QUEUED (not dropped); it
    // runs after the current turn settles (see drainInputQueue). Manage it with
    // /queue. (Slash commands above still dispatch immediately.)
    if (ctx.isProcessing) {
      const { position } = inputQueue.enqueue(text);
      push.notice(`(queued #${position} — runs after the current turn; /queue to view, /queue remove ${position} to drop)`, 'info');
      return;
    }

    // MC-E2 — keyword-triggered JIT skill injection on a PLAIN prompt: a
    // dormant skill whose declared trigger word appears in the prompt is
    // injected into the turn exactly like an explicit /skill invocation
    // (same stacked-skill composition path, same cap). Kill-switch:
    // `cli.skillsKeywordTriggers`. Best-effort — any failure falls back to
    // the plain turn untouched.
    const triggered = scanKeywordTriggers(text, agent.workspaceRoot, [], agent.workspaceAgentId);
    if (triggered.length) {
      const { resolved, disallowedTools, allowedTools } = await resolveStackedSkills(mcpClient, triggered.map((h) => h.name), agent.workspaceRoot)
        .catch(() => ({ resolved: [], disallowedTools: [] as string[], allowedTools: undefined }));
      if (resolved.length >= 1) {
        agent.activeSkill = resolved[0].name;
        agent.activeSkillDisallowedTools = disallowedTools;
        agent.activeSkillAllowedTools = allowedTools;
        noticeSkillReady(push, triggered, resolved.map((s) => s.name));
        await ctx.runChatTurn(buildStackedSkillPrompt(resolved, { input: text }));
        return;
      }
    }

    await ctx.runChatTurn(text);
  };
}

/**
 * MC-E2 — scan a prompt for the keyword triggers of dormant skills. Reads the
 * filesystem skill catalog (which carries each skill's declared
 * `triggers:`/`keywords:` frontmatter) and applies the word-boundary matcher.
 * The `cli.skillsKeywordTriggers` kill-switch and the shared stack cap are
 * enforced inside `matchTriggeredSkills`. Never throws — trigger scanning is
 * additive and must not break prompt dispatch.
 */
function scanKeywordTriggers(
  prompt: string,
  workspaceRoot: string,
  exclude: string[] = [],
  activeAgent?: string,
): TriggeredSkillHit[] {
  try {
    if (!getCliKnobs().skillsKeywordTriggers) return [];
    return matchTriggeredSkills(
      prompt,
      listFilesystemSkills(workspaceRoot, { task: prompt, activeAgent }),
      { exclude },
    );
  } catch {
    return [];
  }
}

/** MC-E2 — surface what fired: `Skill Ready: <name> (trigger: <word>)`. */
function noticeSkillReady(push: PushScrollback, hits: TriggeredSkillHit[], resolvedNames: string[]): void {
  const resolved = new Set(resolvedNames);
  for (const hit of hits) {
    if (resolved.has(hit.name)) push.notice(`Skill Ready: ${hit.name} (trigger: ${hit.trigger})`, 'info');
  }
}
