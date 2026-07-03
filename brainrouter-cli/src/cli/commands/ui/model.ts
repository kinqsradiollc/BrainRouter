/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 *
 * Model / reasoning-depth / tier UI commands split out of ui/index.ts:
 *   /model /effort /tier
 */

import chalk from 'chalk';
import { saveConfig } from '@kinqs/brainrouter-core/config';
import { readPreferences, resolveEffort, writePreferences, normalizeEffort, getSessionMode, resolveActiveMode, setSessionMode, setSessionRuntime } from '@kinqs/brainrouter-core/session';
import { PROVIDER_CATALOG, findProvider } from '@kinqs/brainrouter-core/provider';
import { loadApiKeyPrefixesConfig } from '@kinqs/brainrouter-core/config';
import { selectModel } from '../../wizard/modelsApi.js';
import { buildTheme } from '../../theme/theme.js';
import type { CommandContext } from '../_context.js';

export async function tryHandleUiModelCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, config } = ctx;
  switch (command) {
    case '/model':
    {
      // PARITY-E2 — `--session` (alias `--once`) switches for THIS session
      // only: update the live agent without persisting to config.json.
      const sessionOnly = args.includes('--session') || args.includes('--once');
      const newModel = args.find((a) => !a.startsWith('--'));
      const previous = agent.getModel();
      // Direct-switch form `/model <name>` stays for scripts and muscle
      // memory. No-arg opens the picker (0.3.7).
      if (newModel) {
        agent.setModel(newModel);
        if (sessionOnly) {
          setSessionRuntime(agent.workspaceRoot, agent.sessionKey, { model: newModel });
        } else if (config.llm) {
          config.llm.model = newModel;
          saveConfig(config);
          setSessionRuntime(agent.workspaceRoot, agent.sessionKey, { model: '' });
        }
        const scope = sessionOnly ? chalk.gray(' (this session only — not saved)') : '';
        console.log(chalk.green(`\n✓ Model switched: ${chalk.gray(previous)} → ${chalk.cyan(newModel)}${scope}\n`));
        return true;
      }
      // No-arg → open the picker. Resolves provider by reading the
      // stored llm.provider id first; falls back to endpoint matching
      // for old configs, then to the OpenAI entry as last resort.
      const themeMode = readPreferences(agent.workspaceRoot).theme;
      const theme = buildTheme(themeMode === 'mono' ? 'mono' : themeMode === 'light' ? 'light' : 'dark');
      const llm = config.llm;
      const provider =
        (llm?.provider && findProvider(llm.provider)) ||
        (llm?.endpoint && PROVIDER_CATALOG.find((p) => p.endpoint.replace(/\/$/, '') === (llm.endpoint ?? '').replace(/\/$/, ''))) ||
        findProvider('openai')!;
      const result = await selectModel({
        theme,
        provider,
        apiKey: llm?.apiKey ?? '',
        endpointOverride: llm?.endpoint,
        currentModel: previous,
        title: '/model — quick-swap',
        badge: provider.label,
      });
      if (!result) {
        console.log(chalk.yellow('\n  /model cancelled.\n'));
        return true;
      }
      if (result.model === previous) {
        console.log(chalk.gray(`\n  Model unchanged (${previous}).\n`));
        return true;
      }
      // Cross-provider sanity check — if the picked model looks like
      // a different vendor's namespace (anthropic/*, google/*, etc.)
      // and the active provider isn't a multi-vendor gateway, warn so
      // the user doesn't hit a confusing 404 on the next turn.
      if (looksLikeForeignModel(result.model, { id: provider.id, endpoint: llm?.endpoint ?? provider.endpoint })) {
        console.log(chalk.yellow(
          `\n  ⚠ "${result.model}" looks like a different provider's namespace. ` +
          `Active endpoint: ${provider.label}.` +
          `\n    Run /config provider <id> to switch endpoints, or /model again to pick a native model.\n`
        ));
      }
      agent.setModel(result.model);
      if (sessionOnly) {
        setSessionRuntime(agent.workspaceRoot, agent.sessionKey, { model: result.model });
      } else if (config.llm) {
        config.llm.model = result.model;
        saveConfig(config);
        setSessionRuntime(agent.workspaceRoot, agent.sessionKey, { model: '' });
      }
      const sourceTag =
        result.source === 'live' ? `live · ${result.liveCount} models` :
        result.source === 'fallback' ? `offline · static catalog (${result.liveError ?? 'unknown'})` :
        'static catalog';
      console.log(chalk.green(`\n✓ Model switched: ${chalk.gray(previous)} → ${chalk.cyan(result.model)}`));
      if (sessionOnly) console.log(chalk.gray('  Scope: this session only — not saved to config.json.'));
      console.log(chalk.gray(`  Source: ${sourceTag}\n`));
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
  }
  return false;
}

/**
 * Heuristic — does the picked model id look like it belongs to a
 * different vendor than the active OpenAI endpoint? Catches the
 * common foot-gun of picking `anthropic/claude-*` while pointed at
 * api.openai.com, where the request 404s at the endpoint and the user
 * has no obvious "you needed to switch endpoints" signal.
 *
 * Only applies when the endpoint is api.openai.com itself — once the
 * user has overridden the base URL (OpenRouter, Together, vLLM, …)
 * multi-vendor namespaces are expected and the guard would false-fire.
 */
function looksLikeForeignModel(model: string, provider: { id: string; endpoint?: string }): boolean {
  if (provider.id !== 'openai') return false;
  // Custom OpenAI-compatible endpoints (OpenRouter etc.) are vendor-agnostic.
  if (provider.endpoint && !/^https?:\/\/api\.openai\.com\b/.test(provider.endpoint)) return false;
  // Foreign-model prefixes now live in config/api-key-prefixes.json so users
  // can update the list when a new gateway vendor namespace shows up.
  const prefixes = loadApiKeyPrefixesConfig().foreignModelPrefixes.map((e) => e.prefix);
  return prefixes.some((prefix) => model.startsWith(prefix));
}
