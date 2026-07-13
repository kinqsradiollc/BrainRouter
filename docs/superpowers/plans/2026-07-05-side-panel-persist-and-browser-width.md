# Side-Panel State Persistence + Browser Open-Width — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop side panel (a) preserve each open tool tab's in-panel state when you switch tabs, and (b) open the Browser tool at a comfortable, wider default.

**Architecture:** Two small, independent changes. (1) `ViewsRail` currently renders only the active tab in a div **keyed by the active tab id**, so every switch unmounts/remounts and wipes panel state — instead, render every open tab and hide the inactive ones with `display:none`, keeping each mounted (and the Browser's live `<webview>` loaded). (2) A pure, unit-tested `openWidthFor(id, currentWidth)` helper encodes a per-panel comfortable open width (Browser = 500px) as **widen-only**, called from `ensurePanel` so opening the Browser bumps the rail up without ever overriding a manual resize.

**Tech Stack:** React + TypeScript (renderer). `node:test` + `tsx` for unit tests. No schema/host/IPC changes.

## Global Constraints

- **Test runner is `node:test`, NOT vitest/jest.** `src` tests run via `tsx --test`. Mirror the existing [sideRailLayout.test.ts](../../../brainrouter-desktop/src/lib/panels/sideRailLayout.test.ts): `import test from 'node:test';` + `import assert from 'node:assert/strict';`, top-level `test('…', () => {…})`, no `describe`/`expect`.
- **ESM/NodeNext imports use a `.js` extension** on relative imports even from `.ts` sources.
- **Width bounds are fixed:** `SIDE_RAIL_MIN = 240`, `SIDE_RAIL_MAX = 760` (in `sideRailLayout.ts`); `clampSideRailWidth` floors/caps to that range. **Browser (`uitest`) open width = 500.**
- **`PanelId` type import specifier from `src/lib/panels/` is `../../panels/index.js`** (type-only; erased at runtime).
- **Widen-only:** the open-width logic must never *shrink* the current width, and must only fire on the *open* path (`ensurePanel`), never on a plain tab click (`setActiveSideTab`).
- **Do not disturb concurrent work** in these files. Edits are additive/surgical.
- **Windows hygiene:** after edits, verify no NUL byte and index line-endings stay LF (`git ls-files --eol` shows `i/lf`).

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `brainrouter-desktop/src/lib/panels/sideRailLayout.ts` | Pure side-rail layout helpers. Add `OPEN_WIDTH` map + `openWidthFor(id, currentWidth)`. | Modify |
| `brainrouter-desktop/src/lib/panels/sideRailLayout.test.ts` | Unit tests. Append `openWidthFor` cases. | Modify |
| `brainrouter-desktop/src/lib/panels/usePanels.ts` | Panel state + handlers. Import `openWidthFor`; call it in `ensurePanel`. | Modify |
| `brainrouter-desktop/src/components/ViewsRail.tsx` | Renders the active panel body. Keep every open tab mounted; hide inactive. | Modify |

**Panel ids referenced:** `'uitest'` is the Browser tool's `PanelId` (confirmed by `App.tsx` `case 'uitest': … <BrowserPanel />`). `'files'`, `'atlas'`, `'editor'` are used only as unaffected examples in tests.

---

## Task 1: `openWidthFor` pure helper + unit tests

The only unit-testable piece — the per-panel width policy. TDD.

**Files:**
- Modify: `brainrouter-desktop/src/lib/panels/sideRailLayout.ts`
- Test: `brainrouter-desktop/src/lib/panels/sideRailLayout.test.ts` (append)

**Interfaces:**
- Consumes: `clampSideRailWidth` (already in this file), `PanelId` from `../../panels/index.js`.
- Produces (relied on by Task 2): `function openWidthFor(id: PanelId, currentWidth: number): number` — returns `max(currentWidth, clamp(preferred))` when `id` has a preferred open width, else `currentWidth` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `brainrouter-desktop/src/lib/panels/sideRailLayout.test.ts`. First add `openWidthFor` to the existing import block (lines 3–10) so it reads:

```ts
import {
  SIDE_RAIL_MAX,
  SIDE_RAIL_MIN,
  clampSideRailWidth,
  openWidthFor,
  reorderByValue,
  sideRailClassName,
  sideRailFullscreenTitle,
} from './sideRailLayout.js';
```

Then append these tests at the end of the file (after line 48):

```ts

test('openWidthFor widens to the Browser comfortable width, never shrinks', () => {
  assert.equal(openWidthFor('uitest', SIDE_RAIL_MIN), 500); // 240 -> 500 on open
  assert.equal(openWidthFor('uitest', 640), 640);           // already wider: unchanged
  assert.equal(openWidthFor('uitest', 500), 500);           // exactly at the default
});

test('openWidthFor leaves panels without a preferred width untouched', () => {
  assert.equal(openWidthFor('files', SIDE_RAIL_MIN), SIDE_RAIL_MIN);
  assert.equal(openWidthFor('atlas', 300), 300);
  assert.equal(openWidthFor('editor', 720), 720);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `brainrouter-desktop/`): `npx tsx --test src/lib/panels/sideRailLayout.test.ts`
Expected: FAIL — `openWidthFor` is not exported (`SyntaxError`/import error, or "openWidthFor is not a function").

- [ ] **Step 3: Add the helper**

In `brainrouter-desktop/src/lib/panels/sideRailLayout.ts`, add the `PanelId` import at the very top (before the first comment or right after it — module top), then the map + function. Insert this import as the first line:

```ts
import type { PanelId } from '../../panels/index.js';
```

Then, immediately after the `clampSideRailWidth` function (after its closing `}` on line 9), insert:

```ts

