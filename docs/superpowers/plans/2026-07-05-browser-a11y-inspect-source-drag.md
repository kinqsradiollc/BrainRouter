# Browser Accessibility Rows — Inspect · Jump-to-Source · Drag-to-Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each row in the Browser panel's **Accessibility** drawer into an inspection + navigation affordance — hover to highlight the live element, click **↪ source** to open its source file at the line, and drag the row into chat to drop a `path:line#id` reference.

**Architecture:** Rows come from the live DOM (`a11ySnapshot` → `{ role, name, testid? }`) and carry no source location. A new **pure resolver** (`rowSource.ts`) joins each row to the already-extracted **UI map** (`atlasUiMap`, whose elements carry `filePath`/`line`) — exact by `testid`, else best-effort to the current route's screen file. The Browser panel is **propless by design** (it talks to App via `localStorage` + `br-browser-*` window events); we keep that contract: App mirrors `atlasUiMap` to `localStorage['br-browser-uimap']`, and the panel dispatches `br-browser-openfile` / `br-browser-loaduimap` back to App. Hover-highlight reuses the existing webview injection style (`__brResolve` resolver + inline outline). Drag-to-chat is native `dataTransfer` + a one-branch extension of the Composer's existing `onDrop`.

**Tech Stack:** React + TypeScript (renderer), Electron `<webview>` `executeJavaScript`, Zod-derived `UiMap` types from `@kinqs/brainrouter-ui-test`, `node:test` + `tsx` for unit tests.

## Global Constraints

- **Test runner is `node:test`, NOT vitest/jest.** Renderer/`src` tests run via `tsx --test`; compiled Electron tests via `node --test`. Mirror `src/lib/format.test.ts`: `import test from 'node:test';` + `import assert from 'node:assert/strict';`, top-level `test('…', () => {…})`, no `describe`/`expect`.
- **ESM/NodeNext imports use a `.js` extension on relative imports even from `.ts` sources** (e.g. `from './rowSource.js'`).
- **`UiMap`/`Screen` types import specifier is exactly `@kinqs/brainrouter-ui-test/dist/types.js`** (type-only import; erased at runtime).
- **Outline accent color is `#7c5cff`** (matches the existing `FLASH` / `HIGHLIGHT_JS`).
- **`openFile` signature is `(path: string, line?: number) => void`.**
- **BrowserPanel takes NO props** — cross-component data flows through `localStorage` keys + `br-browser-*` `CustomEvent`s that App forwards. Do **not** convert it to a props-based component.
- **Do not disturb the concurrent UI-Stories code** in `BrowserPanel.tsx` (`runStory`, `drive`, screenshot/run-result handoffs) or `uitestHost.ts`. Edits here are additive.
- **Windows hygiene:** after large edits, verify no NUL byte was injected and line endings stayed LF-in-repo (`git ls-files --eol` shows `i/lf`). Big mixed CRLF/LF edits inflate diffs.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `brainrouter-desktop/src/lib/uitest/rowSource.ts` | **New.** Pure, DOM-free resolver: a11y row + UI map + current URL → `{ filePath?, line?, exact, ref }`, plus `slug`/`normRoute`/`routeOfUrl`/`matchScreen` helpers. | Create |
| `brainrouter-desktop/src/lib/uitest/rowSource.test.ts` | **New.** Unit tests for the resolver (exact / screen-fallback / none / route matching). | Create |
| `brainrouter-desktop/src/lib/uitest/webviewBridge.ts` | Adds `highlightEl` / `clearHighlight` (single-element persistent hover outline via the existing `__brResolve` resolver). | Modify |
| `brainrouter-desktop/src/App.tsx` | Mirrors `atlasUiMap` → `localStorage` + `br-browser-uimap` event; forwards `br-browser-openfile` → `openFile` and `br-browser-loaduimap` → `uitest:manifest`. | Modify |
| `brainrouter-desktop/src/panels/BrowserPanel.tsx` | Loads the mirrored map; a11y rows gain hover-highlight, an **↪ source** link, and drag payload. | Modify |
| `brainrouter-desktop/src/components/Composer.tsx` | Extends `onDrop`: when no files are dropped, append the dragged text ref to the draft. | Modify |
| `brainrouter-desktop/src/theme.css` | Styles for `.br-a11y` hover/grab cursor and the `.br-a11y-src` link. | Modify |

