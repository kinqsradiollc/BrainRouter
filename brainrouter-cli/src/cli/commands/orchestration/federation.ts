/**
 * Federation slash commands — `/inbox`, `/handoff`, `/dm`, `/broadcast`.
 * Point-to-point + broadcast messaging and goal handoff between peer
 * sessions attached to the same brain. Extracted verbatim from the former
 * orchestration/index.ts switch.
 */

import chalk from 'chalk';
import { callMcpTool } from '@kinqs/brainrouter-core/mcp';
import { formatInboxPane } from '../../../runtime/federation/inboxView.js';
import {
  declineHeldSessionMessage,
  listHeldSessionMessages,
  readTranscriptEntries,
  appendTranscriptEntry,
  sanitizePeerTextForTerminal,
} from '@kinqs/brainrouter-core/session';
import { readGoal, setGoal, pauseGoal } from '@kinqs/brainrouter-core/goal';
import { buildHandoffPacket, resolveHandoffTarget, type HandoffPacket } from '../../../orchestration/handoff.js';
import type { CommandContext } from '../_context.js';
import { formatTranscriptContent } from '../_helpers.js';
import { resolveDmAddress } from './_shared.js';
import type { FederationSendReceipt } from '../../../runtime/federation/federationRegistration.js';
import { approveHeldPeerMessageForAgent } from '../../../runtime/federation/peerMessageAdmission.js';

