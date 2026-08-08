/**
 * ADR-029 F3 — a page as Markdown, and what the file could not carry.
 *
 * F3 puts "getting data out" on the list because it is **the answer to "can I
 * leave"**, and the honesty rule from `document.ts` is what makes the answer
 * worth anything: every block this cannot represent is named in the output
 * rather than dropped, because a file that LOOKS complete is worse than one that
 * is visibly partial.
 *
 * Three judgements are worth stating rather than reading out of the switch:
 *
 *  - **A picture is a link, not bytes.** The image's own address goes in and an
 *    omission says the picture itself is in the attachment store. Inlining
 *    megabytes of base64 into a text file would make the export unopenable in
 *    the editors people actually use it in.
 *  - **A synced block is EXPANDED, once.** The mirror is part of the document as
 *    a person reads it, so a file that showed an address where the words are
 *    would not be the page they exported. A mirror encountered INSIDE an
 *    expansion is not expanded again — it renders its state line — which is what
 *    makes this terminate without needing a depth counter to be right.
 *  - **Nothing here parses the block's text.** Markdown out is a write, so no
 *    pattern runs over content somebody else's device wrote; the only regular
 *    expressions in this file are over the fence characters of a code block, at
 *    a bounded width.
 */
import { isLiveBlock, type NoteBlock } from '../block.js';
import { formatTableRow, parseTableRow, tableCells } from '../tableBlock.js';
import { readSyncedBlock, describeSyncedState, SYNCED_BLOCK_KIND } from '../syncedBlock.js';
import {
  dedupeOmissions, exportFilename, MAX_EXPORT_BLOCKS, MAX_EXPORT_CHARS,
  type NoteExport, type NoteExportOmission, type NoteExportOptions,
} from './document.js';
import { walkSubtree, type WalkedBlock } from './walk.js';

/** A heading level Markdown has. Deeper ones exist in the model (E4) and clamp here. */
const MAX_MARKDOWN_HEADING = 6;

/**
 * The longest run of backticks a code block's own text can contain before the
 * fence has to grow past it. Bounded so a hostile paragraph cannot make the
 * scan quadratic.
 */
const MAX_FENCE = 32;

/** The kinds whose children are list continuation, and so are indented. */
const LIST_KINDS = new Set(['bullet', 'numbered', 'todo', 'toggle']);

/** Past this, indentation stops adding meaning and starts eating the width. */
const MAX_LIST_INDENT = 8;

function headingHashes(level: number | null | undefined): string {
  return '#'.repeat(Math.min(MAX_MARKDOWN_HEADING, Math.max(1, level ?? 1)));
}

/** A fence longer than anything inside the code, so the block cannot be broken out of. */
function codeFence(text: string): string {
  let longest = 0;
  let run = 0;
  for (const char of text.slice(0, MAX_EXPORT_CHARS)) {
    run = char === '`' ? run + 1 : 0;
    if (run > longest) longest = run;
    if (longest >= MAX_FENCE) break;
  }
  return '`'.repeat(Math.min(MAX_FENCE, Math.max(3, longest + 1)));
}

/**
 * One block, as the lines it contributes.
 *
 * `indent` is applied by the caller, so a kind cannot forget it and a nested
 * list cannot lose its nesting on one branch of the switch.
 */
