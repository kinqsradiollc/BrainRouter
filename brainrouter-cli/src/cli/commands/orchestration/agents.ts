/**
 * Agent-inspection slash commands — `/roles`, `/agents`, `/agent`.
 * List roles, list/tree/why/transcript/replay/show/diff/defs child agents,
 * remote-peer listing, and single-agent detail. Extracted verbatim from the
 * former orchestration/index.ts switch.
 */

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { callMcpTool, childSessionKey } from '@kinqs/brainrouter-core/mcp';
import { validateAgentDefinition, buildAgentDefinition, previewAgentDefinition } from '../../../orchestration/agentDefValidation.js';
import { LOCAL_TOOLS } from '@kinqs/brainrouter-core/agent';
import { listRoles, listAll as listAgentDefs, formatSessionSummary, getSession, listSessions, reconcileStale, updateSession, parseChildOutput } from '@kinqs/brainrouter-core/orchestration';
import { activeRun, formatActivePhase } from '@kinqs/brainrouter-core/workflow';
import { buildAgentForest, formatAgentForest, formatAgentWhy } from '../../../orchestration/agentTree.js';
import { formatAgentTranscript, formatAgentReplay } from '../../../orchestration/agentTranscriptView.js';
import { readTranscriptEntries } from '@kinqs/brainrouter-core/session';
import type { CommandContext } from '../_context.js';
import { formatTranscriptContent } from '../_helpers.js';

export async function handleRoles(_ctx: CommandContext): Promise<boolean> {
  console.log(chalk.bold('\nAvailable Agent Roles:'));
  for (const r of listRoles()) {
    console.log(`  ${chalk.cyan(r.name)} (${chalk.gray(r.defaultAccess)}) - ${r.description}`);
  }
  console.log();
  return true;
}