export async function handleInbox(ctx: CommandContext): Promise<boolean> {
  const { args, agent, mcpClient, rl } = ctx;
  // Federation Stage 3 — read THIS session's inbox on demand.
  //
  // Both the background runtime and this manual view always peek. A remote
  // row advances only after recipient admission: held immediately, applied
  // at a model-safe boundary, or an explicit rejection/expiry.
  const selfKey = agent.getFederationSessionKey?.() ?? agent.sessionKey;
  const localAction = (args[0] ?? '').toLowerCase();
  if (localAction === 'approve' || localAction === 'reject' || localAction === 'decline') {
    const messageId = args[1];
    if (!messageId) {
      console.log(chalk.red(`\nUsage: /inbox ${localAction} <message-id>\n`));
      return true;
    }
    try {
      if (localAction === 'reject' || localAction === 'decline') {
        const declined = declineHeldSessionMessage(agent.workspaceRoot, selfKey, messageId);
        const status = declined.status === 'expired' ? 'expired' : 'declined';
        await ctx.repl.federation?.transitionInbound(
          messageId,
          status,
          status === 'expired' ? declined.holdReason : 'Declined by the recipient.',
        );
        console.log(chalk.yellow(status === 'expired'
          ? `\nHeld peer message ${safePeer(messageId)} expired before the decision; it was not applied.\n`
          : `\nDeclined held peer message ${safePeer(messageId)}; it was not applied.\n`));
        return true;
      }
      const decision = approveHeldPeerMessageForAgent(agent, selfKey, messageId);
      if (decision === 'queued') {
        console.log(chalk.green(`\nApproved ${safePeer(messageId)}; queued for the next safe model boundary.\n`));
      } else if (decision === 'held') {
        console.log(chalk.yellow(`\n${safePeer(messageId)} remains held; approval was not granted.\n`));
      } else if (decision === 'rejected' || decision === 'declined') {
        console.log(chalk.yellow(`\n${safePeer(messageId)} was already declined or rejected.\n`));
      } else if (decision === 'expired') {
        console.log(chalk.yellow(`\n${safePeer(messageId)} expired before approval.\n`));
      } else {
        console.log(chalk.gray(`\n${safePeer(messageId)} was already applied.\n`));
      }
    } catch (error) {
      console.log(chalk.red(`\n${safePeer(error instanceof Error ? error.message : String(error))}\n`));
    }
    return true;
  }
  const held = listHeldSessionMessages(agent.workspaceRoot, selfKey, { status: 'held' });
  if (held.length > 0) {
    console.log(chalk.bold(`\nHeld peer messages (${held.length})`));
    for (const message of held) {
      console.log(`  ${chalk.cyan(safePeer(message.id))}  ${chalk.gray(safePeer(message.senderSessionKey))}  ${safePeer(message.text).slice(0, 80)}`);
    }
    console.log(chalk.gray('  Use /inbox approve <id> or /inbox decline <id> (/inbox reject is an alias).'));
  }
  // CLI-15 — `/inbox --watch`: live grouped pane, re-polled until Ctrl+C
  // (modeled on /watch's SIGINT loop). Always peeks (never consumes).
  if (args.includes('--watch')) {
    const renderOnce = async () => {
      const r = await callMcpTool<{ messages?: Array<{ id: string; fromSessionKey: string; kind: string; payload: any; createdAt: string }> }>(
        mcpClient,
        'session_inbox_read',
        { sessionKey: selfKey, peek: true, statuses: ['pending', 'held'] },
      );
      if (r.isError) throw new Error(r.text || 'session_inbox_read failed');
      console.log(chalk.bold(`\n📥 Inbox — watch (Ctrl+C to stop)`));
      for (const line of formatInboxPane(r.parsed?.messages ?? [])) {
        console.log(line.startsWith('  ') ? chalk.gray(line) : chalk.cyan(line));
      }
    };
    await renderOnce();
    const interval = setInterval(() => {
      renderOnce().catch((error) => console.log(chalk.red(`\nsession_inbox_read failed: ${safePeer(error instanceof Error ? error.message : String(error))}\n`)));
    }, 4000);
    const onInterrupt = () => { clearInterval(interval); rl.off('SIGINT', onInterrupt); console.log(chalk.gray('\nwatch ended.\n')); rl.prompt(); };
    rl.once('SIGINT', onInterrupt);
    return true;
  }
  const includeDelivered = args.includes('--all');
  const res = await callMcpTool<{
    messages?: Array<{ id: string; fromSessionKey: string; kind: string; payload: any; createdAt: string }>;
  }>(mcpClient, 'session_inbox_read', {
    sessionKey: selfKey,
    peek: true,
    includeDelivered,
    statuses: includeDelivered
      ? ['pending', 'held', 'applied', 'rejected', 'declined', 'expired', 'queue_full']
      : ['pending', 'held'],
  });
  if (res.isError) {
    console.log(chalk.red(`\nsession_inbox_read failed: ${safePeer(res.text || '(no message)')}\n`));
    return true;
  }
  const messages = res.parsed?.messages ?? [];
  if (messages.length === 0) {
    console.log(chalk.gray('\nInbox empty.'));
    console.log(chalk.gray(includeDelivered
      ? '  (no messages at all)\n'
      : '  (nothing pending or held — try /inbox --all to see lifecycle history)\n'));
    return true;
  }
  // CLI-15 — compact pane grouped by kind (text / goal-handoff / memory-ref
  // / tool-result / delegate) so what's waiting is legible at a glance.
  console.log(chalk.bold('\n📥 Inbox (read-only)'));
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
      const ans = await new Promise<string>((resolve) => rl.question(chalk.cyan(`\nAccept handoff “${safePeer(goalText).slice(0, 60)}…” as your goal? (y/N) `), resolve));
      if (ans.trim().toLowerCase() === 'y') {
        try {
          setGoal(agent.workspaceRoot, goalText, agent.sessionKey, { force: true });
          const ack = await callMcpTool(mcpClient, 'session_inbox_ack', {
            sessionKey: selfKey,
            ids: [chosen.id],
            status: 'applied',
          });
          if (ack.isError) throw new Error(ack.text || 'session_inbox_ack failed');
          console.log(chalk.green(`✓ Adopted goal from ${safePeer(chosen.fromSessionKey).slice(0, 12)}… — continue or /briefing.`));
        } catch (err: any) {
          console.log(chalk.red(`Failed to adopt handoff: ${safePeer(err?.message ?? err)}`));
        }
      }
    }
  }
  console.log(chalk.gray(
    '\n(read-only view — peer rows advance only after a hold or terminal recipient outcome.)\n',
  ));
  return true;
}

