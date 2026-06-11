/**
 * DESK-4c — the desktop command registry.
 *
 * The catalog itself comes from the HOST (`commands-catalog` query), which
 * imports SLASH_COMMANDS + HELP_CATEGORIES from the real CLI — single source
 * of truth, zero drift. This module decides how each command surfaces on
 * desktop: `native` runs right here, `panel` opens a workbench column,
 * `settings` deep-links into a settings section, `cli` is catalogued with its
 * description but still terminal-only (the DESK-5 command bridge wires those).
 */
import type { PanelId } from './panels.js';

export type SettingsSection =
  | 'general' | 'permissions' | 'memory' | 'hooks' | 'connectors'
  | 'observability' | 'appearance' | 'commands';

export interface CmdCtx {
  send(command: unknown): void;
  /** Fire a host query/action; the App routes the result by id. */
  query(id: string, name: string, args?: Record<string, unknown>): void;
  ensurePanel(id: PanelId): void;
  openSettings(section: SettingsSection): void;
  info(title: string, body: string): void;
  toast(text: string): void;
}

export type Wire =
  | { kind: 'native'; run: (ctx: CmdCtx) => void }
  | { kind: 'panel'; panel: PanelId }
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'cli' };

export interface CatalogCategory { key: string; title: string; entries: Array<{ cmd: string; desc: string }> }
export interface CommandsCatalog { categories: CatalogCategory[]; all: string[] }

export interface DeskCommand {
  cmd: string;        // full form, e.g. "/export-chat [md|json] [path]"
  base: string;       // dispatch key, e.g. "/export-chat"
  desc: string;
  category: string;
  wire: Wire;
}

/** How each CLI command lands on desktop. Anything not listed = cli-only. */
export const WIRED: Record<string, Wire> = {
  // -- session lifecycle (native) --
  '/new': { kind: 'native', run: (c) => c.send({ kind: 'new-session' }) },
  '/clear': { kind: 'native', run: (c) => c.query('a-clear', 'action:clear') },
  '/compact': { kind: 'native', run: (c) => { c.toast('Compacting session…'); c.query('a-compact', 'action:compact'); } },
  '/recap': { kind: 'native', run: (c) => c.query('q-recap', 'recap') },
  '/chapters': { kind: 'native', run: (c) => c.query('q-chapters', 'chapters') },
  '/export-chat': { kind: 'native', run: (c) => c.query('q-export', 'export-chat', { format: 'md' }) },
  '/sessions': { kind: 'native', run: (c) => c.info('Sessions', 'Your persisted sessions live in the left rail — click any entry under “Recents” to resume it. `/resume <key>` from the palette does the same.') },
  '/resume': { kind: 'native', run: (c) => c.info('Resume', 'Click a session in the left rail to resume it with its full transcript.') },
  '/find': { kind: 'panel', panel: 'search' },

  // -- workbench panels --
  '/diff': { kind: 'panel', panel: 'diff' },
  '/plan': { kind: 'panel', panel: 'plan' },
  '/ps': { kind: 'panel', panel: 'tasks' },
  '/workers': { kind: 'panel', panel: 'tasks' },
  '/agents': { kind: 'panel', panel: 'tasks' },
  '/workflows': { kind: 'panel', panel: 'tasks' },
  '/transcript': { kind: 'panel', panel: 'tools' },
  '/watch': { kind: 'panel', panel: 'terminal' },

  // -- settings deep links --
  '/model': { kind: 'settings', section: 'general' },
  '/tier': { kind: 'settings', section: 'general' },
  '/effort': { kind: 'settings', section: 'general' },
  '/personality': { kind: 'settings', section: 'general' },
  '/config': { kind: 'settings', section: 'general' },
  '/permissions': { kind: 'settings', section: 'permissions' },
  '/mode': { kind: 'settings', section: 'permissions' },
  '/yolo': { kind: 'settings', section: 'permissions' },
  '/review-policy': { kind: 'settings', section: 'permissions' },
  '/delegation-policy': { kind: 'settings', section: 'permissions' },
  '/sandbox': { kind: 'settings', section: 'permissions' },
  '/policy': { kind: 'settings', section: 'permissions' },
  '/hooks': { kind: 'settings', section: 'hooks' },
  '/hookify': { kind: 'settings', section: 'hooks' },
  '/mcp': { kind: 'settings', section: 'connectors' },
  '/login': { kind: 'settings', section: 'connectors' },
  '/logout': { kind: 'settings', section: 'connectors' },
  '/memories': { kind: 'settings', section: 'memory' },
  '/persona': { kind: 'settings', section: 'memory' },
  '/quiet': { kind: 'settings', section: 'memory' },
  '/tokens': { kind: 'settings', section: 'observability' },
  '/usage': { kind: 'settings', section: 'observability' },
  '/context': { kind: 'settings', section: 'observability' },
  '/status': { kind: 'settings', section: 'observability' },
  '/doctor': { kind: 'settings', section: 'observability' },
  '/debug-config': { kind: 'settings', section: 'observability' },
  '/theme': { kind: 'settings', section: 'appearance' },
  '/statusline': { kind: 'settings', section: 'appearance' },
  '/title': { kind: 'settings', section: 'appearance' },
  '/vim': { kind: 'settings', section: 'appearance' },
  '/keymap': { kind: 'settings', section: 'appearance' },
  '/raw': { kind: 'settings', section: 'appearance' },
  '/experimental': { kind: 'settings', section: 'appearance' },
  '/help': { kind: 'settings', section: 'commands' },
};

/** Merge the live CLI catalog with desktop wiring. */
export function buildCommandList(catalog: CommandsCatalog | null): DeskCommand[] {
  if (!catalog) return [];
  const out: DeskCommand[] = [];
  const seen = new Set<string>();
  for (const cat of catalog.categories) {
    for (const e of cat.entries) {
      // "/export-chat [md|json] [path]" → "/export-chat"; "/side <q>  /btw <q>" → "/side"
      const base = (e.cmd.match(/^\/[a-z0-9-]+/i)?.[0] ?? e.cmd).toLowerCase();
      if (!base.startsWith('/')) continue;
      seen.add(base);
      out.push({ cmd: e.cmd, base, desc: e.desc, category: cat.title, wire: WIRED[base] ?? { kind: 'cli' } });
    }
  }
  for (const cmd of catalog.all) {
    const base = cmd.toLowerCase();
    if (seen.has(base)) continue;
    out.push({ cmd, base, desc: '', category: 'Other', wire: WIRED[base] ?? { kind: 'cli' } });
  }
  return out;
}

export function runCommand(c: DeskCommand, ctx: CmdCtx): void {
  switch (c.wire.kind) {
    case 'native': c.wire.run(ctx); return;
    case 'panel': ctx.ensurePanel(c.wire.panel); return;
    case 'settings': ctx.openSettings(c.wire.section); return;
    case 'cli':
      ctx.info(c.cmd, `${c.desc || 'CLI command.'}\n\nThis one still runs in the terminal CLI (\`brainrouter chat\`) — same workspace, same sessions, same config. Desktop wiring for the remaining REPL commands lands with the DESK-5 command bridge.`);
      return;
  }
}

export const wireBadge = (w: Wire): string =>
  w.kind === 'native' ? 'native' : w.kind === 'panel' ? 'panel' : w.kind === 'settings' ? 'settings' : 'cli';