**Data-flow contract (shared string constants — must match across files):**
- `localStorage` key: `br-browser-uimap` — JSON of `atlasUiMap` (or removed when null). *Written by App (Task 3), read by BrowserPanel (Task 4).*
- Event `br-browser-uimap` — fired by App after each map write. *Listened by BrowserPanel (Task 4).*
- Event `br-browser-openfile` — `CustomEvent<{ path?: string; line?: number }>`. *Fired by BrowserPanel (Task 4), handled by App → `openFile` (Task 3).*
- Event `br-browser-loaduimap` — no payload. *Fired by BrowserPanel when it has no map (Task 4), handled by App → `q('q-uitest-manifest', 'uitest:manifest')` (Task 3).*
- Drag MIME: `application/x-brainrouter-ref` (primary) + `text/plain` (fallback), value = `RowSource.ref`. *Set by BrowserPanel (Task 4), read by Composer (Task 5).*

---

## Task 1: `rowSource` pure resolver + unit tests

The risk-bearing core, and the only fully unit-testable unit. Build it first with TDD.

**Files:**
- Create: `brainrouter-desktop/src/lib/uitest/rowSource.ts`
- Test: `brainrouter-desktop/src/lib/uitest/rowSource.test.ts`

**Interfaces:**
- Consumes: `UiMap`, `Screen` from `@kinqs/brainrouter-ui-test/dist/types.js` (`Screen.route: string|null|undefined`, `Screen.filePath?`, `Screen.elements: {id, testID, filePath?, line?}[]`).
- Produces (relied on by Tasks 4 & 5):
  - `interface A11yRow { role: string; name: string; testid?: string }`
  - `interface RowSource { filePath?: string; line?: number; exact: boolean; ref: string }`
  - `function rowSource(row: A11yRow, uiMap: UiMap | null, url: string): RowSource`
  - `function slug(s: string): string`, `function normRoute(r: string): string`, `function routeOfUrl(url: string): string`, `function matchScreen(uiMap: UiMap | null, url: string): Screen | undefined`

- [ ] **Step 1: Write the failing test**

