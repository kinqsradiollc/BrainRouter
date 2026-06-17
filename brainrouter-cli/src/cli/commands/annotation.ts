/**
 * ANNOTATION-RECORDS (0.4.15) — `/annotation` (alias `/annot`) slash commands.
 *
 * An Annotation is a durable, general-purpose feedback record anchored to a
 * plan, requirement, artifact, markdown/HTML doc, agent message, code
 * diff/file, or review finding. These commands are leaf operations against the
 * durable per-workspace `annotationStore`; on create + on a status change + on
 * export they also emit a best-effort BrainRouter memory note via the existing
 * `memory_capture_turn` event path and link the returned record id back into
 * the annotation. `export` additionally prints the grouped markdown feedback so
 * it can flow straight back into the active session.
 *
 * Flag parsing is the minimal sensible subset: `--file <path>`, `--lines a-b`,
 * `--severity <s>`, and `--suggest "<code>"` for `add`; `--status <s>`,
 * `--target <kind>`, and `--file <path>` for `list`/`export`.
 */

import chalk from 'chalk';
import {
  isAnnotationStatus,
  isAnnotationTargetKind,
  isAnnotationSeverity,
  type AnnotationRecord,
  type AnnotationStatus,
  type AnnotationSeverity,
  type AnnotationTargetKind,
  type AnnotationAnchor,
} from '@kinqs/brainrouter-types';
import {
  createAnnotation,
  getAnnotation,
  listAnnotations,
  setStatus,
  linkAnnotation,
  type AnnotationFilter,
} from '../../state/annotationStore.js';
import { annotationsToMarkdown } from '../../state/annotationExport.js';
import { emitAgentEvent } from '../../orchestration/memoryEvents.js';
import type { CommandContext } from './_context.js';

const TARGET_KINDS = 'plan|requirement|artifact|markdown|html|message|diff|file|review-finding';
const STATUSES = 'open|accepted|rejected|resolved|ignored';
const SEVERITIES = 'info|low|medium|high';

export async function tryHandleAnnotationCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent } = ctx;
  if (command !== '/annotation' && command !== '/annot') return false;

  const sub = (args[0] ?? '').toLowerCase();
  const rest = args.slice(1);

  if (!sub || sub === 'help') {
    printUsage();
    return true;
  }

  if (sub === 'add' || sub === 'create' || sub === 'new') {
    return handleAdd(ctx, rest);
  }

  if (sub === 'list' || sub === 'ls') {
    const filter = parseListFlags(rest);
    if (filter.error) {
      console.log(chalk.red(`\n${filter.error}\n`));
      return true;
    }
    const records = listAnnotations(agent.workspaceRoot, filter.value);
    if (records.length === 0) {
      console.log(chalk.yellow('\nNo annotations match. Create one with: /annotation add <targetKind> <targetId> <body…>\n'));
      return true;
    }
    console.log(chalk.bold('\nAnnotations'));
    for (const a of records) {
      const loc = a.anchor?.filePath ? chalk.gray(` · ${anchorShort(a.anchor)}`) : '';
      const sev = a.severity ? ` ${severityLabel(a.severity)}` : '';
      const target = a.targetId ? chalk.gray(` → ${a.targetId}`) : '';
      console.log(
        `  ${chalk.cyan(a.id)} [${statusColor(a.status)}]${sev} ${chalk.magenta(a.type)}${target} ${truncateLine(a.body)}${loc}`,
      );
    }
    console.log();
    return true;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) {
      console.log(chalk.red('\nUsage: /annotation show <id>\n'));
      return true;
    }
    const a = getAnnotation(agent.workspaceRoot, id);
    if (!a) {
      console.log(chalk.yellow(`\nNo annotation with id "${id}".\n`));
      return true;
    }
    printRecord(a);
    return true;
  }

  if (sub === 'status') {
    const id = rest[0];
    const status = rest[1];
    if (!id || !status) {
      console.log(chalk.red(`\nUsage: /annotation status <id> <${STATUSES}>\n`));
      return true;
    }
    if (!isAnnotationStatus(status)) {
      console.log(chalk.red(`\nInvalid status "${status}". One of: ${STATUSES}.\n`));
      return true;
    }
    if (!getAnnotation(agent.workspaceRoot, id)) {
      console.log(chalk.yellow(`\nNo annotation with id "${id}".\n`));
      return true;
    }
    const updated = setStatus(agent.workspaceRoot, id, status);
    if (!updated) {
      console.log(chalk.yellow(`\nNo annotation with id "${id}".\n`));
      return true;
    }
    console.log(chalk.green(`\n✓ Annotation ${chalk.cyan(updated.id)} status → ${statusColor(updated.status)}\n`));
    await captureAnnotationNote(ctx, updated, `status → ${updated.status}`);
    return true;
  }

  if (sub === 'export') {
    const filter = parseListFlags(rest);
    if (filter.error) {
      console.log(chalk.red(`\n${filter.error}\n`));
      return true;
    }
    const records = listAnnotations(agent.workspaceRoot, filter.value);
    const markdown = annotationsToMarkdown(records);
    console.log('\n' + markdown);
    // Capture the export itself as a memory note — the feedback returning to
    // the session. Best-effort; never blocks/throws the command.
    await captureExportNote(ctx, records);
    return true;
  }

  console.log(chalk.red(`\nUnknown /annotation subcommand "${sub}".`));
  printUsage();
  return true;
}

