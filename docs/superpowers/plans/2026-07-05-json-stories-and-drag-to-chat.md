# JSON Stories Manifest + Drag-a-Story-to-Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Atlas "UI Stories" panel list stories from a single `stories.json` manifest (in addition to `*.story.yaml`), and let a story row be dragged into chat as a removable "journey" chip that asks the agent to explain the flow.

**Architecture:** Add a pure `parseStoriesJson(text) → Story[]` to the ui-test package; the host's `listStories` merges the manifest with the YAML files (dedupe by id). Reuse the existing composer tag-chip infra (`application/x-brainrouter-tag` + `componentTags` + `onDropTag`) — a story drag writes a `{ kind:'journey', steps }` tag; the composer already renders and drops any such tag, so the only additions are a `steps?` field, a `'journey'` icon, and a second serialization block in `submit()`. Click-to-trace and ▶-run already exist and are untouched.

**Tech Stack:** TypeScript, Zod (`StorySchema`), `node:test` + `tsx`/`node --test`, React (renderer), Electron main (host).

## Global Constraints

- **Work in the MAIN checkout `D:\BrainRouter\BrainRouter`** (branch `feat/ui-testing-release-0.4.16`). The shell CWD is a separate worktree — prefix every command with `Push-Location 'D:\BrainRouter\BrainRouter'` / `Pop-Location`, and use `git -C 'D:\BrainRouter\BrainRouter'` for git.
- **Test runner is `node:test`** (NOT vitest). Package tests: `node --test` over `dist`. Import modules with a `.js` extension even from `.ts`. `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`.
- **Package name / import specifier:** `@kinqs/brainrouter-ui-test`; the host deep-imports from `@kinqs/brainrouter-ui-test/dist/index.js`. **Rebuild the package (`npm run build`) after editing it** so the host/renderer see new exports.
- **`Story` shape:** `{ id: string; title: string; description: string; steps: FlowStep[] }`; `FlowStep` is a discriminated union on `action`: `navigate{target}`, `tap{target}`, `type{target,text}`, `assertVisible{target}`. `StorySchema` is a Zod object (has `.safeParse`).
- **The composer tag MIME is `application/x-brainrouter-tag`** (JSON payload); the drop handler and `.tag-chip` strip already exist and render any tag — do not duplicate them.
- **`.brainrouter/` is gitignored** — the mock `stories.json` is local test state (not committed), matching the existing `ui-map.json`.
- **Do not disturb** the concurrent Stories code (Suggest/Run/trace). All edits here are additive.
- Windows hygiene after edits: `git ls-files --eol` shows `i/lf`; scan edited files for NUL bytes.
- End any commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/brainrouter-ui-test/src/flow/storySchema.ts` | Add `parseStoriesJson(text)` (pure, non-throwing) next to `parseStoryYaml`. | Modify |
| `packages/brainrouter-ui-test/src/flow/storySchema.test.ts` | Tests for `parseStoriesJson`. | Modify |
| `packages/brainrouter-ui-test/src/index.ts` | Export `parseStoriesJson`. | Modify |
| `brainrouter-desktop/electron/uitestHost.ts` | `listStories` merges `stories.json` + `*.story.yaml`. | Modify |
| `examples/mock-ui/.brainrouter/ui-tests/stories.json` | The mock's 3 journeys as a manifest. | Create |
| `examples/mock-ui/.brainrouter/ui-tests/stories/*.story.yaml` | Remove the 3 YAMLs (JSON becomes the single source). | Delete |
| `brainrouter-desktop/src/lib/uitest/rowSource.ts` | `symbolKindIcon` gains a `'journey' → 'branch'` case. | Modify |
| `brainrouter-desktop/src/panels/AtlasPanel.tsx` | Story row becomes `draggable` (writes an `x-brainrouter-tag` journey payload). | Modify |
| `brainrouter-desktop/src/components/Composer.tsx` | Add `steps?` to the tag types (chip + onDrop already handle it). | Modify |
| `brainrouter-desktop/src/App.tsx` | `componentTags` item gains `steps?`; `submit()` adds an "Explain these UI journeys" block. | Modify |

**Journey-tag contract (shared strings — must match across files):** drag MIME `application/x-brainrouter-tag`; payload `{ name: string; kind: 'journey'; ref: string; steps: Array<{action,target,text?}> }` (`ref` = story id). Icon: `symbolKindIcon('journey') → 'branch'`.

---

## Task 1: `parseStoriesJson` in the ui-test package

**Files:**
- Modify: `packages/brainrouter-ui-test/src/flow/storySchema.ts`
- Modify: `packages/brainrouter-ui-test/src/index.ts`
- Test: `packages/brainrouter-ui-test/src/flow/storySchema.test.ts`

**Interfaces:**
- Consumes: `StorySchema` (Zod object), `Story` (already in this file).
- Produces (used by Task 2): `export function parseStoriesJson(text: string): Story[]` — accepts `{ "stories": [...] }` or a bare `[...]`; validates each with `StorySchema.safeParse`; skips invalid entries; returns `[]` on malformed JSON (never throws).

- [ ] **Step 1: Write the failing test**

Append to `packages/brainrouter-ui-test/src/flow/storySchema.test.ts`:

```ts
test('parseStoriesJson reads a manifest, a bare array, and skips invalid', () => {
  const good = { id: 'x', title: 'X', description: 'd', steps: [
    { action: 'navigate' as const, target: 'home' },
    { action: 'tap' as const, target: 'b' },
  ] };
  const bad = { id: 'y', title: 'Y' }; // missing description + steps
  assert.equal(parseStoriesJson(JSON.stringify({ stories: [good, bad] })).length, 1);
  assert.equal(parseStoriesJson(JSON.stringify([good])).length, 1);
  assert.equal(parseStoriesJson('not json at all').length, 0);
  assert.equal(parseStoriesJson(JSON.stringify({})).length, 0);
  const one = parseStoriesJson(JSON.stringify({ stories: [good] }));
  assert.equal(one[0].id, 'x');
});
```

Also extend the import line at the top of that test file:

```ts
import { StorySchema, parseStoryYaml, serializeStoryYaml, parseStoriesJson } from './storySchema.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `Push-Location 'D:\BrainRouter\BrainRouter'; npm --prefix packages/brainrouter-ui-test run build 2>&1 | Select-Object -Last 20; Pop-Location`
Expected: `tsc` FAILS — `parseStoriesJson` is not exported from `./storySchema.js`.

- [ ] **Step 3: Implement `parseStoriesJson`**

In `packages/brainrouter-ui-test/src/flow/storySchema.ts`, append after `serializeStoryYaml`:

```ts

/**
 * Parse + validate a JSON stories manifest — either `{ "stories": [...] }` or a
 * bare `[...]`. Non-throwing: malformed JSON yields `[]`, and any story that
 * fails `StorySchema` is skipped (so one bad entry can't drop the whole file).
 */