Create `brainrouter-desktop/src/lib/uitest/rowSource.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowSource, matchScreen, routeOfUrl, normRoute, slug } from './rowSource.js';
import type { UiMap } from '@kinqs/brainrouter-ui-test/dist/types.js';

const MAP: UiMap = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  screens: [
    {
      id: 'login', title: 'Login', platform: 'web', route: '/login',
      filePath: 'examples/mock-ui/screens/Login.tsx',
      elements: [
        { id: 'login-submit', testID: 'login-submit', type: 'button', action: 'tap', label: 'Sign in', filePath: 'examples/mock-ui/screens/Login.tsx', line: 14 },
        { id: 'email-field', testID: 'email-field', type: 'input', action: 'type', label: 'Email', filePath: 'examples/mock-ui/screens/Login.tsx' },
      ],
    },
    {
      id: 'todos', title: 'Todos', platform: 'web', route: '/todos',
      filePath: 'examples/mock-ui/screens/Todos.tsx',
      elements: [
        { id: 'todo-add', testID: 'todo-add', type: 'button', action: 'tap', filePath: 'examples/mock-ui/screens/Todos.tsx', line: 22 },
      ],
    },
  ],
};

test('slug kebabs a human label', () => {
  assert.equal(slug('Add todo'), 'add-todo');
  assert.equal(slug('  Increment! '), 'increment');
});

test('normRoute strips #, leading/trailing slashes, lowercases', () => {
  assert.equal(normRoute('#/Todos/'), 'todos');
  assert.equal(normRoute('/login'), 'login');
});

test('routeOfUrl reads hash route first, else pathname', () => {
  assert.equal(routeOfUrl('http://localhost:5174/#/todos'), 'todos');
  assert.equal(routeOfUrl('http://localhost:5174/login'), 'login');
});

test('matchScreen finds a screen by normalized route', () => {
  assert.equal(matchScreen(MAP, 'http://localhost:5174/#/login')?.id, 'login');
  assert.equal(matchScreen(MAP, 'http://x/#/nope'), undefined);
  assert.equal(matchScreen(null, 'http://x/#/login'), undefined);
});

test('exact: testid in map -> element file:line and ref', () => {
  const s = rowSource({ role: 'button', name: 'Sign in', testid: 'login-submit' }, MAP, 'http://x/#/login');
  assert.equal(s.exact, true);
  assert.equal(s.filePath, 'examples/mock-ui/screens/Login.tsx');
  assert.equal(s.line, 14);
  assert.equal(s.ref, 'examples/mock-ui/screens/Login.tsx:14#login-submit');
});

test('exact without a line -> ref omits :line', () => {
  const s = rowSource({ role: 'textbox', name: 'Email', testid: 'email-field' }, MAP, 'http://x/#/login');
  assert.equal(s.exact, true);
  assert.equal(s.line, undefined);
  assert.equal(s.ref, 'examples/mock-ui/screens/Login.tsx#email-field');
});

test('screen fallback: unknown testid but route matches -> screen file', () => {
  const s = rowSource({ role: 'button', name: 'Mystery', testid: 'not-in-map' }, MAP, 'http://x/#/todos');
  assert.equal(s.exact, false);
  assert.equal(s.filePath, 'examples/mock-ui/screens/Todos.tsx');
  assert.equal(s.line, undefined);
  assert.equal(s.ref, 'examples/mock-ui/screens/Todos.tsx#not-in-map');
});

test('screen fallback: no testid -> anchor is slug(name)', () => {
  const s = rowSource({ role: 'heading', name: 'My Todos' }, MAP, 'http://x/#/todos');
  assert.equal(s.filePath, 'examples/mock-ui/screens/Todos.tsx');
  assert.equal(s.ref, 'examples/mock-ui/screens/Todos.tsx#my-todos');
});

test('none: null map -> no file, human ref', () => {
  const s = rowSource({ role: 'button', name: 'Increment', testid: 'counter-increment' }, null, 'http://x/#/home');
  assert.equal(s.filePath, undefined);
  assert.equal(s.exact, false);
  assert.equal(s.ref, 'Increment (button)');
});

test('none: testid not in map and route has no screen -> human ref', () => {
  const s = rowSource({ role: 'button', name: 'Ghost', testid: 'ghost' }, MAP, 'http://x/#/unknown');
  assert.equal(s.filePath, undefined);
  assert.equal(s.ref, 'Ghost (button)');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `brainrouter-desktop/`): `npx tsx --test src/lib/uitest/rowSource.test.ts`
Expected: FAIL — `Cannot find module './rowSource.js'` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `brainrouter-desktop/src/lib/uitest/rowSource.ts`:

```ts
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
import type { UiMap, Screen } from '@kinqs/brainrouter-ui-test/dist/types.js';

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
        return { filePath: el.filePath, line: el.line, exact: true, ref };
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `brainrouter-desktop/`): `npx tsx --test src/lib/uitest/rowSource.test.ts`
Expected: PASS — all 9 tests pass (`# pass 9`, `# fail 0`).

- [ ] **Step 5: Commit**

```bash
git add brainrouter-desktop/src/lib/uitest/rowSource.ts brainrouter-desktop/src/lib/uitest/rowSource.test.ts
git commit -m "feat(desktop): rowSource — resolve a11y rows to source via the UI map"
```

---

## Task 2: `highlightEl` / `clearHighlight` in the webview bridge

Single-element persistent hover outline, using the existing `__brResolve` resolver and injection style.

**Files:**
- Modify: `brainrouter-desktop/src/lib/uitest/webviewBridge.ts` (insert after `assertVisible`, which currently ends at line 234)

**Interfaces:**
- Consumes: `RESOLVE_FN`, `resolveArgs`, `WebviewEl`, `ResolveHint`, `ActionResult` (all already in this file).
- Produces (relied on by Task 4):
  - `function highlightEl(wv: WebviewEl, target: string, hint?: ResolveHint): Promise<ActionResult>`
  - `function clearHighlight(wv: WebviewEl): Promise<ActionResult>`

