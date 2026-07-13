/**
 * Layer 2 — the extractor. Walks a workspace's `.ts/.tsx` source with the
 * TypeScript compiler API (an OPTIONAL, dynamically-loaded peer — mirrors
 * brainrouter/src/memory/source/code-chunker.ts so the default install carries no
 * ~60 MB compiler), recursively (`forEachChild`) collecting every JSX element that
 * carries a `data-testid` (or React-Native-style `testID`), inferring its control
 * type + default action, and assembling a validated `UiMap`.
 *
 * When `typescript` is unavailable the manifest comes back empty + `degraded`,
 * never a regex guess — JSX-attribute scraping by regex is too unreliable to be a
 * source of truth, so the panel surfaces "install typescript" instead.
 */
import { createRequire } from 'node:module';
import type { UiMap, Screen, UiElement } from '../types.js';
import { UiMapSchema } from '../schema.js';
import { inferTypeAndAction } from './infer.js';
import { classifyScreen, kebab, SHARED_SCREEN_ID, SHARED_SCREEN_TITLE } from './screen.js';

/** A workspace source file the caller has already read (host injects fs). */
export interface SourceFile {
  /** Workspace-relative path (used for screen inference + provenance). */
  path: string;
  text: string;
}

/** One `data-testid` site discovered in source. */
export interface TestIdSite {
  testID: string;
  jsxTag: string;
  hasOnClick: boolean;
  role?: string;
  hasHref: boolean;
  label?: string;
  line: number;
  enclosingComponent?: string;
  /** Kind of the enclosing symbol (component/function/class); undefined at top level. */
  symbolKind?: 'component' | 'function' | 'class';
  /** True when synthesized in broad mode (no data-testid on the element). */
  synthetic?: boolean;
}

export interface ExtractFileResult {
  degraded: boolean;
  sites: TestIdSite[];
}

// undefined = untried, null = unavailable. A test seam can force the degraded path.
let tsModule: any | null | undefined;
let forceNoTs = false;

function loadTypeScript(): any | null {
  if (forceNoTs) return null;
  if (tsModule !== undefined) return tsModule;
  try {
    tsModule = createRequire(import.meta.url)('typescript');
  } catch {
    tsModule = null;
  }
  return tsModule;
}

/** Test seam: force the no-typescript (degraded) branch on/off. */
export function __setForceNoTsForTests(on: boolean): void {
  forceNoTs = on;
}

const TESTID_ATTR = /^(?:data-testid|data-test-id|testid)$/i;
// Broad-mode signals: which JSX elements count as interactive controls when they
// carry no data-testid, so a non-instrumented app still yields a command map.
const INTERACTIVE_TAGS = /^(?:button|input|textarea|select|option|a|link|textfield|checkbox|switch|slider)$/i;
const INTERACTIVE_ROLES = /^(?:button|link|textbox|searchbox|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|option|combobox|slider)$/i;

function attrText(name: any, sf: any): string {
  try {
    return String(name.getText(sf));
  } catch {
    return String(name.escapedText ?? name.text ?? '');
  }
}

/** A JSX attribute initializer that is a static string → its value, else null. */
function stringInitializer(ts: any, init: any): string | null {
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return null;
}

interface OwnerInfo {
  tag: string;
  hasOnClick: boolean;
  hasHref: boolean;
  role?: string;
  label?: string;
}

/** Read the owning JSX element of a `data-testid` attribute (attr.parent.parent). */
function ownerInfo(ts: any, attrNode: any, sf: any): OwnerInfo {
  const owner = attrNode.parent?.parent; // JsxAttributes → JsxOpening/SelfClosingElement
  const info: OwnerInfo = { tag: '', hasOnClick: false, hasHref: false };
  if (!owner || !owner.tagName) return info;
  info.tag = attrText(owner.tagName, sf);
  const props = owner.attributes?.properties ?? [];
  for (const p of props) {
    if (!ts.isJsxAttribute(p)) continue;
    const n = attrText(p.name, sf).toLowerCase();
    if (n === 'onclick' || n === 'onpress') info.hasOnClick = true;
    else if (n === 'href' || n === 'to') info.hasHref = true;
    else if (n === 'role') info.role = stringInitializer(ts, p.initializer) ?? info.role;
    else if (n === 'aria-label' || n === 'title' || n === 'placeholder') {
      info.label = info.label ?? (stringInitializer(ts, p.initializer) ?? undefined);
    }
  }
  return info;
}