/**
 * `/annotation add <targetKind> <targetId> <body…>` with optional
 * `--file <path> --lines a-b --severity <s> --suggest "<code>"`. The first two
 * positionals are the target kind + id; everything else (up to the first flag)
 * is the body. The created annotation is anchored to the current session.
 */
async function handleAdd(ctx: CommandContext, rest: string[]): Promise<boolean> {
  const { agent } = ctx;
  const kind = rest[0];
  if (!kind || !isAnnotationTargetKind(kind)) {
    console.log(chalk.red(`\nUsage: /annotation add <targetKind> <targetId> <body…>\n  targetKind: ${TARGET_KINDS}\n`));
    return true;
  }
  // The targetId is the next positional unless it's a flag (a global comment on
  // a kind with no specific id can omit it by leading straight into a flag or
  // body — but the common path supplies one).
  const tokens = rest.slice(1);
  let targetId: string | undefined;
  if (tokens.length && !tokens[0].startsWith('--')) {
    targetId = tokens.shift();
  }

  const parsed = parseAddFlags(tokens);
  if (parsed.error) {
    console.log(chalk.red(`\n${parsed.error}\n`));
    return true;
  }
  const body = parsed.body;
  if (!body) {
    console.log(chalk.red('\nAnnotation body is required: /annotation add <targetKind> <targetId> <body…>\n'));
    return true;
  }

  const record = createAnnotation(agent.workspaceRoot, {
    type: kind,
    targetId,
    body,
    sessionKey: agent.sessionKey,
    anchor: parsed.anchor,
    severity: parsed.severity,
    suggestedText: parsed.suggest,
  });
  console.log(chalk.green(`\n✓ Created annotation ${chalk.cyan(record.id)} [${statusColor(record.status)}] ${chalk.magenta(record.type)}`));
  if (record.targetId) console.log(chalk.gray(`  → ${record.targetId}`));
  if (record.anchor?.filePath) console.log(chalk.gray(`  at ${anchorShort(record.anchor)}`));
  console.log(`  ${record.body}\n`);
  await captureAnnotationNote(ctx, record, 'created');
  return true;
}

interface AddFlags {
  body?: string;
  anchor?: AnnotationAnchor;
  severity?: AnnotationSeverity;
  suggest?: string;
  error?: string;
}

/**
 * Parse the body + optional flags for `/annotation add`. Tokens before the
 * first `--flag` are the body; `--file`, `--lines a-b`, `--severity`, and
 * `--suggest` follow. Returns an `error` string on a bad value.
 */
