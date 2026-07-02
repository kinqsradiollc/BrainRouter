/**
 * Extracted from cli/commands/ui.ts — preference-toggle subcommands.
 *
 * `/vim`, `/statusline`, `/theme`, `/title`, `/personality`, `/raw`,
 * `/effort`, `/tier`, `/quiet`, `/experimental`, `/keymap`. Each writes
 * a workspace preference (or session/knob override) and prints a
 * confirmation. Behavior-preserving: bodies moved verbatim.
 */

import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { readPreferences, resolveEffort, writePreferences, normalizeEffort, getSessionMode, resolveActiveMode, setSessionMode } from '@kinqs/brainrouter-core/session';
import { setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import type { CommandContext } from '../_context.js';

export async function tryHandleUiPreferencesCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/vim':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const next = prefs.editorMode === 'vi' ? 'emacs' : 'vi';
      writePreferences(agent.workspaceRoot, { editorMode: next });
      console.log(chalk.green(`\n✓ Editor mode → ${next}. Restart the CLI to apply.\n`));
      return true;
    }
    case '/statusline':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args.join(' ').trim();
      const { SEGMENT_NAMES, isKnownSegment } = await import('../../statusline.js');
      if (!arg) {
        console.log(chalk.bold('\nStatusline'));
        console.log(`  Current: ${chalk.cyan(prefs.statusline)}`);
        console.log(chalk.gray(`  Available segments: ${SEGMENT_NAMES.join(', ')}`));
        console.log(chalk.gray('  Example: /statusline mode,workflow,goal,model,session,plan\n'));
        return true;
      }
      const requested = arg.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = requested.filter((s) => !isKnownSegment(s));
      if (unknown.length > 0) {
        console.log(chalk.red(`\nUnknown segment(s): ${unknown.join(', ')}. Valid: ${SEGMENT_NAMES.join(', ')}\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { statusline: requested.join(',') });
      ctx.repl.refreshPromptForMode();
      console.log(chalk.green(`\n✓ Statusline set to: ${requested.join(',')}\n`));
      return true;
    }
    case '/theme':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const valid = new Set(['auto', 'light', 'dark', 'mono']);
      if (!arg) {
        console.log(chalk.bold('\nTheme'));
        console.log(`  Current: ${chalk.cyan(prefs.theme)}`);
        console.log(chalk.gray(`  Available: ${Array.from(valid).join(', ')}`));
        console.log(chalk.gray('  Set with: /theme <name>\n'));
        return true;
      }
      if (!valid.has(arg)) {
        console.log(chalk.red(`\nUnknown theme "${arg}". Choose: ${Array.from(valid).join(', ')}\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { theme: arg as any });
      console.log(chalk.green(`\n✓ Theme → ${arg}\n`));
      return true;
    }
    case '/title':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args.join(' ').trim();
      if (!arg) {
        console.log(chalk.bold('\nTerminal title'));
        console.log(`  Current: ${chalk.cyan(prefs.terminalTitle)}`);
        console.log(chalk.gray('  Segments: model, branch, session, mode  (use "off" to disable)'));
        console.log(chalk.gray('  Example: /title model,session\n'));
        return true;
      }
      writePreferences(agent.workspaceRoot, { terminalTitle: arg });
      try {
        if (arg.toLowerCase() !== 'off') {
          const segs = arg.split(',').map((s) => s.trim()).filter(Boolean);
          const parts: string[] = [];
          for (const seg of segs) {
            if (seg === 'model') parts.push(agent.getModel());
            else if (seg === 'session') parts.push(agent.sessionKey);
            else if (seg === 'mode') parts.push(agent.getAccessMode());
            else if (seg === 'branch') {
              try { parts.push(execSync('git rev-parse --abbrev-ref HEAD', { cwd: agent.workspaceRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { /* not a git repo */ }
            }
          }
          if (parts.length > 0) process.stdout.write(`\x1b]0;brainrouter · ${parts.join(' · ')}\x07`);
        }
      } catch { /* terminal does not support OSC titles */ }
      console.log(chalk.green(`\n✓ Terminal title → ${arg}\n`));
      return true;
    }
    case '/personality':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const valid = new Set(['concise', 'standard', 'detailed', 'pair-programmer']);
      if (!arg) {
        console.log(chalk.bold('\nPersonality (communication style)'));
        console.log(`  Current: ${chalk.cyan(prefs.personality)}`);
        console.log(chalk.gray(`  Available: ${Array.from(valid).join(', ')}\n`));
        return true;
      }
      if (!valid.has(arg)) {
        console.log(chalk.red(`\nUnknown personality "${arg}". Choose: ${Array.from(valid).join(', ')}\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { personality: arg as any });
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Personality → ${arg}. New behavior applies on the next turn.\n`));
      return true;
    }
    case '/raw':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const next = arg ? (arg === 'on' || arg === 'true' || arg === '1') : !prefs.rawScrollback;
      writePreferences(agent.workspaceRoot, { rawScrollback: next });
      console.log(chalk.green(`\n✓ Raw scrollback ${next ? 'enabled' : 'disabled'}. Markdown rendering ${next ? 'OFF' : 'ON'} for next turn.\n`));
      return true;
    }
    case '/effort':
    {
      // Per-session reasoning depth: session override > cli.effort config >
      // workspace preference > default. With a session active the toggle
      // writes the per-chat override so each chat keeps its own depth;
      // without one it falls back to the workspace preference (unchanged).
      const sessionKey = agent.sessionKey;
      const arg = (args[0] ?? '').toLowerCase();
      const valid: ReadonlyArray<string> = ['low', 'medium', 'high', 'xhigh', 'max'];
      if (!arg) {
        const resolved = resolveEffort(agent.workspaceRoot);
        const sessionOverride = sessionKey ? getSessionMode(agent.workspaceRoot, sessionKey).effort : undefined;
        const activeEffort = resolveActiveMode(agent.workspaceRoot, sessionKey).effort;
        // The config knob still wins this process even over a session
        // override; reflect that in both the value and the source tag.
        const showEffort = resolved.source === 'config' ? resolved.effort : activeEffort;
        const effectiveSource: typeof resolved.source =
          resolved.source === 'config' ? 'config' : sessionOverride ? 'preference' : resolved.source;
        const sourceTag =
          effectiveSource === 'config' ? chalk.gray(' (cli.effort in config.json)') :
          effectiveSource === 'preference' ? chalk.gray(sessionOverride ? ' (session)' : ' (preference)') :
          chalk.gray(' (default)');
        console.log(chalk.bold(`\nReasoning depth: ${chalk.cyan(showEffort)}${sourceTag}`));
        console.log(chalk.gray('  low     — terse, one-paragraph answers; minimal ceremony.'));
        console.log(chalk.gray('  medium  — current default; no overlay, no provider reasoning slot. (default)'));
        console.log(chalk.gray('  high    — step-by-step reasoning; audits evidence before each tool call.'));
        console.log(chalk.gray('  xhigh   — maximum depth (alias: max); enumerate approaches, verify assumptions, prefer correctness.'));
        console.log(chalk.gray('  When the model supports it (gpt-5, o-series, gpt-oss, DeepSeek R1/V3+, Qwen3,'));
        console.log(chalk.gray('  Magistral, *-reasoning, *-thinking — works on OpenAI, DeepSeek, OpenRouter,'));
        console.log(chalk.gray('  LM Studio 0.3.29+, Ollama), the level is also forwarded as `reasoning_effort`.'));
        console.log(chalk.gray('  Toggle with: /effort low | medium | high | xhigh   (max is an alias for xhigh)'));
        console.log(chalk.gray('  Permanent override: set `cli.effort` in ~/.config/brainrouter/config.json.\n'));
        return true;
      }
      // `max` is an accepted alias for `xhigh`; normalizeEffort canonicalizes
      // it so only `xhigh` is ever stored. Use it as the single validator too.
      const canonical = normalizeEffort(arg);
      if (!canonical) {
        console.log(chalk.red(`\nUnknown level "${arg}". Choose: ${valid.join(' | ')}  (max == xhigh)\n`));
        return true;
      }
      if (sessionKey) {
        setSessionMode(agent.workspaceRoot, sessionKey, { effort: canonical });
      } else {
        writePreferences(agent.workspaceRoot, { effort: canonical });
      }
      agent.refreshSystemPrompt();
      const after = resolveEffort(agent.workspaceRoot);
      // Show the alias the user typed alongside the canonical value so `max` isn't silently rewritten.
      const shown = arg === 'max' ? `${canonical} (max)` : canonical;
      // Surface a friendly nudge when `cli.effort` in `config.json` is still
      // explicitly set and would shadow the preference/override next boot.
      if (after.source === 'config' && after.effort !== canonical) {
        console.log(chalk.yellow(`\n✓ ${sessionKey ? 'Session' : 'Preference'} saved as ${shown}, but cli.effort=${after.effort} in config.json still wins this process.\n`));
      } else {
        console.log(chalk.green(`\n✓ Reasoning depth → ${shown}. Applies on the next turn.\n`));
      }
      return true;
    }
    case '/tier':
    {
      const { resolveTierLadder, currentTier } = await import('@kinqs/brainrouter-core/provider');
      const arg = (args[0] ?? '').toLowerCase();
      const prefs = readPreferences(agent.workspaceRoot);
      const provider = (agent.getLlmConfig?.()?.provider ?? 'openai').toLowerCase();
      const ladder = resolveTierLadder({ provider });
      if (!arg) {
        const model = agent.getModel?.() ?? '?';
        const cur = currentTier(model, ladder);
        const pinned = prefs.tier ?? null;
        console.log(chalk.bold(`\nModel tier: ${chalk.cyan(cur ?? 'unknown')}${pinned ? chalk.gray(` (pinned: ${pinned})`) : ''}`));
        console.log(`  Provider: ${chalk.gray(provider)}`);
        console.log(`  Ladder:   ${chalk.gray(`flash=${ladder.ladder.flash}, standard=${ladder.ladder.standard}, pro=${ladder.ladder.pro}`)}`);
        console.log(chalk.gray('  When the model emits `<<<NEEDS_HIGH>>>` (with optional reason), the runtime'));
        console.log(chalk.gray('  retries the same turn on the next tier up. Auxiliary calls always pin to the'));
        console.log(chalk.gray('  lowest tier; pro-tier marker is a no-op.'));
        console.log(chalk.gray('  Toggle with: /tier flash | /tier standard | /tier pro | /tier auto\n'));
        return true;
      }
      if (arg === 'auto' || arg === 'off') {
        writePreferences(agent.workspaceRoot, { tier: null });
        console.log(chalk.green('\n✓ Tier pin removed. Self-escalation re-enabled.\n'));
        return true;
      }
      if (arg !== 'flash' && arg !== 'standard' && arg !== 'pro') {
        console.log(chalk.red(`\nUnknown tier "${arg}". Choose: flash | standard | pro | auto\n`));
        return true;
      }
      const newModel = ladder.ladder[arg as 'flash' | 'standard' | 'pro'];
      writePreferences(agent.workspaceRoot, { tier: arg as 'flash' | 'standard' | 'pro' });
      agent.setModel?.(newModel);
      console.log(chalk.green(`\n✓ Tier pinned to ${arg} (model → ${newModel}).\n`));
      return true;
    }
    case '/quiet':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const next = arg ? (arg === 'on' || arg === 'true' || arg === '1') : !prefs.quiet;
      writePreferences(agent.workspaceRoot, { quiet: next });
      // `--quiet` set a one-shot knob override at startup; once the user
      // explicitly toggles in-session their choice wins from now on.
      setCliKnobOverride({ quiet: next });
      const detail = next
        ? 'recall tables, briefing dumps, and tool-completion previews are now hidden.'
        : 'full chrome restored — recall tables, previews, and briefings will print again.';
      console.log(chalk.green(`\n✓ Quiet mode ${next ? 'enabled' : 'disabled'}: ${detail}\n`));
      return true;
    }
    case '/experimental':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const next = arg ? (arg === 'on' || arg === 'true' || arg === '1') : !prefs.experimental;
      writePreferences(agent.workspaceRoot, { experimental: next });
      console.log(chalk.green(`\n✓ Experimental features ${next ? 'enabled' : 'disabled'}.`));
      if (next) console.log(chalk.gray('  Streaming output, theme rendering, and other gated features are now active.\n'));
      else console.log();
      return true;
    }
    case '/keymap':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args.join(' ').trim();
      if (!arg) {
        console.log(chalk.bold('\nKeymap'));
        console.log(chalk.gray('  Current overrides:'));
        console.log(chalk.gray(`    ${prefs.keymap || '(none — defaults)'}`));
        console.log(chalk.bold('\n  Built-in bindings'));
        console.log(chalk.gray('    Shift+Tab       cycle access mode (read → write → shell)'));
        console.log(chalk.gray('    Tab             autocomplete slash commands and @mentions'));
        console.log(chalk.gray('    Ctrl+C          interrupt current turn / exit'));
        console.log(chalk.gray('    /vim            toggle vi-mode for the composer'));
        console.log(chalk.gray('\n  Set custom overrides (JSON map): /keymap {"submit":"ctrl+s"}\n'));
        return true;
      }
      try {
        JSON.parse(arg); // validate
      } catch (err: any) {
        console.log(chalk.red(`\nInvalid JSON: ${err.message}\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { keymap: arg });
      console.log(chalk.green(`\n✓ Keymap overrides saved. Restart the CLI to apply.\n`));
      return true;
    }
  }
  return false;
}