/** Nearest enclosing named symbol (function / class / arrow-or-fn const) + its kind.
 *  Capitalized fn/arrow → 'component' (React convention); lowercase → 'function';
 *  a class declaration → 'class'. Used to tag each element for the panel's icon. */
function enclosingSymbol(ts: any, node: any): { name: string; kind: 'component' | 'function' | 'class' } | undefined {
  let cur = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) {
      const name = cur.name.text;
      return { name, kind: /^[A-Z]/.test(name) ? 'component' : 'function' };
    }
    if (ts.isClassDeclaration(cur) && cur.name) return { name: cur.name.text, kind: 'class' };
    if (
      ts.isVariableDeclaration(cur) &&
      cur.name &&
      ts.isIdentifier(cur.name) &&
      cur.initializer &&
      (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))
    ) {
      const name = cur.name.text;
      return { name, kind: /^[A-Z]/.test(name) ? 'component' : 'function' };
    }
    cur = cur.parent;
  }
  return undefined;
}

/** Read a JSX opening/self-closing element's tag + the attributes we care about
 *  (broad mode): interactivity signals, a label, and any data-testid. */
function readElement(ts: any, el: any, sf: any): OwnerInfo & { testID?: string } {
  const info: OwnerInfo & { testID?: string } = { tag: '', hasOnClick: false, hasHref: false };
  if (!el || !el.tagName) return info;
  info.tag = attrText(el.tagName, sf);
  const props = el.attributes?.properties ?? [];
  for (const p of props) {
    if (!ts.isJsxAttribute(p)) continue;
    const n = attrText(p.name, sf).toLowerCase();
    if (n === 'onclick' || n === 'onpress') info.hasOnClick = true;
    else if (n === 'href' || n === 'to') info.hasHref = true;
    else if (n === 'role') info.role = stringInitializer(ts, p.initializer) ?? info.role;
    else if (TESTID_ATTR.test(n)) info.testID = stringInitializer(ts, p.initializer) ?? info.testID;
    else if (n === 'aria-label' || n === 'title' || n === 'placeholder' || n === 'alt') {
      info.label = info.label ?? (stringInitializer(ts, p.initializer) ?? undefined);
    }
  }
  return info;
}