/** Comfortable minimum width to open certain panels at — the Browser (uitest)
 *  needs room for its icon rail + URL bar + webview. Panels not listed keep the
 *  current width. */
const OPEN_WIDTH: Partial<Record<PanelId, number>> = { uitest: 500 };

/** The side width to use when a panel is opened: at least its comfortable
 *  default (if it has one), but never shrinking the user's current width. */
export function openWidthFor(id: PanelId, currentWidth: number): number {
  const pref = OPEN_WIDTH[id];
  return pref ? Math.max(currentWidth, clampSideRailWidth(pref)) : currentWidth;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `brainrouter-desktop/`): `npx tsx --test src/lib/panels/sideRailLayout.test.ts`
Expected: PASS — all tests pass (the 6 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add brainrouter-desktop/src/lib/panels/sideRailLayout.ts brainrouter-desktop/src/lib/panels/sideRailLayout.test.ts
git commit -m "feat(desktop): openWidthFor - per-panel comfortable open width (Browser 500)"
```

---

## Task 2: apply the open width in `ensurePanel`

**Files:**
- Modify: `brainrouter-desktop/src/lib/panels/usePanels.ts`

**Interfaces:**
- Consumes: `openWidthFor` (Task 1); existing `setSideWidth` setter and `ensurePanel(id)` in this hook.
- Produces: opening a panel widens the rail per `openWidthFor` (Browser → ≥500).

- [ ] **Step 1: Add `openWidthFor` to the sideRailLayout import**

In `brainrouter-desktop/src/lib/panels/usePanels.ts`, replace line 10:

```ts
import { clampSideRailWidth, reorderByValue, SIDE_RAIL_MIN } from './sideRailLayout.js';
```

with:

```ts
import { clampSideRailWidth, openWidthFor, reorderByValue, SIDE_RAIL_MIN } from './sideRailLayout.js';
```

- [ ] **Step 2: Widen on open inside `ensurePanel`**

In the `ensurePanel` function, replace its final three lines (the tab/active/open setters, currently lines 162–164):

```ts
    setSideTabs((t) => (t.includes(id) ? t : [...t, id]));
    setActiveSideTab(id);
    setSidePanelOpen(true);
```

with:

```ts
    setSideTabs((t) => (t.includes(id) ? t : [...t, id]));
    setActiveSideTab(id);
    setSidePanelOpen(true);
    // §panel-width — open certain panels (e.g. the Browser) at a comfortable
    // width; widen-only, so a manual resize is never overridden, and a no-op
    // returns the same number so React skips the re-render.
    setSideWidth((w) => openWidthFor(id, w));
```

(`ensurePanel` already `return`s early for `id === 'terminal'`, so the terminal never hits this. Panels with no preferred width get `openWidthFor` returning the same number — React bails on the identical value.)

- [ ] **Step 3: Typecheck**

Run (from `brainrouter-desktop/`): `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 4: Commit**

```bash
git add brainrouter-desktop/src/lib/panels/usePanels.ts
git commit -m "feat(desktop): open the Browser panel at a comfortable width"
```

---

## Task 3: keep every open side tab mounted (state persists on switch)

**Files:**
- Modify: `brainrouter-desktop/src/components/ViewsRail.tsx:178-179` (the active-panel render branch)

**Interfaces:**
- Consumes: existing `sideTabs: PanelId[]`, `activeSideTab`, `renderPanelBody` (all already destructured in this component).
- Produces: all open tabs mounted; only the active one visible. No new CSS — each panel remains a direct child of its own `.side-body panel-body`, identical to today.

- [ ] **Step 1: Render all tabs, hide the inactive ones**

Replace lines 178–180 of `brainrouter-desktop/src/components/ViewsRail.tsx`:

```tsx
      {activeSideTab ? (
        <div className="side-body panel-body" key={activeSideTab}>{renderPanelBody(activeSideTab)}</div>
      ) : (
```

with:

```tsx
      {activeSideTab ? (
        // §panel-persist — keep every open tab mounted (inactive ones hidden) so
        // switching tabs preserves each panel's state: drawers, scroll position,
        // and the Browser's live <webview>. Each panel is still a direct child of
        // its own `.side-body panel-body`, so no layout/CSS change is needed.
        <>{sideTabs.map((t) => (
          <div key={t} className="side-body panel-body" style={{ display: t === activeSideTab ? undefined : 'none' }}>
            {renderPanelBody(t)}
          </div>
        ))}</>
      ) : (
```

- [ ] **Step 2: Typecheck**

Run (from `brainrouter-desktop/`): `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add brainrouter-desktop/src/components/ViewsRail.tsx
git commit -m "feat(desktop): keep open side tabs mounted so state survives tab switches"
```

---

## Task 4: full verification + hygiene

**Files:** none (verification only).

- [ ] **Step 1: Unit tests (targeted)**

Run (from `brainrouter-desktop/`): `npx tsx --test src/lib/panels/sideRailLayout.test.ts`
Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 2: Full renderer test pass + typecheck**

Run (from `brainrouter-desktop/`): `npm run typecheck` then `npx tsx --test "src/**/*.test.ts"`
Expected: typecheck clean; all `src` tests pass, no new failures.

- [ ] **Step 3: Live Electron verification**

Reload the Electron window (Ctrl/Cmd-R — these are renderer-only changes). Then:
1. Open the **Browser** tool from the tools chooser → the side rail widens to ~500px (was ~240).
2. In Browser, do something stateful: open the **Accessibility** (or **Elements**) drawer and/or scroll.
3. Switch to **Atlas**, then back to **Browser** → the drawer/scroll is **exactly as you left it** (no reset), and the webview did not reload.
4. Confirm **Atlas** still renders correctly after being hidden and re-shown. Edge to watch: launching with several saved tabs where Atlas is not the initially-active one — if the ReactFlow graph shows un-fitted on first switch-to, that's the known caveat; fix by nudging a `window.dispatchEvent(new Event('resize'))` (or ReactFlow `fitView`) when a tab becomes active. If Atlas fits correctly on switch, no change needed.
5. Resize the Browser rail narrower by hand, switch away and re-open Browser from the chooser → it widens back to ~500 (widen-on-open is intended); switching *between already-open tabs* must **not** change the width.

Verify via interaction/DOM rather than screenshots (screenshots time out on the webview/ReactFlow panels).

- [ ] **Step 4: Windows hygiene**

Run (from repo root):
```bash
git ls-files --eol brainrouter-desktop/src/lib/panels/sideRailLayout.ts brainrouter-desktop/src/lib/panels/sideRailLayout.test.ts brainrouter-desktop/src/lib/panels/usePanels.ts brainrouter-desktop/src/components/ViewsRail.tsx
```
Expected: every file shows `i/lf`. Then scan each edited file for a stray NUL byte (find none). Re-normalize before finishing if any file shows `i/crlf` or a NUL.

---

## Self-Review

**1. Spec coverage:**
- Issue 1 (preserve state across tab switches): Task 3 (keep-mounted `ViewsRail` render). ✓
- Issue 2 (Browser opens wider): Task 1 (`openWidthFor`, Browser=500) + Task 2 (apply in `ensurePanel`). ✓
- Widen-only / open-path-only constraint: encoded in `openWidthFor` (`Math.max`) and by calling it in `ensurePanel` (open path), never in `setActiveSideTab` (tab click) — covered by Task 1 tests + Task 4 live step 5. ✓

**2. Placeholder scan:** no `TBD`/`TODO`/"handle edge cases"; every code step shows complete code; every command has expected output. The ReactFlow caveat in Task 4 is a conditional verification with a concrete fix, not a placeholder. ✓

**3. Type consistency:** `openWidthFor(id: PanelId, currentWidth: number): number` is defined in Task 1 and consumed with that exact signature in Task 2 (`setSideWidth((w) => openWidthFor(id, w))`) and the tests. `OPEN_WIDTH` uses `Partial<Record<PanelId, number>>`; `uitest`/`files`/`atlas`/`editor` are valid `PanelId`s. The import specifier `../../panels/index.js` matches `usePanels.ts`. ✓

**Known limitation (by design):** the rail width is global (shared across tabs), not per-tab — opening the Browser widens the shared rail, which then stays until the user resizes. This matches the approved design (a single comfortable width, not per-tab widths).