> **Verification note:** the webview bridge is injected-JS-string glue with **no unit tests in this codebase** (it needs a live `<webview>`; the test harness is pure Node, no DOM). Consistent with the existing `tap`/`typeText`/`setHighlight`, these two functions are verified by `typecheck` (Task 7) + live Electron (Task 7), not a unit test.

- [ ] **Step 1: Add the two functions**

Insert immediately after the `assertVisible` function (after line 234) in `webviewBridge.ts`:

```ts

// Persistent hover outline for the Accessibility list: resolve the element the
// user points at, outline it, and scroll it into view — until cleared. Unlike
// FLASH (transient, 700ms) and HIGHLIGHT_JS (every [data-testid]), this outlines
// ONE element and restores its prior inline outline on clear.
export function highlightEl(wv: WebviewEl, target: string, hint?: ResolveHint): Promise<ActionResult> {
  const js = `(() => { ${RESOLVE_FN}
    try { var p = window.__uitestHoverEl; if (p && p.el) { p.el.style.outline = p.o || ''; p.el.style.outlineOffset = p.oo || ''; } } catch(e){}
    var el=__brResolve(${resolveArgs(target, hint)});
    if(!el){ window.__uitestHoverEl=null; return { ok:false, error:'not found: '+${JSON.stringify(target)} }; }
    window.__uitestHoverEl={ el: el, o: el.style.outline, oo: el.style.outlineOffset };
    el.style.outline='2px solid #7c5cff'; el.style.outlineOffset='1px';
    el.scrollIntoView({block:'center',inline:'nearest'});
    return { ok:true };
  })()`;
  return wv.executeJavaScript(js, true) as Promise<ActionResult>;
}

/** Remove the hover outline set by highlightEl, restoring the element's prior inline outline. */
export function clearHighlight(wv: WebviewEl): Promise<ActionResult> {
  const js = `(() => {
    try { var p = window.__uitestHoverEl; if (p && p.el) { p.el.style.outline = p.o || ''; p.el.style.outlineOffset = p.oo || ''; } } catch(e){}
    window.__uitestHoverEl=null; return { ok:true };
  })()`;
  return wv.executeJavaScript(js, true) as Promise<ActionResult>;
}
```

- [ ] **Step 2: Typecheck**

Run (from `brainrouter-desktop/`): `npm run typecheck`
Expected: PASS — no errors. (If it errors with a missing `@kinqs/brainrouter-ui-test/dist` type, run `npm run build:deps` once first, then re-run.)

- [ ] **Step 3: Commit**

```bash
git add brainrouter-desktop/src/lib/uitest/webviewBridge.ts
git commit -m "feat(desktop): webview bridge — highlightEl/clearHighlight hover outline"
```

---

## Task 3: App-side handoff wiring

Mirror the UI map to `localStorage` and forward the panel's `openfile` / `loaduimap` events. Follows the existing propless-panel event pattern verbatim.

**Files:**
- Modify: `brainrouter-desktop/src/App.tsx` — the existing `br-browser-*` listener effect (lines 430–446) and a new adjacent effect.

**Interfaces:**
- Consumes: `openFile(path, line?)` (destructured at line 483), `q(id, name, args?)` (already used in this effect), `atlasUiMap` state (line 259).
- Produces: `localStorage['br-browser-uimap']`, events `br-browser-uimap`; handlers for `br-browser-openfile` and `br-browser-loaduimap` (contract in File Structure above).

- [ ] **Step 1: Extend the `br-browser-*` listener effect**

Replace the effect at `App.tsx` lines 430–446 (the `useEffect` beginning `const onSaveShot = …`) with:

