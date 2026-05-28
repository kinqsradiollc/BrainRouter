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
import type { InboxTextMessage } from '../runtime/federationRegistration.js';

const BANNER_WIDTH = 80;

export function renderIncomingMessages(messages: InboxTextMessage[]): void {
  if (messages.length === 0) return;
  // One block per message rather than one mega-banner. Two messages
  // arriving in the same poll tick (5 s window) is unusual enough
  // that we'd rather see them framed separately than smushed.
  for (const m of messages) {
    process.stdout.write('\n' + formatBanner(m) + '\n');
  }
}

function formatBanner(m: InboxTextMessage): string {
  const sender = m.fromSessionKey.slice(0, 12);
  const age = formatAge(Date.parse(m.receivedAt));
  const header = chalk.cyan(`┌─ 📨 from ${sender}…`) + chalk.gray(` (${age})`);
  const footer = chalk.cyan('└─');
  const bodyLines = wrap(m.text, BANNER_WIDTH - 4)
    .map((line) => chalk.cyan('│ ') + line);
  return [header, ...bodyLines, footer].join('\n');
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