function linesFor(
  block: NoteBlock,
  all: readonly NoteBlock[],
  ordinal: number,
  omissions: NoteExportOmission[],
): string[] {
  const kind = block.kind.value;
  const text = block.text.value ?? '';

  switch (kind) {
    case 'page':
    case 'heading':
      return [`${headingHashes(block.level?.value)} ${text}`];
    case 'bullet':
      return [`- ${text}`];
    case 'numbered':
      return [`${ordinal}. ${text}`];
    case 'todo':
      return [`- [${block.checked?.value === true ? 'x' : ' '}] ${text}`];
    case 'quote':
      return [`> ${text}`];
    case 'toggle':
      // A fold is a reading state, not content: the words and their children go
      // in, and nothing claims the file remembers whether it was open.
      return [`- ${text}`];
    case 'callout':
      return [`> ${(block.icon?.value ?? '').trim()} ${text}`.replace(/^> {2}/, '> ')];
    case 'code': {
      const fence = codeFence(text);
      return [`${fence}${block.language?.value ?? ''}`, ...text.split('\n'), fence];
    }
    case 'divider':
      return ['---'];
    case 'image':
      omissions.push({
        kind: 'attachment',
        detail: 'Pictures are linked by their address; the files themselves stay in this app.',
      });
      return [`![](${text})`];
    case 'bookmark':
      return [`<${text}>`];
    case 'embed':
      omissions.push({
        kind: 'live_reference',
        detail: 'An embed shows another part of the workspace live. The file carries its address, not its current state.',
      });
      return [`<${text}>`];
    case 'table': {
      const rows = all
        .filter((row) => row.parentId.value === block.id && isLiveBlock(row) && row.kind.value === 'table-row')
        .sort((a, b) => (a.rank.value < b.rank.value ? -1 : a.rank.value > b.rank.value ? 1 : 0));
      if (rows.length === 0) return [];
      const width = Math.max(...rows.map((row) => parseTableRow(row.text.value).length));
      const asRow = (row: NoteBlock): string => {
        const cells = tableCells(row.text.value, width);
        // Every cell escaped, because a `|` inside one would otherwise add a
        // column to that row and shear the table from there down.
        const padded = Array.from({ length: width }, (_, at) => (cells[at] ?? '').split('|').join('\\|'));
        return `| ${padded.join(' | ')} |`;
      };
      const header = block.checked?.value === true ? rows[0]! : null;
      const body = header ? rows.slice(1) : rows;
      return [
        header ? asRow(header) : `|${' |'.repeat(width)}`,
        `|${' --- |'.repeat(width)}`,
        ...body.map(asRow),
      ];
    }
    case 'table-row':
      // Emitted by its table, not on its own: a row reached here means its table
      // was not in the exported subtree, and a bare pipe-joined line is not
      // something a reader could make sense of.
      return [formatTableRow(parseTableRow(text))];
    default:
      return text.length > 0 ? [text] : [''];
  }
}

/**
 * A page and everything under it as Markdown.
 *
 * `rootId` is a block, not "a page", because B4 makes those the same thing —
 * exporting a toggle and exporting a page are one operation, and a second entry
 * point for "just this branch" would be a second walk to keep in step.
 */
