/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 *
 * Model / reasoning-depth / tier / profile UI commands split out of ui/index.ts:
 *   /model /effort /tier /profile
 */

import chalk from 'chalk';
import { saveConfig, getCliKnobs, sanitizeLlmProfiles, type LlmProfileConfig } from '@kinqs/brainrouter-core/config';
import { assertModelAllowed, overlayLlmProfile } from '@kinqs/brainrouter-core/provider';
import { aggregateCatalog, buildModelRegistry, resolveRoutes } from '@kinqs/brainrouter-core/router';
import { readPreferences, resolveEffort, writePreferences, normalizeEffort, getSessionMode, resolveActiveMode, setSessionMode, setSessionRuntime, getSessionRuntime } from '@kinqs/brainrouter-core/session';
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
        // CC-CONFIG-A3 — allowlist gate. Refuse an unlisted model when the
        // install enforces `availableModels`, OR when the session is in Fast
        // mode (Fast trades approvals for speed, so it must not silently swap to
        // an un-sanctioned model). A clear message names the permitted set.
        const knobs = getCliKnobs();
        const inFastMode = resolveActiveMode(agent.workspaceRoot, agent.sessionKey).executionMode === 'fast';
        const routerModelRequest = newModel === 'auto' ? '' : newModel;
        const routerEnabled = knobs.router.enabled;
        const baseName = config.providers?.base ? 'base-config' : 'base';
        const routerRegistry = routerEnabled
          ? buildModelRegistry(
            { ...(config.providers ?? {}), ...(config.llm ? { [baseName]: config.llm } : {}) },
            {
              aliases: knobs.router.aliases,
              chain: [...knobs.router.chain, ...knobs.fallbackModels, ...(config.llm ? [`${baseName}/${config.llm.model}`] : [])],
              order: knobs.router.order,
              strategy: knobs.router.strategy,
              passThrough: knobs.router.passThrough,
              availableModels: knobs.availableModels,
              enforceAvailableModels: knobs.enforceAvailableModels || inFastMode,
            },
          )
          : null;
        // withFallbacks:false — an explicit `/model <name>` must resolve to THAT
        // model. The router places it when it's in the catalog (bare → best
        // provider by order, or provider/model pinned); when it can't (a brand-new
        // or uncached model), we fall through to setting the raw name on the
        // current provider — never silently swap in the primary chain's model.
        const routerRoute = routerRegistry ? resolveRoutes(routerRegistry, routerModelRequest, { withFallbacks: false })[0] : undefined;
        const modelForGate = routerRoute?.model ?? newModel;
        const gate = assertModelAllowed(
          modelForGate,
          knobs.availableModels,
          knobs.enforceAvailableModels || inFastMode,
          inFastMode ? 'Fast mode' : 'This install',
        );
        if (gate) {
          console.log(chalk.red(`\n✗ ${gate}\n`));
          return true;
        }
        if (routerRoute && agent.setLLMConfig) agent.setLLMConfig(routerRoute.llm);
        else agent.setModel(routerRoute?.model ?? newModel);
        if (sessionOnly) {
          setSessionRuntime(agent.workspaceRoot, agent.sessionKey, { model: routerRoute?.model ?? (newModel === 'auto' ? '' : newModel) });
        } else if (config.llm) {
          config.llm = routerRoute ? { ...routerRoute.llm } : { ...config.llm, model: newModel };
          saveConfig(config);
          setSessionRuntime(agent.workspaceRoot, agent.sessionKey, { model: '' });
        }
        const scope = sessionOnly ? chalk.gray(' (this session only — not saved)') : '';
        const label = newModel === 'auto' && routerRoute ? `Auto (${routerRoute.slug})` : (routerRoute?.slug ?? newModel);
        console.log(chalk.green(`\n✓ Model switched: ${chalk.gray(previous)} → ${chalk.cyan(label)}${scope}\n`));
        return true;
      }
      if (getCliKnobs().router.enabled) {
        const knobs = getCliKnobs();
        const baseName = config.providers?.base ? 'base-config' : 'base';
        const registry = buildModelRegistry(
          { ...(config.providers ?? {}), ...(config.llm ? { [baseName]: config.llm } : {}) },
          {
            aliases: knobs.router.aliases,
            chain: [...knobs.router.chain, ...knobs.fallbackModels, ...(config.llm ? [`${baseName}/${config.llm.model}`] : [])],
            order: knobs.router.order,
            strategy: knobs.router.strategy,
            passThrough: knobs.router.passThrough,
            availableModels: knobs.availableModels,
            enforceAvailableModels: knobs.enforceAvailableModels,
          },
        );
        const rows = aggregateCatalog(registry, { prefix: 'canonical' }).slice(0, 80);
        console.log(chalk.bold('\nUnified model catalog'));
        console.log(chalk.gray('  Use /model auto, /model <bare>, or /model <provider/model>.'));
        if (rows.length === 0) {
          console.log(chalk.yellow('  No catalog entries. Connect a provider or configure cli.router.chain.\n'));
          return true;
        }
        for (const item of rows) {
          const provider = item.provider ?? item.providers.join(',');
          console.log(`  ${chalk.cyan(item.id.padEnd(36))} ${chalk.gray(provider)}`);
        }
        const total = aggregateCatalog(registry, { prefix: 'canonical' }).length;
        if (total > rows.length) console.log(chalk.gray(`  ... ${total - rows.length} more`));
        console.log();
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
    case '/profile':
    {
      // MC-D3 — named LLM profiles (cli.llmProfiles): saved model/endpoint/
      // effort presets layered over the base llm config. Subcommands:
      //   list · use <name> · save <name> (snapshot current) · delete <name>
      // With 2+ profiles the agent is also offered the switch_model tool.
      const sub = (args[0] ?? 'list').toLowerCase();
      const nameArg = (args[1] ?? '').trim();
      const profiles = sanitizeLlmProfiles(config.cli?.llmProfiles);
      const names = Object.keys(profiles).sort();
      const sessionProfile = agent.sessionKey
        ? (getSessionRuntime(agent.workspaceRoot, agent.sessionKey).llmProfile ?? '')
        : '';
      const globalActive = typeof config.cli?.activeLlmProfile === 'string' ? config.cli.activeLlmProfile.trim() : '';
      const activeName = (sessionProfile && profiles[sessionProfile]) ? sessionProfile
        : (globalActive && profiles[globalActive]) ? globalActive : '';

      if (sub === 'list' || sub === '') {
        if (names.length === 0) {
          console.log(chalk.bold('\nNo LLM profiles configured.'));
          console.log(chalk.gray('  Save the current model as one:  /profile save <name>'));
          console.log(chalk.gray('  Or edit cli.llmProfiles in ~/.config/brainrouter/config.json.'));
          console.log(chalk.gray('  With 2+ profiles the agent can move itself between them via switch_model.\n'));
          return true;
        }
        console.log(chalk.bold(`\nLLM profiles (${names.length}):`));
        for (const n of names) {
          const p = profiles[n];
          const marker = n === activeName ? chalk.green('● ') : '  ';
          const extras = [
            p.endpoint ? `endpoint=${p.endpoint}` : '',
            p.reasoningEffort ? `effort=${p.reasoningEffort}` : '',
            p.fast ? 'fast' : '',
          ].filter(Boolean).join(' · ');
          console.log(`  ${marker}${chalk.cyan(n.padEnd(16))} ${p.model}${extras ? chalk.gray(`  (${extras})`) : ''}`);
        }
        console.log(chalk.gray(`\n  Active: ${activeName || '(none — base llm config)'}${sessionProfile && profiles[sessionProfile] ? ' (this session)' : ''}`));
        console.log(chalk.gray('  /profile use <name> · save <name> · delete <name>'));
        console.log(chalk.gray(`  Agent switch_model tool: ${names.length >= 2 ? 'offered (2+ profiles)' : 'hidden (needs 2+ profiles)'}\n`));
        return true;
      }

      if (sub === 'use') {
        if (!nameArg) { console.log(chalk.red('\nUsage: /profile use <name>\n')); return true; }
        const profile = profiles[nameArg];
        if (!profile) {
          console.log(chalk.red(`\n✗ Unknown profile "${nameArg}". Configured: ${names.join(', ') || '(none)'}\n`));
          return true;
        }
        // Same allowlist gate as /model — enforced installs and Fast mode
        // must not switch to an unsanctioned model via a profile either.
        const knobs = getCliKnobs();
        const inFastMode = resolveActiveMode(agent.workspaceRoot, agent.sessionKey).executionMode === 'fast';
        const gate = assertModelAllowed(
          profile.model,
          knobs.availableModels,
          knobs.enforceAvailableModels || inFastMode,
          inFastMode ? 'Fast mode' : 'This install',
        );
        if (gate) { console.log(chalk.red(`\n✗ ${gate}\n`)); return true; }
        const previous = agent.getModel();
        const baseLlm = agent.getLlmConfig?.() ?? { provider: 'openai', apiKey: '', ...(config.llm ?? {}), model: previous };
        const next = overlayLlmProfile(baseLlm, profile);
        if (agent.setLLMConfig) agent.setLLMConfig(next);
        else agent.setModel(next.model);
        // Persist: global active pointer; clear stale per-session model/endpoint
        // overrides (mirrors /model's global path) and label the session.
        config.cli = { ...(config.cli ?? {}), activeLlmProfile: nameArg };
        saveConfig(config);
        if (agent.sessionKey) {
          setSessionRuntime(agent.workspaceRoot, agent.sessionKey, { model: '', endpoint: '', llmProfile: nameArg });
          if (profile.reasoningEffort) setSessionMode(agent.workspaceRoot, agent.sessionKey, { effort: profile.reasoningEffort });
          if (profile.fast === true) setSessionMode(agent.workspaceRoot, agent.sessionKey, { executionMode: 'fast' });
        } else if (profile.reasoningEffort) {
          writePreferences(agent.workspaceRoot, { effort: profile.reasoningEffort });
        }
        const applied = [
          `model ${chalk.gray(previous)} → ${chalk.cyan(next.model)}`,
          profile.endpoint ? `endpoint → ${profile.endpoint}` : '',
          profile.reasoningEffort ? `effort → ${profile.reasoningEffort}` : '',
          profile.fast ? 'mode → fast' : '',
        ].filter(Boolean).join(', ');
        console.log(chalk.green(`\n✓ Profile "${nameArg}" active: ${applied}\n`));
        return true;
      }

      if (sub === 'save') {
        if (!nameArg) { console.log(chalk.red('\nUsage: /profile save <name>\n')); return true; }
        const active = resolveActiveMode(agent.workspaceRoot, agent.sessionKey);
        const snapshot: LlmProfileConfig = { model: agent.getModel() };
        const endpoint = agent.getLlmConfig?.()?.endpoint ?? config.llm?.endpoint;
        if (endpoint) snapshot.endpoint = endpoint;
        if (active.effort === 'low' || active.effort === 'medium' || active.effort === 'high' || active.effort === 'xhigh') {
          snapshot.reasoningEffort = active.effort;
        }
        if (active.executionMode === 'fast') snapshot.fast = true;
        const existing = !!profiles[nameArg];
        config.cli = { ...(config.cli ?? {}), llmProfiles: { ...(config.cli?.llmProfiles ?? {}), [nameArg]: snapshot } };
        saveConfig(config);
        const total = Object.keys(sanitizeLlmProfiles(config.cli.llmProfiles)).length;
        console.log(chalk.green(`\n✓ Profile "${nameArg}" ${existing ? 'updated' : 'saved'} (model=${snapshot.model}${snapshot.endpoint ? `, endpoint=${snapshot.endpoint}` : ''}${snapshot.reasoningEffort ? `, effort=${snapshot.reasoningEffort}` : ''}${snapshot.fast ? ', fast' : ''}).`));
        console.log(chalk.gray(`  ${total >= 2 ? 'The agent can now switch profiles itself via switch_model.' : 'Save a second profile to offer the agent the switch_model tool.'}\n`));
        return true;
      }

      if (sub === 'delete' || sub === 'remove' || sub === 'rm') {
        if (!nameArg) { console.log(chalk.red('\nUsage: /profile delete <name>\n')); return true; }
        if (!profiles[nameArg] && !(config.cli?.llmProfiles && nameArg in config.cli.llmProfiles)) {
          console.log(chalk.red(`\n✗ Unknown profile "${nameArg}". Configured: ${names.join(', ') || '(none)'}\n`));
          return true;
        }
        const remaining = { ...(config.cli?.llmProfiles ?? {}) };
        delete remaining[nameArg];
        config.cli = { ...(config.cli ?? {}), llmProfiles: remaining };
        // Don't leave a dangling active pointer at a deleted profile.
        if ((config.cli.activeLlmProfile ?? '').trim() === nameArg) config.cli.activeLlmProfile = '';
        saveConfig(config);
        if (agent.sessionKey && getSessionRuntime(agent.workspaceRoot, agent.sessionKey).llmProfile === nameArg) {
          setSessionRuntime(agent.workspaceRoot, agent.sessionKey, { llmProfile: '' });
        }
        console.log(chalk.green(`\n✓ Profile "${nameArg}" deleted. ${Object.keys(sanitizeLlmProfiles(remaining)).length} remaining.\n`));
        return true;
      }

      console.log(chalk.red(`\nUnknown subcommand "${sub}". Usage: /profile [list|use <name>|save <name>|delete <name>]\n`));
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
