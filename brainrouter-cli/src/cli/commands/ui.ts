/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { spinner as makeSpinner } from '../spinner.js';
import { LOCAL_TOOLS } from '../../agent/agent.js';
import { callMcpTool, hasMcpTool } from '../../runtime/mcpUtils.js';
import { listSessions, reconcileStale } from '../../orchestration/orchestrator.js';
import { readPreferences, resolveEffort, writePreferences, type EffortLevel } from '../../state/preferencesStore.js';
import { readPlan } from '../../state/taskStore.js';
// initAgentMd usage moved to commands/init.ts (0.3.7 wizard). The
// legacy /config + /init switch cases here are gone — the dispatcher
// in repl.ts routes them to the new handlers first. getConfigPath
// stays in scope because /doctor still surfaces the path.
import { getConfigPath, saveConfig, setCliKnobOverride } from '../../config/config.js';
import { copyToClipboard } from '../../runtime/clipboard.js';
import type { CommandContext } from './_context.js';
import { completeWorkspacePath, renderHelp } from '../repl.js';
import { PROVIDER_CATALOG, findProvider } from '../wizard/providers.js';
import { loadApiKeyPrefixesConfig } from '../../runtime/configLoader.js';
import { selectModel } from '../wizard/modelsApi.js';
import { buildTheme } from '../theme.js';
import { listFilesystemSkills } from '../../prompt/skillCatalog.js';