function parseAddFlags(tokens: string[]): AddFlags {
  const out: AddFlags = {};
  const anchor: AnnotationAnchor = {};
  const bodyParts: string[] = [];
  let i = 0;
  // Body = everything up to the first flag.
  while (i < tokens.length && !tokens[i].startsWith('--')) {
    bodyParts.push(tokens[i]);
    i += 1;
  }
  out.body = stripQuotes(bodyParts.join(' ').trim()) || undefined;

  while (i < tokens.length) {
    const flag = tokens[i];
    if (flag === '--file') {
      const value = tokens[i + 1];
      if (!value || value.startsWith('--')) return { error: '--file requires a path.' };
      anchor.filePath = value;
      i += 2;
      continue;
    }
    if (flag === '--lines' || flag === '--line') {
      const value = tokens[i + 1];
      if (!value || value.startsWith('--')) return { error: `${flag} requires a value like 12 or 12-20.` };
      const range = parseLineRange(value);
      if (!range) return { error: `Invalid ${flag} value "${value}". Use N or N-M.` };
      anchor.startLine = range.start;
      if (range.end !== undefined) anchor.endLine = range.end;
      i += 2;
      continue;
    }
    if (flag === '--severity' || flag === '--sev') {
      const value = tokens[i + 1];
      if (!value || value.startsWith('--')) return { error: `${flag} requires a value.` };
      if (!isAnnotationSeverity(value)) return { error: `Invalid severity "${value}". One of: ${SEVERITIES}.` };
      out.severity = value;
      i += 2;
      continue;
    }
    if (flag === '--suggest' || flag === '--suggestion') {
      // Collect everything until the next --flag, then strip surrounding quotes.
      const parts: string[] = [];
      i += 1;
      while (i < tokens.length && !tokens[i].startsWith('--')) {
        parts.push(tokens[i]);
        i += 1;
      }
      const suggest = stripQuotes(parts.join(' ').trim());
      if (!suggest) return { error: '--suggest requires a non-empty value.' };
      out.suggest = suggest;
      continue;
    }
    return { error: `Unknown flag "${flag}".` };
  }
  if (anchor.filePath !== undefined || anchor.startLine !== undefined) out.anchor = anchor;
  return out;
}

interface ListFlagsResult {
  value?: AnnotationFilter;
  error?: string;
}

/** Parse `--status`, `--target`, and `--file` filters for list/export. */
function parseListFlags(tokens: string[]): ListFlagsResult {
  const filter: AnnotationFilter = {};
  let i = 0;
  while (i < tokens.length) {
    const flag = tokens[i];
    const value = tokens[i + 1];
    if (flag === '--status') {
      if (!value || value.startsWith('--')) return { error: '--status requires a value.' };
      if (!isAnnotationStatus(value)) return { error: `Invalid status "${value}". One of: ${STATUSES}.` };
      filter.status = value;
      i += 2;
      continue;
    }
    if (flag === '--target' || flag === '--kind') {
      if (!value || value.startsWith('--')) return { error: `${flag} requires a value.` };
      if (!isAnnotationTargetKind(value)) return { error: `Invalid target kind "${value}". One of: ${TARGET_KINDS}.` };
      filter.targetKind = value;
      i += 2;
      continue;
    }
    if (flag === '--file') {
      if (!value || value.startsWith('--')) return { error: '--file requires a path.' };
      filter.file = value;
      i += 2;
      continue;
    }
    return { error: `Unknown flag "${flag}".` };
  }
  return { value: Object.keys(filter).length ? filter : undefined };
}

function parseLineRange(value: string): { start: number; end?: number } | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const start = Number(m[1]);
  if (!Number.isFinite(start) || start <= 0) return null;
  if (m[2] === undefined) return { start };
  const end = Number(m[2]);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Capture a short structured note for an annotation via the existing
 * `memory_capture_turn` event path (emitAgentEvent). Best-effort: never throws,
 * never blocks the command on a brain miss. On success, links the returned
 * memory record id back into the annotation.
 */
async function captureAnnotationNote(
  ctx: CommandContext,
  record: AnnotationRecord,
  change: string,
): Promise<void> {
  try {
    const where = record.anchor?.filePath ? ` @ ${anchorShort(record.anchor)}` : '';
    const memoryId = await emitAgentEvent(
      { mcpClient: ctx.mcpClient, sessionKey: ctx.agent.sessionKey },
      {
        kind: 'agent_output',
        summary: `Annotation ${record.id} on ${record.type}${record.targetId ? ` ${record.targetId}` : ''}${where} [${record.status}] (${change})`,
        payload: {
          annotationId: record.id,
          targetKind: record.type,
          targetId: record.targetId ?? null,
          status: record.status,
          severity: record.severity ?? null,
          body: record.body,
          suggestedText: record.suggestedText ?? null,
          anchor: record.anchor ?? null,
          change,
        },
      },
    );
    if (memoryId) {
      linkAnnotation(ctx.agent.workspaceRoot, record.id, { memoryId });
    }
  } catch {
    // Memory capture is advisory — a failure must never break the command.
  }
}

/**
 * Capture an `export` as a single memory note (the feedback flowing back into
 * the session) and link the returned memory id into every exported record.
 * Best-effort; no-op when there's nothing to export.
 */
