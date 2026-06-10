/**
 * CC-P1.6 — transcript export (0.4.15 thread A). Pure formatters turning a
 * loaded session transcript into a shareable Markdown or JSON document. The
 * `/export` command writes the result to a file; redaction already happened at
 * append time, so these just render. No IO here → unit-tested.
 */
import type { TranscriptEntry } from './sessionStore.js';

export type ExportFormat = 'md' | 'json';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try { return JSON.stringify(content, null, 2); } catch { return String(content); }
}

function toolCallSummary(entry: TranscriptEntry): string[] {
  if (!Array.isArray(entry.tool_calls)) return [];
  return (entry.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>).map((c) => {
    const name = c?.function?.name ?? 'tool';
    let args = c?.function?.arguments ?? '';
    if (args.length > 200) args = args.slice(0, 197) + '…';
    return `\`${name}(${args})\``;
  });
}

/** Render the transcript as a readable Markdown document. Pure. */
export function exportTranscriptMarkdown(
  entries: TranscriptEntry[],
  meta: { sessionKey: string; exportedAt: string },
): string {
  const lines: string[] = [
    `# BrainRouter session transcript`,
    '',
    `- Session: \`${meta.sessionKey}\``,
    `- Exported: ${meta.exportedAt}`,
    `- Entries: ${entries.length}`,
    '',
    '---',
    '',
  ];
  for (const e of entries) {
    const ts = e.timestamp ? ` _(${e.timestamp.replace('T', ' ').slice(0, 19)})_` : '';
    if (e.role === 'user') {
      lines.push(`## ❯ User${ts}`, '', textOf(e.content).trim(), '');
    } else if (e.role === 'assistant') {
      lines.push(`## ⏺ Assistant${ts}`);
      const calls = toolCallSummary(e);
      if (calls.length) lines.push('', `Tool calls: ${calls.join(' · ')}`);
      const body = textOf(e.content).trim();
      if (body) lines.push('', body);
      lines.push('');
    } else if (e.role === 'tool') {
      const name = e.name ? ` \`${e.name}\`` : '';
      const flag = e.isError ? ' ✗' : '';
      lines.push(`### ⎿ Tool result${name}${flag}${ts}`, '', '```', textOf(e.content).trim().slice(0, 4000), '```', '');
    } else {
      lines.push(`### system${ts}`, '', textOf(e.content).trim(), '');
    }
  }
  return lines.join('\n');
}

/** Render the transcript as pretty JSON. Pure. */
export function exportTranscriptJson(
  entries: TranscriptEntry[],
  meta: { sessionKey: string; exportedAt: string },
): string {
  return JSON.stringify({ sessionKey: meta.sessionKey, exportedAt: meta.exportedAt, entries }, null, 2);
}

/** Default file name for an export. Pure. */
export function exportFileName(sessionKey: string, format: ExportFormat, exportedAt: string): string {
  const safeKey = sessionKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  const stamp = exportedAt.replace(/[:.]/g, '-').slice(0, 19);
  return `brainrouter-transcript-${safeKey}-${stamp}.${format}`;
}
