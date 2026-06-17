/**
 * ARTIFACT-RECORDS (0.4.15) — `/artifact` slash commands.
 *
 * An Artifact Record is a durable workflow output (design note, sketch, HTML
 * prototype, markdown report, verification summary, review export) linked to
 * the requirement / task / session / memory it relates to. These commands are
 * leaf operations against the per-workspace `artifactStore`; on create + on a
 * meaningful status change they emit a best-effort BrainRouter memory note via
 * the existing `memory_capture_turn` event path and link the returned id back.
 */

import chalk from 'chalk';
import {
  isArtifactKind,
  isArtifactStatus,
  isArtifactFormat,
  type ArtifactRecord,
  type ArtifactKind,
  type ArtifactStatus,
  type ArtifactFormat,
} from '@kinqs/brainrouter-types';
import {
  createArtifact,
  updateArtifact,
  getArtifact,
  listArtifacts,
  linkArtifact,
} from '../../state/artifactStore.js';
import { emitAgentEvent } from '../../orchestration/memoryEvents.js';
import type { CommandContext } from './_context.js';

export async function tryHandleArtifactCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent } = ctx;
  if (command !== '/artifact' && command !== '/art') return false;

  const sub = (args[0] ?? '').toLowerCase();
  const rest = args.slice(1);

  if (!sub || sub === 'help') {
    printUsage();
    return true;
  }

  if (sub === 'create' || sub === 'new') {
    const kind = (rest[0] ?? '').toLowerCase();
    if (!isArtifactKind(kind)) {
      console.log(chalk.red(`\nUsage: /artifact create <kind> <title…>  — kind one of: design-note, sketch, html-prototype, markdown-report, verification-summary, review-export, other\n`));
      return true;
    }
    const flags = parseFlags(rest.slice(1));
    if (flags.error) { console.log(chalk.red(`\n${flags.error}\n`)); return true; }
    const title = flags.rest.join(' ').trim();
    if (!title) { console.log(chalk.red('\nUsage: /artifact create <kind> <title…>\n')); return true; }
    const record = createArtifact(agent.workspaceRoot, {
      kind,
      title,
      sessionKey: agent.sessionKey,
      format: flags.format,
      path: flags.path,
      summary: flags.summary,
      requirementId: flags.requirement,
    });
    console.log(chalk.green(`\n✓ Created artifact ${chalk.cyan(record.id)} [${statusColor(record.status)}] ${chalk.gray(record.kind)}`));
    console.log(`  ${record.title}${record.path ? chalk.gray(`  (${record.path})`) : ''}\n`);
    await captureArtifactNote(ctx, record, 'created');
    return true;
  }

  if (sub === 'list' || sub === 'ls') {
    const flags = parseFlags(rest);
    if (flags.error) { console.log(chalk.red(`\n${flags.error}\n`)); return true; }
    const records = listArtifacts(agent.workspaceRoot, {
      kind: flags.kind,
      status: flags.status,
    });
    if (records.length === 0) {
      console.log(chalk.yellow('\nNo artifacts yet. Create one with: /artifact create <kind> <title>\n'));
      return true;
    }
    console.log(chalk.bold('\nArtifacts'));
    for (const a of records) {
      const req = a.requirementId ? chalk.gray(` · ${a.requirementId}`) : '';
      console.log(`  ${chalk.cyan(a.id)} [${statusColor(a.status)}] ${chalk.gray(a.kind)} ${a.title}${req}`);
    }
    console.log();
    return true;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) { console.log(chalk.red('\nUsage: /artifact show <id>\n')); return true; }
    const a = getArtifact(agent.workspaceRoot, id);
    if (!a) { console.log(chalk.yellow(`\nNo artifact with id "${id}".\n`)); return true; }
    printRecord(a);
    return true;
  }

  if (sub === 'update' || sub === 'set') {
    const id = rest[0];
    if (!id) { console.log(chalk.red('\nUsage: /artifact update <id> --status <s> | --summary "<text>"\n')); return true; }
    if (!getArtifact(agent.workspaceRoot, id)) { console.log(chalk.yellow(`\nNo artifact with id "${id}".\n`)); return true; }
    const flags = parseFlags(rest.slice(1));
    if (flags.error) { console.log(chalk.red(`\n${flags.error}\n`)); return true; }
    if (!flags.status && flags.summary === undefined) {
      console.log(chalk.red('\nNothing to update. Use --status <s> or --summary "<text>".\n'));
      return true;
    }
    const patch: { status?: ArtifactStatus; summary?: string } = {};
    if (flags.status) patch.status = flags.status;
    if (flags.summary !== undefined) patch.summary = flags.summary;
    const updated = updateArtifact(agent.workspaceRoot, id, patch);
    if (!updated) { console.log(chalk.yellow(`\nNo artifact with id "${id}".\n`)); return true; }
    console.log(chalk.green(`\n✓ Updated artifact ${chalk.cyan(updated.id)} [${statusColor(updated.status)}]`));
    if (flags.status) console.log(chalk.gray(`  status → ${updated.status}`));
    if (flags.summary !== undefined) console.log(chalk.gray('  summary updated'));
    console.log();
    if (flags.status) await captureArtifactNote(ctx, updated, `status → ${updated.status}`);
    return true;
  }

  console.log(chalk.red(`\nUnknown /artifact subcommand "${sub}".`));
  printUsage();
  return true;
}

