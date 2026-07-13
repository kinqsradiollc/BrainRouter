/**
 * rowSource — resolve a live Accessibility row (role/name/testid) back to its
 * source file, best-effort, by joining against the generated UI map:
 *
 *   1. exact  — the row's testid matches an element id/testID in some screen ->
 *               that element's filePath[:line].
 *   2. screen — else, the current Browser route matches a screen -> that
 *               screen's filePath (no line).
 *   3. none   — no map / no match -> no file; ref is just the row's name + role.
 *
 * Pure and DOM-free so it runs under tsx/node --test (no React, no webview).
 */
import type { UiMap, Screen, SymbolKind } from '@kinqs/brainrouter-ui-test';

/** One row of the Browser panel's Accessibility snapshot. */
export interface A11yRow {
  role: string;
  name: string;
  testid?: string;
}

/** Where an a11y row came from, plus the drag/chat reference string. */
export interface RowSource {
  /** Workspace-relative source file, when known. */
  filePath?: string;
  /** 1-based line within filePath, when known (exact matches only). */
  line?: number;
  /** True when resolved to an exact element (not just the owning screen). */
  exact: boolean;
  /** Source-symbol kind of the resolved element (exact matches only). */
  kind?: SymbolKind;
  /** Enclosing component/function/class name of the resolved element, when known. */
  component?: string;
  /** Payload dropped into chat / shown on the source link. */
  ref: string;
}

/** kebab a human label into a URL-ish anchor ("Add todo" -> "add-todo"). */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Normalize a route/URL fragment: drop leading #/ and trailing slashes, lowercase. */
export function normRoute(r: string): string {
  return r.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
}

/** Pull a comparable route out of a full browser URL — hash first (hash router),
 *  else pathname. "http://x/#/todos" -> "todos"; "http://x/login" -> "login". */
export function routeOfUrl(url: string): string {
  try {
    const u = new URL(url);
    return normRoute(u.hash ? u.hash.slice(1) : u.pathname);
  } catch {
    return normRoute(url);
  }
}

/** Find the screen whose route matches the current URL (normalized). */
export function matchScreen(uiMap: UiMap | null, url: string): Screen | undefined {
  if (!uiMap) return undefined;
  const route = routeOfUrl(url);
  if (!route) return undefined;
  return uiMap.screens.find((s) => s.route != null && normRoute(s.route) === route);
}

/** Resolve one a11y row to its source, best-effort. */
export function rowSource(row: A11yRow, uiMap: UiMap | null, url: string): RowSource {
  const anchor = row.testid || slug(row.name) || row.role;
  const nameRef = row.name ? `${row.name} (${row.role})` : row.role;

  // 1. exact — testid matches an element in any screen.
  if (row.testid && uiMap) {
    for (const screen of uiMap.screens) {
      const el = screen.elements.find((e) => e.id === row.testid || e.testID === row.testid);
      if (el && el.filePath) {
        const ref = el.line != null ? `${el.filePath}:${el.line}#${row.testid}` : `${el.filePath}#${row.testid}`;
        return { filePath: el.filePath, line: el.line, exact: true, kind: el.kind, component: el.component, ref };
      }
    }
  }

  // 2. screen — current route maps to a screen with a known file.
  const screen = matchScreen(uiMap, url);
  if (screen && screen.filePath) {
    return { filePath: screen.filePath, exact: false, ref: `${screen.filePath}#${anchor}` };
  }

  // 3. none — no file; still draggable as a human reference.
  return { exact: false, ref: nameRef };
}

/** Map a source-symbol kind to an Icon name (see brainrouter-desktop/src/icons.tsx).
 *  component → layout, function → code, class → command, feature → spark,
 *  unresolved → dots (neutral). Shared by the a11y rows and the composer tag chips. */
export function symbolKindIcon(kind?: string): string {
  switch (kind) {
    case 'component': return 'layout';
    case 'function': return 'code';
    case 'class': return 'command';
    case 'feature': return 'spark';
    case 'journey': return 'branch';
    default: return 'dots';
  }
}
