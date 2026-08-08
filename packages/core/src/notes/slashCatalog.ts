/**
 * ADR-029 E1/E4 — the slash menu's catalog, in one place.
 *
 * E1 pairs the slash menu with the input rules and puts both ahead of new block
 * kinds, on the argument that a kind reachable only through a dropdown is a
 * kind nobody uses. This file is the other half of that: the list of things `/`
 * offers, what each is called, what else someone might type to mean it, and the
 * order they come back in.
 *
 * **One catalog, because three surfaces.** The desktop, the dashboard and the
 * CLI are three processes (Q5). A menu built inside a React component is a menu
 * the other two either lack or re-derive with a different order — and a command
 * list that differs by surface is the thing E1's parity test catches
 * immediately, because the muscle memory is in the order.
 *
 * Ranking is deliberately simple and explained rather than tuned: an exact name
 * wins, then a name that starts with what you typed, then an alias that does,
 * then a substring anywhere. A menu at this size does not have a ranking
 * problem; it has a predictability problem, and a scheme nobody can anticipate
 * is worse than an obvious one.
 */
import type { NoteBlockKind } from './block.js';

export type SlashGroup = 'basic' | 'lists' | 'media' | 'advanced';

export interface SlashCommand {
  id: string;
  label: string;
  /** What inserting it produces. */
  kind: NoteBlockKind;
  /** For headings. */
  level?: number;
  /** Other words that mean the same thing, including other apps' names for it. */
  aliases: readonly string[];
  group: SlashGroup;
  /** The line under the label. Says what it is FOR, not what it is called. */
  hint: string;
  /** The input-rule marker that reaches the same block without the menu. */
  marker?: string;
}

/**
 * E4's Blocks row, in the order the menu shows them.
 *
 * Order is authored rather than alphabetical because the first three entries
 * are what people pick nine times out of ten, and an alphabetical menu puts
 * "bookmark" there instead.
 */
export const SLASH_CATALOG: readonly SlashCommand[] = [
  {
    id: 'text', label: 'Text', kind: 'paragraph', group: 'basic',
    aliases: ['paragraph', 'plain', 'p', 'body'],
    hint: 'Just write.',
  },
  {
    id: 'heading-1', label: 'Heading 1', kind: 'heading', level: 1, group: 'basic',
    aliases: ['h1', 'title', 'big heading'], marker: '# ',
    hint: 'The top-level section.',
  },
  {
    id: 'heading-2', label: 'Heading 2', kind: 'heading', level: 2, group: 'basic',
    aliases: ['h2', 'subheading'], marker: '## ',
    hint: 'A section inside a section.',
  },
  {
    id: 'heading-3', label: 'Heading 3', kind: 'heading', level: 3, group: 'basic',
    aliases: ['h3', 'small heading'], marker: '### ',
    hint: 'The smallest heading.',
  },
  {
    id: 'bullet', label: 'Bulleted list', kind: 'bullet', group: 'lists',
    aliases: ['bullet', 'unordered', 'ul', 'list', 'dash'], marker: '- ',
    hint: 'Items with no order.',
  },
  {
    id: 'numbered', label: 'Numbered list', kind: 'numbered', group: 'lists',
    aliases: ['ordered', 'ol', 'number', '1.'], marker: '1. ',
    hint: 'Items in order — the numbers are worked out for you.',
  },
  {
    id: 'todo', label: 'To-do list', kind: 'todo', group: 'lists',
    aliases: ['todo', 'task', 'checkbox', 'checklist'], marker: '[] ',
    hint: 'Things to tick off. A line can become a real task in another mode.',
  },
  {
    id: 'toggle', label: 'Toggle list', kind: 'toggle', group: 'lists',
    aliases: ['toggle', 'collapse', 'fold', 'details', 'accordion'], marker: '+ ',
    hint: 'Hide the detail until someone wants it.',
  },
  {
    id: 'quote', label: 'Quote', kind: 'quote', group: 'basic',
    aliases: ['quote', 'blockquote', 'cite'], marker: '> ',
    hint: 'Someone else’s words.',
  },
  {
    id: 'callout', label: 'Callout', kind: 'callout', group: 'basic',
    aliases: ['callout', 'note', 'aside', 'info', 'warning', 'tip'], marker: '!! ',
    hint: 'A framed aside that should not be skimmed past.',
  },
  {
    id: 'code', label: 'Code', kind: 'code', group: 'advanced',
    aliases: ['code', 'snippet', 'fence', 'pre'], marker: '``` ',
    hint: 'Verbatim text, with a language.',
  },
  {
    id: 'divider', label: 'Divider', kind: 'divider', group: 'basic',
    aliases: ['divider', 'rule', 'hr', 'separator', 'line'], marker: '--- ',
    hint: 'A line between two things.',
  },
  {
    id: 'image', label: 'Image', kind: 'image', group: 'media',
    aliases: ['image', 'picture', 'photo', 'screenshot', 'img'],
    hint: 'A picture, stored once however many notes use it.',
  },
  {
    id: 'bookmark', label: 'Bookmark', kind: 'bookmark', group: 'media',
    aliases: ['bookmark', 'link preview', 'url', 'web'],
    hint: 'A link that shows what it points at.',
  },
  {
    id: 'table', label: 'Table', kind: 'table', group: 'advanced',
    aliases: ['table', 'grid', 'rows', 'columns'],
    hint: 'Rows and columns. Each row merges on its own.',
  },
  {
    id: 'database', label: 'Database', kind: 'database', group: 'advanced',
    aliases: ['database', 'db', 'board', 'kanban', 'calendar', 'gallery', 'collection'],
    hint: 'Pages with properties — table, board, calendar or gallery.',
  },
  {
    id: 'page', label: 'Page', kind: 'page', group: 'advanced',
    aliases: ['page', 'subpage', 'sub-page', 'document', 'doc'],
    hint: 'A page inside this one.',
  },
  {
    id: 'embed', label: 'Workspace item', kind: 'embed', group: 'advanced',
    aliases: ['embed', 'reference', 'link to', 'task', 'planner', 'meeting', 'pull request'],
    hint: 'Show a task, a file or a meeting here — live, not a copy.',
  },
  {
    id: 'synced', label: 'Synced block', kind: 'synced', group: 'advanced',
    aliases: ['synced', 'sync', 'mirror', 'reuse', 'same block', 'transclude'],
    hint: 'Show a block from another page here. Editing either place edits the one block.',
  },
];

