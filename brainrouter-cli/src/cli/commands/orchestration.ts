/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import chalk from 'chalk';
import { callMcpTool, childSessionKey } from '../../runtime/mcpUtils.js';
import { listRoles } from '../../orchestration/roles.js';
import { listAll as listAgentDefs } from '../../orchestration/agentRegistry.js';
import { formatSessionSummary, getSession, listSessions, reconcileStale } from '../../orchestration/orchestrator.js';
import { readPreferences, writePreferences } from '../../state/preferencesStore.js';
import { readTranscriptEntries, appendTranscriptEntry } from '../../state/sessionStore.js';
import { readGoal, setGoal, pauseGoal } from '../../state/goalStore.js';
import { buildHandoffPacket, resolveHandoffTarget, type HandoffPacket } from '../../orchestration/handoff.js';
import { getLoopState, stopLoop } from '../../runtime/loopRunner.js';
import type { CommandContext } from './_context.js';
import { formatTranscriptContent } from './_helpers.js';
import { formatIncomingBanner } from '../incomingBanner.js';
import { resolveAutoChainMode, isAutoChainMode } from '../../orchestration/autoChain.js';
import { resolveDelegationPolicy, isDelegationPolicy } from '../../orchestration/delegationPolicy.js';
import { listPacks, packAgentIds } from '../../orchestration/packs.js';
import { readPackState, isPackEnabled, enablePack, disablePack } from '../../state/packStore.js';
import { listWorkers, readWorkerMeta, readWorkerSummary, closeWorker, type WorkerStatus } from '../../state/workerStore.js';
import { parseChildOutput } from '../../orchestration/outputContracts.js';

interface DmAddressResolution {
  to: string;
  error?: string;
}

function isLikelyFullSessionKey(target: string): boolean {
  return target.length >= 32 || target.includes(':child:');
}

async function resolveDmAddress(mcpClient: CommandContext['mcpClient'], target: string): Promise<DmAddressResolution> {
  const rawTarget = target.trim();
  const res = await callMcpTool<{ sessions: Array<{ sessionKey?: string }> }>(
    mcpClient,
    'session_list',
    { includeStale: true },
  );
  if (res.isError) {
    return { to: rawTarget };
  }

  const sessionKeys = (res.parsed?.sessions ?? [])
    .map((s) => s.sessionKey)
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  const exact = sessionKeys.find((key) => key === rawTarget);
  if (exact) return { to: exact };

  const matches = sessionKeys.filter((key) => key.startsWith(rawTarget));
  if (matches.length === 1) return { to: matches[0] };
  if (matches.length > 1) {
    const prefixes = matches.map((key) => key.slice(0, 12)).join(', ');
    return {
      to: rawTarget,
      error: `Ambiguous session prefix "${rawTarget}" matched ${matches.length} sessions (${prefixes}). Use more characters.`,
    };
  }
  if (!isLikelyFullSessionKey(rawTarget)) {
    return {
      to: rawTarget,
      error: `No active or recently-seen session matched prefix "${rawTarget}". Use /agents --remote to copy a session prefix.`,
    };
  }
  return { to: rawTarget };
}

