/**
 * DIAGRAM (ADR-056 D-A5) — `/diagram` slash command.
 *
 * Typed, validated system maps rendered to one self-contained HTML with a
 * receipt, kept under `.brainrouter/diagrams/`. The leaf subcommands
 * (`validate`, `render`, `list`, `show`, `open`) are deterministic and run
 * without a model; `/diagram <kind> <what…>` hands the authoring to the agent
 * with a bounded brief that ends in `diagram_render`, so the artifact the user
 * gets back is one that passed every check.
 */
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DIAGRAM_KINDS, isDiagramKind, type DiagramKind } from '@kinqs/brainrouter-types';
import { readAtlasGraph } from '@kinqs/brainrouter-core/atlas';
import {
  validateDiagram,
  deliverDiagram,
  verifyDiagramEvidence,
  draftDiagramFromAtlas,
  compareDiagrams,
  renderDiagramDelta,
  readDiagramSpecAtRevision,
  readDiagramSpec,
  diagramPaths,
  isDiagramSlug,
  listDiagrams,
  slugifyDiagramTitle,
  writeDiagramSpec,
  type DiagramReceipt,
  importMermaidDiagram,
} from '@kinqs/brainrouter-core/diagram';
import { resolveCliKnobs } from '@kinqs/brainrouter-core/config';
import type { CommandContext } from '../_context.js';

export type DiagramCommandAction =
  | { action: 'help' }
  | { action: 'list' }
  | { action: 'validate'; file: string }
  | { action: 'render'; file: string; slug?: string; theme?: 'auto' | 'dark' | 'light'; verify?: boolean }
  | { action: 'draft'; slug?: string; layers?: string[]; pathPrefix?: string; title?: string }
  | { action: 'import'; file: string; kind?: 'workflow' | 'architecture'; slug?: string; title?: string }
  | { action: 'show'; slug: string }
  | { action: 'diff'; slug: string; base?: string; open?: boolean }
  | { action: 'open'; slug: string }
  | { action: 'author'; kind: DiagramKind; brief: string }
  | { action: 'error'; message: string };