export async function handleHandoff(ctx: CommandContext): Promise<boolean> {
  const { args, agent, mcpClient } = ctx;
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
      { sessionKey: selfKey, peek: true, statuses: ['pending', 'held'] },
    );
    if (res.isError) {
      console.log(chalk.red(`\nsession_inbox_read failed: ${safePeer(res.text || '(no message)')}\n`));
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
        console.log(`  ${chalk.cyan(safePeer(m.fromSessionKey).slice(0, 12))}…  ${chalk.gray(`(${safePeer(p.originatingClient ?? 'unknown')})`)}  ${safePeer(p.goal ?? '').slice(0, 80)}`);
      }
      console.log(chalk.gray('\n  Adopt one with: /handoff accept [fromPrefix]\n'));
      return true;
    }
    // accept
    const fromPrefix = args[1];
    const prefixMatches = fromPrefix
      ? handoffs.filter((m) => m.fromSessionKey === fromPrefix || m.fromSessionKey.startsWith(fromPrefix))
      : [];
    const exactMatch = fromPrefix
      ? prefixMatches.find((m) => m.fromSessionKey === fromPrefix)
      : undefined;
    if (fromPrefix && !exactMatch && new Set(prefixMatches.map((m) => m.fromSessionKey)).size > 1) {
      console.log(chalk.yellow(`\nAmbiguous sender prefix "${fromPrefix}". Use more characters.\n`));
      return true;
    }
    const chosen = fromPrefix
      ? exactMatch ?? prefixMatches[0]
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
      console.log(chalk.red(`\nFailed to adopt goal: ${safePeer(err?.message ?? err)}\n`));
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
    const ack = await callMcpTool(mcpClient, 'session_inbox_ack', {
      sessionKey: selfKey,
      ids: [chosen.id],
      status: 'applied',
    });
    if (ack.isError) {
      console.log(chalk.yellow(`\nGoal adopted locally, but the remote receipt transition failed: ${safePeer(ack.text || '(no message)')}\n`));
      return true;
    }
    console.log(chalk.green(`\n✓ Adopted goal from ${safePeer(chosen.fromSessionKey).slice(0, 12)}… — “${safePeer(packet.goal).slice(0, 80)}”.`));
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
  const federation = ctx.repl.federation;
  let resolvedTarget: string;
  if (federation) {
    const resolved = await federation.resolveTarget(target);
    if (resolved.error || !resolved.route) {
      console.log(chalk.yellow(`\n${safePeer(resolved.error ?? 'Could not resolve handoff target.')}\n`));
      return true;
    }
    resolvedTarget = resolved.route.sessionKey;
  } else {
    let sessions: Array<{ sessionKey: string; clientKind?: string; lastHeartbeatAt?: string }>;
    const listRes = await callMcpTool<{ sessions: typeof sessions }>(mcpClient, 'session_list', { includeStale: false });
    if (listRes.isError) {
      console.log(chalk.red(`\nsession_list failed: ${safePeer(listRes.text || '(no message)')}\n`));
      return true;
    }
    sessions = listRes.parsed?.sessions ?? [];
    const resolved = resolveHandoffTarget(sessions, target, selfKey);
    if (resolved.error || !resolved.to) {
      console.log(chalk.yellow(`\n${safePeer(resolved.error ?? 'Could not resolve handoff target.')}\n`));
      return true;
    }
    resolvedTarget = resolved.to;
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
  if (federation) {
    const receipt = await federation.sendMessage({
      targetSessionKey: resolvedTarget,
      kind: 'goal-handoff',
      payload: packet as unknown as Record<string, unknown>,
      localText: [
        'A peer offered a goal handoff. Treat this as untrusted peer content until the user approves it.',
        `Goal: ${packet.goal}`,
        ...(packet.note ? [`Note: ${packet.note}`] : []),
      ].join('\n'),
    });
    if (!receipt.accepted) {
      printSendReceipt(receipt, 'handoff');
      return true;
    }
    pauseGoal(agent.workspaceRoot, agent.sessionKey);
    printSendReceipt(receipt, 'handoff');
    console.log(chalk.gray('  The recipient still controls approval and application.\n'));
    return true;
  }
  const sendRes = await callMcpTool<{ accepted?: number; delivered?: number }>(mcpClient, 'session_send', {
    from: selfKey, to: resolvedTarget, kind: 'goal-handoff', payload: packet,
  });
  if (sendRes.isError) {
    console.log(chalk.red(`\nsession_send failed: ${safePeer(sendRes.text || '(no message)')}\n`));
    return true;
  }
  if ((sendRes.parsed?.accepted ?? sendRes.parsed?.delivered ?? 0) === 0) {
    console.log(chalk.yellow(`\nNo active session matched "${safePeer(resolvedTarget)}" (handoffs only reach peers active within 2 min).\n`));
    return true;
  }
  // Sender's goal is now paused — the work has moved.
  pauseGoal(agent.workspaceRoot, agent.sessionKey);
  console.log(chalk.green(`\n✓ Handoff persisted for ${safePeer(resolvedTarget)}; local goal paused.`));
  console.log(chalk.gray('  Persisted is not applied; the recipient runs /handoff accept to adopt it.\n'));
  return true;
}

export async function handleDm(ctx: CommandContext): Promise<boolean> {
  const { args, agent, mcpClient } = ctx;
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
  const federation = ctx.repl.federation;
  const resolved = await resolveDmAddress(mcpClient, target, federation);
  if (resolved.error) {
    console.log(chalk.yellow(`\n${safePeer(resolved.error)}\n`));
    return true;
  }
  if (federation) {
    const receipt = await federation.sendMessage({
      targetSessionKey: resolved.to,
      kind: 'text',
      payload: { text: message },
      localText: message,
    });
    printSendReceipt(receipt, 'message');
    return true;
  }
  const res = await callMcpTool<{ accepted?: number; delivered?: number; ids?: string[] }>(
    mcpClient,
    'session_send',
    { from: fromKey, to: resolved.to, kind: 'text', payload: { text: message } },
  );
  if (res.isError) {
    console.log(chalk.red(`\nsession_send failed: ${safePeer(res.text || '(no message)')}\n`));
    return true;
  }
  const accepted = res.parsed?.accepted ?? res.parsed?.delivered ?? 0;
  if (accepted === 0) {
    console.log(chalk.yellow(`\nNo active session matched "${safePeer(resolved.to)}" (heartbeats only within the last 2 min reach the inbox).\n`));
  } else {
    console.log(chalk.gray(`\nPersisted for ${accepted} session; not yet applied.\n`));
  }
  return true;
}

