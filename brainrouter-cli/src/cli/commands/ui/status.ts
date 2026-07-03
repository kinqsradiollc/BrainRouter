/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 *
 * Status / diagnostics / context UI commands split out of ui/index.ts:
 *   /status /workspace /policy /doctor /where
 */

import chalk from 'chalk';
import { spinner as makeSpinner } from '../../prompt/spinner.js';
import { LOCAL_TOOLS } from '@kinqs/brainrouter-core/agent';
import { callMcpTool, hasMcpTool } from '@kinqs/brainrouter-core/mcp';
import { listSessions, reconcileStale } from '@kinqs/brainrouter-core/orchestration';
import { readPlan } from '@kinqs/brainrouter-core/task';
import { getConfigPath, getCliKnobs, setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import { getPolicyProfile, profileNames } from '../../../runtime/exec/policyProfiles.js';
import { describeActiveServer } from '../serverStatus/index.js';
import type { CommandContext } from '../_context.js';

export async function tryHandleUiStatusCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config } = ctx;
  switch (command) {
    case '/status':
    {
      console.log(chalk.bold('\n🖥️  BrainRouter Status:'));
      for (const line of describeActiveServer(config)) console.log(line);

      const llm = config.llm;
      if (llm) {
        // Show the model's max prompt-context window inline so users
        // can tell whether they're 5% or 95% through it. Source +
        // override path live in runtime/contextWindow.ts. Unknown
        // models render "?" rather than a guess.
        const { formatContextWindow } = await import('@kinqs/brainrouter-core/context');
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
        const { lookupLmStudioModel } = await import('@kinqs/brainrouter-core/provider');
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
    case '/policy':
    {
      const knobs = getCliKnobs();
      const requested = (args[0] ?? '').toLowerCase().trim();
      if (!requested) {
        console.log(chalk.bold('\n🛡️  Policy:'));
        console.log(`  Access mode:      ${chalk.cyan(agent.getAccessMode())}`);
        console.log(`  Sandbox:          ${chalk.cyan(knobs.sandbox)}`);
        console.log(`  External writes:  ${chalk.cyan(knobs.externalDirWrites)}`);
        console.log(`  Egress allowlist: ${knobs.egressAllowlist.length ? chalk.cyan(knobs.egressAllowlist.join(', ')) : chalk.gray('(unrestricted)')}`);
        console.log(chalk.gray(`\n  Profiles (apply with \`/policy <name>\`):`));
        for (const n of profileNames()) {
          console.log(`    ${chalk.bold(n.padEnd(10))} ${chalk.gray(getPolicyProfile(n)!.description)}`);
        }
        console.log(chalk.gray(`\n  Trust model reference: brainrouter-docs/policy.md`));
        console.log();
        return true;
      }
      const profile = getPolicyProfile(requested);
      if (!profile) {
        console.log(chalk.red(`Unknown policy profile "${requested}". Available: ${profileNames().join(', ')}.`));
        return true;
      }
      agent.setAccessMode(profile.accessMode);
      setCliKnobOverride({ sandbox: profile.sandbox, externalDirWrites: profile.externalDirWrites, egressAllowlist: profile.egressAllowlist });
      agent.refreshSystemPrompt?.();
      console.log(chalk.green(`\n🛡️  Applied policy "${requested}": access=${profile.accessMode}, sandbox=${profile.sandbox}, externalWrites=${profile.externalDirWrites}, egress=${profile.egressAllowlist.length ? profile.egressAllowlist.join(',') : 'unrestricted'}.`));
      console.log(chalk.gray(`  ${profile.description}\n`));
      return true;
    }
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
    case '/where':
    {
      const { gatherWhereInputs, renderWhere } = await import('../../view/whereView.js');
      const { resolveDisplayedMcpState } = await import('../../view/banner.js');
      const { resolveTheme } = await import('../../theme/theme.js');
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
      // AUG-A1: surface the active Project (multi-folder scope) if a
      // `.brainrouter/project.json` marker names one.
      const { activeProjectName } = await import('../../../config/project.js');
      const project = activeProjectName(agent.workspaceRoot);
      if (project) {
        console.log(`  Project: ${project}  ${chalk.gray('(recall can widen to this project with scope:project)')}\n`);
      }
      return true;
    }
  }
  return false;
}