```tsx
  useEffect(() => {
    const onSaveShot = (e: Event): void => {
      const d = (e as CustomEvent<{ dataUrl?: string; name?: string }>).detail;
      if (d?.dataUrl) q('q-uitest-shot', 'uitest:save-screenshot', { dataUrl: d.dataUrl, name: d.name });
    };
    const onRunResult = (e: Event): void => {
      const d = (e as CustomEvent<Record<string, unknown>>).detail;
      if (d) q('q-uitest-report', 'uitest:run-report', d);
    };
    // A11y-row -> source: the Browser panel asks App to open a file at a line.
    const onOpenFile = (e: Event): void => {
      const d = (e as CustomEvent<{ path?: string; line?: number }>).detail;
      if (d?.path) openFile(d.path, typeof d.line === 'number' ? d.line : undefined);
    };
    // The Browser panel wants the UI map but has none yet -> load the manifest;
    // its result lands in atlasUiMap and is mirrored back via localStorage.
    const onLoadUiMap = (): void => { q('q-uitest-manifest', 'uitest:manifest'); };
    window.addEventListener('br-browser-savescreenshot', onSaveShot);
    window.addEventListener('br-browser-runresult', onRunResult);
    window.addEventListener('br-browser-openfile', onOpenFile);
    window.addEventListener('br-browser-loaduimap', onLoadUiMap);
    return () => {
      window.removeEventListener('br-browser-savescreenshot', onSaveShot);
      window.removeEventListener('br-browser-runresult', onRunResult);
      window.removeEventListener('br-browser-openfile', onOpenFile);
      window.removeEventListener('br-browser-loaduimap', onLoadUiMap);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 2: Add the UI-map mirror effect**

Immediately after that effect (after the closing `}, []);` at line 446), insert:

```tsx

  // Mirror the generated UI map to localStorage so the (propless) Browser panel
  // can resolve Accessibility rows to their source files, and notify an open panel.
  useEffect(() => {
    try {
      if (atlasUiMap) localStorage.setItem('br-browser-uimap', JSON.stringify(atlasUiMap));
      else localStorage.removeItem('br-browser-uimap');
    } catch { /* ignore quota / serialization errors */ }
    window.dispatchEvent(new CustomEvent('br-browser-uimap'));
  }, [atlasUiMap]);
```

- [ ] **Step 3: Typecheck**

Run (from `brainrouter-desktop/`): `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 4: Commit**

```bash
git add brainrouter-desktop/src/App.tsx
git commit -m "feat(desktop): App forwards a11y openfile + mirrors UI map to Browser panel"
```

---

## Task 4: BrowserPanel — hover-highlight, ↪ source link, drag payload

**Files:**
- Modify: `brainrouter-desktop/src/panels/BrowserPanel.tsx`

**Interfaces:**
- Consumes: `highlightEl`, `clearHighlight` (Task 2); `rowSource`, `A11yRow` (Task 1); `atlasUiMap` mirror + events (Task 3); existing `wvRef`, `ready`, `url`, `withWv`, `a11ySnapshot`.
- Produces: enriched `.br-a11y` rows (consumed visually + by Composer via drag MIME `application/x-brainrouter-ref` / `text/plain`).

- [ ] **Step 1: Extend the webviewBridge import**

In the import block at lines 11–26, add `highlightEl` and `clearHighlight`. Replace:

```tsx
  a11ySnapshot,
  tap,
  typeText,
  assertVisible,
} from '../lib/uitest/webviewBridge.js';
```

with:

```tsx
  a11ySnapshot,
  tap,
  typeText,
  assertVisible,
  highlightEl,
  clearHighlight,
} from '../lib/uitest/webviewBridge.js';
```

- [ ] **Step 2: Add the UiMap type + rowSource imports**

Immediately after the webviewBridge import (after line 26), add:

```tsx
import type { UiMap } from '@kinqs/brainrouter-ui-test/dist/types.js';
import { rowSource } from '../lib/uitest/rowSource.js';
```

- [ ] **Step 3: Add the map reader + key at module scope**

Next to `const URL_KEY = 'br-browser-url';` (line 37), add:

```tsx
const UIMAP_KEY = 'br-browser-uimap';
function readUiMap(): UiMap | null {
  try { const raw = localStorage.getItem(UIMAP_KEY); return raw ? (JSON.parse(raw) as UiMap) : null; } catch { return null; }
}
```

- [ ] **Step 4: Add `uiMap` state**

