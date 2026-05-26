/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import chalk from 'chalk';
import { listSessions } from '../../orchestration/orchestrator.js';
import { readPreferences } from '../../state/preferencesStore.js';
import { readTranscriptEntries } from '../../state/sessionStore.js';
import { getCliStateFile } from '../../state/cliState.js';
import type { CommandContext } from './_context.js';
import { formatTranscriptContent } from './_helpers.js';


export async function tryHandleObsCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/transcript':
    {
      const requestedSession = args.join(' ').trim();
      const sessionKey = !requestedSession || requestedSession === 'main'
        ? agent.sessionKey
        : requestedSession;
      const entries = readTranscriptEntries(agent.workspaceRoot, sessionKey, 20);
      console.log(chalk.bold(`\nTranscript: ${sessionKey}`));
      if (entries.length === 0) {
        console.log(chalk.yellow('  No transcript entries found.'));
      } else {
        for (const entry of entries) {
          const label = entry.name ? `${entry.role}:${entry.name}` : entry.role;
          const text = formatTranscriptContent(entry.content ?? entry.tool_calls ?? '');
          console.log(`${chalk.gray(entry.timestamp)} ${chalk.cyan(label)} ${chalk.gray(text)}`);
        }
      }
      console.log();
      return true;
    }
    case '/watch':
    {
      const tracePath = process.env.BRAINROUTER_TRACE_LOG?.trim();
      if (!tracePath) {
        console.log(chalk.yellow('\nLive tracing is off. Enable with:'));
        console.log(chalk.gray('  export BRAINROUTER_TRACE_LOG=' + path.join(agent.workspaceRoot, '.brainrouter/cli/trace.jsonl')));
        console.log(chalk.gray('  (restart the CLI so the change takes effect)\n'));
        console.log(chalk.gray('Without it, you can still see per-tool activity inline in this REPL,'));
        console.log(chalk.gray('and child-agent tool calls now surface as "role:id → tool" lines.'));
        console.log(chalk.gray('Use /agents and /agent <id> --full for the persisted child transcripts.\n'));
        return true;
      }
      if (!fs.existsSync(tracePath)) {
        console.log(chalk.yellow(`\nTrace file does not exist yet: ${tracePath}\nIt will appear after the first turn.\n`));
        return true;
      }
      console.log(chalk.bold(`\n📡 Tailing ${tracePath} — Ctrl+C to stop.\n`));
      // Stream the last 30 lines + new appends as JSONL until the user
      // interrupts with Ctrl+C. We use child_process tail because that's
      // dramatically simpler than re-implementing inotify in Node.
      const tail = exec(`tail -n 30 -f "${tracePath}"`);
      const lineHandler = (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const raw of text.split('\n')) {
          if (!raw.trim()) continue;
          try {
            const e = JSON.parse(raw);
            const attrs = e.attributes ?? {};
            const dur = typeof e.duration_ms === 'number' ? chalk.gray(` ${e.duration_ms}ms`) : '';
            const detail = Object.entries(attrs)
              .slice(0, 4)
              .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
              .join(' ');
            console.log(`${chalk.gray(e.ts?.slice(11, 19) ?? '')} ${chalk.cyan(e.name)}${dur} ${chalk.gray(detail)}`);
          } catch { /* not JSON — print raw */ console.log(chalk.gray(raw)); }
        }
      };
      tail.stdout?.on('data', lineHandler);
      tail.stderr?.on('data', (c) => process.stderr.write(c));
      const onInterrupt = () => {
        try { tail.kill('SIGTERM'); } catch { /* noop */ }
        console.log(chalk.gray('\nwatch ended.\n'));
        rl.off('SIGINT', onInterrupt);
        rl.prompt();
      };
      rl.once('SIGINT', onInterrupt);
      // Resume the prompt only after the user interrupts; otherwise the
      // tail stays attached.
      return true;
    }
    case '/tokens':
    {
      const session = agent.sessionUsage;
      const metrics = agent.memoryMetrics;
      // Scope to the live parent: sessions.json is workspace-wide and
      // persists across CLI restarts, so an unfiltered list mixes in every
      // child spawned by every prior CLI process. Filtering by
      // parentSessionKey limits the row to children spawned by THIS parent.
      const children = listSessions(agent.workspaceRoot).filter(
        (s) => s.usage && s.parentSessionKey === agent.sessionKey,
      );
      const childPrompt = children.reduce((acc, c) => acc + (c.usage?.promptTokens ?? 0), 0);
      const childCompletion = children.reduce((acc, c) => acc + (c.usage?.completionTokens ?? 0), 0);
      const childCalls = children.reduce((acc, c) => acc + (c.usage?.calls ?? 0), 0);

      // What we can actually measure:
      //   - offload: bytes of child output that did NOT land in the parent's
      //     context. These are real tokens not spent on the parent. We
      //     subtract the preview that DID land (OFFLOAD_PREVIEW_CHARS is
      //     already netted out in tools.ts before recordOffload fires).
      //   - briefing tokens: cost, not savings. They're already counted in
      //     session.promptTokens. We report them so the user can see how
      //     much of the prompt budget memory is consuming.
      const offloadSavedTokens = Math.round(metrics.offloadCharsAvoided / 4);
      const compactionSavedTokens = Math.round((metrics.compactedToolCharsAvoided ?? 0) / 4);
      const totalSpent = session.promptTokens + session.completionTokens + childPrompt + childCompletion;

      console.log(chalk.bold('\nToken usage — this session'));
      console.log(`  Parent: ${chalk.cyan(session.promptTokens.toLocaleString())}↑  ${chalk.cyan(session.completionTokens.toLocaleString())}↓  ${chalk.gray(`(${session.turns} turn${session.turns === 1 ? '' : 's'}, ${session.calls} LLM call${session.calls === 1 ? '' : 's'})`)}`);
      if (children.length > 0) {
        console.log(`  Children (${children.length}): ${chalk.cyan(childPrompt.toLocaleString())}↑  ${chalk.cyan(childCompletion.toLocaleString())}↓  ${chalk.gray(`(${childCalls} LLM call${childCalls === 1 ? '' : 's'})`)}`);
        for (const c of children.slice(0, 5)) {
          const u = c.usage!;
          console.log(chalk.gray(`    · ${c.id} (${c.role}): ${u.promptTokens.toLocaleString()}↑ ${u.completionTokens.toLocaleString()}↓`));
        }
        if (children.length > 5) console.log(chalk.gray(`    …and ${children.length - 5} more (see /agents)`));
      }
      console.log(`  Total this session: ${chalk.bold.cyan(totalSpent.toLocaleString())} tokens`);

      console.log(chalk.bold('\nMemory'));
      console.log(`  Briefing tokens injected: ${chalk.gray(metrics.briefingTokensInjected.toLocaleString())}  ${chalk.gray(`(${metrics.recallRecordsConsulted} records consulted — already included in parent ↑)`)}`);
      console.log(`  Child output offloaded:   ${chalk.gray(metrics.offloadCharsAvoided.toLocaleString())} chars  ${chalk.gray(`(≈${offloadSavedTokens.toLocaleString()} parent tokens not spent)`)}`);
      console.log(`  Tool output compacted:    ${chalk.gray((metrics.compactedToolCharsAvoided ?? 0).toLocaleString())} chars  ${chalk.gray(`(≈${compactionSavedTokens.toLocaleString()} parent tokens not spent)`)}`);

      if (offloadSavedTokens > 0 && totalSpent > 0) {
        const ratio = offloadSavedTokens / totalSpent;
        const display = ratio >= 0.01 ? ratio.toFixed(2) : '<0.01';
        console.log(chalk.gray(`  Offload ratio: ~${display} saved per token spent.`));
      }
      console.log(chalk.gray('\n  (Offload is measured; briefing tokens are an information-gain stat, not a savings number.)\n'));
      return true;
    }
    case '/feedback':
    {
      // Personal CLI state lives under the user-global brainrouter home (per
      // README's storage contract), NOT inside the workspace — writing
      // feedback.jsonl into the project tree risks accidental commits and
      // breaks the "workflows are the only thing written inside the project"
      // guarantee. Route through getCliStateFile() so the path becomes
      // ~/.brainrouter/workspaces/<encoded>/cli/feedback.jsonl.
      const msg = args.join(' ').trim();
      const file = getCliStateFile(agent.workspaceRoot, 'feedback.jsonl');
      const entry = {
        ts: new Date().toISOString(),
        sessionKey: agent.sessionKey,
        model: agent.getModel(),
        accessMode: agent.getAccessMode(),
        message: msg || '(no message provided)',
      };
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
      console.log(chalk.green(`\n✓ Feedback recorded at ${file}`));
      console.log(chalk.gray('  This stays in your user-global brainrouter home — share by copying the file into a GitHub issue.\n'));
      return true;
    }
    case '/rollout':
    {
      const { getSessionStateDir } = await import('../../state/cliState.js');
      const sessionDir = getSessionStateDir(agent.workspaceRoot, agent.sessionKey);
      console.log(chalk.bold('\nSession bucket'));
      console.log(`  Session:   ${chalk.cyan(agent.sessionKey)}`);
      console.log(`  Directory: ${chalk.blue(sessionDir)}`);
      const interestingFiles = ['transcript.jsonl', 'goal.json', 'tasks.json'];
      console.log(chalk.bold('\nFiles in bucket:'));
      let printedAny = false;
      for (const name of interestingFiles) {
        const full = path.join(sessionDir, name);
        if (fs.existsSync(full)) {
          const stat = fs.statSync(full);
          console.log(`  ${chalk.cyan(name.padEnd(18))} ${chalk.gray(`${stat.size} bytes · modified ${stat.mtime.toISOString()}`)}`);
          printedAny = true;
        }
      }
      if (!printedAny) console.log(chalk.gray('  (empty — files appear after you set a goal, update a plan, or run a turn)'));
      console.log();
      return true;
    }
    case '/debug-config':
    {
      console.log(chalk.bold('\nConfig layers (in order of precedence)'));
      console.log(`  Workspace: ${chalk.cyan(agent.workspaceRoot)}`);
      console.log(`  CLI state: ${chalk.cyan(path.join(agent.workspaceRoot, '.brainrouter/cli'))}`);
      console.log(`  Profile:   ${chalk.cyan(config.activeServer)}`);
      console.log(`  Server:    ${chalk.cyan(JSON.stringify(config.servers[config.activeServer], null, 2).split('\n').map((l) => '             ' + l).join('\n').trim())}`);
      console.log(chalk.bold('\nEnvironment'));
      const flags = ['BRAINROUTER_SANDBOX', 'BRAINROUTER_SANDBOX_READ_PATHS', 'BRAINROUTER_SANDBOX_WRITE_PATHS', 'BRAINROUTER_SANDBOX_NETWORK', 'BRAINROUTER_TRACE_LOG', 'BRAINROUTER_MAX_TOOL_LOOPS', 'BRAINROUTER_LLM_TIMEOUT_MS', 'BRAINROUTER_WORKSPACE'];
      for (const f of flags) {
        const v = process.env[f];
        if (v) console.log(`  ${chalk.cyan(f)} = ${v}`);
      }
      console.log(chalk.bold('\nPreferences'));
      console.log(chalk.gray(JSON.stringify(readPreferences(agent.workspaceRoot), null, 2)));
      console.log();
      return true;
    }
  }
  return false;
}
