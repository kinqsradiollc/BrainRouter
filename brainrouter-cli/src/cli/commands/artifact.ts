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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
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
  listArtifactVersions,
  revertArtifact,
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

  if (sub === 'open' || sub === 'preview') {
    const id = rest[0];
    if (!id) { console.log(chalk.red('\nUsage: /artifact open <id>\n')); return true; }
    const a = getArtifact(agent.workspaceRoot, id);
    if (!a) { console.log(chalk.yellow(`\nNo artifact with id "${id}".\n`)); return true; }
    // Terminals can't render HTML/SVG/markdown richly — write a self-contained
    // preview file and hand it to the OS opener (browser/desktop). §AV-2.
    let content = a.content ?? '';
    if (!content && a.path) {
      try { content = fs.readFileSync(path.join(agent.workspaceRoot, a.path), 'utf8'); }
      catch { console.log(chalk.yellow(`\nCould not read ${a.path}.\n`)); return true; }
    }
    const html = buildArtifactPreviewHtml(a.title, a.format, a.language, content);
    const dir = path.join(os.tmpdir(), 'brainrouter-artifacts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${a.id}-v${a.currentVersion ?? 1}.html`);
    fs.writeFileSync(file, html, 'utf8');
    openExternally(file);
    console.log(chalk.green(`\n✓ Opened ${chalk.cyan(a.id)} (${a.format}) in your browser.`) + chalk.gray(`\n  ${file}\n`));
    return true;
  }

  if (sub === 'export') {
    const id = rest[0];
    if (!id) { console.log(chalk.red('\nUsage: /artifact export <id> [--format html|md|text] [--out <path>]\n')); return true; }
    const a = getArtifact(agent.workspaceRoot, id);
    if (!a) { console.log(chalk.yellow(`\nNo artifact with id "${id}".\n`)); return true; }
    const flags = parseFlags(rest.slice(1));
    if (flags.error) { console.log(chalk.red(`\n${flags.error}\n`)); return true; }
    let content = a.content ?? '';
    if (!content && a.path) {
      try { content = fs.readFileSync(path.join(agent.workspaceRoot, a.path), 'utf8'); }
      catch { console.log(chalk.yellow(`\nCould not read ${a.path}.\n`)); return true; }
    }
    // Export format: explicit --format, else a sensible default per artifact format.
    const asHtml = flags.format === 'html' || (!flags.format && (a.format === 'html' || a.format === 'svg'));
    const ext = asHtml ? 'html' : (a.format === 'markdown' ? 'md' : a.format === 'code' ? (a.language || 'txt') : 'txt');
    const body = asHtml ? buildArtifactPreviewHtml(a.title, a.format, a.language, content) : content;
    const slug = a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || a.id;
    const outPath = flags.out
      ? (path.isAbsolute(flags.out) ? flags.out : path.join(agent.workspaceRoot, flags.out))
      : path.join(agent.workspaceRoot, `${slug}.${ext}`);
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, body, 'utf8');
    } catch (e) { console.log(chalk.red(`\nWrite failed: ${(e as Error).message}\n`)); return true; }
    console.log(chalk.green(`\n✓ Exported ${chalk.cyan(a.id)} → ${path.relative(agent.workspaceRoot, outPath) || outPath} ${chalk.gray(`(${asHtml ? 'self-contained HTML' : ext})`)}\n`));
    return true;
  }

  if (sub === 'versions' || sub === 'history' || sub === 'log') {
    const id = rest[0];
    if (!id) { console.log(chalk.red('\nUsage: /artifact versions <id>\n')); return true; }
    const a = getArtifact(agent.workspaceRoot, id);
    if (!a) { console.log(chalk.yellow(`\nNo artifact with id "${id}".\n`)); return true; }
    const versions = listArtifactVersions(agent.workspaceRoot, id);
    console.log(chalk.bold(`\nVersions of ${a.title}`) + chalk.gray(`  ${a.id}`));
    for (const v of versions) {
      const cur = v.v === a.currentVersion ? chalk.green(' ← current') : '';
      const note = v.note ? chalk.gray(`  ${v.note}`) : '';
      console.log(`  ${chalk.cyan('v' + v.v)} ${chalk.gray(v.editedBy)} ${chalk.gray(v.editedAt)} ${chalk.gray('#' + v.contentHash)}${note}${cur}`);
    }
    console.log(chalk.gray('\n  Restore one with: /artifact revert <id> <v>   ·   compare: /artifact diff <id> <v1> [v2]\n'));
    return true;
  }

  if (sub === 'revert' || sub === 'restore') {
    const id = rest[0];
    const v = Number(rest[1]);
    if (!id || !Number.isInteger(v)) { console.log(chalk.red('\nUsage: /artifact revert <id> <version>\n')); return true; }
    const updated = revertArtifact(agent.workspaceRoot, id, v, { editedBy: 'user' });
    if (!updated) { console.log(chalk.yellow(`\nNo artifact "${id}" or no version v${v}.\n`)); return true; }
    console.log(chalk.green(`\n✓ Reverted ${chalk.cyan(updated.id)} to the content of v${v} (now v${updated.currentVersion}).\n`));
    await captureArtifactNote(ctx, updated, `reverted to v${v}`);
    return true;
  }

  if (sub === 'diff') {
    const id = rest[0];
    const a = id ? getArtifact(agent.workspaceRoot, id) : undefined;
    if (!a) { console.log(chalk.red('\nUsage: /artifact diff <id> <v1> [v2]\n')); return true; }
    const versions = listArtifactVersions(agent.workspaceRoot, id);
    const v1 = rest[1] ? Number(rest[1]) : (a.currentVersion ?? 1) - 1;
    const v2 = rest[2] ? Number(rest[2]) : (a.currentVersion ?? 1);
    const from = versions.find((x) => x.v === v1);
    const to = versions.find((x) => x.v === v2);
    if (!from || !to) { console.log(chalk.yellow(`\nNo such version (have v1..v${versions.length}).\n`)); return true; }
    console.log(chalk.bold(`\nDiff ${a.title}  v${v1} → v${v2}`));
    printLineDiff(from.content ?? '', to.content ?? '');
    console.log();
    return true;
  }

  console.log(chalk.red(`\nUnknown /artifact subcommand "${sub}".`));
  printUsage();
  return true;
}

