/**
 * ATTACHMENTS (0.4.15 workflow gaps) — `/attach` slash commands.
 *
 * Attach a file (PDF, image/screenshot, text/code, or generic blob) to the
 * current session. The original blob is preserved in the workspace state tree;
 * text/metadata is extracted where practical; the record links to session +
 * (optionally) requirement and into BrainRouter memory so the content is
 * recallable and usable as session context.
 *
 *   /attach <path> [--requirement <id>]   ingest a file
 *   /attach list                          list this session's attachments
 *   /attach show <id>                     show metadata + extracted text
 */
import path from 'node:path';
import chalk from 'chalk';
import { ingestAttachment, attachmentContextMarkdown } from '@kinqs/brainrouter-core/attachment';
import { getAttachment, listAttachments, linkAttachmentMemory } from '@kinqs/brainrouter-core/attachment';
import { emitAgentEvent } from '@kinqs/brainrouter-core/memory';
import type { AttachmentRecord } from '@kinqs/brainrouter-types';
import type { CommandContext } from './_context.js';

export async function tryHandleAttachmentCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent } = ctx;
  if (command !== '/attach' && command !== '/upload') return false;

  const sub = (args[0] ?? '').toLowerCase();

  if (!sub || sub === 'help') {
    printUsage();
    return true;
  }

  if (sub === 'list' || sub === 'ls') {
    const rows = listAttachments(agent.workspaceRoot, { sessionKey: agent.sessionKey });
    if (rows.length === 0) {
      console.log(chalk.gray('\nNo attachments in this session yet. /attach <path> to add one.\n'));
      return true;
    }
    console.log('');
    for (const a of rows) {
      const dims = a.width && a.height ? ` ${a.width}×${a.height}` : '';
      const pages = a.pageCount ? ` ${a.pageCount}p` : '';
      console.log(`  ${chalk.cyan(a.id)} ${chalk.gray(`[${a.kind}]`)} ${a.name}${chalk.gray(`  ${fmtBytes(a.byteSize)}${dims}${pages}`)}`);
    }
    console.log('');
    return true;
  }

  if (sub === 'show') {
    const id = args[1] ?? '';
    const a = getAttachment(agent.workspaceRoot, id);
    if (!a) { console.log(chalk.red(`\nNo attachment ${id} in this workspace.\n`)); return true; }
    console.log('');
    console.log(`${chalk.cyan(a.id)} ${chalk.gray(`[${a.kind}]`)} ${a.name}`);
    console.log(chalk.gray(`  ${a.mimeType} · ${fmtBytes(a.byteSize)}${a.width && a.height ? ` · ${a.width}×${a.height}` : ''}${a.pageCount ? ` · ${a.pageCount} page(s)` : ''}`));
    console.log(chalk.gray(`  stored: ${a.storedPath}`));
    if (a.linkedMemoryIds.length) console.log(chalk.gray(`  memory: ${a.linkedMemoryIds.join(', ')}`));
    if (a.extractedText) {
      console.log(chalk.gray(`\n  --- extracted text${a.textTruncated ? ' (truncated)' : ''} ---`));
      console.log(a.extractedText.slice(0, 2_000));
    }
    console.log('');
    return true;
  }

  // Default: treat the args as a file path to ingest.
  const flags = parseFlags(args);
  const rel = flags.rest.join(' ').trim();
  if (!rel) { printUsage(); return true; }
  const abs = path.isAbsolute(rel) ? rel : path.resolve(agent.launchCwd ?? process.cwd(), rel);

  let record: AttachmentRecord;
  try {
    record = await ingestAttachment({
      workspaceRoot: agent.workspaceRoot,
      sessionKey: agent.sessionKey,
      requirementId: flags.requirement,
      source: { kind: 'path', path: abs },
    });
  } catch (err) {
    console.log(chalk.red(`\n✗ Could not attach ${rel}: ${err instanceof Error ? err.message : String(err)}\n`));
    return true;
  }

  const dims = record.width && record.height ? ` · ${record.width}×${record.height}` : '';
  const pages = record.pageCount ? ` · ${record.pageCount} page(s)` : '';
  console.log(chalk.green(`\n✓ Attached ${chalk.cyan(record.id)} ${chalk.gray(`[${record.kind}]`)} ${record.name}`));
  console.log(chalk.gray(`  ${record.mimeType} · ${fmtBytes(record.byteSize)}${dims}${pages}`));
  if (record.extractedText) console.log(chalk.gray(`  extracted ${record.extractedText.length} chars of text`));
  console.log('');
  await captureAttachmentNote(ctx, record);
  return true;
}

async function captureAttachmentNote(ctx: CommandContext, record: AttachmentRecord): Promise<void> {
  try {
    const memoryId = await emitAgentEvent(
      { mcpClient: ctx.mcpClient, sessionKey: ctx.agent.sessionKey },
      {
        kind: 'agent_output',
        summary: `Attachment ${record.id}: ${record.name} [${record.kind}] ${record.mimeType} (${fmtBytes(record.byteSize)})`,
        payload: {
          attachmentId: record.id,
          name: record.name,
          kind: record.kind,
          mimeType: record.mimeType,
          byteSize: record.byteSize,
          requirementId: record.requirementId,
          pageCount: record.pageCount,
          // Cap extracted text so a large doc doesn't blow the capture payload.
          context: attachmentContextMarkdown(record, { maxChars: 4_000 }),
        },
      },
    );
    if (memoryId) linkAttachmentMemory(ctx.agent.workspaceRoot, record.id, memoryId);
  } catch {
    // Memory capture is advisory — a failure must never break the command.
  }
}

interface AttachFlags {
  requirement?: string;
  rest: string[];
}

function parseFlags(args: string[]): AttachFlags {
  const out: AttachFlags = { rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--requirement' || a === '--req') {
      out.requirement = args[++i];
    } else {
      out.rest.push(a);
    }
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function printUsage(): void {
  console.log(chalk.bold('\n/attach — attach a file to this session (alias /upload)\n'));
  console.log('  /attach <path> [--requirement <id>]   ingest a PDF / image / text / code / file');
  console.log('  /attach list                          list this session\'s attachments');
  console.log('  /attach show <id>                     metadata + extracted text');
  console.log(chalk.gray('\n  The original file is preserved; text/metadata is extracted where practical'));
  console.log(chalk.gray('  and the attachment is captured into BrainRouter memory for recall.\n'));
}