Immediately after `const [logsOpen, setLogsOpen] = useState(true);` (line 68), add:

```tsx
  const [uiMap, setUiMap] = useState<UiMap | null>(() => readUiMap());
```

- [ ] **Step 5: Add the map-refresh listener + hover helpers**

Immediately after the `withWv` helper (after line 139), add:

```tsx

  // The UI map is produced by the Atlas extract flow and mirrored to localStorage
  // by App; refresh our copy whenever it changes so source links stay current.
  useEffect(() => {
    const onMap = (): void => setUiMap(readUiMap());
    window.addEventListener('br-browser-uimap', onMap);
    return () => window.removeEventListener('br-browser-uimap', onMap);
  }, []);

  // §a11y-inspect — map an a11y role to the resolver's coarse type hint so the
  // fuzzy fallback finds the right control when a row has no data-testid.
  const roleToType = (role: string): string | undefined => {
    if (role === 'link') return 'link';
    if (role === 'button') return 'button';
    if (role === 'combobox') return 'select';
    if (role === 'textbox' || role === 'searchbox') return 'input';
    return undefined;
  };
  const hoverHighlight = (n: { role: string; name: string; testid?: string }): void => {
    const wv = wvRef.current; if (!wv || !ready) return;
    highlightEl(wv, n.testid || n.name, { label: n.name, type: roleToType(n.role) }).catch(() => { /* ignore */ });
  };
  const hoverClear = (): void => {
    const wv = wvRef.current; if (!wv || !ready) return;
    clearHighlight(wv).catch(() => { /* ignore */ });
  };
```

- [ ] **Step 6: Auto-load the map when the Accessibility drawer opens without one**

Replace `doA11y` (line 166):

```tsx
  const doA11y = () => withWv(async (wv) => { setA11y(await a11ySnapshot(wv)); setDrawer('a11y'); });
```

with:

```tsx
  const doA11y = () => withWv(async (wv) => {
    setA11y(await a11ySnapshot(wv));
    setDrawer('a11y');
    if (!uiMap) window.dispatchEvent(new CustomEvent('br-browser-loaduimap'));
  });
```

- [ ] **Step 7: Enrich the a11y row JSX**

Replace the a11y render branch (lines 374–376):

```tsx
                {drawer === 'a11y' && (a11y.length ? a11y.map((n, i) => (
                  <div key={i} className="br-a11y"><span className="br-a11y-role">{n.role}</span><span className="br-a11y-name">{n.name || '—'}</span>{n.testid && <span className="br-a11y-tid">{n.testid}</span>}</div>
                )) : <div className="br-empty">No accessibility nodes found.</div>)}
```

with:

```tsx
                {drawer === 'a11y' && (a11y.length ? a11y.map((n, i) => {
                  const src = rowSource(n, uiMap, url);
                  return (
                    <div key={i} className="br-a11y" draggable
                      title={`Drag into chat · ${src.ref}`}
                      onMouseEnter={() => hoverHighlight(n)}
                      onMouseLeave={hoverClear}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', src.ref);
                        e.dataTransfer.setData('application/x-brainrouter-ref', src.ref);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}>
                      <span className="br-a11y-role">{n.role}</span>
                      <span className="br-a11y-name">{n.name || '—'}</span>
                      {n.testid && <span className="br-a11y-tid">{n.testid}</span>}
                      {src.filePath && (
                        <button className="br-a11y-src"
                          title={`Open ${src.filePath}${src.line != null ? ':' + src.line : ''}`}
                          onClick={() => window.dispatchEvent(new CustomEvent('br-browser-openfile', { detail: { path: src.filePath, line: src.line } }))}>↪ source</button>
                      )}
                    </div>
                  );
                }) : <div className="br-empty">No accessibility nodes found.</div>)}
```

- [ ] **Step 8: Typecheck**