/** First non-empty static text child of a JSX element (a button/link's caption). */
function elementText(ts: any, openingEl: any): string {
  const parent = openingEl.parent;
  if (!parent || !ts.isJsxElement(parent)) return '';
  for (const child of parent.children ?? []) {
    if (ts.isJsxText(child)) {
      const t = String(child.text ?? '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
  }
  return '';
}

/** True when an element is an interactive control worth capturing in broad mode. */
function isInteractiveEl(info: OwnerInfo): boolean {
  return INTERACTIVE_TAGS.test(info.tag) || (!!info.role && INTERACTIVE_ROLES.test(info.role)) || info.hasOnClick || info.hasHref;
}

/** Extract every `data-testid` site (and, in broad mode, every interactive
 *  element) from one source file (pure over text). */
export function extractFile(filePath: string, text: string, opts: { broad?: boolean } = {}): ExtractFileResult {
  const ts = loadTypeScript();
  if (!ts) return { degraded: true, sites: [] };
  const isTsx = /\.[jt]sx$/i.test(filePath);
  let sf: any;
  try {
    sf = ts.createSourceFile(
      isTsx ? 'f.tsx' : 'f.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
      isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  } catch {
    return { degraded: false, sites: [] };
  }

  const sites: TestIdSite[] = [];
  const synthCounts = new Map<string, number>();
  const visit = (node: any): void => {
    if (ts.isJsxAttribute(node) && TESTID_ATTR.test(attrText(node.name, sf).trim())) {
      const testID = stringInitializer(ts, node.initializer);
      if (testID) {
        const owner = ownerInfo(ts, node, sf);
        const startNode = node.parent?.parent ?? node;
        const line = sf.getLineAndCharacterOfPosition(startNode.getStart(sf)).line + 1;
        const sym = enclosingSymbol(ts, node);
        sites.push({
          testID,
          jsxTag: owner.tag,
          hasOnClick: owner.hasOnClick,
          role: owner.role,
          hasHref: owner.hasHref,
          label: owner.label,
          line,
          enclosingComponent: sym?.name,
          symbolKind: sym?.kind,
        });
      }
    }
    // Broad mode: also capture interactive elements that carry NO data-testid,
    // synthesizing a stable id from their label/text/tag (deduped within a file).
    if (opts.broad && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))) {
      const info = readElement(ts, node, sf);
      if (!info.testID && isInteractiveEl(info)) {
        const cap = ts.isJsxOpeningElement(node) ? elementText(ts, node) : '';
        const base = kebab(info.label || cap || info.tag || 'el').slice(0, 40) || 'el';
        const n = (synthCounts.get(base) ?? 0) + 1;
        synthCounts.set(base, n);
        const sym = enclosingSymbol(ts, node);
        sites.push({
          testID: n === 1 ? base : `${base}-${n}`,
          jsxTag: info.tag,
          hasOnClick: info.hasOnClick,
          role: info.role,
          hasHref: info.hasHref,
          label: info.label || cap || undefined,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          enclosingComponent: sym?.name,
          symbolKind: sym?.kind,
          synthetic: true,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { degraded: false, sites };
}

function sortElements(a: UiElement, b: UiElement): number {
  return a.testID < b.testID ? -1 : a.testID > b.testID ? 1 : 0;
}

/** One file's extracted sites — the unit the incremental cache stores + replays. */
export interface FileSites {
  path: string;
  sites: TestIdSite[];
  degraded?: boolean;
}

/**
 * Assemble a validated `UiMap` from already-extracted per-file sites. This is the
 * seam the host's incremental path drives: re-extract only changed files, keep the
 * cached sites for the rest, then re-assemble from all of them. Screens + elements
 * are sorted so the manifest is deterministic (stable diffs + goldens).
 */
export function assembleManifest(files: FileSites[], opts: { now?: string; broad?: boolean } = {}): {
  manifest: UiMap;
  degraded: boolean;
} {
  let degraded = false;
  const screens = new Map<string, Screen>();
  // Per-screen testID set for dedupe (last write wins).
  const seen = new Map<string, Set<string>>();

  const ensureScreen = (id: string, title: string, route: string | null, filePath?: string): Screen => {
    let s = screens.get(id);
    if (!s) {
      s = { id, title, platform: 'web', route, filePath, elements: [] };
      screens.set(id, s);
      seen.set(id, new Set());
    }
    return s;
  };

  for (const f of files) {
    if (f.degraded) degraded = true;
    if (f.sites.length === 0) continue;

    const cls = classifyScreen(f.path, { broad: opts.broad });
    // In broad mode a file with several interactive controls is its own screen
    // even without a screen-y name/dir (e.g. settings.tsx); small helpers (<3
    // controls) still fold into the shared bucket to keep the map legible.
    const asScreen = cls.isScreen || (!!opts.broad && f.sites.length >= 3);
    const screen = asScreen
      ? ensureScreen(cls.id, cls.title, cls.route, f.path)
      : ensureScreen(SHARED_SCREEN_ID, SHARED_SCREEN_TITLE, null);

    const dedup = seen.get(screen.id)!;
    for (const site of f.sites) {
      const { type, action } = inferTypeAndAction({
        jsxTag: site.jsxTag,
        hasOnClick: site.hasOnClick,
        role: site.role,
        hasHref: site.hasHref,
      });
      const el: UiElement = {
        id: site.testID,
        testID: site.testID,
        type,
        action,
        label: site.label,
        filePath: f.path,
        line: site.line,
        kind: site.symbolKind ?? 'feature',
        component: site.enclosingComponent,
      };
      if (dedup.has(site.testID)) {
        const idx = screen.elements.findIndex((e) => e.testID === site.testID);
        if (idx >= 0) screen.elements[idx] = el;
      } else {
        dedup.add(site.testID);
        screen.elements.push(el);
      }
    }
  }

  for (const s of screens.values()) s.elements.sort(sortElements);
  const ordered = [...screens.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const manifest = UiMapSchema.parse({
    version: 1,
    generatedAt: opts.now ?? new Date().toISOString(),
    degraded: degraded || undefined,
    screens: ordered,
  });
  return { manifest, degraded };
}

/**
 * Build a validated `UiMap` from a set of already-read source files (extract all,
 * then assemble). Pure: the caller (host) owns directory walking + ignore
 * filtering + fs reads.
 */
export function buildManifest(files: SourceFile[], opts: { now?: string; broad?: boolean } = {}): {
  manifest: UiMap;
  degraded: boolean;
} {
  const per: FileSites[] = files.map((f) => {
    const r = extractFile(f.path, f.text, { broad: opts.broad });
    return { path: f.path, sites: r.sites, degraded: r.degraded };
  });
  return assembleManifest(per, opts);
}