export function slashCommand(id: string): SlashCommand | null {
  return SLASH_CATALOG.find((entry) => entry.id === id) ?? null;
}

/** Everything, grouped, for a menu opened with nothing typed after the slash. */
export function slashCatalogByGroup(): { group: SlashGroup; commands: SlashCommand[] }[] {
  const groups: SlashGroup[] = ['basic', 'lists', 'media', 'advanced'];
  return groups
    .map((group) => ({ group, commands: SLASH_CATALOG.filter((entry) => entry.group === group) }))
    .filter((bucket) => bucket.commands.length > 0);
}

/**
 * The tiers a match can land in. Higher wins; ties keep catalog order.
 *
 * Named rather than inlined as magic numbers because the ORDER of these is the
 * behaviour: "head" must beat "heading 3" contains "h", or typing `head` offers
 * the wrong heading first and the muscle memory never forms.
 */
const SCORE = {
  exactId: 100,
  exactLabel: 95,
  labelPrefix: 80,
  aliasExact: 75,
  aliasPrefix: 60,
  wordPrefix: 50,
  labelContains: 30,
  aliasContains: 20,
} as const;

function scoreCommand(entry: SlashCommand, needle: string): number {
  const label = entry.label.toLowerCase();
  const aliases = entry.aliases.map((alias) => alias.toLowerCase());

  if (entry.id === needle) return SCORE.exactId;
  if (label === needle) return SCORE.exactLabel;
  if (label.startsWith(needle)) return SCORE.labelPrefix;
  if (aliases.includes(needle)) return SCORE.aliasExact;
  if (aliases.some((alias) => alias.startsWith(needle))) return SCORE.aliasPrefix;
  // A word inside the label, so `list` finds "Bulleted list" without also
  // making every substring anywhere rank as highly.
  if (label.split(/[\s-]+/).some((word) => word.startsWith(needle))) return SCORE.wordPrefix;
  if (label.includes(needle)) return SCORE.labelContains;
  if (aliases.some((alias) => alias.includes(needle))) return SCORE.aliasContains;
  return 0;
}

/**
 * The menu's contents for what has been typed after the `/`.
 *
 * An empty query returns the whole catalog in authored order — that is the menu
 * opening, not a search with no results.
 */
export function searchSlashCatalog(query: string, limit?: number): SlashCommand[] {
  const needle = (query ?? '').trim().toLowerCase();
  if (needle.length === 0) {
    return limit === undefined ? [...SLASH_CATALOG] : SLASH_CATALOG.slice(0, limit);
  }

  const ranked = SLASH_CATALOG
    .map((entry, index) => ({ entry, index, score: scoreCommand(entry, needle) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.entry);

  return limit === undefined ? ranked : ranked.slice(0, limit);
}

/**
 * What a picked command asks the store for.
 *
 * The menu produces an INPUT, not a block: the store still mints the id, stamps
 * the clock and queues the outbox operation, so there is no second write path
 * for "things that came from the slash menu".
 */
export function slashCommandInput(entry: SlashCommand): { kind: NoteBlockKind; level?: number } {
  return entry.level === undefined ? { kind: entry.kind } : { kind: entry.kind, level: entry.level };
}
