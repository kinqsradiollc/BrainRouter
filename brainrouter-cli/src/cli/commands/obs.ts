/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import chalk from 'chalk';
import { listSessions } from '../../orchestration/orchestrator.js';
import { formatContextReport } from '../../runtime/contextReport.js';
import { formatMemoryDecisions } from '../../runtime/memoryDecisionView.js';
import { formatOffloadList, type OffloadStep } from '../../runtime/offloadView.js';
import { contextWindowFor } from '../../runtime/contextWindow.js';
import { readPreferences } from '../../state/preferencesStore.js';
import { readTranscriptEntries } from '../../state/sessionStore.js';
import { getCliStateFile } from '../../state/cliState.js';
import { getCliKnobs } from '../../config/config.js';
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
      const tracePath = getCliKnobs().traceLog?.trim();
      if (!tracePath) {
        console.log(chalk.yellow('\nLive tracing is off. Enable with:'));
        console.log(chalk.gray('  Edit ~/.config/brainrouter/config.json and set:'));
        console.log(chalk.gray(`    cli.traceLog = "${path.join(agent.workspaceRoot, '.brainrouter/cli/trace.jsonl')}"`));
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
        const childOffloaded = children.reduce((acc, c) => acc + (c.usage?.offloadedChars ?? 0), 0);
        const offloadNote = childOffloaded > 0 ? chalk.gray(`, ${childOffloaded.toLocaleString()} chars offloaded`) : '';
        console.log(`  Children (${children.length}): ${chalk.cyan(childPrompt.toLocaleString())}↑  ${chalk.cyan(childCompletion.toLocaleString())}↓  ${chalk.gray(`(${childCalls} LLM call${childCalls === 1 ? '' : 's'}${offloadNote ? '' : ''})`)}${offloadNote}`);
        // MAS-P4-T3 "By child": per-child tokens + offloaded chars + wall-clock.
        for (const c of children.slice(0, 5)) {
          const u = c.usage!;
          const off = (u.offloadedChars ?? 0) > 0 ? chalk.gray(` · ${(u.offloadedChars ?? 0).toLocaleString()}c offloaded`) : '';
          const wall = u.wallClockMs ? chalk.gray(` · ${(u.wallClockMs / 1000).toFixed(1)}s`) : '';
          console.log(chalk.gray(`    · ${c.id} (${c.role}): ${u.promptTokens.toLocaleString()}↑ ${u.completionTokens.toLocaleString()}↓`) + off + wall);
        }
        if (children.length > 5) console.log(chalk.gray(`    …and ${children.length - 5} more (see /agents --json)`));
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

      // 0.3.9 item 10 — prefix-cache panel. The numbers come from the
      // provider's own cache fields normalised by
      // `runtime/cacheStats.ts`. When both counters are zero the
      // provider either doesn't expose cache info (LM Studio /
      // Ollama / older endpoints) or this session hasn't yet seen a
      // turn — print "—" instead of misleading 0% / 0.
      const { formatCacheStats } = await import('../../runtime/cacheStats.js');
      const turnCache = formatCacheStats({
        cachedTokens: agent.lastTurnUsage.cachedTokens,
        missedTokens: agent.lastTurnUsage.missedTokens,
        cacheHitRatio: (agent.lastTurnUsage.cachedTokens + agent.lastTurnUsage.missedTokens) > 0
          ? agent.lastTurnUsage.cachedTokens / (agent.lastTurnUsage.cachedTokens + agent.lastTurnUsage.missedTokens)
          : 0,
        source: 'unknown',
      });
      const sessionCache = formatCacheStats({
        cachedTokens: agent.sessionUsage.cachedTokens,
        missedTokens: agent.sessionUsage.missedTokens,
        cacheHitRatio: (agent.sessionUsage.cachedTokens + agent.sessionUsage.missedTokens) > 0
          ? agent.sessionUsage.cachedTokens / (agent.sessionUsage.cachedTokens + agent.sessionUsage.missedTokens)
          : 0,
        source: 'unknown',
      });
      console.log(chalk.bold('Prefix cache'));
      console.log(`  Last turn:   ${chalk.cyan(turnCache)}`);
      console.log(`  This session: ${chalk.cyan(sessionCache)}`);
      console.log(chalk.gray('  (Anchored briefing — /refresh-memory rotates the pin if you want a fresh card set.)'));

      // 0.3.9 item 14 — cost panel. Per-turn USD, session USD, and the
      // cache-savings line. Costs are computed from the active model's
      // built-in pricing row (`runtime/pricing.ts`), overridable via
      // `~/.config/brainrouter/pricing.json` for users who want exact
      // billing parity with their actual contract.
      const { buildCostSummary } = await import('../../runtime/pricing.js');
      const cost = buildCostSummary({
        model: agent.getModel(),
        turnCachedTokens: agent.lastTurnUsage.cachedTokens,
        turnMissedTokens: agent.lastTurnUsage.missedTokens,
        turnCompletionTokens: agent.lastTurnUsage.completionTokens,
        sessionCachedTokens: agent.sessionUsage.cachedTokens,
        sessionMissedTokens: agent.sessionUsage.missedTokens,
        sessionCompletionTokens: agent.sessionUsage.completionTokens,
      });
      const bandColor = (band: 'green' | 'yellow' | 'red' | 'mono'): (s: string) => string => {
        if (band === 'green') return chalk.green;
        if (band === 'yellow') return chalk.yellow;
        if (band === 'red') return chalk.red;
        return chalk.gray;
      };
      console.log(chalk.bold('\nCost (built-in pricing — overridable at ~/.config/brainrouter/pricing.json)'));
      console.log(`  Turn:        ${bandColor(cost.turnBadge.band)(cost.turnBadge.text)}  ${chalk.gray(`(model: ${agent.getModel()})`)}`);
      console.log(`  Session:     ${bandColor(cost.sessionBadge.band)(cost.sessionBadge.text)}`);
      if (cost.sessionCacheSavedUsd > 0) {
        console.log(`  Cache saved: ${chalk.green(`$${cost.sessionCacheSavedUsd.toFixed(4)}`)} ${chalk.gray('this session vs. no-cache baseline.')}`);
      }
      console.log();
      return true;
    }
    case '/context':
    {
      // 0.4.x-4 — where did this session's tokens go? Total + per-skill
      // (bucketed at each turn by activeSkill) + per-briefing + per-tool
      // (call counts). `/context current` narrows to the active skill.
      // CLI-6 — `/context memory` shows the last turn's memory-decision view.
      if ((args[0] ?? '').toLowerCase() === 'memory') {
        const b = agent.getLastBriefing();
        const lines = formatMemoryDecisions({
          decision: b.decision,
          reasons: b.reasons,
          sources: b.sources,
          sourcesPlanned: b.sourcesPlanned,
          skippedSources: b.skippedSources,
          recordCount: b.recordCount,
          tokensInjected: b.tokensInjected,
          charsSaved: b.charsSaved,
          recalled: agent.getRecalledRecords().map((r) => ({ recordId: r.recordId, type: r.type, priority: r.priority, content: r.content })),
        });
        console.log(chalk.bold('\n🧠 Context — memory decisions (last turn)'));
        for (const line of lines) console.log(line.startsWith('  ') ? chalk.gray(line) : line);
        console.log();
        return true;
      }
      // CLI-14 — `/context offloads` lists working-memory offloads (durable
      // refs pushed out of context) with their tool, token savings, and ref id.
      if ((args[0] ?? '').toLowerCase() === 'offloads') {
        let steps: OffloadStep[] = [];
        try {
          const res = await mcpClient.callTool('memory_working_context', { sessionKey: agent.sessionKey, workspacePath: agent.workspaceRoot });
          const text = (res as any)?.content?.[0]?.text;
          const parsed = text ? JSON.parse(text) : {};
          if (Array.isArray(parsed?.steps)) {
            steps = parsed.steps.map((s: any) => ({
              nodeId: s.nodeId, title: s.title, summary: s.summary, kind: s.kind,
              refPath: s.refPath, tokenEstimate: s.tokenEstimate, createdAt: s.createdAt,
            }));
          }
        } catch (err: any) {
          console.log(chalk.yellow(`\nCould not read working memory: ${err?.message ?? err}\n`));
          return true;
        }
        console.log(chalk.bold('\n📦 Context — offloads'));
        for (const line of formatOffloadList(steps)) console.log(line.startsWith('  ') ? chalk.gray(line) : line);
        console.log();
        return true;
      }
      // CLI-5 — `/context prefix`: the cache-stable region's components + drift
      // (system / memory-anchor) since the last check, diffed against a
      // CLI-state snapshot. Read-only; no change to the turn loop.
      if ((args[0] ?? '').toLowerCase() === 'prefix') {
        const { diffPrefixComponents } = await import('../../runtime/contextRegions.js');
        const curr = agent.getPrefixComponents();
        const snapFile = getCliStateFile(agent.workspaceRoot, 'prefix-snapshot.json');
        let prev: ReturnType<typeof agent.getPrefixComponents> | null = null;
        try { if (fs.existsSync(snapFile)) prev = JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch { /* first run */ }
        const drift = diffPrefixComponents(prev, curr);
        console.log(chalk.bold('\n🔌 Context — prefix (cache-stable region)'));
        console.log(chalk.gray(`  system hash:    ${curr.systemHash}`));
        console.log(chalk.gray(`  memory anchors: ${curr.anchorCount} (hash ${curr.anchorsHash})`));
        const labels = drift.labels.join('; ');
        console.log(`  drift since last check: ${drift.changed ? chalk.yellow(labels) : chalk.green(labels)}`);
        console.log(chalk.gray('  (tool-list drift not tracked in this view yet — needs per-turn tool capture)'));
        try { fs.writeFileSync(snapFile, JSON.stringify(curr), 'utf8'); } catch { /* best-effort */ }
        console.log();
        return true;
      }
      const scope: 'all' | 'current' = (args[0] ?? '').toLowerCase() === 'current' ? 'current' : 'all';
      const session = agent.sessionUsage;
      const children = listSessions(agent.workspaceRoot).filter(
        (s) => s.usage && s.parentSessionKey === agent.sessionKey,
      );
      const childAgg = children.reduce(
        (acc, c) => ({
          count: acc.count + 1,
          promptTokens: acc.promptTokens + (c.usage?.promptTokens ?? 0),
          completionTokens: acc.completionTokens + (c.usage?.completionTokens ?? 0),
          calls: acc.calls + (c.usage?.calls ?? 0),
        }),
        { count: 0, promptTokens: 0, completionTokens: 0, calls: 0 },
      );
      const lines = formatContextReport({
        scope,
        currentSkill: agent.activeSkill ?? null,
        window: {
          current: agent.getCurrentContextTokens(),
          max: contextWindowFor(agent.getModel()) ?? null,
          autoCompactThreshold: getCliKnobs().autoCompactTokens,
        },
        cache: { cachedTokens: session.cachedTokens, missedTokens: session.missedTokens },
        repair: agent.getRepairTotals(),
        session: {
          promptTokens: session.promptTokens,
          completionTokens: session.completionTokens,
          turns: session.turns,
          calls: session.calls,
        },
        bySkill: Array.from(agent.usageBySkill.entries()).map(([skill, u]) => ({ skill, ...u })),
        byTool: Array.from(agent.toolCallCounts.entries()).map(([tool, count]) => ({ tool, count })),
        briefing: {
          tokensInjected: agent.memoryMetrics.briefingTokensInjected,
          recordsConsulted: agent.memoryMetrics.recallRecordsConsulted,
        },
        children: childAgg,
      });
      console.log(chalk.bold(`\n📊 Context — token breakdown (${scope})`));
      for (const line of lines) console.log(line.startsWith('  ') ? chalk.gray(line) : line);
      console.log();
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
      console.log(`  Profile:   ${chalk.cyan(config.activeServer || '(none configured)')}`);
      const activeProfile = config.servers?.[config.activeServer];
      // Guard the same #59-class deref: JSON.stringify(undefined) is `undefined`
      // (not a string), so .split('\n') would throw when no profile resolves.
      console.log(`  Server:    ${activeProfile
        ? chalk.cyan(JSON.stringify(activeProfile, null, 2).split('\n').map((l) => '             ' + l).join('\n').trim())
        : chalk.yellow('(none configured)')}`);
      // Resolved CLI knobs — the live, effective values (config.cli > workspace
      // preference > default). This is the non-destructive "show me all the
      // variables" view: config.json only needs to carry what you've CHANGED;
      // absent knobs fall through to the defaults printed here, so the file
      // stays minimal and the config > preference > default layering survives.
      // (Replaces the old hardcoded BRAINROUTER_* list — those CLI env vars
      // were retired in the 0.3.9 knob migration and are no longer consulted.)
      console.log(chalk.bold('\nResolved CLI knobs (effective — config.cli > preference > default)'));
      const knobs = getCliKnobs() as unknown as Record<string, unknown>;
      for (const key of Object.keys(knobs).sort()) {
        const v = knobs[key];
        if (v === undefined) continue;
        console.log(`  ${chalk.cyan(key)} = ${chalk.white(JSON.stringify(v))}`);
      }
      console.log(chalk.bold('\nPreferences'));
      console.log(chalk.gray(JSON.stringify(readPreferences(agent.workspaceRoot), null, 2)));
      console.log();
      return true;
    }
  }
  return false;
}