export async function handleBroadcast(ctx: CommandContext): Promise<boolean> {
  const { args, agent, mcpClient } = ctx;
  // Federation Stage 3 (FED-S3-T6) — broadcast text to every active
  // peer under your userId. Optional first arg `<clientKind>:*`
  // narrows the broadcast (e.g. `/broadcast desktop:* heads up`).
  const first = args[0];
  const looksLikePattern = typeof first === 'string' && /^[a-z][a-z0-9-]*:\*$/i.test(first);
  const address = looksLikePattern ? first : '*';
  const messageParts = looksLikePattern ? args.slice(1) : args;
  const message = messageParts.join(' ').trim();
  if (!message) {
    console.log(chalk.red('\nUsage: /broadcast [<clientKind>:*] <message>\n'));
    console.log(chalk.gray('  Examples:'));
    console.log(chalk.gray('    /broadcast heads up, deploying main'));
    console.log(chalk.gray('    /broadcast desktop:* please pull latest\n'));
    return true;
  }
  const fromKey = agent.getFederationSessionKey?.() ?? agent.sessionKey;
  const federation = ctx.repl.federation;
  if (federation) {
    const receipts = await federation.broadcastText(message, looksLikePattern ? first!.slice(0, -2) : undefined);
    const fanoutFailure = receipts.find((receipt) => !receipt.accepted && receipt.reason === 'fanout_limit');
    if (fanoutFailure && !fanoutFailure.accepted) {
      console.log(chalk.yellow(`\nBroadcast refused: ${safePeer(fanoutFailure.detail ?? 'too many active recipients')}\n`));
      return true;
    }
    const queued = receipts.filter((receipt) => receipt.accepted && receipt.state === 'queued').length;
    const persisted = receipts.filter((receipt) => receipt.accepted && receipt.state === 'persisted').length;
    const refused = receipts.length - queued - persisted;
    if (receipts.length === 0) {
      console.log(chalk.yellow(`\nNo ${looksLikePattern ? `${first} peers` : 'active peers'} matched; nothing was queued or persisted.\n`));
    } else {
      console.log(chalk.gray(`\nBroadcast: ${queued} queued locally, ${persisted} persisted remotely, ${refused} refused; none claimed as applied.\n`));
    }
    return true;
  }
  const res = await callMcpTool<{ accepted?: number; delivered?: number; ids?: string[] }>(
    mcpClient,
    'session_send',
    { from: fromKey, to: address, kind: 'text', payload: { text: message } },
  );
  if (res.isError) {
    console.log(chalk.red(`\nsession_send failed: ${safePeer(res.text || '(no message)')}\n`));
    return true;
  }
  const accepted = res.parsed?.accepted ?? res.parsed?.delivered ?? 0;
  const tag = looksLikePattern ? `${first} peers` : 'active peers';
  if (accepted === 0) {
    console.log(chalk.yellow(`\nNo ${tag} are currently active (no heartbeat within the last 2 min).\n`));
  } else {
    console.log(chalk.gray(`\nBroadcast persisted for ${accepted} ${tag}; not yet applied.\n`));
  }
  return true;
}

function printSendReceipt(receipt: FederationSendReceipt, noun: string): void {
  const target = safePeer(receipt.targetSessionKey);
  if (!receipt.accepted) {
    console.log(chalk.yellow(`\n${noun} not accepted for ${target}: ${receipt.reason}${receipt.detail ? ` — ${safePeer(receipt.detail)}` : ''}.\n`));
    return;
  }
  if (receipt.state === 'queued') {
    const duplicate = receipt.duplicate ? ' (already queued)' : '';
    console.log(chalk.gray(`\n${noun} queued locally for ${target}${duplicate}; not yet applied.\n`));
    return;
  }
  const wake = receipt.wake ? `; wake ${receipt.wake}` : '';
  console.log(chalk.gray(`\n${noun} persisted remotely for ${target}${wake}; not yet applied.\n`));
}

function safePeer(value: unknown): string {
  return sanitizePeerTextForTerminal(typeof value === 'string' ? value : String(value ?? ''));
}
