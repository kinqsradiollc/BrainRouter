/**
 * Orchestration handlers — federation messaging (inbox / handoff / dm / broadcast).
 * Extracted from cli/commands/orchestration.ts (god-file breakdown).
 * Commands: /inbox, /handoff, /dm, /broadcast.
 */

import chalk from 'chalk';
import { callMcpTool } from '@kinqs/brainrouter-core/mcp';
import { formatInboxPane } from '../../../runtime/inboxView.js';
import { readTranscriptEntries, appendTranscriptEntry } from '@kinqs/brainrouter-core/session';
import { readGoal, setGoal, pauseGoal } from '@kinqs/brainrouter-core/goal';
import { buildHandoffPacket, resolveHandoffTarget, type HandoffPacket } from '../../../orchestration/handoff.js';
import type { CommandContext } from '../_context.js';
import { formatTranscriptContent } from '../_helpers.js';
import { resolveDmAddress } from './_shared.js';

export async function handleFederationCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, rl } = ctx;
  switch (command) {
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
      const selfKey = agent.getFederationSessionKey?.() ?? agent.sessionKey;
      // CLI-15 — `/inbox --watch`: live grouped pane, re-polled until Ctrl+C
      // (modeled on /watch's SIGINT loop). Always peeks (never consumes).
      if (args.includes('--watch')) {
        const renderOnce = async () => {
          const r = await callMcpTool<{ messages?: Array<{ id: string; fromSessionKey: string; kind: string; payload: any; createdAt: string }> }>(
            mcpClient, 'session_inbox_read', { sessionKey: selfKey, peek: true },
          );
          console.log(chalk.bold(`\n📥 Inbox — watch (Ctrl+C to stop)`));
          for (const line of formatInboxPane(r.parsed?.messages ?? [])) {
            console.log(line.startsWith('  ') ? chalk.gray(line) : chalk.cyan(line));
          }
        };
        await renderOnce();
        const interval = setInterval(() => { renderOnce().catch(() => { /* transient */ }); }, 4000);
        const onInterrupt = () => { clearInterval(interval); rl.off('SIGINT', onInterrupt); console.log(chalk.gray('\nwatch ended.\n')); rl.prompt(); };
        rl.once('SIGINT', onInterrupt);
        return true;
      }
      const peek = args.includes('--peek');
      const includeDelivered = args.includes('--all');
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
      // CLI-15 — compact pane grouped by kind (text / goal-handoff / memory-ref
      // / tool-result / delegate) so what's waiting is legible at a glance.
      console.log(chalk.bold(`\n📥 Inbox${peek ? ' (peek)' : ''}`));
      for (const line of formatInboxPane(messages)) {
        console.log(line.startsWith('  ') ? chalk.gray(line) : chalk.cyan(line));
      }
      // CLI-15 — inline handoff acceptance: if a goal-handoff is waiting, offer
      // to adopt it on the spot (same adopt path as /handoff accept).
      const pendingHandoffs = messages.filter((m) => m.kind === 'goal-handoff');
      if (pendingHandoffs.length > 0) {
        const chosen = pendingHandoffs[pendingHandoffs.length - 1];
        const goalText = (chosen.payload as { goal?: string } | null)?.goal;
        if (goalText) {
          const ans = await new Promise<string>((resolve) => rl.question(chalk.cyan(`\nAccept handoff “${goalText.slice(0, 60)}…” as your goal? (y/N) `), resolve));
          if (ans.trim().toLowerCase() === 'y') {
            try {
              setGoal(agent.workspaceRoot, goalText, agent.sessionKey, { force: true });
              await callMcpTool(mcpClient, 'session_inbox_ack', { sessionKey: selfKey, ids: [chosen.id] });
              console.log(chalk.green(`✓ Adopted goal from ${chosen.fromSessionKey.slice(0, 12)}… — continue or /briefing.`));
            } catch (err: any) {
              console.log(chalk.red(`Failed to adopt handoff: ${err?.message ?? err}`));
            }
          }
        }
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
  }
  return false;
}