export async function tryHandleUiCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/status':
    {
      console.log(chalk.bold('\n🖥️  BrainRouter Status:'));
      const activeServerName = config.activeServer;
      const server = config.servers[activeServerName];
      console.log(`  Active Server: ${chalk.green(activeServerName)} (Type: ${chalk.cyan(server.type)})`);
      if (server.type === 'http') {
        console.log(`  Endpoint URL:  ${chalk.blue(server.url)}`);
      } else {
        console.log(`  Command:       ${chalk.blue(server.command)} ${server.args?.join(' ') || ''}`);
      }

      const llm = config.llm;
      if (llm) {
        // Show the model's max prompt-context window inline so users
        // can tell whether they're 5% or 95% through it. Source +
        // override path live in runtime/contextWindow.ts. Unknown
        // models render "?" rather than a guess.
        const { formatContextWindow } = await import('../../runtime/contextWindow.js');
        const ctxLabel = formatContextWindow(llm.model);
        console.log(`  LLM Provider:  ${chalk.green(llm.provider)}`);
        console.log(`  LLM Model:     ${chalk.cyan(llm.model)}${ctxLabel !== '?' ? chalk.gray(` (${ctxLabel} ctx)`) : ''}`);
        if (llm.endpoint) {
          console.log(`  LLM Endpoint:  ${chalk.blue(llm.endpoint)}`);
        }

        // LM Studio enrichment: when we have a native /api/v1/models
        // entry for the active model, surface signals the shipped JSON
        // doesn't carry — currently-loaded? trained for tool use?
        // reasoning modes? format + quantisation. This is the "is my
        // model actually appropriate for the agent loop?" check.
        const { lookupLmStudioModel } = await import('../../runtime/lmStudioApi.js');
        const lm = lookupLmStudioModel(llm.model);
        if (lm) {
          const loadedBadge = lm.loaded ? chalk.green('● loaded') : chalk.gray('○ not loaded');
          console.log(`  LM Studio:     ${loadedBadge}${lm.paramsString ? chalk.gray(`  ·  ${lm.paramsString}`) : ''}${lm.quantisation ? chalk.gray(`  ·  ${lm.quantisation}`) : ''}${lm.format ? chalk.gray(`  ·  ${lm.format}`) : ''}`);
          if (lm.trainedForToolUse === false) {
            console.log(chalk.yellow(`  ⚠️  LM Studio reports this model as NOT trained for tool use — the agent loop may fail on tool_call output. Consider a model packaged with tool-use training.`));
          }
          if (lm.reasoning && lm.reasoning.allowedOptions.length > 0 && !lm.reasoning.allowedOptions.includes('off')) {
            console.log(chalk.gray(`  Reasoning: forced ${lm.reasoning.allowedOptions.join(' | ')} (default ${lm.reasoning.defaultOption ?? '—'}). /effort flag is a no-op upstream.`));
          }
        }
      }

      const spinner = makeSpinner(chalk.gray('Querying diagnostics & testing latency...')).start();
      try {
        const start = Date.now();
        const testRes = await mcpClient.callTool('list_skills', { scope: 'local' });
        const latency = Date.now() - start;
        spinner.succeed(chalk.green(`Latency check: ${latency}ms`));

        // Diagnostics / memory stats.
        //
        // Field names align with brain-side `getMemoryStats()` in
        // `brainrouter/src/memory/store/sqlite.ts`. Earlier this code
        // read `stats.totalCount` and `stats.typeCounts` — fields the
        // brain never emits — so every /status panel printed 0 even
        // when cognitive_records had hundreds of rows. The brain emits
        // `total`, `byType`, `sensoryTotal`, etc.; we read those names
        // verbatim now. Bug surfaced 2026-05-27.
        const diag = await callMcpTool<any>(mcpClient, 'memory_diagnostics', {});
        if (!diag.isError && diag.parsed) {
          const stats = diag.parsed.databaseStats?.userStats;
          if (stats) {
            const cognitiveTotal = stats.total ?? 0;
            const byType = stats.byType ?? {};
            const sensoryTotal = stats.sensoryTotal ?? 0;
            const sensoryUnextracted = stats.sensoryUnextracted ?? 0;
            const focusSceneTotal = stats.focusSceneTotal ?? 0;
            const extraction = stats.extraction ?? {};

            console.log(chalk.bold('\n📊 Cognitive Memory Database Stats:'));
            console.log(`  Cognitive Records:    ${chalk.yellow(cognitiveTotal.toLocaleString())}`);
            console.log(`    - Instructions:     ${chalk.gray((byType.instruction ?? 0).toLocaleString())}`);
            console.log(`    - Codebase Facts:   ${chalk.gray((byType.codebase_fact ?? 0).toLocaleString())}`);
            console.log(`    - Architectures:    ${chalk.gray((byType.architecture_decision ?? 0).toLocaleString())}`);
            const otherTypes = Object.entries(byType).filter(([k]) => !['instruction', 'codebase_fact', 'architecture_decision'].includes(k));
            for (const [type, count] of otherTypes) {
              console.log(`    - ${type.padEnd(18)}${chalk.gray((count as number).toLocaleString())}`);
            }
            // Sensory tells the "is capture firing at all?" story. When
            // cognitive is 0 but sensory > 0, extraction is the bottleneck
            // (threshold not reached OR the LLM extraction call is failing).
            console.log(`  Sensory Stream:       ${chalk.yellow(sensoryTotal.toLocaleString())}${sensoryUnextracted > 0 ? chalk.gray(`  (${sensoryUnextracted.toLocaleString()} awaiting extraction)`) : ''}`);
            console.log(`  Focus Scenes:         ${chalk.yellow(focusSceneTotal.toLocaleString())}`);
            if (stats.lastRecallAt) {
              console.log(`  Last Captured:        ${chalk.gray(stats.lastRecallAt)}`);
            }
            // Surface extraction health. `syncPaused` fires when 5+
            // consecutive failures occurred — usually the local LM is
            // OOM, the API key is missing, or the model returns non-JSON.
            if (extraction.syncPaused) {
              console.log(chalk.red(`  ⚠️  Extraction PAUSED after ${extraction.extractionErrors} consecutive failures.`));
              if (extraction.lastErrorMessage) {
                console.log(chalk.gray(`     Last error: ${String(extraction.lastErrorMessage).slice(0, 200)}`));
              }
              console.log(chalk.gray(`     Fix the upstream LLM (model loaded / API key set), then run /memories consolidate to backfill.`));
            } else if (extraction.extractionErrors > 0) {
              console.log(chalk.yellow(`  ⚠️  ${extraction.extractionErrors} recent extraction failure(s). Last: ${extraction.lastErrorAt ?? '(unknown)'}.`));
              if (extraction.lastErrorMessage) {
                console.log(chalk.gray(`     ${String(extraction.lastErrorMessage).slice(0, 200)}`));
              }
            } else if (cognitiveTotal === 0 && sensoryTotal > 0) {
              console.log(chalk.gray(`  (Cognitive extraction fires every 3 sensory turns — keep talking to populate.)`));
            } else if (cognitiveTotal === 0 && sensoryTotal === 0) {
              console.log(chalk.gray(`  (No captures yet for this user. Run a turn to start populating memory.)`));
            }
          }
        }
      } catch (err: any) {
        spinner.fail(chalk.red('Failed to fetch diagnostics.'));
        console.warn(chalk.yellow(`  Warning: ${err.message}`));
      }
      console.log();
      return true;
    }
    case '/workspace':
    {
      console.log(chalk.bold('\nWorkspace:'));
      console.log(`  Root:       ${chalk.blue(agent.workspaceRoot)}`);
      console.log(`  Launch CWD: ${chalk.gray(agent.launchCwd)}`);
      console.log(`  Session:    ${chalk.green(agent.sessionKey)}`);
      console.log();
      return true;
    }
    // /config now lives in commands/config.ts (0.3.7 settings home panel
    // + verb-overloaded get/set). The dispatcher in repl.ts routes it
    // before this case, so leaving anything here is dead — removed.
    // Use `/config raw` if you want the old scrubbed-JSON dump.
    case '/doctor':
    {
      console.log(chalk.bold('\nBrainRouter Doctor:'));
      console.log(`  Config file: ${chalk.blue(getConfigPath())}`);
      console.log(`  Active profile: ${chalk.green(config.activeServer)}`);

      const server = config.servers[config.activeServer];
      if (!server) {
        console.log(chalk.red('  Server profile: missing'));
        return true;
      }

      console.log(`  Server profile: ${chalk.green(server.type)}`);
      if (server.type === 'stdio') {
        console.log(`  Launch command: ${chalk.blue(server.command)} ${server.args?.join(' ') || ''}`);
      } else {
        console.log(`  Endpoint: ${chalk.blue(server.url)}`);
      }

      const spinner = makeSpinner(chalk.gray('Checking MCP tool surface...')).start();
      try {
        const startedAt = Date.now();
        const res = await mcpClient.listTools();
        const latency = Date.now() - startedAt;
        spinner.succeed(chalk.green(`MCP connection healthy (${latency}ms)`));
        console.log(`  MCP tools: ${chalk.yellow(res.tools?.length ?? 0)}`);
        const toolNames = new Set((res.tools || []).map((tool: any) => tool.name));
        const memoryTools = ['memory_recall', 'memory_capture_turn', 'memory_working_offload'];
        for (const name of memoryTools) {
          const hasTool = hasMcpTool(toolNames, name);
          console.log(`  ${name}: ${hasTool ? chalk.green('available') : chalk.yellow('not exposed')}`);
        }
      } catch (err: any) {
        spinner.fail(chalk.red('MCP connection check failed.'));
        console.warn(chalk.yellow(`  Warning: ${err.message}`));
      }

      // Memory health: are captures actually being extracted into searchable
      // cognitive records, or are they piling up in sensory_stream? This is
      // the silent failure mode that makes briefings return "0 records" — the
      // CLI shows 💾 Captured after every turn but the LLM the extractor
      // needs may not be configured in the MCP child env.
      try {
        const diagRes = await callMcpTool<any>(mcpClient, 'memory_diagnostics', {});
        const ext = diagRes.parsed?.databaseStats?.userStats?.extraction;
        if (ext) {
          const errs = ext.extractionErrors ?? 0;
          const pending = ext.unextractedCount ?? 0;
          const total = diagRes.parsed?.databaseStats?.userStats?.total ?? 0;
          const headline = errs > 0
            ? chalk.red(`  Memory extraction: DEGRADED — ${errs} consecutive failures`)
            : pending > 5
              ? chalk.yellow(`  Memory extraction: backlog of ${pending} sensory rows pending`)
              : chalk.green(`  Memory extraction: healthy (${total} cognitive records, ${pending} pending)`);
          console.log(headline);
          if (ext.lastErrorMessage) {
            console.log(chalk.gray(`    Last error: ${String(ext.lastErrorMessage).slice(0, 160)}`));
          }
          if (errs > 0 || !diagRes.parsed?.envKeys?.some?.((k: string) => /BRAINROUTER_LLM_API_KEY|OPENAI_API_KEY/.test(k))) {
            console.log(chalk.gray('    Hint: set OPENAI_API_KEY (or BRAINROUTER_LLM_API_KEY) before launching brainrouter so the MCP child can run extraction.'));
          }
        }
      } catch (err: any) {
        console.log(chalk.yellow(`  Memory extraction: unable to query (${err?.message ?? err})`));
      }

      const plan = readPlan(agent.workspaceRoot, agent.sessionKey);
      console.log(`  Plan items: ${chalk.yellow(plan.items.length)} (updated: ${chalk.gray(plan.updatedAt || 'never')})`);
      const reconciled = reconcileStale(agent.workspaceRoot);
      if (reconciled > 0) console.log(`  Reconciled ${chalk.yellow(reconciled)} stale child session(s).`);
      const childSessions = listSessions(agent.workspaceRoot);
      console.log(`  Child sessions: ${chalk.yellow(childSessions.length)} total`);
      const orchestrationTools = ['task_agent', 'delegate_agent', 'list_agents', 'wait_agent', 'read_agent_transcript', 'close_agent', 'update_plan'];
      for (const tn of orchestrationTools) {
        const has = LOCAL_TOOLS.some((lt: any) => lt.name === tn);
        console.log(`  ${tn}: ${has ? chalk.green('available') : chalk.red('missing')}`);
      }
      console.log();
      return true;
    }
    // /init is now the onboarding-wizard entrypoint (commands/init.ts).
    // The AGENT.md-only path lives behind `/init agentmd` for back-compat.
    // Routed before this case in repl.ts; no fall-through handler needed.
    case '/model':
    {
      const newModel = args[0];
      const previous = agent.getModel();
      // Direct-switch form `/model <name>` stays for scripts and muscle
      // memory. No-arg opens the picker (0.3.7).
      if (newModel) {
        agent.setModel(newModel);
        if (config.llm) {
          config.llm.model = newModel;
          saveConfig(config);
        }
        console.log(chalk.green(`\n✓ Model switched: ${chalk.gray(previous)} → ${chalk.cyan(newModel)}\n`));
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
      if (config.llm) {
        config.llm.model = result.model;
        saveConfig(config);
      }
      const sourceTag =
        result.source === 'live' ? `live · ${result.liveCount} models` :
        result.source === 'fallback' ? `offline · static catalog (${result.liveError ?? 'unknown'})` :
        'static catalog';
      console.log(chalk.green(`\n✓ Model switched: ${chalk.gray(previous)} → ${chalk.cyan(result.model)}`));
      console.log(chalk.gray(`  Source: ${sourceTag}\n`));
      return true;
    }
    // /mcp moved to its own command file (commands/mcp.ts) as part of 0.3.6
    // Item 11. The new dispatcher supports `/mcp list`, `/mcp reconnect`,
    // and the original no-arg "show tools by namespace" behaviour is now
    // covered by `/mcp tools` (handled in commands/mcp.ts).
    case '/copy':
    {
      if (!agent.lastAnswer) {
        console.log(chalk.yellow('\nNo response yet to copy.\n'));
        return true;
      }
      const result = await copyToClipboard(agent.lastAnswer);
      if (result.ok) {
        console.log(chalk.green(`\n✓ Copied last response to clipboard via ${result.tool} (${agent.lastAnswer.length} chars).\n`));
      } else {
        console.log(chalk.yellow(`\nClipboard tool unavailable (${result.error}). Selecting the text above with your terminal still works.\n`));
      }
      return true;
    }
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
      const { SEGMENT_NAMES, isKnownSegment } = await import('../statusline.js');
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
            else if (seg === 'session') parts.push(agent.sessionKey.slice(0, 24));
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
      const arg = (args[0] ?? '').toLowerCase();
      const valid: ReadonlyArray<EffortLevel> = ['low', 'medium', 'high'];
      if (!arg) {
        const resolved = resolveEffort(agent.workspaceRoot);
        const sourceTag =
          resolved.source === 'config' ? chalk.gray(' (cli.effort in config.json)') :
          resolved.source === 'preference' ? chalk.gray(' (preference)') :
          chalk.gray(' (default)');
        console.log(chalk.bold(`\nReasoning depth: ${chalk.cyan(resolved.effort)}${sourceTag}`));
        console.log(chalk.gray('  low     — terse, one-paragraph answers; minimal ceremony.'));
        console.log(chalk.gray('  medium  — current default; no overlay, no provider reasoning slot. (default)'));
        console.log(chalk.gray('  high    — step-by-step reasoning; audits evidence before each tool call.'));
        console.log(chalk.gray('  When the model supports it (gpt-5, o-series, gpt-oss, DeepSeek R1/V3+, Qwen3,'));
        console.log(chalk.gray('  Magistral, *-reasoning, *-thinking — works on OpenAI, DeepSeek, OpenRouter,'));
        console.log(chalk.gray('  LM Studio 0.3.29+, Ollama), the level is also forwarded as `reasoning_effort`.'));
        console.log(chalk.gray('  Toggle with: /effort low | /effort medium | /effort high'));
        console.log(chalk.gray('  Permanent override: set `cli.effort` in ~/.config/brainrouter/config.json.\n'));
        return true;
      }
      if (!valid.includes(arg as EffortLevel)) {
        console.log(chalk.red(`\nUnknown level "${arg}". Choose: ${valid.join(' | ')}\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { effort: arg as EffortLevel });
      agent.refreshSystemPrompt();
      const after = resolveEffort(agent.workspaceRoot);
      // Surface a friendly nudge when `cli.effort` in `config.json` is still
      // explicitly set and would shadow the workspace preference next boot.
      if (after.source === 'config' && after.effort !== arg) {
        console.log(chalk.yellow(`\n✓ Preference saved as ${arg}, but cli.effort=${after.effort} in config.json still wins this process.\n`));
      } else {
        console.log(chalk.green(`\n✓ Reasoning depth → ${arg}. Applies on the next turn.\n`));
      }
      return true;
    }
    case '/tier':
    {
      const { resolveTierLadder, currentTier } = await import('../../runtime/tierLadder.js');
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
    case '/apps':
    case '/plugins':
    {
      const skillsRoot = path.join(agent.workspaceRoot, 'skills');
      const pluginsRoot = path.join(agent.workspaceRoot, 'plugins');
      console.log(chalk.bold(`\n${command === '/apps' ? 'Apps' : 'Plugins'}`));
      const roots = [skillsRoot, pluginsRoot].filter((p) => fs.existsSync(p));
      if (roots.length === 0) {
        console.log(chalk.yellow('  No skills/ or plugins/ directory in this workspace.'));
        console.log(chalk.gray('  Drop a folder under skills/<category>/<name>/SKILL.md to register one.\n'));
        return true;
      }
      const skills = listFilesystemSkills(agent.workspaceRoot);
      if (skills.length > 0) {
        console.log(chalk.gray('  Skills'));
        for (const skill of skills) {
          const category = skill.category ? `${skill.category}/` : '';
          console.log(`  • ${chalk.cyan(`${category}${skill.name}`)} (${chalk.gray(skill.scope ?? 'filesystem')})`);
        }
      }
      if (fs.existsSync(pluginsRoot)) {
        const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
        const pluginDirs = entries.filter((entry) => entry.isDirectory());
        if (pluginDirs.length > 0) {
          console.log(chalk.gray('  Plugin folders'));
          for (const entry of pluginDirs) {
            console.log(`  • ${chalk.cyan(path.relative(agent.workspaceRoot, path.join(pluginsRoot, entry.name)))}`);
          }
        }
      }
      console.log();
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
    case '/mention':
    {
      const partial = args.join(' ').trim();
      console.log(chalk.bold('\nFile mention helper'));
      console.log(chalk.gray('  Inline syntax: write `@path/to/file` in a prompt — the CLI expands it before sending.'));
      const ws = agent.workspaceRoot;
      const suggestions = completeWorkspacePath(ws, partial || '');
      if (suggestions.length === 0) {
        console.log(chalk.yellow('  No files matched.\n'));
        return true;
      }
      console.log(chalk.gray(`  Workspace matches${partial ? ` for "${partial}"` : ''}:`));
      for (const s of suggestions.slice(0, 20)) console.log(`    ${chalk.cyan('@' + s)}`);
      if (suggestions.length > 20) console.log(chalk.gray(`    …and ${suggestions.length - 20} more`));
      console.log();
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
    case '/ide':
    {
      const env = process.env;
      console.log(chalk.bold('\nIDE context'));
      const cursor = env.CURSOR_TRACE_ID ? 'Cursor' : null;
      const code = env.VSCODE_INJECTION || env.VSCODE_PID ? 'VS Code' : null;
      const jet = env.JETBRAINS_IDE || env.IDEA_INITIAL_DIRECTORY ? 'JetBrains' : null;
      const detected = [cursor, code, jet].filter(Boolean);
      console.log(`  Detected: ${detected.length > 0 ? chalk.cyan(detected.join(', ')) : chalk.gray('(none — running standalone)')}`);
      console.log(chalk.gray('  Brainrouter reads files via the workspace root; if your IDE has an open selection, paste it with @ mentions or copy/paste.'));
      console.log(chalk.gray('  Tip: configure IDE to launch brainrouter with -w <workspace> so paths match.\n'));
      return true;
    }
    case '/where':
    {
      const { gatherWhereInputs, renderWhere } = await import('../whereView.js');
      const { resolveDisplayedMcpState } = await import('../banner.js');
      const { resolveTheme } = await import('../theme.js');
      const theme = resolveTheme(agent.workspaceRoot);
      const displayedMcp = resolveDisplayedMcpState(config, mcpClient as any);
      const briefing = agent.getLastBriefing();
      const inputs = gatherWhereInputs({
        workspaceRoot: agent.workspaceRoot,
        sessionKey: agent.sessionKey,
        model: agent.getModel(),
        mcpProfile: displayedMcp.profile,
        mcpTransport: displayedMcp.transport,
        mcpOnline: displayedMcp.online,
        mcpIdentity: displayedMcp.identity,
        accessMode: agent.getAccessMode(),
        recalledRecords: agent.getRecalledRecords(),
        briefingSources: briefing.sources,
        briefingSourceStats: briefing.sourceStats,
      });
      console.log('\n' + renderWhere(inputs, theme) + '\n');
      return true;
    }
    case '/help': {
      renderHelp(args[0]?.toLowerCase());
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