export function parseStoriesJson(text: string): Story[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { stories?: unknown }).stories)
      ? ((raw as { stories: unknown[] }).stories)
      : []);
  const out: Story[] = [];
  for (const item of arr) {
    const r = StorySchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}
```

- [ ] **Step 4: Export it**

In `packages/brainrouter-ui-test/src/index.ts`, replace line 53:

```ts
export { parseStoryYaml, serializeStoryYaml, StorySchema, type Story } from './flow/storySchema.js';
```

with:

```ts
export { parseStoryYaml, serializeStoryYaml, parseStoriesJson, StorySchema, type Story } from './flow/storySchema.js';
```

- [ ] **Step 5: Build + run the test**

Run: `Push-Location 'D:\BrainRouter\BrainRouter'; npm --prefix packages/brainrouter-ui-test run test 2>&1 | Select-Object -Last 20; Pop-Location`
Expected: PASS — all package tests pass, including "parseStoriesJson reads a manifest, a bare array, and skips invalid". (`npm run test` builds then runs `node --test dist`.)

- [ ] **Step 6: Commit**

```bash
git -C 'D:\BrainRouter\BrainRouter' add packages/brainrouter-ui-test/src/flow/storySchema.ts packages/brainrouter-ui-test/src/flow/storySchema.test.ts packages/brainrouter-ui-test/src/index.ts
git -C 'D:\BrainRouter\BrainRouter' commit -m "feat(ui-test): parseStoriesJson - read a JSON stories manifest"
```

---

## Task 2: Host `listStories` merges the JSON manifest

**Files:**
- Modify: `brainrouter-desktop/electron/uitestHost.ts` (import line 16-36; `listStories` lines 272-286)

**Interfaces:**
- Consumes: `parseStoriesJson` (Task 1), existing `parseStoryYaml`, `storiesDir()`, `fs`, `path`, `workspaceRoot`.
- Produces: `listStories()` returns `{ stories: Story[] }` merged from `.brainrouter/ui-tests/stories.json` (parent of `stories/`) and every `.brainrouter/ui-tests/stories/*.story.yaml`, deduped by `id` (YAML overrides JSON on id clash), sorted by title.

> **Verification note:** `listStories` is thin fs glue over the unit-tested `parseStoriesJson`; the Electron host has no temp-dir fs-test harness, so this task is verified by typecheck + the live check in Task 5 (the mock's manifest lists in the panel), consistent with how the rest of `uitestHost` is validated.

- [ ] **Step 1: Add `parseStoriesJson` to the host import**

In `uitestHost.ts`, in the `@kinqs/brainrouter-ui-test/dist/index.js` import block (lines 16-36), add `parseStoriesJson` next to `parseStoryYaml`:

```ts
  parseFlowYaml,
  serializeFlowYaml,
  parseStoryYaml,
  parseStoriesJson,
  serializeStoryYaml,
```

- [ ] **Step 2: Rewrite `listStories` to merge**

Replace `listStories` (lines 272-286):

```ts
  function listStories(): { stories: Story[] } {
    try {
      const dir = storiesDir();
      const out: Story[] = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.story.yaml')) continue;
        try { out.push(parseStoryYaml(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip a bad story */ }
      }
      out.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
      return { stories: out };
    } catch {
      return { stories: [] };
    }
  }