interface ArtifactFlags {
  kind?: ArtifactKind;
  status?: ArtifactStatus;
  format?: ArtifactFormat;
  path?: string;
  summary?: string;
  requirement?: string;
  rest: string[];
  error?: string;
}

/** Minimal flag parser: `--kind --status --format(md|html|text) --path --summary
 *  "<quoted>" --requirement`. Non-flag leading tokens collect into `rest` (the
 *  create title). `--summary` joins multiple tokens up to the next `--flag`. */
function parseFlags(tokens: string[]): ArtifactFlags {
  const out: ArtifactFlags = { rest: [] };
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--kind' || t === '--status' || t === '--format' || t === '--path' || t === '--requirement') {
      const v = tokens[i + 1];
      if (!v || v.startsWith('--')) return { ...out, error: `${t} requires a value.` };
      if (t === '--kind') { if (!isArtifactKind(v)) return { ...out, error: `Invalid kind "${v}".` }; out.kind = v; }
      else if (t === '--status') { if (!isArtifactStatus(v)) return { ...out, error: `Invalid status "${v}". One of: draft, final, archived.` }; out.status = v; }
      else if (t === '--format') { const f = v === 'md' ? 'markdown' : v; if (!isArtifactFormat(f)) return { ...out, error: `Invalid format "${v}". One of: md|markdown, html, text.` }; out.format = f; }
      else if (t === '--path') out.path = v;
      else if (t === '--requirement') out.requirement = v;
      i += 2;
    } else if (t === '--summary') {
      const parts: string[] = [];
      i += 1;
      while (i < tokens.length && !tokens[i].startsWith('--')) { parts.push(tokens[i]); i += 1; }
      out.summary = parts.join(' ');
    } else {
      out.rest.push(t);
      i += 1;
    }
  }
  return out;
}

function statusColor(s: ArtifactStatus): string {
  if (s === 'final') return chalk.green(s);
  if (s === 'archived') return chalk.gray(s);
  return chalk.yellow(s);
}

function printRecord(a: ArtifactRecord): void {
  console.log(chalk.bold(`\n${a.title}`) + chalk.gray(`  ${a.id}`));
  console.log(`  ${chalk.gray('kind')}     ${a.kind}`);
  console.log(`  ${chalk.gray('status')}   ${statusColor(a.status)}`);
  console.log(`  ${chalk.gray('format')}   ${a.format}`);
  if (a.path) console.log(`  ${chalk.gray('path')}     ${a.path}`);
  if (a.summary) console.log(`  ${chalk.gray('summary')}  ${a.summary}`);
  if (a.requirementId) console.log(`  ${chalk.gray('req')}      ${a.requirementId}`);
  if (a.taskId) console.log(`  ${chalk.gray('task')}     ${a.taskId}`);
  if (a.sessionKey) console.log(`  ${chalk.gray('session')}  ${a.sessionKey}`);
  if (a.linkedMemoryIds.length) console.log(`  ${chalk.gray('memory')}   ${a.linkedMemoryIds.length} linked`);
  if (a.content) {
    const head = a.content.split('\n').slice(0, 8).join('\n');
    console.log(chalk.gray('\n  --- content (head) ---'));
    console.log(head.split('\n').map((l) => `  ${l}`).join('\n'));
  }
  console.log();
}

function printUsage(): void {
  console.log(chalk.bold('\n/artifact — durable workflow artifact records'));
  console.log(chalk.gray('  /artifact create <kind> <title…>            Create an artifact (kind: design-note|sketch|html-prototype|markdown-report|verification-summary|review-export|other)'));
  console.log(chalk.gray('      flags: --format md|html|text  --path <p>  --summary "<s>"  --requirement <id>'));
  console.log(chalk.gray('  /artifact list [--kind k] [--status s]      List this workspace\'s artifacts'));
  console.log(chalk.gray('  /artifact show <id>                         Full record + summary + content head'));
  console.log(chalk.gray('  /artifact update <id> --status <s> | --summary "<s>"   Change status or summary'));
  console.log();
}

async function captureArtifactNote(ctx: CommandContext, record: ArtifactRecord, change: string): Promise<void> {
  try {
    const memoryId = await emitAgentEvent(
      { mcpClient: ctx.mcpClient, sessionKey: ctx.agent.sessionKey },
      {
        kind: 'agent_output',
        summary: `Artifact ${record.id}: ${record.title} [${record.status}] ${record.kind} (${change})`,
        payload: {
          artifactId: record.id,
          title: record.title,
          kind: record.kind,
          status: record.status,
          format: record.format,
          path: record.path,
          requirementId: record.requirementId,
          change,
        },
      },
    );
    if (memoryId) linkArtifact(ctx.agent.workspaceRoot, record.id, { memoryId });
  } catch {
    // Memory capture is advisory — a failure must never break the command.
  }
}
