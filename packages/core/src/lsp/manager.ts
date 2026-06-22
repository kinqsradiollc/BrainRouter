import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { LspClient, spawnStdioTransport, type LspPosition } from './client.js';

/**
 * CLI-19 (0.4.4) — language-server manager: maps a file to an LSP `languageId`,
 * lazily spawns + initializes the configured server (one per command, reused),
 * and runs a navigation query, formatting the LSP result into a compact, model-
 * facing string. Server commands come from `cli.lspServers` (overrides) merged
 * over a small set of common defaults.
 */

export const DEFAULT_LSP_SERVERS: Record<string, string> = {
  typescript: 'typescript-language-server --stdio',
  javascript: 'typescript-language-server --stdio',
  python: 'pyright-langserver --stdio',
  rust: 'rust-analyzer',
  go: 'gopls',
};

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python', '.rs': 'rust', '.go': 'go',
};

export function languageIdFor(filePath: string): string | null {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXT_LANG[base.slice(dot).toLowerCase()] ?? null;
}

export type LspAction = 'definition' | 'references' | 'hover' | 'symbols';

const clients = new Map<string, LspClient>();

async function getClientFor(language: string, cwd: string, servers: Record<string, string>): Promise<LspClient | null> {
  const cmdStr = (servers[language] ?? DEFAULT_LSP_SERVERS[language] ?? '').trim();
  if (!cmdStr) return null;
  const existing = clients.get(cmdStr);
  if (existing) return existing;
  const [command, ...args] = cmdStr.split(/\s+/);
  const transport = spawnStdioTransport(command, args, cwd);
  if (!transport) return null;
  const client = new LspClient(transport);
  clients.set(cmdStr, client);
  try {
    await client.initialize(pathToFileURL(cwd).href);
  } catch {
    clients.delete(cmdStr);
    return null;
  }
  return client;
}

/** Shut down every spawned server (call on CLI exit). */
export async function shutdownAllLsp(): Promise<void> {
  const all = [...clients.values()];
  clients.clear();
  await Promise.allSettled(all.map((c) => c.shutdown()));
}

function loc(uri: string, range: any): string {
  let p = uri;
  try { p = fileURLToPath(uri); } catch { /* keep uri */ }
  const line = (range?.start?.line ?? 0) + 1;
  const col = (range?.start?.character ?? 0) + 1;
  return `${p}:${line}:${col}`;
}

/** Format an LSP definition/references result (Location | Location[] | LocationLink[]). */
export function formatLocations(result: any): string[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((r) => (r?.targetUri ? loc(r.targetUri, r.targetSelectionRange ?? r.targetRange) : loc(r?.uri, r?.range))).filter(Boolean);
}

export function formatHover(result: any): string {
  const c = result?.contents;
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (typeof c?.value === 'string') return c.value; // MarkupContent
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.value ?? '')).filter(Boolean).join('\n');
  return '';
}

export function formatSymbols(result: any): string[] {
  if (!Array.isArray(result)) return [];
  const KIND: Record<number, string> = { 5: 'class', 6: 'method', 8: 'field', 11: 'interface', 12: 'function', 13: 'variable', 23: 'struct', 26: 'typeParameter' };
  const out: string[] = [];
  const walk = (sym: any, depth: number) => {
    const range = sym?.range ?? sym?.location?.range;
    const line = (range?.start?.line ?? 0) + 1;
    out.push(`${'  '.repeat(depth)}${KIND[sym?.kind] ?? 'symbol'} ${sym?.name ?? '?'} (L${line})`);
    for (const child of sym?.children ?? []) walk(child, depth + 1);
  };
  for (const s of result) walk(s, 0);
  return out;
}

/**
 * Run an LSP query for a file at a 1-based (line, character). Returns a compact
 * human/model string, or a clear "no server" / error message — never throws.
 */
export async function runLspQuery(opts: {
  action: LspAction;
  file: string; // absolute path
  line?: number; // 1-based
  character?: number; // 1-based
  cwd: string;
  servers?: Record<string, string>;
}): Promise<string> {
  const language = languageIdFor(opts.file);
  if (!language) return `lsp: no language server mapped for "${opts.file}".`;
  const client = await getClientFor(language, opts.cwd, opts.servers ?? {});
  if (!client) {
    return `lsp: no ${language} language server available (configure cli.lspServers.${language}, e.g. "${DEFAULT_LSP_SERVERS[language] ?? '<server> --stdio'}").`;
  }
  let text: string;
  try { text = fs.readFileSync(opts.file, 'utf8'); } catch { return `lsp: cannot read ${opts.file}.`; }
  const uri = pathToFileURL(opts.file).href;
  client.ensureOpen(uri, language, text);
  const position: LspPosition = { line: Math.max(0, (opts.line ?? 1) - 1), character: Math.max(0, (opts.character ?? 1) - 1) };

  try {
    if (opts.action === 'hover') {
      const h = formatHover(await client.hover(uri, position));
      return h ? h.slice(0, 4000) : 'lsp: no hover info at that position.';
    }
    if (opts.action === 'symbols') {
      const syms = formatSymbols(await client.documentSymbol(uri));
      return syms.length ? syms.slice(0, 200).join('\n') : 'lsp: no symbols found.';
    }
    const result = opts.action === 'references' ? await client.references(uri, position) : await client.definition(uri, position);
    const locs = formatLocations(result);
    return locs.length ? locs.slice(0, 100).join('\n') : `lsp: no ${opts.action} found at that position.`;
  } catch (err: any) {
    return `lsp ${opts.action} failed: ${err?.message ?? err}`;
  }
}