/** Wrap artifact content in a self-contained HTML document for the browser. HTML
 *  and SVG render natively; markdown/code/text/mermaid are shown as escaped,
 *  styled source (a terminal-free way to read them). No external resources. */
function buildArtifactPreviewHtml(title: string, format: string, language: string | undefined, content: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>`;
  if (format === 'html') return content;
  if (format === 'svg') {
    return `${head}<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style>${content}`;
  }
  const label = format === 'code' && language ? `code · ${language}` : format;
  return `${head}<style>body{margin:0;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0d1117;color:#e6edf3}header{padding:10px 16px;border-bottom:1px solid #30363d;color:#8b949e;font-size:12px}pre{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word}</style><header>${esc(title)} — ${esc(label)}</header><pre>${esc(content)}</pre>`;
}

/** Open a local file with the platform opener (detached, best-effort). */
function openExternally(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' })
      : spawn(cmd, [file], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* opener missing — the path is printed for manual open */ }
}

/** Minimal LCS-free line diff: a context line stays gray, removed lines are red
 *  `-`, added lines green `+`. Good enough for terminal review of small docs. */
function printLineDiff(a: string, b: string): void {
  const al = a.split('\n');
  const bl = b.split('\n');
  const bSet = new Set(bl);
  const aSet = new Set(al);
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    const la = al[i];
    const lb = bl[i];
    if (la === lb) { if (la !== undefined) console.log(chalk.gray(`   ${la}`)); continue; }
    if (la !== undefined && !bSet.has(la)) console.log(chalk.red(`  -${la}`));
    if (lb !== undefined && !aSet.has(lb)) console.log(chalk.green(`  +${lb}`));
  }
}

interface ArtifactFlags {
  kind?: ArtifactKind;
  status?: ArtifactStatus;
  format?: ArtifactFormat;
  path?: string;
  out?: string;
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
    if (t === '--kind' || t === '--status' || t === '--format' || t === '--path' || t === '--out' || t === '--requirement') {
      const v = tokens[i + 1];
      if (!v || v.startsWith('--')) return { ...out, error: `${t} requires a value.` };
      if (t === '--kind') { if (!isArtifactKind(v)) return { ...out, error: `Invalid kind "${v}".` }; out.kind = v; }
      else if (t === '--status') { if (!isArtifactStatus(v)) return { ...out, error: `Invalid status "${v}". One of: draft, final, archived.` }; out.status = v; }
      else if (t === '--format') { const f = v === 'md' ? 'markdown' : v; if (!isArtifactFormat(f)) return { ...out, error: `Invalid format "${v}". One of: md|markdown, html, text.` }; out.format = f; }
      else if (t === '--path') out.path = v;
      else if (t === '--out') out.out = v;
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
  if (a.versions?.length) console.log(`  ${chalk.gray('versions')} ${a.versions.length} (current v${a.currentVersion})`);
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
  console.log(chalk.gray('  /artifact versions <id>                     Version history (§AV-1)'));
  console.log(chalk.gray('  /artifact revert <id> <v>                   Restore a prior version as a new version'));
  console.log(chalk.gray('  /artifact diff <id> <v1> [v2]               Line diff between two versions'));
  console.log(chalk.gray('  /artifact open <id>                         Render the artifact in your browser (§AV-2)'));
  console.log(chalk.gray('  /artifact export <id> [--format html|md|text] [--out <path>]   Write a self-contained file (§AV-7)'));
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