/** Pure argument parser, exported for tests. */
export function parseDiagramArgs(args: string[]): DiagramCommandAction {
  const sub = (args[0] ?? '').toLowerCase();
  const rest = args.slice(1);
  if (!sub || sub === 'help') return { action: 'help' };
  if (sub === 'list' || sub === 'ls') return { action: 'list' };
  if (sub === 'validate' || sub === 'check') {
    return rest[0] ? { action: 'validate', file: rest[0] } : { action: 'error', message: 'Usage: /diagram validate <file.json>' };
  }
  if (sub === 'render') {
    if (!rest[0]) return { action: 'error', message: 'Usage: /diagram render <file.json> [--slug <slug>] [--theme auto|dark|light]' };
    const out: Extract<DiagramCommandAction, { action: 'render' }> = { action: 'render', file: rest[0] };
    for (let i = 1; i < rest.length; i++) {
      const [flag, inline] = rest[i].split('=', 2);
      const value = inline ?? rest[++i];
      if (flag === '--slug') {
        if (!isDiagramSlug(value)) return { action: 'error', message: `Invalid slug "${value}": lowercase letters, digits, and dashes only.` };
        out.slug = value;
      } else if (flag === '--theme') {
        if (value !== 'auto' && value !== 'dark' && value !== 'light') return { action: 'error', message: 'Theme must be auto, dark, or light.' };
        out.theme = value;
      } else if (flag === '--no-verify') {
        out.verify = false; i--;
      } else {
        return { action: 'error', message: `Unknown option ${flag}` };
      }
    }
    return out;
  }
  if (sub === 'draft') {
    const out: Extract<DiagramCommandAction, { action: 'draft' }> = { action: 'draft' };
    for (let i = 0; i < rest.length; i++) {
      const [flag, inline] = rest[i].split('=', 2);
      const value = inline ?? rest[++i];
      if (flag === '--slug') {
        if (!isDiagramSlug(value)) return { action: 'error', message: `Invalid slug "${value}": lowercase letters, digits, and dashes only.` };
        out.slug = value;
      } else if (flag === '--layers') out.layers = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      else if (flag === '--prefix') out.pathPrefix = value;
      else if (flag === '--title') out.title = value;
      else return { action: 'error', message: `Unknown option ${flag}` };
    }
    return out;
  }
  if (sub === 'diff') {
    const slug = rest[0] ?? '';
    if (!isDiagramSlug(slug)) return { action: 'error', message: 'Usage: /diagram diff <slug> [--base <revision>] [--open]' };
    const out: Extract<DiagramCommandAction, { action: 'diff' }> = { action: 'diff', slug };
    for (let i = 1; i < rest.length; i++) {
      const [flag, inline] = rest[i].split('=', 2);
      if (flag === '--base') { const value = inline ?? rest[++i]; if (!value) return { action: 'error', message: '--base needs a revision' }; out.base = value; }
      else if (flag === '--open') out.open = true;
      else return { action: 'error', message: `Unknown option ${flag}` };
    }
    return out;
  }
  if (sub === 'import') {
    if (!rest[0]) return { action: 'error', message: 'Usage: /diagram import <file.mmd> [--kind workflow|architecture] [--slug <slug>] [--title <title>]' };
    const out: Extract<DiagramCommandAction, { action: 'import' }> = { action: 'import', file: rest[0] };
    for (let i = 1; i < rest.length; i++) {
      const [flag, inline] = rest[i].split('=', 2);
      const value = inline ?? rest[++i] ?? '';
      if (flag === '--kind') { if (value !== 'workflow' && value !== 'architecture') return { action: 'error', message: 'Kind must be workflow or architecture' }; out.kind = value; }
      else if (flag === '--slug') { if (!isDiagramSlug(value)) return { action: 'error', message: `Invalid slug "${value}": lowercase letters, digits, and dashes only.` }; out.slug = value; }
      else if (flag === '--title') { out.title = value; }
      else return { action: 'error', message: `Unknown option ${flag}` };
    }
    return out;
  }
  if (sub === 'show' || sub === 'open') {
    const slug = rest[0] ?? '';
    if (!isDiagramSlug(slug)) return { action: 'error', message: `Usage: /diagram ${sub} <slug>` };
    return { action: sub, slug };
  }
  if (isDiagramKind(sub)) {
    const brief = rest.join(' ').trim();
    return brief ? { action: 'author', kind: sub, brief } : { action: 'error', message: `Usage: /diagram ${sub} <what to map…>` };
  }
  return { action: 'error', message: `Unknown subcommand "${sub}". Kinds: ${DIAGRAM_KINDS.join(', ')}; or validate | render | list | show | open | help.` };
}

/** The bounded brief a `/diagram <kind> …` turn hands the agent. Exported for tests. */
export function diagramAuthoringPrompt(kind: DiagramKind, brief: string, slug: string): string {
  return [
    `Produce a ${kind} diagram of: ${brief}`,
    '',
    'Work like this:',
    '1. Author a typed diagram document (JSON) for the diagram_validate / diagram_render tools: `schemaVersion: 1`, `kind`, `meta.title`, and the element arrays for this kind. Use at most 12 primary elements and one clear main path; put supporting detail in element descriptions, not extra elements. Relationship labels are semantic (protocol, action, direction) — keep them short.',
    '2. When the map reflects real code in this workspace, read the code first and attach `sources` (repo-relative paths, optional line ranges) to the elements they support. Never infer a relationship from file proximity or naming alone.',
    '3. Call diagram_validate and repair every diagnostic it reports; then call diagram_render with `slug: "' + slug + '"`.',
    '4. Reply with the receipt line the tool returns (artifact path, checks, sha256) and one paragraph on what the map shows. Do not claim success if the tool did not deliver.',
  ].join('\n');
}

function readJsonFile(file: string, workspaceRoot: string): { ok: true; value: unknown; abs: string } | { ok: false; message: string } {
  const abs = path.resolve(workspaceRoot, file);
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown, abs };
  } catch (err) {
    return { ok: false, message: `Cannot read ${file}: ${(err as Error).message}` };
  }
}

