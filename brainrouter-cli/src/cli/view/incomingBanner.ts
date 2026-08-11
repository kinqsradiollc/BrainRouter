/**
 * Federation Stage 3 (FED-S3-T6) — incoming-message banner.
 *
 * The inbox poller (`federationRegistration.ts`) fires this with any
 * `text`-kind messages that arrived since the previous tick. We print
 * a compact banner directly to stdout — the Ink REPL is a separate
 * render layer, and writing to stdout here surfaces the banner above
 * the active prompt at the next redraw. No prompt rewrite, no
 * fancy positional control: the goal is "you got mail" visibility,
 * not a full chat UI.
 *
 * Banner shape, intentionally small:
 *
 *   ┌─ 📨 from <sender>… (<age> ago)
 *   │ <text body, wrapped at 80 chars>
 *   └─
 *
 * Sender is shown as the first 12 chars of the federation sessionKey
 * — same shape `/agents --remote` uses, so users can correlate
 * incoming with the peer list visually.
 */

import chalk from 'chalk';
import { sanitizePeerTextForTerminal } from '@kinqs/brainrouter-core/session';
import type {
  InboxTextMessage,
  SenderReceiptNotice,
} from '../../runtime/federation/federationRegistration.js';

const BANNER_WIDTH = 80;

export function renderIncomingMessages(messages: InboxTextMessage[]): void {
  if (messages.length === 0) return;
  // Fallback path used by headless / non-Ink contexts (e.g. before
  // `runChat` has wired the controller, or for one-shot scripts).
  // Inside the Ink REPL the same banners are pushed through
  // `controller.push.notice` so they land in persistent scrollback
  // ABOVE the composer rather than below it (where Ink would stomp
  // them on the next redraw).
  for (const m of messages) {
    process.stdout.write('\n' + formatBanner(m) + '\n');
  }
}

/**
 * Same banner shape as `renderIncomingMessages` but returns the
 * formatted string instead of writing to stdout. Used by the Ink
 * REPL to push the banner through `controller.push.notice` so it
 * lands in persistent scrollback.
 */
export function formatIncomingBanner(m: InboxTextMessage): string {
  return formatBanner(m);
}

export function renderSenderReceipts(receipts: SenderReceiptNotice[]): void {
  for (const receipt of receipts) {
    process.stdout.write(`\n${formatSenderReceipt(receipt)}\n`);
  }
}

export function formatSenderReceipt(receipt: SenderReceiptNotice): string {
  const messageId = sanitizePeerTextForTerminal(receipt.messageId).slice(0, 12);
  const targetSessionKey = sanitizePeerTextForTerminal(receipt.targetSessionKey);
  const reason = receipt.reason ? ` — ${sanitizePeerTextForTerminal(receipt.reason)}` : '';
  return chalk.gray(
    `Message ${messageId} to ${targetSessionKey}: ${receiptStatusLabel(receipt.status)}${reason}`,
  );
}

function formatBanner(m: InboxTextMessage): string {
  const sender = sanitizePeerTextForTerminal(m.fromSessionKey);
  const age = formatAge(Date.parse(m.receivedAt));
  const header = chalk.cyan(`┌─ 📨 from ${sender}`) +
    chalk.gray(` (${age} · ${m.transport} · ${stateLabel(m.state)})`);
  const footer = chalk.cyan('└─');
  const bodyLines = wrap(sanitizePeerTextForTerminal(m.text), BANNER_WIDTH - 4)
    .map((line) => chalk.cyan('│ ') + line);
  return [header, ...bodyLines, footer].join('\n');
}

function stateLabel(state: InboxTextMessage['state']): string {
  if (state === 'queued') return 'queued for safe boundary';
  if (state === 'held') return 'held for approval';
  return state;
}

function receiptStatusLabel(status: SenderReceiptNotice['status']): string {
  if (status === 'pending') return 'persisted, awaiting recipient admission';
  if (status === 'held') return 'held by recipient for approval';
  if (status === 'applied') return 'applied at the recipient safe boundary';
  if (status === 'queue_full') return 'refused because the recipient queue is full';
  return status;
}

function formatAge(receivedAtMs: number): string {
  if (!Number.isFinite(receivedAtMs)) return 'just now';
  const ageMs = Date.now() - receivedAtMs;
  if (ageMs < 5_000) return 'just now';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 60 * 60_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / (60 * 60_000))}h ago`;
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= width) {
      lines.push(paragraph);
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += ' ' + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}
