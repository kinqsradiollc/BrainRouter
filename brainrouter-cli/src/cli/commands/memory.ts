/**
 * Memory-related slash commands. All cases here are leaf operations against
 * the MCP memory tools (search, recall, briefing inspection, scenes,
 * forget, handover, explain, trace, failed, verify, audit, export, import,
 * persona, skill-hints, diagnostics, working canvas) plus the pipeline
 * toggle / consolidation operation.
 *
 * They mostly delegate to printMcpCall / printMemoryCards and write nothing
 * back to the workspace except /export (which writes the JSON envelope).
 */

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { spinner as makeSpinner } from '../spinner.js';
import { callMcpTool } from '@kinqs/brainrouter-core/dist/mcp/mcpUtils.js';
import { extractMemories, renderMemoryCards } from '../../memory/formatters.js';
import { consolidateMemories } from '../../memory/consolidation.js';
import { scanWorkspaceSources } from '../../memory/sourceManifest.js';
import { readPreferences, writePreferences } from '@kinqs/brainrouter-core/dist/session/preferencesStore.js';
import { getCliKnobs } from '@kinqs/brainrouter-core/dist/config/config.js';
import type { CommandContext } from './_context.js';
import { printMcpCall, printMemoryCards } from './_helpers.js';

export async function tryHandleMemoryCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient } = ctx;
  switch (command) {
    case '/memory': {
      // B6 (0.4.11) — `/memory verify [--apply]` reconciles code-anchored memories
      // against the current source index (fresh / re-anchorable / archivable).
      // Read-only unless `--apply`, which archives the confirmed-dead anchors.
      if ((args[0] ?? '').toLowerCase() === 'verify') {
        const apply = args.includes('--apply');
        await printMcpCall(
          mcpClient,
          'memory_verify_anchors',
          { apply },
          apply ? 'Memory verify — applying (archiving confirmed-dead anchors)' : 'Memory verify — read-only sweep',
        );
        return true;
      }
      const query = args.join(' ').trim();
      if (!query) { console.log(chalk.red('\nUsage: /memory <query>   ·   /memory verify [--apply]\n')); return true; }
      await printMemoryCards(mcpClient, 'memory_search', { query, sessionKey: agent.sessionKey }, `Memory search · "${query}"`);
      return true;
    }
    case '/recall': {
      const query = args.join(' ').trim();
      if (!query) { console.log(chalk.red('\nUsage: /recall <query>\n')); return true; }
      await printMemoryCards(mcpClient, 'memory_recall', { sessionKey: agent.sessionKey, query }, `Cognitive recall · "${query}"`);
      return true;
    }
    case '/refresh-memory': {
      // 0.3.9 item 9 — clear the pinned memory anchor. The next briefing
      // will re-pin as a fresh PIN action, replacing the previous anchor
      // bytes in the immutable prefix slot. Provider prefix cache will
      // miss exactly once on the following turn, then re-warm.
      const hadAnchor = agent.hasPinnedMemoryAnchor();
      agent.clearPinnedMemoryAnchor();
      if (hadAnchor) {
        console.log(chalk.cyan('\nMemory anchor cleared. Next turn will re-pin a fresh briefing.\n'));
      } else {
        console.log(chalk.gray('\nNo memory anchor was pinned. Next turn will pin the first available briefing.\n'));
      }
      return true;
    }
    case '/briefing': {
      const b = agent.getLastBriefing();
      console.log(chalk.bold('\nLast Memory Briefing'));
      console.log(`  Decision: ${chalk.cyan(b.decision)}`);
      if (b.reasons.length > 0) console.log(`  Reasons: ${chalk.gray(b.reasons.join(', '))}`);
      if (b.sourcesPlanned.length > 0) console.log(`  Sources planned: ${chalk.gray(b.sourcesPlanned.join(', '))}`);
      if (b.sources.length > 0) console.log(`  Sources queried: ${chalk.cyan(b.sources.join(', '))}`);
      if (b.sourceStats.length > 0) {
        console.log(chalk.bold('\n  Source stats'));
        for (const s of b.sourceStats) {
          console.log(`    ${chalk.cyan(s.source.padEnd(24))} ${String(s.records).padStart(3)} records  ${String(s.chars).padStart(5)} chars`);
        }
      }
      if (b.skippedSources.length > 0) {
        console.log(chalk.bold('\n  Skipped sources'));
        for (const s of b.skippedSources) console.log(`    ${chalk.gray(s.source)} — ${s.reason}`);
      }
      if (b.recordIds.length > 0) {
        console.log(`\n  Recalled record IDs (${b.recordIds.length}): ${chalk.gray(b.recordIds.slice(0, 10).join(', '))}${b.recordIds.length > 10 ? '…' : ''}`);
      }
      if (b.warnings.length > 0) {
        console.log(chalk.bold.yellow('\n  Warnings'));
        for (const w of b.warnings) console.log(`    ${w}`);
      }
      console.log(chalk.gray(`\n  Tokens injected: ${b.tokensInjected.toLocaleString()}  ·  compacted chars avoided: ${b.charsSaved.toLocaleString()}`));
      if (b.sources.length === 0 && b.decision !== 'none') console.log(chalk.gray('  Manual fallback: /recall <query> or /memory <query>'));
      if (b.decision === 'none') console.log(chalk.yellow('  No briefing has been built yet. Start a turn or use /recall.'));
      console.log();
      return true;
    }
    case '/scenes': {
      const res = await callMcpTool<any>(mcpClient, 'memory_recall', { sessionKey: agent.sessionKey, query: 'list focus scenes' });
      if (res.isError) {
        console.log(chalk.red(`\nmemory_recall failed: ${res.text || '(no message)'}\n`));
      } else {
        const persona = res.parsed?.appendSystemContext ?? '';
        const sceneRe = /Recent focus scenes:\s*\n([\s\S]*?)(\n\n|<\/scene-navigation>)/;
        const m = sceneRe.exec(persona);
        console.log(chalk.bold('\nActive focus scenes'));
        if (m) {
          for (const line of m[1].split('\n')) {
            const trimmed = line.replace(/^\s+/, '').replace(/^-\s*/, '').trim();
            if (trimmed) console.log(`  • ${chalk.cyan(trimmed)}`);
          }
        } else {
          console.log(chalk.yellow('  (no scenes returned — recall may be empty)'));
        }
        const cards = extractMemories(res.parsed);
        if (cards.length > 0) {
          console.log();
          console.log(renderMemoryCards(cards, 'Related memories', 5));
        }
      }
      return true;
    }
    case '/forget': {
      const id = args[0];
      if (!id) { console.log(chalk.red('\nUsage: /forget <recordId>\n')); return true; }
      await printMcpCall(mcpClient, 'memory_update', { recordId: id, status: 'archived' }, `Archive memory ${id}`);
      return true;
    }
    case '/handover': {
      // Generate a compact continuation note from current task memories so
      // the next session can pick up. Uses memory_handover.
      await printMcpCall(mcpClient, 'memory_handover', { sessionKey: agent.sessionKey }, 'Session handover note');
      return true;
    }
    case '/explain': {
      const query = args.join(' ').trim();
      if (!query) {
        console.log(chalk.red('\nUsage: /explain <query>\n'));
        console.log(chalk.gray('  Re-runs recall in explain mode: shows FTS hits, vector hits, RRF scores, type/skill boosts, reranker, graph expansion.\n'));
        return true;
      }
      await printMcpCall(mcpClient, 'memory_explain_recall', { sessionKey: agent.sessionKey, query }, `Recall explanation · "${query}"`);
      return true;
    }
    case '/trace': {
      const sub = args[0];
      if (sub === 'save') {
        const rest = args.slice(1).join(' ').trim();
        if (!rest) { console.log(chalk.red('\nUsage: /trace save <description>\n')); return true; }
        await printMcpCall(mcpClient, 'memory_debug_trace_save', { content: rest }, 'Saved debug trace');
        return true;
      }
      if (sub === 'search' || !sub) {
        const query = args.slice(1).join(' ').trim();
        if (sub !== 'search' && !query) {
          console.log(chalk.red('\nUsage: /trace save <description> | /trace search <query>\n'));
          return true;
        }
        await printMcpCall(mcpClient, 'memory_debug_trace_search', { query: query || '*' }, 'Prior debug traces');
        return true;
      }
      console.log(chalk.red('\nUsage: /trace save <description> | /trace search <query>\n'));
      return true;
    }
    case '/failed': {
      const area = args.join(' ').trim();
      await printMcpCall(mcpClient, 'memory_failed_attempts', area ? { area } : {}, `Past failed attempts${area ? ` · "${area}"` : ''}`);
      return true;
    }
    case '/verify': {
      const id = args[0];
      // CLI-10 — `/verify detect` reports the project profile + the verify
      // recipe it would run (read-only; sandbox-run + LSP diagnostics later).
      if (id === 'detect') {
        const { detectProjectProfile, formatProjectProfiles } = await import('../../runtime/projectProfile.js');
        let entries: string[] = [];
        try { entries = fs.readdirSync(agent.workspaceRoot); } catch { /* ignore */ }
        console.log(chalk.bold('\n🔎 Verify — project profile'));
        for (const line of formatProjectProfiles(detectProjectProfile(entries))) {
          console.log(line.startsWith('  ') ? chalk.gray(line) : chalk.cyan(line));
        }
        console.log();
        return true;
      }
      // CLI-10 — `/verify run [build|test|lint]` runs the detected recipe step
      // in the workspace and reports pass/fail + tail output.
      if (id === 'run') {
        const { detectProjectProfile } = await import('../../runtime/projectProfile.js');
        const { runVerifyRecipe, formatRecipeResult } = await import('../../runtime/verifyRunner.js');
        const cp = await import('node:child_process');
        const step = ((args[1] as 'build' | 'test' | 'lint') || 'test');
        let entries: string[] = [];
        try { entries = fs.readdirSync(agent.workspaceRoot); } catch { /* ignore */ }
        const profiles = detectProjectProfile(entries);
        if (profiles.length === 0) { console.log(chalk.yellow('\nNo known project profile to run a recipe for. Try /verify detect.\n')); return true; }
        const exec = (command: string, cwd: string): { exitCode: number; output: string } => {
          try {
            const out = cp.execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return { exitCode: 0, output: out };
          } catch (e: any) {
            return { exitCode: typeof e?.status === 'number' ? e.status : 1, output: `${e?.stdout ?? ''}${e?.stderr ?? ''}` || String(e?.message ?? e) };
          }
        };
        console.log(chalk.bold(`\n🔎 Verify — run ${step} (${profiles[0].name})`));
        const result = runVerifyRecipe(profiles[0].recipe, step, agent.workspaceRoot, exec);
        if ('error' in result) { console.log(chalk.yellow(`  ${result.error}`)); console.log(); return true; }
        for (const line of formatRecipeResult(result)) {
          console.log(line.startsWith('  ') ? chalk.gray(line) : (result.ok ? chalk.green(line) : chalk.red(line)));
        }
        console.log();
        return true;
      }
      // VERIFY-BROWSER — `/verify browser [url]` runs the configured browser
      // smoke command, writes artifacts to a run dir, and reports what it
      // produced. Infrastructure-agnostic (cli.browserSmoke template).
      if (id === 'browser') {
        const { runBrowserSmoke, formatBrowserSmokeResult } = await import('../../runtime/browserVerify.js');
        const cp = await import('node:child_process');
        const template = getCliKnobs().browserSmoke;
        const url = args[1] || 'http://localhost:3000';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outDir = path.join(agent.workspaceRoot, '.brainrouter', 'browser-smoke', stamp);
        try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* best-effort */ }
        const exec = (command: string, cwd: string): { exitCode: number; output: string } => {
          try {
            const out = cp.execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return { exitCode: 0, output: out };
          } catch (e: any) {
            return { exitCode: typeof e?.status === 'number' ? e.status : 1, output: `${e?.stdout ?? ''}${e?.stderr ?? ''}` || String(e?.message ?? e) };
          }
        };
        const list = (dir: string): string[] => {
          try { return fs.readdirSync(dir).map((f) => path.join(dir, f)); } catch { return []; }
        };
        console.log(chalk.bold(`\n🌐 Verify — browser smoke (${url})`));
        const result = runBrowserSmoke(template, { url, outDir, cwd: agent.workspaceRoot }, exec, list);
        if ('error' in result) { console.log(chalk.yellow(`  ${result.error}`)); console.log(); return true; }
        for (const line of formatBrowserSmokeResult(result)) {
          console.log(line.startsWith('  ') ? chalk.gray(line) : (result.ok ? chalk.green(line) : chalk.red(line)));
        }
        console.log();
        return true;
      }
      if (!id) { console.log(chalk.red('\nUsage: /verify <recordId> [status] [confidence]  ·  /verify detect  ·  /verify run [build|test|lint]  ·  /verify browser [url]\n')); return true; }
      const status = args[1] || 'verified';
      const confidence = args[2] ? Number(args[2]) : 0.9;
      await printMcpCall(mcpClient, 'memory_verify', { recordId: id, verificationStatus: status, confidence }, `Verify ${id}`);
      return true;
    }
    case '/audit': {
      await printMcpCall(mcpClient, 'memory_audit', { limit: 30 }, 'Recent memory audit log');
      return true;
    }
    case '/export': {
      const out = args[0] || `.brainrouter/cli/memory-export-${Date.now()}.json`;
      const res = await callMcpTool<any>(mcpClient, 'memory_export', {});
      if (res.isError) {
        console.log(chalk.red(`\nmemory_export failed: ${res.text}\n`));
      } else {
        try {
          fs.writeFileSync(path.resolve(agent.workspaceRoot, out), res.text, 'utf8');
          console.log(chalk.green(`\n✓ Exported memory to ${out} (${res.text.length} chars)\n`));
        } catch (err: any) {
          console.log(chalk.red(`\nWrite failed: ${err.message}\n`));
        }
      }
      return true;
    }
    case '/import': {
      const src = args[0];
      if (!src) { console.log(chalk.red('\nUsage: /import <path-to-export.json>\n')); return true; }
      let envelope: string;
      try { envelope = fs.readFileSync(path.resolve(agent.workspaceRoot, src), 'utf8'); }
      catch (err: any) { console.log(chalk.red(`\nRead failed: ${err.message}\n`)); return true; }
      await printMcpCall(mcpClient, 'memory_import', { envelope }, `Import from ${src}`);
      return true;
    }
    case '/persona': {
      const sub = args[0]?.trim();

      // Subcommand: /persona refresh — re-distill Core Identity via the brain.
      if (sub === 'refresh') {
        const spinner = makeSpinner(chalk.gray('Re-distilling Core Identity from persona + instruction cognitives…')).start();
        const res = await callMcpTool<any>(mcpClient, 'memory_persona_refresh', {});
        if (res.isError) {
          spinner.fail(chalk.red(`memory_persona_refresh failed: ${res.text || '(no message)'}`));
          return true;
        }
        const parsed = res.parsed ?? {};
        if (parsed.status === 'ok' && parsed.personaMd) {
          spinner.succeed(chalk.green(`Core Identity refreshed (hash ${parsed.hash}, ${parsed.cognitiveCountAtGeneration ?? '?'} cognitives).`));
          agent.clearPinnedMemoryAnchor();
          console.log(chalk.gray('  Anchor cleared — next turn will re-pin the new persona.\n'));
        } else {
          spinner.warn(chalk.yellow(`Refresh skipped: ${parsed.reason ?? 'unknown reason'}\n`));
        }
        return true;
      }

      // Subcommands: /persona on | off — toggle preference; do not delete the
      // underlying core_identity row.
      if (sub === 'on' || sub === 'off') {
        const enabled = sub === 'on';
        writePreferences(agent.workspaceRoot, { personaAnchorEnabled: enabled });
        agent.clearPinnedMemoryAnchor();
        console.log(chalk.green(`\n✓ Persona anchor ${enabled ? 'enabled' : 'disabled'}.`));
        console.log(chalk.gray('  Anchor cleared — next turn will rebuild the briefing.\n'));
        return true;
      }

      // Subcommand: /persona show (or no args) — render the active Core Identity.
      if (!sub || sub === 'show' || sub === 'status') {
        const prefs = readPreferences(agent.workspaceRoot);
        const configOff = getCliKnobs().personaAnchor === 'off';
        const effectivelyOn = prefs.personaAnchorEnabled && !configOff;
        const res = await callMcpTool<any>(mcpClient, 'memory_persona', {});
        console.log(chalk.bold('\nCore Identity'));
        console.log(`  Anchor:     ${effectivelyOn ? chalk.green('on') : chalk.gray('off')}${configOff ? chalk.gray(' (config.json cli.personaAnchor=off)') : ''}`);
        if (res.isError) {
          console.log(chalk.red(`  memory_persona failed: ${res.text || '(no message)'}`));
          return true;
        }
        const parsed = res.parsed ?? {};
        if (!parsed.personaMd) {
          console.log(chalk.yellow(`  ${parsed.reason ?? 'No Core Identity yet.'}`));
          console.log(chalk.gray('  Run: /persona refresh\n'));
          return true;
        }
        console.log(`  Hash:       ${chalk.cyan(parsed.hash ?? '(unknown)')}`);
        if (parsed.cognitiveCountAtGeneration != null) {
          console.log(`  Cognitives: ${chalk.cyan(String(parsed.cognitiveCountAtGeneration))}`);
        }
        if (parsed.updatedTime) console.log(`  Updated:    ${chalk.gray(parsed.updatedTime)}`);
        if (parsed.createdTime) console.log(`  Created:    ${chalk.gray(parsed.createdTime)}`);
        console.log(chalk.bold('\n  Body:'));
        for (const line of String(parsed.personaMd).split('\n')) {
          console.log('    ' + line);
        }
        console.log();
        return true;
      }

      // Back-compat: /persona <named-persona> still fetches a registry persona
      // definition (e.g. /persona code-reviewer). Reserved subcommands above
      // shadow this only for the exact tokens `refresh`, `on`, `off`, `show`,
      // `status`.
      const name = args.join(' ').trim();
      await printMcpCall(mcpClient, 'get_persona', { name }, `Persona · ${name}`);
      return true;
    }
    case '/skill-hints': {
      const skill = args[0];
      const hints = args.slice(1).join(' ').trim();
      if (!skill || !hints) {
        console.log(chalk.red('\nUsage: /skill-hints <skill-name> <hints>\n'));
        return true;
      }
      await printMcpCall(mcpClient, 'memory_register_skill_hints', { skill, hints }, `Registered hints for ${skill}`);
      return true;
    }
    case '/diagnostics': {
      await printMcpCall(mcpClient, 'memory_diagnostics', {}, 'Memory diagnostics');
      return true;
    }
    case '/working': {
      const sub = args[0];
      if (sub === 'reset') {
        const confirm = args[1];
        if (confirm !== 'confirm') {
          console.log(chalk.yellow('\n⚠ /working reset clears the working-memory canvas. Confirm with: /working reset confirm\n'));
          return true;
        }
        await printMcpCall(mcpClient, 'memory_working_reset', { sessionKey: agent.sessionKey, workspacePath: agent.workspaceRoot }, 'Working memory reset');
        return true;
      }
      await printMcpCall(mcpClient, 'memory_working_context', { sessionKey: agent.sessionKey, workspacePath: agent.workspaceRoot }, 'Working memory canvas');
      return true;
    }
    case '/memories': {
      const sub = args[0];
      if (!sub || sub === 'status') {
        const prefs = readPreferences(agent.workspaceRoot);
        console.log(chalk.bold('\nMemories pipeline'));
        console.log(`  Enabled: ${prefs.memoriesEnabled ? chalk.green('on') : chalk.gray('off')}`);
        console.log(chalk.gray('  Subcommands:'));
        console.log(chalk.gray('    /memories on | off          — toggle the pipeline'));
        console.log(chalk.gray('    /memories list [query]      — list memories with citation precision'));
        console.log(chalk.gray('    /memories consolidate       — write user/feedback/project/reference files'));
        console.log(chalk.gray('    /memories sources [limit]   — read-only local source manifest spike'));
        console.log(chalk.gray('    /memories status            — show this view\n'));
        return true;
      }
      if (sub === 'on' || sub === 'off') {
        writePreferences(agent.workspaceRoot, { memoriesEnabled: sub === 'on' });
        console.log(chalk.green(`\n✓ Memories pipeline ${sub === 'on' ? 'enabled' : 'disabled'}.\n`));
        return true;
      }
      if (sub === 'consolidate') {
        const spinner = makeSpinner(chalk.gray('Consolidating memories from MCP into filesystem artifacts...')).start();
        try {
          const result = await consolidateMemories(mcpClient, agent.workspaceRoot, { sessionKey: agent.sessionKey });
          spinner.succeed(chalk.green(`Consolidated ${result.totalRecords} records.`));
          console.log(chalk.bold('\nPer-type counts:'));
          for (const [t, n] of Object.entries(result.perType)) {
            console.log(`  ${chalk.cyan(t.padEnd(10))} ${n}`);
          }
          console.log(chalk.bold('\nFiles written:'));
          for (const f of result.files) console.log(`  ${chalk.gray(f)}`);
          console.log();
        } catch (err: any) {
          spinner.fail(chalk.red(`Consolidation failed: ${err.message}\n`));
        }
        return true;
      }
      if (sub === 'list') {
        // /memories list [query] — surface recent records with citation
        // metrics so users can see what the brain is about to archive
        // before auto-archive fires (T5). Backed by memory_search since
        // it returns full CognitiveRecord shapes including citationCount
        // and neverCitedCount.
        const query = args.slice(1).join(' ').trim() || '*';
        const res = await callMcpTool<any>(mcpClient, 'memory_search', { query, sessionKey: agent.sessionKey });
        if (res.isError) {
          console.log(chalk.red(`\nmemory_search failed: ${res.text || '(no message)'}\n`));
          return true;
        }
        const memories = extractMemories(res.parsed);
        console.log();
        console.log(renderMemoryCards(memories, `Memories${query !== '*' ? ` · "${query}"` : ''}`, 20));
        const noisy = memories.filter((m) => {
          const total = (m.citationCount ?? 0) + (m.neverCitedCount ?? 0);
          if (total === 0) return false;
          return (m.citationCount ?? 0) / total < 0.2;
        });
        if (noisy.length > 0) {
          console.log(chalk.yellow(`  ⚠ ${noisy.length} record(s) below 20% recall precision — auto-archive may fire soon.`));
          console.log(chalk.gray('    Inspect with /memory <query> or archive manually with /forget <recordId>.'));
        }
        console.log();
        return true;
      }
      if (sub === 'sources') {
        const limitArg = Number(args[1]);
        const manifest = scanWorkspaceSources(agent.workspaceRoot, {
          limit: Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 80,
        });
        console.log(chalk.bold('\nSource manifest spike'));
        console.log(`  Workspace: ${chalk.gray(manifest.workspaceRoot)}`);
        console.log(`  Entries: ${chalk.cyan(manifest.entries.length)}`);
        console.log(`  Skipped: ${chalk.gray(`${manifest.skipped.directories} dirs, ${manifest.skipped.largeFiles} large, ${manifest.skipped.unsupportedFiles} unsupported`)}`);
        for (const entry of manifest.entries.slice(0, 30)) {
          console.log(`  ${chalk.cyan(entry.kind.padEnd(6))} ${entry.path} ${chalk.gray(`${entry.size} bytes ${entry.hash}`)}`);
        }
        if (manifest.entries.length > 30) console.log(chalk.gray(`  …and ${manifest.entries.length - 30} more`));
        console.log();
        return true;
      }
      console.log(chalk.red(`\nUnknown /memories subcommand "${sub}". Try: status, on, off, list, consolidate, sources.\n`));
      return true;
    }
    case '/blackboard': {
      // BLACKBOARD-REVIEW-UX — review + drive the memory blackboard over MCP.
      // Default view focuses on the candidates a human cares about reviewing:
      // rejected + duplicate (dropped) ones they may want to restore.
      const sub = (args[0] ?? 'review').toLowerCase();
      const STATUSES = ['pending', 'reconciled', 'duplicate', 'committed', 'rejected'];
      const dot = (s: string) =>
        s === 'committed' ? chalk.green('●')
        : s === 'reconciled' ? chalk.cyan('●')
        : s === 'rejected' ? chalk.red('○')
        : s === 'duplicate' ? chalk.yellow('○')
        : chalk.gray('●'); // pending
      const renderItems = (items: any[]) => {
        if (!items.length) { console.log(chalk.gray('  (none)')); return; }
        for (const it of items) {
          const c = it.candidate ?? {};
          const content = String(c.content ?? '').replace(/\s+/g, ' ').slice(0, 64);
          const score = typeof it.score === 'number' ? ` score=${it.score.toFixed(2)}` : '';
          const conflicts = it.conflictIds?.length ? chalk.gray(` ↔${it.conflictIds.length}`) : '';
          console.log(`  ${dot(it.status)} ${chalk.cyan(it.id)} ${chalk.gray(`[${it.status}]`)}${chalk.gray(score)} ${chalk.gray(c.type ?? '')}${conflicts} — ${content}`);
        }
      };
      const list = async (status?: string) => {
        const res = await callMcpTool<any>(mcpClient, 'memory_blackboard_review', status ? { status } : {});
        if (res.isError) { console.log(chalk.red(`\nblackboard list failed: ${res.text || '(no message)'}\n`)); return [] as any[]; }
        return (res.parsed?.items ?? []) as any[];
      };
      if (sub === 'review' || sub === 'list') {
        const status = args[1];
        if (sub === 'list' && status && !STATUSES.includes(status)) {
          console.log(chalk.red(`\nUnknown status "${status}". One of: ${STATUSES.join(', ')}.\n`));
          return true;
        }
        if (sub === 'list') {
          console.log(chalk.bold(`\nBlackboard candidates${status ? ` · ${status}` : ''}`));
          renderItems(await list(status));
          console.log(chalk.gray('\n  /blackboard restore <id> · commit <id> · reject <id> · reconcile\n'));
          return true;
        }
        // review: surface the dropped candidates (rejected + duplicate).
        const rejected = await list('rejected');
        const duplicate = await list('duplicate');
        console.log(chalk.bold('\nBlackboard review — dropped candidates'));
        console.log(chalk.red(`\n  rejected (${rejected.length}):`));
        renderItems(rejected);
        console.log(chalk.yellow(`\n  duplicate (${duplicate.length}):`));
        renderItems(duplicate);
        console.log(chalk.gray('\n  Restore one for re-review: /blackboard restore <id>'));
        console.log(chalk.gray('  Full list: /blackboard list [status]\n'));
        return true;
      }
      if (sub === 'restore' || sub === 'commit' || sub === 'reject') {
        const id = args[1];
        if (!id) { console.log(chalk.red(`\nUsage: /blackboard ${sub} <id>\n`)); return true; }
        const res = await callMcpTool<any>(mcpClient, 'memory_blackboard_review', { action: sub, itemId: id });
        if (res.isError) { console.log(chalk.red(`\n${sub} failed: ${res.text || '(no message)'}\n`)); return true; }
        const r = res.parsed ?? {};
        if (sub === 'restore') {
          console.log(r.restored ? chalk.green(`\n✓ Restored ${id} → pending (will be re-evaluated on next reconcile).\n`) : chalk.yellow(`\nNot restored: ${r.reason ?? 'unknown'}.\n`));
        } else if (sub === 'commit') {
          console.log(r.committed ? chalk.green(`\n✓ Committed ${id}${r.recordId ? ` → record ${r.recordId}` : ''}.\n`) : chalk.yellow(`\nNot committed: ${r.reason ?? 'unknown'}.\n`));
        } else {
          console.log(r.rejected ? chalk.green(`\n✓ Rejected ${id}.\n`) : chalk.yellow(`\nNot rejected (no such item?).\n`));
        }
        return true;
      }
      if (sub === 'reconcile') {
        const res = await callMcpTool<any>(mcpClient, 'memory_blackboard_review', { action: 'reconcile' });
        if (res.isError) { console.log(chalk.red(`\nreconcile failed: ${res.text || '(no message)'}\n`)); return true; }
        const r = res.parsed ?? {};
        console.log(chalk.green(`\n✓ Reconciled — ${r.reconciled ?? 0} ready, ${r.duplicate ?? 0} duplicate, ${r.rejected ?? 0} rejected.\n`));
        return true;
      }
      console.log(chalk.gray('\nUsage: /blackboard [review] | list [status] | restore <id> | commit <id> | reject <id> | reconcile\n'));
      return true;
    }
  }
  return false;
}