function printDiagnostics(list: ReadonlyArray<{ severity: string; path: string; message: string; supportedFixes?: string[] }>): void {
  for (const d of list) {
    const tag = d.severity === 'error' ? chalk.red('error') : chalk.yellow('warn ');
    console.log(`  ${tag} ${chalk.gray(d.path || '(document)')}  ${d.message}${d.supportedFixes?.length ? chalk.gray(`  — ${d.supportedFixes.join(' · ')}`) : ''}`);
  }
}

function printReceipt(r: DiagramReceipt, workspaceRoot: string, htmlPath: string): void {
  const passed = r.checks.filter((c) => c.ok).length;
  console.log(`\n${chalk.green('✓')} ${chalk.bold(r.title)} ${chalk.gray(`(${r.kind})`)} → ${chalk.cyan(path.relative(workspaceRoot, htmlPath))}`);
  console.log(chalk.gray(`  checks ${passed}/${r.checks.length} · artifact ${r.artifact.bytes} B sha256 ${r.artifact.sha256.slice(0, 16)}… · spec sha256 ${r.specification.sha256.slice(0, 16)}… · evidence ${r.evidence} · ${r.renderer.name}@${r.renderer.version}`));
  for (const c of r.checks) if (!c.ok) console.log(`  ${chalk.red('✗')} ${c.id}${c.detail ? chalk.gray(` — ${c.detail}`) : ''}`);
  console.log('');
}

function openInBrowser(file: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log(chalk.yellow(`\nCould not launch a browser; open ${file} yourself.\n`));
  }
}