```

with:

```ts
  function listStories(): { stories: Story[] } {
    // Merge a single JSON manifest (…/ui-tests/stories.json) with the per-story
    // YAML files (…/ui-tests/stories/*.story.yaml), deduped by id. JSON is read
    // first so a per-story YAML can override an entry by id.
    const byId = new Map<string, Story>();
    try {
      const manifest = path.join(workspaceRoot, '.brainrouter', 'ui-tests', 'stories.json');
      if (fs.existsSync(manifest)) {
        for (const s of parseStoriesJson(fs.readFileSync(manifest, 'utf8'))) byId.set(s.id, s);
      }
    } catch { /* ignore a bad manifest */ }
    try {
      const dir = storiesDir();
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.story.yaml')) continue;
        try { const s = parseStoryYaml(fs.readFileSync(path.join(dir, f), 'utf8')); byId.set(s.id, s); } catch { /* skip a bad story */ }
      }
    } catch { /* no stories dir yet */ }
    const out = [...byId.values()].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    return { stories: out };
  }
```

- [ ] **Step 3: Typecheck the host**

Run: `Push-Location 'D:\BrainRouter\BrainRouter'; npm --prefix brainrouter-desktop run build:deps 2>&1 | Select-Object -Last 5; npm --prefix brainrouter-desktop exec -- tsc -p tsconfig.electron.json --noEmit 2>&1 | Select-Object -Last 20; Pop-Location`
Expected: no errors. (`build:deps` rebuilds the package dist so the new `parseStoriesJson` export resolves.)

- [ ] **Step 4: Commit**

```bash
git -C 'D:\BrainRouter\BrainRouter' add brainrouter-desktop/electron/uitestHost.ts
git -C 'D:\BrainRouter\BrainRouter' commit -m "feat(desktop): host lists stories from a stories.json manifest too"
```

---

## Task 3: Mock `stories.json` (and remove the YAMLs)

**Files:**
- Create: `examples/mock-ui/.brainrouter/ui-tests/stories.json`
- Delete: `examples/mock-ui/.brainrouter/ui-tests/stories/log-in.story.yaml`, `add-a-todo.story.yaml`, `count-up.story.yaml`

> These are gitignored local test files — no commit. This task is the demonstrable payload for Tasks 2 & 5.

- [ ] **Step 1: Write the manifest**

Create `examples/mock-ui/.brainrouter/ui-tests/stories.json`:

```json
{
  "stories": [
    {
      "id": "log-in",
      "title": "Log in",
      "description": "Open Login, enter valid credentials, submit, and confirm the message.",
      "steps": [
        { "action": "navigate", "target": "login" },
        { "action": "type", "target": "email-field", "text": "a@b.co" },
        { "action": "type", "target": "password-field", "text": "secret" },
        { "action": "tap", "target": "login-submit" },
        { "action": "assertVisible", "target": "login-message" }
      ]
    },
    {
      "id": "add-a-todo",
      "title": "Add a todo",
      "description": "Go to Todos, type a new item, add it, and confirm the count updates.",
      "steps": [
        { "action": "navigate", "target": "todos" },
        { "action": "type", "target": "todo-input", "text": "Buy milk" },
        { "action": "tap", "target": "todo-add" },
        { "action": "assertVisible", "target": "todo-count" }
      ]
    },
    {
      "id": "count-up",
      "title": "Count up",
      "description": "On Home, increment the counter twice and confirm the value stays visible.",
      "steps": [
        { "action": "navigate", "target": "home" },
        { "action": "tap", "target": "counter-increment" },
        { "action": "tap", "target": "counter-increment" },
        { "action": "assertVisible", "target": "counter-value" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Remove the superseded YAMLs**

Run: `Push-Location 'D:\BrainRouter\BrainRouter'; Remove-Item 'examples/mock-ui/.brainrouter/ui-tests/stories/log-in.story.yaml','examples/mock-ui/.brainrouter/ui-tests/stories/add-a-todo.story.yaml','examples/mock-ui/.brainrouter/ui-tests/stories/count-up.story.yaml' -ErrorAction SilentlyContinue; Pop-Location`

- [ ] **Step 3: Validate the manifest parses**

Run (reuses the scratchpad validator pattern, or a one-off): from `D:\BrainRouter\BrainRouter`, a `tsx` script importing `parseStoriesJson` from `file:///D:/BrainRouter/BrainRouter/packages/brainrouter-ui-test/dist/index.js`, reading the manifest, asserting `.length === 3`.
Expected: prints 3 stories (log-in 5 steps, add-a-todo 4 steps, count-up 4 steps).

---

## Task 4: Drag a story → chat journey chip

**Files:**
- Modify: `brainrouter-desktop/src/lib/uitest/rowSource.ts` (`symbolKindIcon`, lines 96-104)
- Modify: `brainrouter-desktop/src/panels/AtlasPanel.tsx` (story row, line 784)
- Modify: `brainrouter-desktop/src/components/Composer.tsx` (tag types, lines 72-73)
- Modify: `brainrouter-desktop/src/App.tsx` (`componentTags` type line 276; `submit()` finalPrompt lines 845-849; displayPrompt journey/fix wording)

**Interfaces:**
- Consumes: existing `componentTags` / `onDropTag` / `.tag-chip` infra + `application/x-brainrouter-tag` drop path (all already present).
- Produces: dragging a story row drops a `{ kind:'journey', steps }` tag → a chip (branch icon) → on send an "Explain these UI journeys" block.

- [ ] **Step 1: `symbolKindIcon` gains `'journey'`**

In `rowSource.ts`, in `symbolKindIcon`, add the case before `default`:

```ts
    case 'feature': return 'spark';
    case 'journey': return 'branch';
    default: return 'dots';
```

- [ ] **Step 2: Make the story row draggable**

In `AtlasPanel.tsx`, replace the story-row opening `<div>` (line 784):

```tsx
                <div key={s.id} className={`atlas-story${selectedStory === s.id ? " sel" : ""}`} onClick={() => setSelectedStory((cur) => (cur === s.id ? null : s.id))} title="Click to trace this journey on the map">
```

with:

```tsx
                <div key={s.id} className={`atlas-story${selectedStory === s.id ? " sel" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData("application/x-brainrouter-tag", JSON.stringify({ name: s.title, kind: "journey", ref: s.id, steps: s.steps }));
                    e.dataTransfer.setData("text/plain", `UI journey "${s.title}" (${s.steps.length} steps)`);
                  }}
                  onClick={() => setSelectedStory((cur) => (cur === s.id ? null : s.id))}
                  title="Click to trace on the map · ▶ to run · drag into chat to explain">
```

- [ ] **Step 3: Add `steps?` to the composer tag types**

In `Composer.tsx`, replace the tag prop block (lines 72-73):

```tsx
  componentTags?: Array<{ id: string; name: string; kind?: string; ref: string }>;
  onDropTag?: (tag: { name: string; kind?: string; ref: string; filePath?: string; line?: number }) => void;
```

with:

```tsx
  componentTags?: Array<{ id: string; name: string; kind?: string; ref: string; steps?: Array<{ action: string; target: string; text?: string }> }>;
  onDropTag?: (tag: { name: string; kind?: string; ref: string; filePath?: string; line?: number; steps?: Array<{ action: string; target: string; text?: string }> }) => void;
```

(The `.tag-chip` strip and the `x-brainrouter-tag` drop branch already render/forward any tag — no other Composer change.)

- [ ] **Step 4: Add `steps?` to App's `componentTags` state**

In `App.tsx`, replace the `componentTags` useState (line 276):

```tsx
  const [componentTags, setComponentTags] = useState<Array<{ id: string; name: string; kind?: string; ref: string; filePath?: string; line?: number }>>([]);
```

with:

```tsx
  const [componentTags, setComponentTags] = useState<Array<{ id: string; name: string; kind?: string; ref: string; filePath?: string; line?: number; steps?: Array<{ action: string; target: string; text?: string }> }>>([]);
```

- [ ] **Step 5: Split `submit()` serialization into component + journey blocks**

In `App.tsx`, replace the finalPrompt block (lines 845-849):

```tsx
    // §a11y-inspect — dragged component tags become a reference block so the agent
    // can open and fix each one (ref = `path:line#id`).
    const finalPrompt = componentTags.length
      ? `${prompt}\n\nTagged UI components (open & fix):\n${componentTags.map((t) => `- ${t.name}${t.kind ? ` (${t.kind})` : ''} — ${t.ref}`).join('\n')}`
      : prompt;
```

with:

```tsx
    // §a11y-inspect — dragged tags become reference blocks: component tags (open &
    // fix, ref = `path:line#id`) and journey tags (explain the ordered flow).
    const compTags = componentTags.filter((t) => !t.steps);
    const journeyTags = componentTags.filter((t) => t.steps && t.steps.length);
    let finalPrompt = prompt;
    if (compTags.length) {
      finalPrompt += `\n\nTagged UI components (open & fix):\n${compTags.map((t) => `- ${t.name}${t.kind ? ` (${t.kind})` : ''} — ${t.ref}`).join('\n')}`;
    }
    if (journeyTags.length) {
      finalPrompt += `\n\nExplain these UI journeys (steps in order):\n${journeyTags.map((t) => `- ${t.name}:\n${(t.steps ?? []).map((st, i) => `    ${i + 1}. ${st.action} ${st.target}${st.text != null ? ` "${st.text}"` : ''}`).join('\n')}`).join('\n')}`;
    }
```

- [ ] **Step 6: Update the display-prompt wording for a tags-only send**

In `App.tsx`, the `displayPrompt` fallback ends with these two lines:

```tsx
        : componentTags.length === 1 ? `Fix ${componentTags[0].name}`
        : `Fix ${componentTags.length} components`);
```

Replace them with:

```tsx
        : componentTags.length === 1 ? `${componentTags[0].steps ? 'Explain' : 'Fix'} ${componentTags[0].name}`
        : `${componentTags.length} tagged UI items`);
```

- [ ] **Step 7: Typecheck the renderer**

Run: `Push-Location 'D:\BrainRouter\BrainRouter'; npm --prefix brainrouter-desktop run typecheck 2>&1 | Select-Object -Last 20; Pop-Location`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git -C 'D:\BrainRouter\BrainRouter' add brainrouter-desktop/src/lib/uitest/rowSource.ts brainrouter-desktop/src/panels/AtlasPanel.tsx brainrouter-desktop/src/components/Composer.tsx brainrouter-desktop/src/App.tsx
git -C 'D:\BrainRouter\BrainRouter' commit -m "feat(desktop): drag a UI story into chat as an explain-journey chip"
```

---

## Task 5: Full verification

**Files:** none.

- [ ] **Step 1: Package tests**

Run: `Push-Location 'D:\BrainRouter\BrainRouter'; npm --prefix packages/brainrouter-ui-test run test 2>&1 | Select-Object -Last 12; Pop-Location`
Expected: all pass, incl. the `parseStoriesJson` test.

- [ ] **Step 2: Renderer suite + typecheck**

Run: `Push-Location 'D:\BrainRouter\BrainRouter'; npm --prefix brainrouter-desktop run typecheck 2>&1 | Select-Object -Last 5; Pop-Location`
Then: `Push-Location 'D:\BrainRouter\BrainRouter\brainrouter-desktop'; npx tsx --test "src/**/*.test.ts" 2>&1 | Select-Object -Last 8; Pop-Location`
Expected: typecheck clean; renderer suite all pass (no regressions).

- [ ] **Step 3: Live (Electron dev) on the mock**

Fully restart the Electron app (host must reload the rebuilt package). With the mock-ui workspace open:
1. Open **Atlas → Screens** → the **UI Stories** panel now lists **3 journeys** (Log in, Add a todo, Count up) — sourced from `stories.json`.
2. **Click** a story → its elements/screens highlight on the map with animated flow lines (unchanged trace).
3. Click **▶** → it runs live in the Browser (unchanged).
4. **Drag** a story row into the chat composer → a **journey chip** appears (branch icon + title + remove). Type nothing and send → the outgoing prompt carries `Explain these UI journeys (steps in order): - <title>: 1. navigate … 2. type … "…"`; the chip clears.
Verify via DOM (`preview_eval`) — screenshots time out on the ReactFlow/webview panels.

- [ ] **Step 4: Hygiene**

Run: `git -C 'D:\BrainRouter\BrainRouter' ls-files --eol` on the edited source files (expect `i/lf`), and a NUL scan. Fix + amend if needed.

---

## Self-Review

**1. Spec coverage:**
- (A) JSON manifest the panel lists → Task 1 (`parseStoriesJson`) + Task 2 (`listStories` merge) + Task 3 (mock `stories.json`). ✓
- (B) click-to-trace + ▶-run already exist → untouched (verified in Task 5 Step 2-3). ✓
- (C) drag story → chat explain, click still executes → Task 4 (draggable row + journey tag + "Explain these UI journeys" block); ▶ untouched. ✓
- Decision "one stories.json manifest" → Task 3 shape `{ stories: [...] }`. ✓ Decision "click=trace, ▶=run, drag=explain" → Task 4 keeps onClick/▶, adds drag. ✓ Decision "story chip → explain" → Task 4 journey chip + explain block. ✓

**2. Placeholder scan:** none — every code step has complete code; every command has an expected result. The host-merge "verified live" note is a justified test-strategy choice (pure logic is unit-tested), not a placeholder.

**3. Type consistency:** `parseStoriesJson(text): Story[]` identical in Task 1 (def), Task 2 (host import). The tag `steps?: Array<{ action: string; target: string; text?: string }>` shape is identical across Composer prop, `onDropTag` param, and App state (Task 4 Steps 3-4). MIME `application/x-brainrouter-tag` matches the AtlasPanel `onDragStart` (Task 4 Step 2) and the existing Composer drop handler. `symbolKindIcon('journey') → 'branch'` (Task 4 Step 1) matches the chip's `symbolKindIcon(t.kind)`. `finalPrompt` stays the variable sent at `start-turn` (Task 4 Step 5 changes `const`→`let`, same name).

**Known scope note:** row-drag payload dedupes by `ref` (= story id) in App's existing `onDropTag`, so dragging the same story twice won't double-add. The journey block lists steps as `action target "text"`; it does not resolve targets to human labels (the agent has the map). If the dashed-connector visual from screenshot 2 is wanted over the current glow+animated-edges, that's a separate CSS-only follow-up (out of scope here).