export function exportPageMarkdown(
  blocks: Iterable<NoteBlock>,
  rootId: string,
  opts: NoteExportOptions = {},
): NoteExport | null {
  const all = [...blocks];
  const root = all.find((block) => block.id === rootId && isLiveBlock(block));
  if (!root) return null;

  const limit = Math.max(1, Math.min(opts.maxBlocks ?? MAX_EXPORT_BLOCKS, MAX_EXPORT_BLOCKS));
  const maxChars = Math.max(1, Math.min(opts.maxChars ?? MAX_EXPORT_CHARS, MAX_EXPORT_CHARS));
  const walked = walkSubtree(all, rootId, limit);

  const omissions: NoteExportOmission[] = [];
  const out: string[] = [];
  let count = 0;
  let chars = 0;
  let truncated = walked.truncated;

  // The ordinal of a numbered item is per (parent, run), the same rule the
  // renderer draws: a list restarted under a new parent starts at 1.
  const ordinals = new Map<string, number>();

  const byId = new Map(all.map((one) => [one.id, one] as const));

  /**
   * How deep inside LISTS a block sits, which is the only nesting Markdown has.
   *
   * Not the tree depth. Indenting by tree depth puts two spaces in front of a
   * heading (which stops being a heading in some readers) and four in front of
   * anything two levels down — and four spaces in Markdown is a code block, so a
   * deeply nested page would export as source code. Indentation is list
   * continuation and nothing else; a heading says its own depth with hashes.
   */
  const listDepthOf = (block: NoteBlock): number => {
    let found = 0;
    let cursor = block.parentId.value ?? null;
    for (let hops = 0; cursor !== null && hops < walked.total + 1; hops += 1) {
      if (cursor === rootId) break;
      const parent = byId.get(cursor);
      if (!parent) break;
      if (LIST_KINDS.has(parent.kind.value)) found += 1;
      cursor = parent.parentId.value ?? null;
    }
    return found;
  };

  const emit = (row: WalkedBlock, expanded: boolean): boolean => {
    const parentKey = `${row.block.parentId.value ?? ''}`;
    const next = row.block.kind.value === 'numbered' ? (ordinals.get(parentKey) ?? 0) + 1 : 0;
    if (row.block.kind.value === 'numbered') ordinals.set(parentKey, next);
    else ordinals.delete(parentKey);

    const indent = '  '.repeat(Math.min(MAX_LIST_INDENT, listDepthOf(row.block)));
    for (const line of linesFor(row.block, all, next, omissions)) {
      const rendered = line.length > 0 ? `${indent}${line}` : '';
      if (chars + rendered.length + 1 > maxChars) { truncated = true; return false; }
      out.push(rendered);
      chars += rendered.length + 1;
    }
    out.push('');
    chars += 1;
    if (!expanded) count += 1;
    return true;
  };

  // A table writes its own rows as a grid, and the walk visits those rows too —
  // so without this every table appeared twice, once as a grid and once as a run
  // of pipe-joined lines underneath it.
  const insideTable = new Set(
    all.filter((one) => one.kind.value === 'table-row'
      && byId.get(one.parentId.value ?? '')?.kind.value === 'table').map((one) => one.id),
  );

  for (const row of walked.rows) {
    if (insideTable.has(row.block.id)) continue;
    if (row.block.kind.value === SYNCED_BLOCK_KIND) {
      const state = readSyncedBlock(all, row.block, { canSee: opts.canSee, maxBlocks: limit });
      if (state.status === 'ready') {
        const mirrored = walkSubtree(all, state.source.id, limit);
        let stopped = false;
        for (const inner of mirrored.rows) {
          // Not recursive: a mirror met inside an expansion renders its own state
          // line through the `default` branch below rather than being expanded
          // again. That is what makes this terminate on a mirror of a mirror
          // without a depth counter that has to be maintained separately.
          const nested = inner.block.kind.value === SYNCED_BLOCK_KIND;
          const shown: WalkedBlock = { block: inner.block, depth: row.depth + inner.depth };
          if (nested) {
            if (chars + 200 > maxChars) { truncated = true; stopped = true; break; }
            out.push(`> ${describeSyncedState(readSyncedBlock(all, inner.block, { canSee: opts.canSee }))}`);
            out.push('');
            chars += 220;
            continue;
          }
          if (!emit(shown, true)) { stopped = true; break; }
        }
        count += 1;
        if (state.omittedLabel || mirrored.truncated) {
          omissions.push({
            kind: 'bounded',
            detail: 'A synced block showed more than this file carries; the rest is in the original.',
          });
        }
        if (stopped) break;
        continue;
      }
      omissions.push({
        kind: state.status === 'denied' ? 'permission' : 'live_reference',
        detail: 'A synced block shows a block kept somewhere else; the file says so where it stood.',
      });
      const line = `> ${describeSyncedState(state)}`;
      if (chars + line.length + 2 > maxChars) { truncated = true; break; }
      out.push(line, '');
      chars += line.length + 2;
      count += 1;
      continue;
    }
    if (!emit(row, false)) break;
  }

  if (truncated) {
    omissions.push({
      kind: 'bounded',
      detail: `This page is longer than an export carries, so it stops after ${count} blocks.`,
    });
  }

  const notes = dedupeOmissions(omissions);
  // Bounded quantifier: a run longer than this collapses in more than one pass,
  // which costs a blank line and cannot be made to backtrack.
  const body = out.join('\n').replace(/\n{3,64}/g, '\n\n').trimEnd();
  const trailer = notes.length === 0 ? '' : [
    '',
    '',
    '---',
    '',
    '**What this file does not carry**',
    '',
    ...notes.map((omission) => `- ${omission.detail}`),
  ].join('\n');

  const title = (root.text.value ?? '').trim() || 'note';
  return {
    format: 'markdown',
    filename: exportFilename(title, 'md'),
    contentType: 'text/markdown; charset=utf-8',
    content: `${body}${trailer}\n`,
    count,
    truncated,
    omissions: notes,
  };
}