export async function tryHandleDiagramCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, config } = ctx;
  if (command !== '/diagram') return false;
  const root = agent.workspaceRoot;
  const parsed = parseDiagramArgs(args);

  switch (parsed.action) {
    case 'help':
      printUsage();
      return true;
    case 'error':
      console.log(chalk.red(`\n${parsed.message}\n`));
      return true;
    case 'list': {
      const entries = listDiagrams(root);
      if (!entries.length) { console.log(chalk.gray('\nNo diagrams yet — try /diagram architecture <what to map>.\n')); return true; }
      console.log('');
      for (const e of entries) {
        console.log(`  ${chalk.cyan(e.slug.padEnd(28))} ${chalk.gray((e.kind ?? '?').padEnd(13))} ${e.title ?? ''}${e.hasHtml ? '' : chalk.yellow('  (spec only)')}`);
      }
      console.log('');
      return true;
    }
    case 'validate': {
      const read = readJsonFile(parsed.file, root);
      if (!read.ok) { console.log(chalk.red(`\n${read.message}\n`)); return true; }
      const v = validateDiagram(read.value);
      console.log(v.ok
        ? `\n${chalk.green('✓')} valid ${v.kind} diagram (${v.warningCount} warnings)`
        : `\n${chalk.red('✗')} ${v.errorCount} errors, ${v.warningCount} warnings`);
      printDiagnostics(v.diagnostics);
      console.log('');
      return true;
    }
    case 'render': {
      const read = readJsonFile(parsed.file, root);
      if (!read.ok) { console.log(chalk.red(`\n${read.message}\n`)); return true; }
      const v = validateDiagram(read.value);
      if (!v.ok || !v.diagram) {
        console.log(`\n${chalk.red('✗')} not rendered — ${v.errorCount} errors, ${v.warningCount} warnings`);
        printDiagnostics(v.diagnostics);
        console.log('');
        return true;
      }
      const slug = parsed.slug ?? slugifyDiagramTitle(v.diagram.meta.title);
      const paths = diagramPaths(root, slug);
      const theme = parsed.theme ?? resolveCliKnobs(config).diagram.theme;
      let toRender = v.diagram;
      if (parsed.verify !== false) {
        const e = verifyDiagramEvidence(v.diagram, root);
        toRender = e.diagram;
        console.log(chalk.gray(`\n  evidence${e.revision ? ` at ${e.revision.slice(0, 12)}` : ''}: ${e.counts.verified} verified · ${e.counts.unverified} unverified · ${e.counts.unsourced} without sources`));
        printDiagnostics(e.diagnostics);
      }
      const result = deliverDiagram(toRender, paths.html, { theme });
      if (!result.ok) {
        console.log(`\n${chalk.red('✗')} not delivered${result.previousKept ? ' — previous artifact kept' : ''}`);
        printDiagnostics(result.diagnostics);
        for (const c of result.receipt?.checks ?? []) if (!c.ok) console.log(`  ${chalk.red('check')} ${c.id}${c.detail ? chalk.gray(` — ${c.detail}`) : ''}`);
        console.log('');
        return true;
      }
      writeDiagramSpec(root, slug, toRender);
      printReceipt(result.receipt!, root, paths.html);
      return true;
    }
    case 'draft': {
      const graph = readAtlasGraph(root);
      if (!graph || !graph.layers.length) { console.log(chalk.yellow('\nNo enriched codebase map — run /atlas then /atlas enrich first.\n')); return true; }
      const d = draftDiagramFromAtlas(graph, { ...(parsed.layers ? { layers: parsed.layers } : {}), ...(parsed.pathPrefix ? { pathPrefix: parsed.pathPrefix } : {}), ...(parsed.title ? { title: parsed.title } : {}) });
      const slug = parsed.slug ?? slugifyDiagramTitle(d.diagram.meta.title);
      const spec = writeDiagramSpec(root, slug, d.diagram);
      console.log(`\n${chalk.green('✓')} drafted ${d.diagram.components.length} components, ${d.diagram.connections.length} connections → ${chalk.cyan(path.relative(root, spec))}`);
      for (const n of d.notes) console.log(chalk.gray(`  · ${n}`));
      console.log(chalk.gray(`  curate the JSON, then /diagram render ${path.relative(root, spec)} --slug ${slug}\n`));
      return true;
    }
    case 'import': {
      // ADR-056 D-A6 — Mermaid is an input: a fresh document is authored; styling is never transcribed.
      const abs = path.resolve(root, parsed.file);
      if (abs !== path.resolve(root) && !abs.startsWith(path.resolve(root) + path.sep)) { console.log(chalk.red('\nThe Mermaid file must be inside the workspace.\n')); return true; }
      let text: string;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { console.log(chalk.red(`\nCannot read ${parsed.file}\n`)); return true; }
      let imported;
      try { imported = importMermaidDiagram(text, { ...(parsed.kind ? { kind: parsed.kind } : {}), ...(parsed.title ? { title: parsed.title } : {}) }); }
      catch (err) { console.log(chalk.red(`\n${err instanceof Error ? err.message : String(err)}\n`)); return true; }
      const slug = parsed.slug ?? slugifyDiagramTitle(imported.diagram.meta.title);
      const spec = writeDiagramSpec(root, slug, imported.diagram);
      const count = imported.diagram.kind === 'workflow' ? `${imported.diagram.nodes.length} nodes, ${imported.diagram.edges.length} edges` : `${imported.diagram.components.length} components, ${imported.diagram.connections.length} connections`;
      console.log(`\n${chalk.green('✓')} imported ${imported.diagram.kind}: ${count} → ${chalk.cyan(path.relative(root, spec))} ${imported.validation.ok ? chalk.gray('(valid)') : chalk.yellow(`(${imported.validation.diagnostics?.length ?? 0} validation issue(s) — curate before rendering)`)}`);
      for (const n of imported.notes) console.log(chalk.gray(`  · ${n}`));
      if (imported.dropped.length) console.log(chalk.gray(`  · not transcribed: ${imported.dropped.slice(0, 6).join(' · ')}${imported.dropped.length > 6 ? ' · …' : ''}`));
      console.log(chalk.gray(`  curate the JSON, then /diagram render ${path.relative(root, spec)} --slug ${slug}\n`));
      return true;
    }
    case 'show': {
      const paths = diagramPaths(root, parsed.slug);
      let receipt: DiagramReceipt;
      try { receipt = JSON.parse(fs.readFileSync(paths.receipt, 'utf8')) as DiagramReceipt; }
      catch { console.log(chalk.yellow(`\nNo receipt for "${parsed.slug}" — render it first.\n`)); return true; }
      printReceipt(receipt, root, paths.html);
      return true;
    }
    case 'diff': {
      const headRaw = readDiagramSpec(root, parsed.slug);
      if (!headRaw) { console.log(chalk.yellow(`\nNo pinned specification for "${parsed.slug}" — render it first.\n`)); return true; }
      const base = parsed.base ?? 'HEAD';
      const baseRaw = readDiagramSpecAtRevision(root, base, parsed.slug);
      if (!baseRaw) { console.log(chalk.yellow(`\n"${parsed.slug}" is not committed at ${base}, so there is nothing to compare against.\n`)); return true; }
      const bv = validateDiagram(baseRaw, { quality: 'standard' }), hv = validateDiagram(headRaw, { quality: 'standard' });
      if (!bv.diagram || !hv.diagram) { console.log(chalk.red('\nOne side does not validate:')); printDiagnostics([...bv.diagnostics, ...hv.diagnostics]); console.log(''); return true; }
      if (bv.diagram.kind !== hv.diagram.kind) { console.log(chalk.red(`\nKinds differ (${bv.diagram.kind} at ${base} vs ${hv.diagram.kind} now) — that is a different diagram, not a delta.\n`)); return true; }
      const receipt = compareDiagrams(bv.diagram, hv.diagram);
      const c = receipt.counts;
      console.log(`\n${chalk.bold(receipt.title)} ${chalk.gray(`— ${base} → working tree`)}`);
      console.log(receipt.identical ? chalk.gray('  identical') : `  ${c.added} added · ${c.removed} removed · ${c.rerouted} rerouted · ${c.moved} moved · ${c.changed} changed`);
      for (const f of receipt.facts) {
        const fields = f.fields?.map((d) => `${d.field}: ${d.before ?? '∅'} → ${d.after ?? '∅'}`).join('; ');
        console.log(`  ${chalk.cyan(f.kind.padEnd(8))} ${f.subject}/${f.id}${f.label ? chalk.gray(` "${f.label}"`) : ''}${fields ? chalk.gray(`  ${fields}`) : ''}`);
      }
      const paths = diagramPaths(root, parsed.slug);
      const deltaPath = paths.html.replace(/\.html$/, '.delta.html');
      fs.mkdirSync(path.dirname(deltaPath), { recursive: true });
      fs.writeFileSync(deltaPath, renderDiagramDelta(bv.diagram, hv.diagram, receipt, { theme: resolveCliKnobs(config).diagram.theme }), 'utf8');
      console.log(chalk.gray(`  Before · Delta · After → ${path.relative(root, deltaPath)}\n`));
      if (parsed.open) openInBrowser(deltaPath);
      return true;
    }
    case 'open': {
      const paths = diagramPaths(root, parsed.slug);
      if (!fs.existsSync(paths.html)) { console.log(chalk.yellow(`\nNo artifact for "${parsed.slug}" — render it first.\n`)); return true; }
      openInBrowser(paths.html);
      console.log(chalk.gray(`\nOpening ${path.relative(root, paths.html)}\n`));
      return true;
    }
    case 'author': {
      const slug = slugifyDiagramTitle(parsed.brief.slice(0, 64));
      console.log(chalk.gray(`\nAuthoring a ${parsed.kind} diagram → .brainrouter/diagrams/${slug}.html\n`));
      ctx.repl.runAgentTurn(diagramAuthoringPrompt(parsed.kind, parsed.brief, slug));
      return true;
    }
  }
}

function printUsage(): void {
  console.log(`
${chalk.bold('/diagram')} — typed, validated system maps with a receipt (${chalk.gray('.brainrouter/diagrams/')})

  /diagram <kind> <what to map…>          agent authors + renders one (kinds: ${DIAGRAM_KINDS.join(', ')})
  /diagram validate <file.json>           check a document; prints path-prefixed diagnostics
  /diagram import <file.mmd> [--kind workflow|architecture] [--slug s] [--title t]   author a fresh document from a Mermaid flowchart/graph (styling never transcribed)
  /diagram draft [--layers a,b] [--prefix path] [--title t] [--slug s]
                                          seed an architecture document from the codebase map (/atlas)
  /diagram render <file.json> [--slug s] [--theme auto|dark|light] [--no-verify]
                                          verify sources, render, run the nine checks, deliver HTML + receipt
  /diagram diff <slug> [--base <rev>] [--open]
                                          exact facts vs the committed spec + a Before · Delta · After page
  /diagram list                           stored diagrams
  /diagram show <slug>                    the receipt (checks, sha256, evidence)
  /diagram open <slug>                    open the delivered HTML in a browser
`);
}
