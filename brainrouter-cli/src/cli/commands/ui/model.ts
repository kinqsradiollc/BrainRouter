/**
 * Extracted from cli/commands/ui.ts — the `/model` quick-swap subcommand
 * plus its foreign-model heuristic. Behavior-preserving: bodies moved
 * verbatim.
 */

import chalk from 'chalk';
import { readPreferences } from '@kinqs/brainrouter-core/session';
import { saveConfig } from '@kinqs/brainrouter-core/config';
import { setSessionRuntime } from '@kinqs/brainrouter-core/session';
import { PROVIDER_CATALOG, findProvider } from '@kinqs/brainrouter-core/provider';
import { loadApiKeyPrefixesConfig } from '@kinqs/brainrouter-core/config';
import { selectModel } from '../../wizard/modelsApi.js';
import { buildTheme } from '../../theme.js';
import type { CommandContext } from '../_context.js';

export async function tryHandleUiModelCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
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