async function captureExportNote(ctx: CommandContext, records: AnnotationRecord[]): Promise<void> {
  if (records.length === 0) return;
  try {
    const memoryId = await emitAgentEvent(
      { mcpClient: ctx.mcpClient, sessionKey: ctx.agent.sessionKey },
      {
        kind: 'agent_output',
        summary: `Annotation export — ${records.length} annotation(s) returned to session`,
        payload: {
          exported: records.length,
          annotationIds: records.map((r) => r.id),
          markdown: annotationsToMarkdown(records),
        },
      },
    );
    if (memoryId) {
      for (const r of records) {
        linkAnnotation(ctx.agent.workspaceRoot, r.id, { memoryId });
      }
    }
  } catch {
    // Advisory — never break the command.
  }
}

function printRecord(a: AnnotationRecord): void {
  console.log(chalk.bold(`\nAnnotation ${chalk.cyan(a.id)}`));
  console.log(`  Target:    ${chalk.magenta(a.type)}${a.targetId ? ` ${chalk.gray(a.targetId)}` : ''}`);
  console.log(`  Status:    ${statusColor(a.status)}`);
  if (a.severity) console.log(`  Severity:  ${severityLabel(a.severity)}`);
  if (a.anchor) console.log(`  Anchor:    ${anchorShort(a.anchor)}`);
  if (a.anchor?.selectedText) console.log(`  Selected:  ${chalk.gray(a.anchor.selectedText)}`);
  console.log(`  Body:      ${a.body}`);
  if (a.suggestedText) {
    console.log(chalk.bold('\n  Suggested'));
    for (const line of a.suggestedText.split('\n')) console.log(`    ${line}`);
  }
  if (a.author) console.log(`\n  Author:    ${chalk.gray(a.author)}`);
  if (a.sessionKey) console.log(`  Session:   ${chalk.gray(a.sessionKey)}`);
  if (a.requirementId) console.log(`  Req:       ${chalk.gray(a.requirementId)}`);
  if (a.taskId) console.log(`  Task:      ${chalk.gray(a.taskId)}`);
  if (a.artifactId) console.log(`  Artifact:  ${chalk.gray(a.artifactId)}`);
  console.log(`  Created:   ${chalk.gray(a.createdAt)}`);
  console.log(`  Updated:   ${chalk.gray(a.updatedAt)}`);
  console.log(chalk.bold('\n  Links'));
  console.log(`    memory:    ${a.linkedMemoryIds.length ? chalk.gray(a.linkedMemoryIds.join(', ')) : chalk.gray('(none)')}`);
  if (a.sourceEventId) console.log(`    source:    ${chalk.gray(a.sourceEventId)}`);
  console.log();
}

function anchorShort(anchor: AnnotationAnchor): string {
  const parts: string[] = [];
  if (anchor.filePath) {
    let loc = anchor.filePath;
    if (anchor.startLine !== undefined) {
      loc += `:${anchor.startLine}`;
      if (anchor.endLine !== undefined && anchor.endLine !== anchor.startLine) loc += `-${anchor.endLine}`;
    }
    parts.push(loc);
  }
  if (anchor.block) parts.push(`block ${anchor.block}`);
  return parts.join(' · ') || '(no location)';
}

function truncateLine(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 60 ? oneLine : oneLine.slice(0, 59) + '…';
}

function statusColor(status: AnnotationStatus): string {
  switch (status) {
    case 'open': return chalk.yellow(status);
    case 'accepted': return chalk.green(status);
    case 'rejected': return chalk.red(status);
    case 'resolved': return chalk.cyan(status);
    case 'ignored': return chalk.gray(status);
    default: return status;
  }
}

function severityLabel(severity: AnnotationSeverity): string {
  switch (severity) {
    case 'high': return chalk.red('high');
    case 'medium': return chalk.yellow('medium');
    case 'low': return chalk.blue('low');
    case 'info': return chalk.gray('info');
    default: return severity;
  }
}

function printUsage(): void {
  console.log(chalk.bold('\n/annotation (/annot) — durable feedback records'));
  console.log(chalk.gray(`  /annotation add <targetKind> <targetId> <body…>   Create, anchored to this session`));
  console.log(chalk.gray(`     flags: --file <path> --lines a-b --severity <${SEVERITIES}> --suggest "<code>"`));
  console.log(chalk.gray(`  /annotation list [--status s] [--target kind] [--file path]   List this workspace's annotations`));
  console.log(chalk.gray('  /annotation show <id>                             Full record + anchor + suggested code + links'));
  console.log(chalk.gray(`  /annotation status <id> <${STATUSES}>   Transition status`));
  console.log(chalk.gray('  /annotation export [--status s] [--target kind]   Print grouped markdown + capture it as a session memory note'));
  console.log(chalk.gray(`  targetKind: ${TARGET_KINDS}`));
  console.log();
}