Run (from `brainrouter-desktop/`): `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 9: Commit**

```bash
git add brainrouter-desktop/src/panels/BrowserPanel.tsx
git commit -m "feat(desktop): a11y rows — hover highlight, source link, drag-to-chat ref"
```

---

## Task 5: Composer — append a dragged text ref to the draft

**Files:**
- Modify: `brainrouter-desktop/src/components/Composer.tsx` — the outer `<div className="box …">` `onDrop` (lines 138–143).

**Interfaces:**
- Consumes: existing `draft`, `setDraft`, `onAttach`, `handleFiles`, `dragOver`/`setDragOver`, and the drag MIME set by Task 4.
- Produces: dropping a text ref (no files) appends it to the draft. No new prop; image/file drop is unchanged.

- [ ] **Step 1: Extend `onDrop`**

Replace the outer wrapper (lines 138–143):

```tsx
      <div
        className={`box${dragOver ? ' drag-over' : ''}`}
        onDragOver={onAttach ? (e) => { e.preventDefault(); if (!dragOver) setDragOver(true); } : undefined}
        onDragLeave={onAttach ? () => setDragOver(false) : undefined}
        onDrop={onAttach ? (e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); } : undefined}
      >
```

with:

```tsx
      <div
        className={`box${dragOver ? ' drag-over' : ''}`}
        onDragOver={onAttach ? (e) => { e.preventDefault(); if (!dragOver) setDragOver(true); } : undefined}
        onDragLeave={onAttach ? () => setDragOver(false) : undefined}
        onDrop={onAttach ? (e) => {
          e.preventDefault(); setDragOver(false);
          if (e.dataTransfer.files.length) { handleFiles(e.dataTransfer.files); return; }
          // §a11y-inspect — a dragged Accessibility row (or any text) appends its
          // file reference to the draft so you can point the agent straight at it.
          const ref = e.dataTransfer.getData('application/x-brainrouter-ref') || e.dataTransfer.getData('text/plain');
          if (ref) setDraft(draft ? draft.replace(/\s*$/, '') + ' ' + ref : ref);
        } : undefined}
      >
```

- [ ] **Step 2: Typecheck**

Run (from `brainrouter-desktop/`): `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add brainrouter-desktop/src/components/Composer.tsx
git commit -m "feat(desktop): composer accepts a dragged a11y ref into the draft"
```

---

## Task 6: Styles for the enriched a11y rows

**Files:**
- Modify: `brainrouter-desktop/src/theme.css` — insert after `.br-a11y-tid` (line 4065).

- [ ] **Step 1: Add the CSS rules**

Immediately after `.br-a11y-tid { … }` (line 4065), insert:

```css
.br-a11y { cursor: grab; border-radius: 6px; }
.br-a11y:hover { background: var(--bg-elev, rgba(127,127,127,0.08)); }
.br-a11y:active { cursor: grabbing; }
.br-a11y-src { margin-left: auto; padding: 1px 7px; border-radius: 5px; border: 1px solid var(--border); background: transparent; color: var(--accent); font-size: 10px; cursor: pointer; opacity: 0; white-space: nowrap; }
.br-a11y:hover .br-a11y-src { opacity: 1; }
.br-a11y-src:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
```

- [ ] **Step 2: Commit**

```bash
git add brainrouter-desktop/src/theme.css
git commit -m "style(desktop): a11y row hover + source-link affordances"
```

---

## Task 7: Full verification + hygiene

**Files:** none (verification only).

- [ ] **Step 1: Unit tests (targeted)**

Run (from `brainrouter-desktop/`): `npx tsx --test src/lib/uitest/rowSource.test.ts`
Expected: `# pass 9`, `# fail 0`.

- [ ] **Step 2: Full desktop gate**

Run (from `brainrouter-desktop/`): `npm test`
Expected: `build:deps` + `typecheck` + `build:electron` succeed; `node --test dist-electron/**/*.test.js` and `tsx --test src/**/*.test.ts` both pass, including `rowSource.test.ts`. (Pre-existing Windows env failures noted in project memory are the known baseline — confirm no *new* failures in the files this plan touched.)

- [ ] **Step 3: Live Electron verification on the mock**