export async function tryHandleOrchestrationCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/workers':
    {
      // MAS-P5-T3 — persistent worker threads. list | info <id> | close <id>.
      const sub = (args[0] ?? 'list').toLowerCase();
      const ws = agent.workspaceRoot;
      const dot = (s: WorkerStatus) =>
        s === 'running' ? chalk.cyan('●') : s === 'completed' ? chalk.green('●') : s === 'failed' ? chalk.red('●') : chalk.gray('○');
      if (sub === 'list') {
        const workers = listWorkers(ws);
        if (!workers.length) {
          console.log(chalk.gray('\nNo worker threads. (workers persist under .brainrouter/cli/workers/)\n'));
          return true;
        }
        console.log(chalk.bold('\nWorker threads:'));
        for (const w of workers) {
          console.log(`  ${dot(w.status)} ${chalk.cyan(w.id)} ${chalk.gray(`(${w.role})`)} — ${w.status} · ${w.goal.slice(0, 60)}${w.goal.length > 60 ? '…' : ''}`);
        }
        console.log(chalk.gray('\n  /workers info <id> | close <id>\n'));
        return true;
      }
      if (sub === 'info') {
        const id = args[1];
        const w = id ? readWorkerMeta(ws, id) : null;
        if (!w) { console.log(chalk.red(`\nNo worker "${id ?? ''}". Try /workers.\n`)); return true; }
        console.log(chalk.bold(`\nWorker ${chalk.cyan(w.id)} ${chalk.gray(`(${w.role})`)}`));
        console.log(`  status: ${w.status}   depth: ${w.depth}   pid: ${w.pid ?? '—'}`);
        if (w.ownership) console.log(`  ownership: ${w.ownership}`);
        console.log(`  goal: ${w.goal}`);
        console.log(chalk.gray(`  created ${w.createdAt} · updated ${w.updatedAt}`));
        const summary = readWorkerSummary(ws, w.id);
        if (summary) console.log(chalk.gray('\n  --- summary.md ---\n') + summary);
        console.log();
        return true;
      }
      if (sub === 'close') {
        const id = args[1];
        if (!id) { console.log(chalk.yellow('\nUsage: /workers close <id>\n')); return true; }
        const w = closeWorker(ws, id);
        console.log(w ? chalk.green(`\nWorker ${id} closed.\n`) : chalk.red(`\nNo worker "${id}".\n`));
        return true;
      }
      console.log(chalk.gray('Usage: /workers [list] | info <id> | close <id>'));
      return true;
    }
    case '/pack':
    {
      // MAS-P5-T4 — agent-definition packs. list | enable <n> | disable <n> | info <n>
      const sub = (args[0] ?? 'list').toLowerCase();
      const name = args[1];
      const ws = agent.workspaceRoot;
      const packs = listPacks(ws);
      const enabled = readPackState(ws).enabled;
      if (sub === 'list') {
        if (!packs.length) {
          console.log(chalk.gray('No packs found. (built-in, ~/.config/brainrouter/packs, .brainrouter/packs)'));
          return true;
        }
        console.log(chalk.bold('\nAgent packs:') + chalk.gray(' (opt-in — enable to add their agents)'));
        for (const p of packs) {
          const on = isPackEnabled(enabled, p.name);
          console.log(
            `  ${on ? chalk.green('●') : chalk.gray('○')} ${chalk.cyan(p.name)} ` +
              `${chalk.gray(`(${p.source} · v${p.version})`)}${p.description ? ` — ${p.description}` : ''}`,
          );
        }
        console.log(chalk.gray('\n  /pack enable <name> | disable <name> | info <name>'));
        return true;
      }
      if (sub === 'info') {
        const p = packs.find((x) => x.name === name);
        if (!p) { console.log(chalk.red(`No pack named "${name ?? ''}". Try /pack list.`)); return true; }
        const ids = packAgentIds(p);
        console.log(chalk.bold(`\nPack: ${chalk.cyan(p.name)} ${chalk.gray(`(${p.source} · v${p.version})`)}`));
        if (p.description) console.log(`  ${p.description}`);
        console.log(chalk.gray(`  dir: ${p.dir}`));
        console.log(`  enabled: ${isPackEnabled(enabled, p.name) ? chalk.green('yes') : chalk.gray('no')}`);
        console.log(`  agents (${ids.length}): ${ids.length ? ids.join(', ') : chalk.gray('none')}`);
        console.log();
        return true;
      }
      if (sub === 'enable' || sub === 'disable') {
        if (!name) { console.log(chalk.red(`Usage: /pack ${sub} <name>`)); return true; }
        if (!packs.some((x) => x.name === name)) { console.log(chalk.red(`No pack named "${name}". Try /pack list.`)); return true; }
        if (sub === 'enable') enablePack(ws, name); else disablePack(ws, name);
        console.log(chalk.green(`Pack "${name}" ${sub}d for this workspace.`) + chalk.gray(' (affects newly spawned agents)'));
        return true;
      }
      console.log(chalk.gray('Usage: /pack list | enable <name> | disable <name> | info <name>'));
      return true;
    }
    case '/roles':
    {
      console.log(chalk.bold('\nAvailable Agent Roles:'));
      for (const r of listRoles()) {
        console.log(`  ${chalk.cyan(r.name)} (${chalk.gray(r.defaultAccess)}) - ${r.description}`);
      }
      console.log();
      return true;
    }
    case '/inbox':
    {
      // Federation Stage 3 — read THIS session's inbox on demand.
      //
      // Why this exists: the background poller only *peeks* the inbox
      // (peek:true) to render the "you got mail" banner — it never
      // consumes the row, and an agent has no reliable way to read the
      // inbox itself (it doesn't know its own federation sessionKey).
      // `/inbox` is the deterministic read path: it uses the runtime's
      // known session key and, by default, marks the messages delivered
      // (so they don't re-surface). `--peek` inspects without consuming;
      // `--all` also shows already-delivered history.
      const peek = args.includes('--peek');
      const includeDelivered = args.includes('--all');
      const selfKey = agent.getFederationSessionKey?.() ?? agent.sessionKey;
      const res = await callMcpTool<{
        messages?: Array<{ id: string; fromSessionKey: string; kind: string; payload: any; createdAt: string }>;
      }>(mcpClient, 'session_inbox_read', { sessionKey: selfKey, peek, includeDelivered });
      if (res.isError) {
        console.log(chalk.red(`\nsession_inbox_read failed: ${res.text || '(no message)'}\n`));
        return true;
      }
      const messages = res.parsed?.messages ?? [];
      if (messages.length === 0) {
        console.log(chalk.gray('\nInbox empty.'));
        console.log(chalk.gray(includeDelivered ? '  (no messages at all)\n' : '  (nothing unread — try /inbox --all to see delivered history)\n'));
        return true;
      }
      console.log(chalk.bold(`\nInbox — ${messages.length} message${messages.length === 1 ? '' : 's'}${peek ? ' (peek)' : ''}`));
      for (const m of messages) {
        const text = m.kind === 'text' && typeof m.payload?.text === 'string'
          ? m.payload.text
          : `(${m.kind} payload)`;
        console.log(formatIncomingBanner({ id: m.id, fromSessionKey: m.fromSessionKey, text, receivedAt: m.createdAt }));
      }
      console.log(peek
        ? chalk.gray('\n(peek — messages left unread. Run /inbox without --peek to mark them delivered.)\n')
        : chalk.gray('\n(marked delivered.)\n'));
      return true;
    }
    case '/handoff':
    {
      // Federation Stage 4 — hand the current goal + context to another
      // active session. `/handoff <target> [note]` sends; `/handoff list`
      // shows pending inbound handoffs; `/handoff accept [fromPrefix]`
      // adopts one as a fresh local goal. Target may be a sessionKey, a
      // unique prefix, or `<clientKind>:next-idle`.
      const selfKey = agent.getFederationSessionKey?.() ?? agent.sessionKey;
      const sub = (args[0] ?? '').toLowerCase();

      if (sub === 'list' || sub === 'accept') {
        const res = await callMcpTool<{ messages?: Array<{ id: string; fromSessionKey: string; kind: string; payload: any; createdAt: string }> }>(
          mcpClient,
          'session_inbox_read',
          { sessionKey: selfKey, peek: true },
        );
        if (res.isError) {
          console.log(chalk.red(`\nsession_inbox_read failed: ${res.text || '(no message)'}\n`));
          return true;
        }
        const handoffs = (res.parsed?.messages ?? []).filter((m) => m.kind === 'goal-handoff');
        if (handoffs.length === 0) {
          console.log(chalk.gray('\nNo pending goal handoffs in your inbox.\n'));
          return true;
        }
        if (sub === 'list') {
          console.log(chalk.bold(`\nPending handoffs (${handoffs.length})`));
          for (const m of handoffs) {
            const p = (m.payload ?? {}) as HandoffPacket;
            console.log(`  ${chalk.cyan(m.fromSessionKey.slice(0, 12))}…  ${chalk.gray(`(${p.originatingClient ?? 'unknown'})`)}  ${String(p.goal ?? '').slice(0, 80)}`);
          }
          console.log(chalk.gray('\n  Adopt one with: /handoff accept [fromPrefix]\n'));
          return true;
        }
        // accept
        const fromPrefix = args[1];
        const chosen = fromPrefix
          ? handoffs.find((m) => m.fromSessionKey.startsWith(fromPrefix))
          : handoffs[handoffs.length - 1];
        if (!chosen) {
          console.log(chalk.yellow(`\nNo pending handoff from "${fromPrefix}". Run /handoff list.\n`));
          return true;
        }
        const packet = (chosen.payload ?? {}) as HandoffPacket;
        if (!packet.goal) {
          console.log(chalk.red('\nHandoff packet has no goal text — ignoring.\n'));
          return true;
        }
        try {
          setGoal(agent.workspaceRoot, packet.goal, agent.sessionKey, { force: true });
        } catch (err: any) {
          console.log(chalk.red(`\nFailed to adopt goal: ${err?.message ?? err}\n`));
          return true;
        }
        // Tag the adopted context so the next turn's briefing can use it.
        appendTranscriptEntry(agent.workspaceRoot, agent.sessionKey, {
          role: 'system',
          name: 'handoff-context',
          content: JSON.stringify({
            from: chosen.fromSessionKey,
            originatingClient: packet.originatingClient,
            originatingWorkspace: packet.originatingWorkspace,
            note: packet.note,
            recentTranscript: packet.recentTranscript,
          }),
        });
        await callMcpTool(mcpClient, 'session_inbox_ack', { sessionKey: selfKey, ids: [chosen.id] });
        console.log(chalk.green(`\n✓ Adopted goal from ${chosen.fromSessionKey.slice(0, 12)}… — “${packet.goal.slice(0, 80)}”.`));
        console.log(chalk.gray('  Handoff context attached; run /briefing or just continue.\n'));
        return true;
      }

      // Default: send a handoff.
      const target = args[0];
      const note = args.slice(1).join(' ').trim();
      if (!target) {
        console.log(chalk.red('\nUsage: /handoff <sessionKey | prefix | <clientKind>:next-idle> [note]'));
        console.log(chalk.gray('   or: /handoff list | /handoff accept [fromPrefix]\n'));
        return true;
      }
      const goal = readGoal(agent.workspaceRoot, agent.sessionKey);
      if (!goal || !goal.text.trim()) {
        console.log(chalk.yellow('\nNothing to hand off — set a goal first with /goal <text>.\n'));
        return true;
      }
      const listRes = await callMcpTool<{ sessions: any[] }>(mcpClient, 'session_list', { includeStale: false });
      if (listRes.isError) {
        console.log(chalk.red(`\nsession_list failed: ${listRes.text || '(no message)'}\n`));
        return true;
      }
      const resolved = resolveHandoffTarget(listRes.parsed?.sessions ?? [], target, selfKey);
      if (resolved.error || !resolved.to) {
        console.log(chalk.yellow(`\n${resolved.error ?? 'Could not resolve handoff target.'}\n`));
        return true;
      }
      const transcript = readTranscriptEntries(agent.workspaceRoot, agent.sessionKey, 12)
        .map((e) => `${e.role}: ${formatTranscriptContent(e.content ?? '')}`)
        .join('\n');
      const packet = buildHandoffPacket({
        goal: goal.text,
        fromSessionKey: selfKey,
        originatingClient: 'brainrouter-cli',
        originatingWorkspace: agent.workspaceRoot,
        recentTranscript: transcript,
        note: note || undefined,
        now: new Date().toISOString(),
      });
      const sendRes = await callMcpTool<{ delivered: number }>(mcpClient, 'session_send', {
        from: selfKey,
        to: resolved.to,
        kind: 'goal-handoff',
        payload: packet,
      });
      if (sendRes.isError) {
        console.log(chalk.red(`\nsession_send failed: ${sendRes.text || '(no message)'}\n`));
        return true;
      }
      if ((sendRes.parsed?.delivered ?? 0) === 0) {
        console.log(chalk.yellow(`\nNo active session matched "${resolved.to}" (handoffs only reach peers active within 2 min).\n`));
        return true;
      }
      // Sender's goal is now paused — the work has moved.
      pauseGoal(agent.workspaceRoot, agent.sessionKey);
      console.log(chalk.green(`\n✓ Handed off to ${resolved.to.slice(0, 12)}… — local goal paused (handed-off-to:${resolved.to.slice(0, 8)}).`));
      console.log(chalk.gray('  The recipient runs /handoff accept to adopt it.\n'));
      return true;
    }
    case '/dm':
    {
      // Federation Stage 3 (FED-S3-T6) — point-to-point chat. Takes a
      // sessionKey (or a 12-char prefix from `/agents --remote`) plus a
      // message. Drops the message into the recipient's inbox; that
      // session's poll picks it up within ~5 s and renders a banner
      // above its next prompt.
      const target = args[0];
      const message = args.slice(1).join(' ').trim();
      if (!target || !message) {
        console.log(chalk.red('\nUsage: /dm <sessionKey | sessionKey-prefix> <message>\n'));
        return true;
      }
      const fromKey = agent.getFederationSessionKey?.() ?? agent.sessionKey;
      const resolved = await resolveDmAddress(mcpClient, target);
      if (resolved.error) {
        console.log(chalk.yellow(`\n${resolved.error}\n`));
        return true;
      }
      const res = await callMcpTool<{ delivered: number; ids: string[] }>(
        mcpClient,
        'session_send',
        { from: fromKey, to: resolved.to, kind: 'text', payload: { text: message } },
      );
      if (res.isError) {
        console.log(chalk.red(`\nsession_send failed: ${res.text || '(no message)'}\n`));
        return true;
      }
      const delivered = res.parsed?.delivered ?? 0;
      if (delivered === 0) {
        console.log(chalk.yellow(`\nNo active session matched "${resolved.to}" (heartbeats only within the last 2 min reach the inbox).\n`));
      } else {
        console.log(chalk.gray(`\nDelivered to ${delivered} session.\n`));
      }
      return true;
    }
    case '/broadcast':
    {
      // Federation Stage 3 (FED-S3-T6) — broadcast text to every active
      // peer under your userId. Optional first arg `<clientKind>:*`
      // narrows the broadcast (e.g. `/broadcast claude-code:* heads up`).
      const first = args[0];
      const looksLikePattern = typeof first === 'string' && /^[a-z][a-z0-9-]*:\*$/i.test(first);
      const address = looksLikePattern ? first : '*';
      const messageParts = looksLikePattern ? args.slice(1) : args;
      const message = messageParts.join(' ').trim();
      if (!message) {
        console.log(chalk.red('\nUsage: /broadcast [<clientKind>:*] <message>\n'));
        console.log(chalk.gray('  Examples:'));
        console.log(chalk.gray('    /broadcast heads up, deploying main'));
        console.log(chalk.gray('    /broadcast claude-code:* please pull latest\n'));
        return true;
      }
      const fromKey = agent.getFederationSessionKey?.() ?? agent.sessionKey;
      const res = await callMcpTool<{ delivered: number; ids: string[] }>(
        mcpClient,
        'session_send',
        { from: fromKey, to: address, kind: 'text', payload: { text: message } },
      );
      if (res.isError) {
        console.log(chalk.red(`\nsession_send failed: ${res.text || '(no message)'}\n`));
        return true;
      }
      const delivered = res.parsed?.delivered ?? 0;
      const tag = looksLikePattern ? `${first} peers` : 'active peers';
      if (delivered === 0) {
        console.log(chalk.yellow(`\nNo ${tag} are currently active (no heartbeat within the last 2 min).\n`));
      } else {
        console.log(chalk.gray(`\nBroadcast delivered to ${delivered} ${tag}.\n`));
      }
      return true;
    }
    case '/agents':
    {
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
        const { formatSnapshotForHuman } = await import('../../orchestration/parentContext.js');
        console.log(chalk.bold(`\nChild ${match.id} (${match.role}) — ${match.status}`));
        if (match.parentContext) {
          console.log(formatSnapshotForHuman(match.parentContext));
        } else {
          console.log(chalk.gray('  No parent context recorded — child was spawned before MAS-P2-M3 landed.'));
        }
        console.log();
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
    case '/agent':
    {
      const showMode = args[0] === 'show';
      const id = showMode ? args[1] : args[0];
      if (!id) { console.log(chalk.red('\nUsage: /agent <id> [--full]\n       /agent show <id>\n')); break; }
      const full = showMode || args.includes('--full');
      const s = getSession(agent.workspaceRoot, id);
      if (!s) { console.log(chalk.red(`\nNo session ${id}\n`)); break; }
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
          const roleColor = e.role === 'user' ? chalk.yellow : e.role === 'assistant' ? chalk.green : e.role === 'tool' ? chalk.magenta : chalk.cyan;
          console.log(`  ${chalk.gray(e.timestamp)} ${roleColor(e.role)} ${chalk.gray(text)}`);
        }
        if (!full && entries.length === 10) {
          console.log(chalk.gray(`\n  (use /agent ${id} --full to see all entries)`));
        }
      }
      console.log();
      return true;
    }
    case '/spawn':
    {
      const role = args[0];
      const prompt = args.slice(1).join(' ').trim();
      if (!role || !prompt) {
        console.log(chalk.red('\nUsage: /spawn <role> <prompt>\n'));
        return true;
      }
      // Validate the role upfront — saves an LLM round-trip that would just
      // error out server-side anyway.
      const validRoles = listRoles().map((r) => r.name);
      if (!validRoles.includes(role)) {
        console.log(chalk.red(`\nUnknown role "${role}". Available: ${validRoles.join(', ')}.\n`));
        return true;
      }
      ctx.repl.runAgentTurn(
        `Use the delegate_agent tool to start a ${role} child agent (background) with this prompt:\n\n${prompt}\n\nReturn the child agent id when done. If you need the result immediately, use task_agent instead.`,
      );
      return true;
    }
    case '/wait':
    {
      const id = args[0];
      const ms = args[1] ? Number(args[1]) : 120000;
      if (!id) { console.log(chalk.red('\nUsage: /wait <id> [timeoutMs]\n')); break; }
      ctx.repl.runAgentTurn(
        `Use the wait_agent tool with id="${id}" and timeoutMs=${ms}. Then summarize the child output for me.`,
      );
      return true;
    }
    case '/delegation-policy':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const current = resolveDelegationPolicy(prefs);
      if (!arg) {
        console.log(chalk.bold(`\nDelegation policy: ${current === 'auto' ? chalk.gray('auto') : chalk.green(current)}`));
        console.log(chalk.gray('  Controls whether/when the agent may spawn child agents:'));
        console.log(chalk.gray('    auto                    — spawn freely (default)'));
        console.log(chalk.gray('    ask-before-spawn        — confirm before any top-level spawn'));
        console.log(chalk.gray('    ask-before-write-child  — confirm before a write/shell child'));
        console.log(chalk.gray('    no-children             — never spawn'));
        console.log(chalk.gray('  Set with: /delegation-policy auto | ask-before-spawn | ask-before-write-child | no-children\n'));
        return true;
      }
      if (!isDelegationPolicy(arg)) {
        console.log(chalk.yellow(`\nUnknown policy "${arg}". Use: auto | ask-before-spawn | ask-before-write-child | no-children\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { delegationPolicy: arg });
      console.log(chalk.green(`\n✓ Delegation policy set to ${arg}.\n`));
      return true;
    }
    case '/auto-chain':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const mode = resolveAutoChainMode(prefs);
      if (!arg) {
        console.log(chalk.bold(`\nAuto-chain: ${mode === 'off' ? chalk.gray('off') : chalk.green(mode)}`));
        console.log(chalk.gray('  After a worker finishes, automatically chain follow-up agents on its output:'));
        console.log(chalk.gray('    review  — a reviewer reads the diff for correctness/regressions'));
        console.log(chalk.gray('    verify  — a verifier runs the tests/build to confirm it works'));
        console.log(chalk.gray('    both    — reviewer + verifier'));
        console.log(chalk.gray('    off     — no follow-ups'));
        console.log(chalk.gray('  Set with: /auto-chain review | verify | both | off\n'));
        return true;
      }
      if (!isAutoChainMode(arg)) {
        console.log(chalk.yellow(`\nUnknown mode "${arg}". Use: review | verify | both | off\n`));
        return true;
      }
      // Keep the legacy boolean in sync so older readers stay consistent.
      writePreferences(agent.workspaceRoot, { autoChain: arg, autoReview: arg === 'review' || arg === 'both' });
      console.log(chalk.green(`\n✓ Auto-chain set to ${arg}.\n`));
      return true;
    }
    case '/auto-review':
    {
      // Thin alias over /auto-chain (MAS-P4-T4): on → review, off → off.
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const mode = resolveAutoChainMode(prefs);
      if (!arg) {
        const on = mode === 'review' || mode === 'both';
        console.log(chalk.bold(`\nAuto-review: ${on ? chalk.green('on') : chalk.gray('off')}`) + chalk.gray(`  (auto-chain mode: ${mode})`));
        console.log(chalk.gray('  Alias for /auto-chain review|off. For verify/both, use /auto-chain.\n'));
        return true;
      }
      const next = arg === 'on' || arg === 'true';
      writePreferences(agent.workspaceRoot, { autoChain: next ? 'review' : 'off', autoReview: next });
      console.log(chalk.green(`\n✓ Auto-review ${next ? 'enabled' : 'disabled'}.\n`));
      return true;
    }
    case '/kill':
    {
      const id = args[0];
      if (!id) { console.log(chalk.red('\nUsage: /kill <agent-id>\n')); break; }
      const session = getSession(agent.workspaceRoot, id);
      if (!session) { console.log(chalk.red(`\nNo agent session with id "${id}".\n`)); break; }
      if (session.status !== 'pending' && session.status !== 'running') {
        console.log(chalk.gray(`\nAgent ${id} is already ${session.status}.\n`));
        return true;
      }
      ctx.repl.runAgentTurn(
        `Use the close_agent tool with id="${id}" and reason="user-requested kill". Then confirm the close result.`,
      );
      return true;
    }
    case '/ps':
    {
      const loopState = getLoopState();
      console.log(chalk.bold('\nBackground tasks'));
      if (!loopState) {
        console.log(chalk.gray('  No /loop running.'));
      } else {
        console.log(`  Loop: ${chalk.cyan(loopState.prompt)} (${loopState.iterations} ticks, every ${loopState.intervalMs}ms)`);
      }
      reconcileStale(agent.workspaceRoot);
      const sessions = listSessions(agent.workspaceRoot).filter((s) => s.status === 'pending' || s.status === 'running');
      if (sessions.length === 0) {
        console.log(chalk.gray('  No running child agents.'));
      } else {
        for (const s of sessions) {
          console.log(`  Agent: ${chalk.cyan(s.id)} ${chalk.gray(s.role)} (${s.status})`);
        }
      }
      console.log();
      return true;
    }
    case '/stop':
    {
      // Stop the loop AND mark any running children stale.
      const stopped = stopLoop();
      console.log(stopped ? chalk.green('\n✓ Stopped /loop.') : chalk.gray('\nNo loop was running.'));
      const reconciled = reconcileStale(agent.workspaceRoot);
      if (reconciled > 0) console.log(chalk.yellow(`Marked ${reconciled} child session(s) stale.`));
      console.log();
      return true;
    }
  }
  return false;
}