export async function handleAgents(ctx: CommandContext): Promise<boolean> {
  const { args, agent, mcpClient } = ctx;
  // CLI-13 + AGENTS-WIZARD — `/agents create <id>` writes a scoped agent
  // definition. Flag-driven (non-interactive) to avoid a stdin conflict
  // with the live Ink REPL; AGENTS-WIZARD adds tool-scope existence +
  // ownership validation and a `--dry-run` preview. (A fully interactive
  // Ink flow needs mid-REPL stdin handoff — same 0.5.0 TUI-NATIVE concern
  // as live-turn detach — so it stays deferred; flags + dry-run give the
  // full capability scriptably.)
  if (args[0] === 'create') {
    const id = args[1];
    const dryRun = args.includes('--dry-run');
    const flag = (name: string): string | undefined => {
      const i = args.indexOf(`--${name}`);
      return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
    };
    const csv = (v?: string): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
    const draft = {
      id,
      displayName: flag('display'),
      whenToUse: flag('when'),
      prompt: flag('prompt'),
      defaultAccess: flag('access') ?? 'read',
      toolScope: { local: csv(flag('tools')), mcp: csv(flag('mcp')) },
      ownership: flag('ownership'),
    };
    // Validate against the REAL tool sets: this build's LOCAL_TOOLS + the
    // currently-connected MCP server's tools (best-effort — skip MCP names
    // when offline so an unreachable server doesn't block creation).
    let knownMcpTools: string[] | undefined;
    try {
      if (mcpClient.isConnected()) {
        const res = await mcpClient.listTools();
        knownMcpTools = (res.tools ?? []).map((t: any) => t.name);
      }
    } catch { /* offline / list failed — skip MCP existence check */ }
    const v = validateAgentDefinition(draft, {
      knownLocalTools: LOCAL_TOOLS.map((t) => t.name),
      knownMcpTools,
    });
    if (!v.valid) {
      console.log(chalk.red('\nInvalid agent definition:'));
      for (const e of v.errors) console.log(chalk.gray(`  - ${e}`));
      console.log(chalk.gray('\nUsage: /agents create <id> --display "Name" --when "..." --prompt "..." --access read|write|shell'));
      console.log(chalk.gray('         [--tools a,b] [--mcp memory_search,...] [--ownership "src/x/**"] [--dry-run] [--force]\n'));
      return true;
    }
    for (const w of v.warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
    const built = buildAgentDefinition(draft);
    if (dryRun) {
      console.log(chalk.bold('\n[dry-run] Resolved agent definition (nothing written):\n'));
      console.log(previewAgentDefinition(built));
      console.log(chalk.gray('\n  Re-run without --dry-run to write it.\n'));
      return true;
    }
    const dir = path.join(agent.workspaceRoot, '.brainrouter', 'agents');
    const file = path.join(dir, `${id}.json`);
    if (fs.existsSync(file) && !args.includes('--force')) {
      console.log(chalk.yellow(`\n${id}.json already exists — pass --force to overwrite.\n`));
      return true;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(built, null, 2), 'utf8');
      console.log(chalk.green(`\n✓ Wrote agent definition: ${path.relative(agent.workspaceRoot, file)}`));
      console.log(chalk.gray('  Loads on next /agents (workspace tier).\n'));
    } catch (err: any) {
      console.log(chalk.red(`\nFailed to write: ${err?.message ?? err}\n`));
    }
    return true;
  }
  // `--remote` (FED-S2-T6): list peers attached to the same BrainRouter
  // brain via `session_list`. Local-child output stays the default —
  // `--remote` is opt-in. `--watch` flips to a live re-poll, `--json`
  // dumps the raw payload, `--usage` opts in to the per-session token
  // / USD snapshot (FED-S2-T8).
  if (args.includes('--remote')) {
    const watch = args.includes('--watch');
    const wantUsage = args.includes('--usage');
    const wantJson = args.includes('--json');
    const wantStale = args.includes('--include-stale');

    const renderOnce = async (): Promise<void> => {
      const res = await callMcpTool<{ sessions: any[] }>(mcpClient, 'session_list', {
        includeUsage: wantUsage,
        includeStale: wantStale,
      });
      if (res.isError) {
        console.log(chalk.red(`\nsession_list failed: ${res.text || '(no message)'}\n`));
        return;
      }
      const sessions = res.parsed?.sessions ?? [];
      if (wantJson) {
        console.log(JSON.stringify({ sessions }));
        return;
      }
      if (sessions.length === 0) {
        console.log(chalk.gray('\nNo active remote sessions (default scope = heartbeat within 2 min). Try --include-stale.'));
        console.log(chalk.gray('  Hint: peers show up here when another MCP host (Claude Code, Codex, Cursor, Gemini CLI, …)'));
        console.log(chalk.gray('  registers against the same brain. See `brainrouter-docs/mcp-install.md` for setup.\n'));
        return;
      }
      console.log(chalk.bold(`\nRemote sessions (${sessions.length})`));
      const KIND_W = Math.max(...sessions.map((s: any) => (s.clientKind ?? '').length), 6) + 2;
      const SK_W = 14;
      const HB_W = 12;
      const header = `  ${'CLIENT'.padEnd(KIND_W)}${'SESSION'.padEnd(SK_W)}${'HEARTBEAT'.padEnd(HB_W)}${wantUsage ? 'TOKENS    USD     ' : ''}WORKSPACE`;
      console.log(chalk.gray(header));
      const now = Date.now();
      for (const s of sessions) {
        const kind = chalk.cyan((s.clientKind ?? 'unknown').padEnd(KIND_W));
        const sk = chalk.gray((s.sessionKey ?? '').slice(0, 12).padEnd(SK_W));
        const hbMs = now - new Date(s.lastHeartbeatAt ?? 0).getTime();
        const hbAge = hbMs < 60_000
          ? `${Math.max(1, Math.round(hbMs / 1000))}s ago`
          : `${Math.round(hbMs / 60_000)}m ago`;
        const hbStr = (hbMs > 2 * 60_000 ? chalk.gray : chalk.green)(hbAge.padEnd(HB_W));
        let usageStr = '';
        if (wantUsage) {
          const usage = s.usage ?? {};
          const tokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
          const usd = typeof usage.totalUsd === 'number' ? usage.totalUsd : null;
          usageStr =
            chalk.gray(String(tokens).padStart(9)) + '  ' +
            chalk.gray((usd === null ? '   —   ' : `$${usd.toFixed(3)}`).padEnd(8));
        }
        const ws = chalk.gray(s.workspaceRoot ?? '');
        console.log(`  ${kind}${sk}${hbStr}${usageStr}${ws}`);
      }
      console.log();
    };

    if (!watch) {
      await renderOnce();
      return true;
    }

    // --watch loop: re-poll every 2s. Auto-exits after ~20 s
    // because the Ink REPL owns SIGINT — relying on Ctrl-C to
    // break out would leave the slash command awaiting forever
    // (the user sees "thinking" until the 10-min cap). 10 ticks
    // is enough to watch a peer come / go without blocking the
    // prompt for long; re-run the command for another window.
    const intervalMs = 2_000;
    const maxTicks = 10; // ~20s window
    let ticks = 0;
    console.log(chalk.bold(`\nWatching remote sessions (re-polls ${maxTicks}× every ${intervalMs / 1000}s, then auto-exits)…`));
    await new Promise<void>((resolve) => {
      const tick = async () => {
        try { await renderOnce(); } catch { /* network blip — keep watching */ }
      };
      tick();
      const handle = setInterval(() => {
        tick();
        if (++ticks >= maxTicks) {
          clearInterval(handle);
          console.log(chalk.gray('  Watch window expired. Re-run /agents --remote --watch to keep watching.'));
          resolve();
        }
      }, intervalMs);
    });
    return true;
  }

  // MAS-P5-T5 (§6.5): `/agents tree` renders the spawn hierarchy
  // (parent → children → workers) so you can see who spawned what.
  if (args[0] === 'tree') {
    const sessions = listSessions(agent.workspaceRoot);
    if (sessions.length === 0) {
      console.log(chalk.gray('\nNo child agents in this workspace yet.\n'));
      return true;
    }
    console.log(chalk.bold('\n🌳 Agent tree'));
    for (const line of formatAgentForest(buildAgentForest(sessions))) console.log(`  ${line}`);
    console.log(chalk.gray(`\n  ${sessions.length} agent${sessions.length === 1 ? '' : 's'} total. /agents why <id> for one's rationale; /agents transcript <id> for its run.\n`));
    return true;
  }

  // MAS-P5-T6 (§6.5): `/agents why <id>` — why this agent exists (role,
  // task, spawner, usage) so a fan-out can be debugged after the fact.
  if (args[0] === 'why' && args[1]) {
    const sessions = listSessions(agent.workspaceRoot);
    const match = sessions.find((s) => s.id === args[1] || s.id.startsWith(args[1]));
    if (!match) {
      console.log(chalk.red(`\nNo child session matches "${args[1]}". Run /agents tree to list, or pass a full id.\n`));
      return true;
    }
    console.log(chalk.bold('\n🔎 Why this agent'));
    for (const line of formatAgentWhy(match, sessions)) console.log(line.startsWith('  ') ? chalk.gray(line) : `  ${line}`);
    console.log();
    return true;
  }

  // MAS-P5-T7 (§6.5): `/agents transcript <id> [--tools] [--errors]` —
  // dump a child's transcript, optionally filtered to tool calls / errors.
  if (args[0] === 'transcript' && args[1]) {
    const match = listSessions(agent.workspaceRoot).find((s) => s.id === args[1] || s.id.startsWith(args[1]));
    if (!match) {
      console.log(chalk.red(`\nNo child session matches "${args[1]}". Run /agents tree to list.\n`));
      return true;
    }
    const childKey = childSessionKey(match.parentSessionKey, match.id);
    const entries = readTranscriptEntries(agent.workspaceRoot, childKey, Number.MAX_SAFE_INTEGER);
    const opts = { tools: args.includes('--tools'), errors: args.includes('--errors') };
    const filterNote = opts.tools || opts.errors ? ` (${[opts.tools && 'tools', opts.errors && 'errors'].filter(Boolean).join(' + ')})` : '';
    console.log(chalk.bold(`\n📜 Transcript — ${match.id} (${match.role})${filterNote}`));
    for (const line of formatAgentTranscript(entries as any, opts)) console.log(`  ${line}`);
    console.log();
    return true;
  }

  // MAS-P5-T8 (§6.5): `/agents replay <id>` — numbered, read-only
  // step-through of a child's run in order.
  if (args[0] === 'replay' && args[1]) {
    const match = listSessions(agent.workspaceRoot).find((s) => s.id === args[1] || s.id.startsWith(args[1]));
    if (!match) {
      console.log(chalk.red(`\nNo child session matches "${args[1]}". Run /agents tree to list.\n`));
      return true;
    }
    const childKey = childSessionKey(match.parentSessionKey, match.id);
    const entries = readTranscriptEntries(agent.workspaceRoot, childKey, Number.MAX_SAFE_INTEGER);
    console.log(chalk.bold(`\n⏯  Replay — ${match.id} (${match.role}) · ${match.status} · read-only`));
    for (const line of formatAgentReplay(entries as any)) console.log(`  ${chalk.gray(line)}`);
    console.log();
    return true;
  }

  // MAS-P2-M3: `/agents show <id>` renders the parent-execution
  // context snapshot persisted on the child's session record. Helps
  // users (and AI agents debugging spawn issues) see exactly what
  // the parent handed off to the child.
  if (args[0] === 'show' && args[1]) {
    const target = args[1];
    const sessions = listSessions(agent.workspaceRoot);
    const match = sessions.find((s) => s.id === target || s.id.startsWith(target));
    if (!match) {
      console.log(chalk.red(`\nNo child session matches "${target}". Try /agents to list, or pass a full id.\n`));
      return true;
    }
    const { formatSnapshotForHuman } = await import('@kinqs/brainrouter-core/orchestration');
    console.log(chalk.bold(`\nChild ${match.id} (${match.role}) — ${match.status}`));
    if (match.parentContext) {
      console.log(formatSnapshotForHuman(match.parentContext));
    } else {
      console.log(chalk.gray('  No parent context recorded — child was spawned before MAS-P2-M3 landed.'));
    }
    console.log();
    return true;
  }
  // A2 (0.4.11): `/agents diff <id> [show|apply|discard]` — review, apply, or
  // discard the recovery patch captured from an isolated child's worktree.
  // With merge-back a clean child's edits already landed (applied) and the
  // patch is a backup; a conflicting child's edits wait here for a manual
  // apply. Closes the loop the completion notice points at.
  if (args[0] === 'diff' && args[1]) {
    const action = (args[2] ?? 'show').toLowerCase();
    const match = listSessions(agent.workspaceRoot).find((s) => s.id === args[1] || s.id.startsWith(args[1]));
    if (!match) {
      console.log(chalk.red(`\nNo child session matches "${args[1]}". Run /agents tree to list.\n`));
      return true;
    }
    const patchPath = match.worktreePatchPath;
    const hasPatch = !!patchPath && fs.existsSync(patchPath);
    const changed = match.worktreeChangedFiles ?? 0;
    // Apply from the child's source repo root so the patch's repo-relative
    // paths line up (workspaceRoot may be a subdir of the repo).
    const applyCwd = match.childWorkspaceIsolation?.sourceRoot ?? agent.workspaceRoot;

    if (action === 'apply') {
      if (!hasPatch) {
        console.log(chalk.red(`\n  No recovery patch on disk for ${match.id}${patchPath ? " (GC'd or discarded)" : ''}.\n`));
        return true;
      }
      const { applyPatchFile } = await import('@kinqs/brainrouter-core/worktree');
      const res = applyPatchFile(applyCwd, patchPath!);
      if (!res.ok) {
        console.log(chalk.yellow(`\n  Patch does not apply cleanly: ${res.error}`));
        console.log(chalk.gray(`  Resolve it by hand: git apply --3way ${patchPath}\n`));
        return true;
      }
      updateSession(agent.workspaceRoot, match.id, { worktreeApplied: true, worktreeApplyError: undefined });
      console.log(chalk.green(`\n  ✓ Applied ${changed} file(s) from ${match.id} onto your tree.\n`));
      return true;
    }

    if (action === 'discard') {
      if (hasPatch) { try { fs.rmSync(patchPath!, { force: true }); } catch { /* noop */ } }
      console.log(chalk.yellow(`\n  ✓ Discarded the recovery patch for ${match.id}.\n`));
      return true;
    }

    // Default: show.
    console.log(chalk.bold(`\n🩹 Worktree changes — ${match.id} (${match.role}) · ${match.status}`));
    if (!match.worktreeChangedFiles && !match.worktreeDiff && !patchPath) {
      console.log(chalk.gray('  No isolated-worktree changes recorded for this agent.\n'));
      return true;
    }
    const state = match.worktreeApplied
      ? chalk.green('merged into your tree')
      : match.worktreeApplyError
        ? chalk.yellow(`NOT merged (${match.worktreeApplyError})`)
        : chalk.gray('not applied');
    console.log(`  ${chalk.cyan('files')}   ${changed}`);
    console.log(`  ${chalk.cyan('status')}  ${state}`);
    console.log(`  ${chalk.cyan('patch')}   ${patchPath ? chalk.gray(hasPatch ? patchPath : `${patchPath} (gone — GC'd or discarded)`) : chalk.gray('(none)')}`);
    if (match.worktreeDiff) {
      console.log(chalk.bold('\n  preview:'));
      for (const line of match.worktreeDiff.split('\n')) console.log(`    ${chalk.gray(line)}`);
    }
    const hints: string[] = [];
    if (hasPatch && !match.worktreeApplied) hints.push(`/agents diff ${match.id} apply`);
    if (hasPatch) hints.push(`/agents diff ${match.id} discard`);
    console.log(hints.length ? chalk.gray(`\n  ${hints.join('  ·  ')}\n`) : '');
    return true;
  }
  if (args[0] === 'defs') {
    const defs = listAgentDefs(agent.workspaceRoot);
    console.log(chalk.bold('\nAgent Definitions:'));
    const ID_W = Math.max(...defs.map((l) => l.def.id.length), 4) + 2;
    const TIER_W = 12;
    const SRC_W = 10;
    console.log(
      chalk.gray(
        `  ${'ID'.padEnd(ID_W)}${'TIER'.padEnd(TIER_W)}${'SOURCE'.padEnd(SRC_W)}PATH`,
      ),
    );
    for (const loaded of defs) {
      const idStr = chalk.cyan(loaded.def.id.padEnd(ID_W));
      const tierColor = loaded.def.tier === 'reasoning' ? chalk.blue : chalk.yellow;
      const tierStr = tierColor(loaded.def.tier.padEnd(TIER_W));
      const srcStr = chalk.gray(loaded.source.padEnd(SRC_W));
      console.log(`  ${idStr}${tierStr}${srcStr}${chalk.gray(loaded.filePath)}`);
    }
    console.log();
    return true;
  }
  // `--watch`: poll the same data shape every second and re-render the
  // running-children list inline. Same shape as `/agents` and the Ink
  // status row so the user gets a single mental model (roadmap §3).
  if (args.includes('--watch')) {
    const intervalMs = 1000;
    const maxTicks = 600; // ~10 min safety cap; Ctrl-C exits early.
    let ticks = 0;
    console.log(chalk.bold('\nWatching child agents (Ctrl-C to stop)…'));
    await new Promise<void>((resolve) => {
      const handle = setInterval(() => {
        reconcileStale(agent.workspaceRoot);
        const running = listSessions(agent.workspaceRoot)
          .filter((s) => s.status === 'pending' || s.status === 'running');
        const stamp = new Date().toISOString().slice(11, 19);
        if (running.length === 0) {
          process.stdout.write(`\r[${stamp}] no running children${' '.repeat(40)}`);
        } else {
          const parts = running.map((s) => `${s.id.slice(0, 14)} (${s.role})`).join(', ');
          process.stdout.write(`\r[${stamp}] running: ${parts}${' '.repeat(10)}`);
        }
        if (++ticks >= maxTicks) {
          clearInterval(handle);
          process.stdout.write('\n');
          resolve();
        }
      }, intervalMs);
      const onSig = () => { clearInterval(handle); process.stdout.write('\n'); process.off('SIGINT', onSig); resolve(); };
      process.once('SIGINT', onSig);
    });
    console.log();
    return true;
  }
  reconcileStale(agent.workspaceRoot);
  const sessions = listSessions(agent.workspaceRoot);
  // `--json` for scripting. Emits a single JSON line on stdout so
  // tmux-resurrect, status bars, agent pickers, and pipelines can
  // parse the live session list reliably.
  if (args.includes('--json')) {
    const payload = sessions.map((s) => ({
      id: s.id,
      role: s.role,
      status: s.status,
      label: s.label,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      completedAt: s.completedAt,
      prompt: s.prompt,
      usage: s.usage,
      parentSessionKey: s.parentSessionKey,
      finalOutputPreview: s.finalOutput ? String(s.finalOutput).slice(0, 280) : undefined,
    }));
    // process.stdout.write with no chalk so jq / scripts get clean JSON.
    process.stdout.write(JSON.stringify({ sessions: payload }) + '\n');
    return true;
  }
  console.log(chalk.bold('\nChild Agent Sessions:'));
  // BUILD-LOOP P4 — when a run_workflow/build is progressing, head the list with
  // its active phase so the child agents below are seen in that context.
  {
    const active = activeRun(agent.workspaceRoot);
    if (active) {
      const ph = formatActivePhase(active);
      console.log(chalk.magenta(`  ⟳ workflow ${active.slug}${ph ? ` · ${ph}` : ''}`));
    }
  }
  if (sessions.length === 0) {
    console.log(chalk.yellow('  No child agents yet. Use /spawn <role> <prompt> to start one.'));
  } else {
    for (const s of sessions) {
      const colorFn =
        s.status === 'completed' ? chalk.green :
        s.status === 'failed' ? chalk.red :
        s.status === 'stale' ? chalk.yellow :
        s.status === 'closed' ? chalk.gray : chalk.cyan;
      console.log(`  ${colorFn(formatSessionSummary(s))}`);
      if (s.usage) {
        console.log(chalk.gray(`      tokens: ${s.usage.promptTokens.toLocaleString()}↑ ${s.usage.completionTokens.toLocaleString()}↓ across ${s.usage.calls} call${s.usage.calls === 1 ? '' : 's'} (${s.usage.turns} turn${s.usage.turns === 1 ? '' : 's'})`));
      }
      if (s.prompt) {
        console.log(chalk.gray(`      prompt: ${s.prompt.replace(/\s+/g, ' ').slice(0, 100)}${s.prompt.length > 100 ? '…' : ''}`));
      }
    }
    console.log(chalk.gray('\n  (pipe-friendly output: /agents --json)'));
    console.log(chalk.gray('  See also: /agents --remote to list peer CLIs/hosts attached to the same brain (federation).'));
  }
  console.log();
  return true;
}

export async function handleAgent(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  const showMode = args[0] === 'show';
  const id = showMode ? args[1] : args[0];
  if (!id) { console.log(chalk.red('\nUsage: /agent <id> [--full]\n       /agent show <id>\n')); return false; }
  const full = showMode || args.includes('--full');
  const s = getSession(agent.workspaceRoot, id);
  if (!s) { console.log(chalk.red(`\nNo session ${id}\n`)); return false; }
  console.log(chalk.bold(`\nAgent ${s.id}`));
  console.log(`  Role:    ${chalk.cyan(s.role)} (${s.access})`);
  console.log(`  Status:  ${chalk.yellow(s.status)}`);
  console.log(`  Started: ${chalk.gray(s.startedAt)}`);
  if (s.completedAt) console.log(`  Ended:   ${chalk.gray(s.completedAt)}`);
  if (s.label) console.log(`  Label:   ${s.label}`);
  console.log(`  Prompt:  ${chalk.gray(s.prompt.slice(0, 240))}`);
  if (s.usage) {
    console.log(`  Tokens:  ${chalk.cyan(s.usage.promptTokens.toLocaleString())}↑  ${chalk.cyan(s.usage.completionTokens.toLocaleString())}↓  ${chalk.gray(`(${s.usage.calls} LLM call${s.usage.calls === 1 ? '' : 's'}, ${s.usage.turns} turn${s.usage.turns === 1 ? '' : 's'})`)}`);
  }
  // MAS-P3-P3.2: render the parsed output contract (field-labelled) when
  // the role has one and the child honoured it.
  if (s.finalOutput) {
    const parsed = parseChildOutput(s.role, s.finalOutput);
    if (parsed && parsed.contractStatus === 'parsed') {
      console.log(`\n${chalk.bold('Contract output:')}`);
      for (const [field, value] of Object.entries(parsed.fields)) {
        console.log(`  ${chalk.cyan(field)}: ${chalk.gray(value.replace(/\n+/g, ' ').slice(0, 200))}`);
      }
    } else if (parsed && parsed.missing.length > 0) {
      console.log(`\n${chalk.yellow('Contract unparsed')} ${chalk.gray(`(missing: ${parsed.missing.join(', ')})`)}`);
    }
  }
  if (s.finalOutput) console.log(`\n${chalk.bold('Final output:')}\n${s.finalOutput}`);
  if (s.error) console.log(`\n${chalk.red('Error:')} ${s.error}`);
  const entries = readTranscriptEntries(agent.workspaceRoot, childSessionKey(s.parentSessionKey, s.id), full ? 1000 : 10);
  if (entries.length > 0) {
    console.log(chalk.bold(`\n${full ? 'Full' : 'Recent'} transcript (${entries.length} entries):`));
    for (const e of entries) {
      const text = formatTranscriptContent(e.content ?? e.tool_calls ?? '');
      // A role:'user' entry WITH a name is an injected system/guard message,
      // not a user turn — label it `guard` so the dump isn't misleading.
      const role = e.role === 'user' && e.name ? e.name : e.role;
      const roleColor = role === 'user' ? chalk.yellow : role === 'assistant' ? chalk.green : role === 'tool' ? chalk.magenta : chalk.cyan;
      console.log(`  ${chalk.gray(e.timestamp)} ${roleColor(role)} ${chalk.gray(text)}`);
    }
    if (!full && entries.length === 10) {
      console.log(chalk.gray(`\n  (use /agent ${id} --full to see all entries)`));
    }
  }
  console.log();
  return true;
}