Start the desktop app (from `brainrouter-desktop/`): `npm run start:fast` (or the existing Electron dev flow). Then:
1. Ensure the mock-ui dev server is running on `:5174` and, in the **Atlas → Screens** mode, **Extract** once so `atlasUiMap` is populated (or rely on the auto-load: opening the Accessibility drawer with no map dispatches `br-browser-loaduimap`).
2. Open the **Browser** panel, navigate to `http://localhost:5174/#/home`, click **Accessibility**.
3. **Hover** a row (e.g. `button — Increment`) → the matching control in the webview gains a `#7c5cff` outline and scrolls into view; moving off the row clears it.
4. Click **↪ source** on a resolvable row → the editor opens the element's source file; exact rows land on the element's line.
5. **Drag** a row into the chat composer → the draft gains the ref (e.g. `examples/mock-ui/screens/Home.tsx:NN#counter-increment`), appended with a leading space if the draft was non-empty.

Because `preview_screenshot` times out on the ReactFlow/webview panels (known tooling limit), verify outline/scroll/link/draft state via DOM inspection (`preview_eval`) rather than screenshots.

- [ ] **Step 4: Windows hygiene**

Run (from repo root):
```bash
git ls-files --eol brainrouter-desktop/src/lib/uitest/rowSource.ts brainrouter-desktop/src/lib/uitest/rowSource.test.ts brainrouter-desktop/src/lib/uitest/webviewBridge.ts brainrouter-desktop/src/App.tsx brainrouter-desktop/src/panels/BrowserPanel.tsx brainrouter-desktop/src/components/Composer.tsx brainrouter-desktop/src/theme.css
```
Expected: every file shows `i/lf` (repo-normalized LF). Then scan each edited file for a stray NUL byte (`grep -Pl "\x00"` finds none). If any file shows `i/crlf` or a NUL, re-normalize before finishing.

- [ ] **Step 5: Final commit (if hygiene required fixups)**

```bash
git add -A
git commit -m "chore(desktop): a11y-inspect verification + line-ending hygiene"
```

---

## Self-Review

**1. Spec coverage** — the three approved behaviors + the approved best-effort rule all map to tasks:
- (A) hover → highlight the live element: Task 2 (`highlightEl`/`clearHighlight`) + Task 4 Step 5/7 (row `onMouseEnter`/`onMouseLeave`). ✓
- (B) ↪ jump to source, best-effort (exact `testid`, else route→screen file): Task 1 (`rowSource`) + Task 4 Step 7 (`↪ source` → `br-browser-openfile`) + Task 3 Step 1 (`openFile`). ✓
- (C) drag row → chat gets `path[:line]#id`: Task 1 (`ref`) + Task 4 Step 7 (`dataTransfer`) + Task 5 (Composer `onDrop`). ✓
- "Best-effort: exact, else screen file; link present when any file is known": encoded in `rowSource` branches 1/2/3 and gated in JSX by `src.filePath`. ✓
- Map delivery to the propless panel: Task 3 (mirror + events) + Task 4 (read + refresh + auto-load). ✓

**2. Placeholder scan** — no `TBD`/`TODO`/"handle edge cases"/"similar to Task N"; every code step shows complete code; every command has an expected result. ✓

**3. Type consistency** — `A11yRow`/`RowSource`/`rowSource`/`slug`/`normRoute`/`routeOfUrl`/`matchScreen` names are identical across Task 1 (def), Task 4 (use). Event names (`br-browser-uimap`, `br-browser-openfile`, `br-browser-loaduimap`), the `localStorage` key (`br-browser-uimap` = `UIMAP_KEY`), and the drag MIME (`application/x-brainrouter-ref`) match between App (Task 3), BrowserPanel (Task 4), and Composer (Task 5). `openFile(path, line?)` and `highlightEl(wv, target, hint?)` signatures match their call sites. `Screen.route` is `string | null | undefined` — `matchScreen` guards with `s.route != null`. ✓

**Known limitations (by design, per the approved "best-effort" decision):**
- Source links require an extracted UI map; rows whose `testid` isn't in the map fall back to the current route's screen file, and rows on a route with no matching screen (or with no map) get no link but stay draggable (name+role ref).
- The route→screen fallback uses the panel's `url` state; after an in-page hash change that didn't emit a navigation event, the fallback route may lag (exact `testid` matches are unaffected).
