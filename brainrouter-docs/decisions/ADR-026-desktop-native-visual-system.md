# ADR-026 — Desktop Native Visual System and Platform-Adaptive Shell

**Status:** Accepted for phased implementation on `release/0.4.18` ·
**Approved:** 2026-07-30 · **Builds on:** ADR-019's Desktop security boundary and the
shared interface contract shipped in 0.4.17 · **Does not authorize:** runtime,
browser-engine, terminal-transport, or orchestration changes.

## Date

2026-07-30

## Decision in brief

BrainRouter Desktop will adopt a platform-adaptive semantic visual system. The
operating system will continue to own the parts users expect to be genuinely
native: window controls and frame policy, drag regions, menus, dialogs, file
pickers, system appearance, accessibility preferences, and terminal processes.
The Electron renderer will use one accessible component and token contract,
with deliberate macOS, Windows, and Linux adaptations.

The change will be delivered surface by surface behind a reversible
`desktop.visualSystemV2` rollout setting. It will not be a single styling PR.
The current monolithic stylesheet will become an ordered compatibility
manifest while foundation, shell, and surface styles move into owned modules.
Existing behavior—including mounted panel state, browser isolation, Monaco
editing, terminal PTYs, and the preload-only capability boundary—must remain
intact.

Implementation proceeds through the dependency-ordered slices and review gates
below.

## Context

Desktop already has the right workbench shape:

- a left activity bar and resizable project/session rail;
- a central Chat or Code surface;
- a state-preserving right views rail;
- a bottom terminal and tool dock;
- Monaco editing with an embedded file explorer; and
- an embedded browser whose page contents remain owned by the main process.

The visual implementation has grown feature by feature around that shape:

- `src/theme.css` is 5,953 lines and owns unrelated shell, chat, settings,
  editor, terminal, browser, workflow, meeting, and review styles;
- late cascade overrides repeat platform and layout selectors, so ownership is
  difficult to establish;
- renderer components contain hundreds of inline styles and many literal color
  values outside the shared semantic token vocabulary;
- the Desktop appearance setting offers two dark variants rather than System,
  Light, Dark, and High Contrast behavior;
- the Electron window uses a static startup background, which can disagree
  with the resolved canvas before the renderer paints; and
- custom floating chrome, inconsistent spacing, and decorative movement can
  make the application feel like a web page inside a window rather than a
  focused desktop workbench.

The solution is not to imitate one operating system everywhere. Fake traffic
lights on Windows or custom Windows controls on macOS would be less native,
less accessible, and more expensive to maintain. The product needs a stable
semantic system whose host boundary follows the current operating system.

## Decision drivers

1. Window behavior must feel correct on macOS, Windows, and Linux without
   compromising the Electron security boundary.
2. Styling ownership must be discoverable without another design-system god
   file or a large library of thin wrapper components.
3. A visual migration must not reset sessions, panel state, file-tree
   expansion, editor tabs, terminal processes, or browser tabs.
4. System appearance, contrast, reduced motion, keyboard focus, and zoom must
   work as product behavior rather than optional polish.
5. Editor, file explorer, terminal, and browser performance must improve or
   remain measurable; styling changes cannot hide remount or rendering costs.
6. Every delivery slice must be independently reviewable, reversible, and
   shippable.

## Decision

### 1. Establish one layered token contract

Tokens will be resolved in this order:

```text
shared brand semantics
  -> Desktop semantic aliases
  -> resolved appearance mode
  -> platform adaptation
  -> exceptional component-local tokens
```

The shared brand package remains the source for cross-product concepts such as
canvas, raised surface, text hierarchy, divider, interaction, route identity,
and status. Desktop aliases may express workbench-specific concepts such as
sidebar, dock, editor gutter, terminal selection, or browser chrome. They must
map back to a semantic role rather than duplicate literal colors.

Platform selectors may adjust geometry, typography, materials, and motion.
They must not create separate component APIs or change capability rules.
Component-local tokens are allowed only where the shared and Desktop semantic
layers cannot describe a genuine local state.

New or migrated component CSS must not contain hard-coded theme colors.
Inline styles remain valid for dynamic geometry and measured values, but not
for static visual decisions.

### 2. Replace stylesheet-by-history with stylesheet-by-owner

The target layout is:

```text
brainrouter-desktop/src/styles/
  foundation/
    tokens.css
    reset.css
    typography.css
    motion.css
  shell/
    window.css
    activity-bar.css
    sidebar.css
    topbar.css
    views-rail.css
    dock.css
  surfaces/
    chat.css
    composer.css
    editor.css
    files.css
    terminal.css
    browser.css
    settings.css
    track.css
    atlas.css
    workflows.css
    meetings.css
    review.css
```

`theme.css` will temporarily become the ordered import manifest and
compatibility layer. A selector moves only with its owning surface and its
visual characterization. Compatibility selectors may coexist during the
rollout, but each migration PR must identify what it owns and what remains.

Repeated behavior may become a shared primitive when at least two real
surfaces require the same interaction and accessibility contract. The plan
does not authorize wrapping every HTML element or creating a second,
application-wide component hierarchy.

### 3. Define the native host boundary

| Concern | Owner | Decision |
|---|---|---|
| Window controls and frame | Electron main process and OS | Use real platform controls; never draw imitations |
| Drag and no-drag regions | Desktop shell CSS | Preserve accessible controls and platform clearance |
| Appearance resolution | Main/preload plus renderer theme hook | Support System, Light, Dark, and High Contrast |
| Menus, dialogs, file pickers | Electron main process and OS | Keep native presentation and behavior |
| Application content | React renderer | Use the shared semantic component contract |
| Terminal process | Host PTY adapter | Remains a genuine local shell process |
| Terminal presentation | Renderer terminal surface | Match platform font, palette, cursor, and selection |
| Browser page content | Main-process browser view | Preserve isolation, authority, and navigation policy |
| Browser chrome | React renderer | Adopt the same workbench tokens and focus policy |

Platform policy:

- **macOS:** retain the hidden inset title bar, native traffic lights, and
  explicit drag/no-drag regions. Respect system appearance and platform
  typography. Native material is optional and may be used only where contrast,
  legibility, and rendering cost are proven.
- **Windows:** retain the native frame for the first migration. A title-bar
  overlay may be evaluated later only with correct system buttons, contrast,
  scaling, snap-layout behavior, and keyboard access. The renderer will not
  fake Windows caption buttons.
- **Linux:** retain the default native frame. Distribution and window-manager
  variation makes custom caption behavior an explicit future decision.

The main process will set the startup background to the resolved canvas so the
window does not flash an unrelated color before first paint. Theme-change
events will cross a narrow preload contract; the renderer will not receive
general main-process access.

### 4. Make appearance a resolved preference

Desktop appearance choices will be:

- **System** — the default for new installations;
- **Light**;
- **Dark**; and
- **High Contrast**.

Existing `dark` and `hc` values will migrate without resetting user settings.
The stored value represents the preference; a separate resolved attribute
represents the effective appearance. System changes update the effective
appearance without rewriting the user's preference.

Accent behavior will offer system/default accent and a custom override.
Reduced motion, forced colors, contrast preference, text scaling, and
80–200 percent application zoom are part of the acceptance contract.
Personality, workspace profile, and agent profile do not change the visual
theme; those concepts may affect prose or available work surfaces, not basic
legibility or operating-system behavior.

### 5. Use a restrained workbench grammar

The visual grammar is:

- canvas → sidebar or dock → raised popover is the primary surface hierarchy;
- selected navigation is quiet and persistent rather than a decorative card;
- visible controls generally use a compact 28–32 pixel geometry, with larger
  effective pointer targets where the layout permits;
- spacing, radius, typography, separators, focus rings, and status colors come
  from named scales;
- ordinary hover states do not translate or scale controls;
- blur and translucency are not used in hot, scrolling, or fullscreen panels
  by default; and
- motion explains a state transition and stops under reduced-motion settings.

This is an application shell, not a collection of independent dashboard cards.
Content surfaces may still use grouping where it improves scanning, but
elevation must communicate a real layering or interaction relationship.

### 6. Preserve explicit contracts per surface

| Surface | Visual-system contract | Behavior that must not regress |
|---|---|---|
| Shell and navigation | Integrate top controls into the window hierarchy; flatten persistent navigation; use platform spacing | Resizing, drag regions, project/session selection, keyboard navigation |
| Chat and composer | Keep one stable content axis and a compact anchored composer; make queued and steering messages visibly distinct | Streaming, drafts, attachments, queue/steer ordering, focus |
| Views rail and Settings | Share panel headers, tabs, rows, actions, empty states, and focus treatment | Inactive panels stay mounted; drawer/docked/fullscreen state survives |
| Editor and Files | Align Monaco, explorer, tabs, breadcrumbs, and status bar to the resolved theme | Split panes, dirty buffers, expansion state, file watching, lazy Monaco load |
| Terminal | Use a platform-appropriate monospace stack, palette, cursor, selection, and shell labels | Native PTY lifecycle, discovered shells, input, resize, exit state |
| Browser | Use the same toolbar, tab, menu, and status vocabulary as the workbench | Main-process page ownership; agent-opened tabs do not steal human focus |
| Track, Atlas, workflows, meetings, and review | Migrate to shared semantics without feature redesign | Existing state, navigation, data refresh, and authority boundaries |

The embedded file explorer already belongs in the editor surface and will
remain available there. This ADR does not authorize replacing Monaco. It does
authorize measuring tree projection, editor decorations, and panel lifecycle
so visual work does not mask performance faults.

### 7. Treat responsiveness as an acceptance criterion

Each migrated surface will record a before/after trace on representative data.
The initial budgets are:

- switching an already-open panel should produce visible feedback within
  100 ms and must not remount the panel solely because it became inactive;
- expanding a previously loaded directory must retain state when moving
  between Files and Editor;
- file trees above 1,000 visible nodes must use a bounded or virtualized
  projection rather than render the entire hierarchy on every change;
- streaming chat must not move the composer or cause avoidable whole-pane
  layout shifts;
- Monaco and browser code must remain lazy and must not increase first-paint
  bundle cost;
- terminal repaint and resize must not be coupled to unrelated panel state;
  and
- full-panel blur and unbounded CSS animation are release blockers.

These are interaction budgets, not promises that every operation completes in
100 ms. Long work must show immediate state and progress without discarding
the user's current view.

### 8. Make accessibility a release gate

Every migrated surface must provide:

- WCAG AA text and non-text contrast for its supported modes;
- visible keyboard focus and complete keyboard traversal;
- accessible names and state for icon-only actions;
- no status communicated by color alone;
- forced-colors and high-contrast behavior;
- usable layouts at supported zoom and narrow window widths;
- reduced-motion behavior; and
- platform-correct caption and drag-region hit testing.

Visual screenshot approval does not replace accessibility checks.

## Alternatives considered

| Approach | Advantages | Costs and risks | Decision |
|---|---|---|---|
| Separate fully native macOS and Windows interfaces | Maximum platform-specific control | Duplicates the product, fragments behavior, and substantially increases accessibility and release work | Rejected |
| Keep the current single stylesheet and add more overrides | Lowest immediate change cost | Preserves unclear ownership, cascade coupling, literals, and inconsistent platform behavior | Rejected |
| Adopt a comprehensive third-party component framework | Fast access to primitives and documentation | Introduces another token model, can make the app look generic, and does not solve Electron host ownership | Rejected as the foundation; individual accessible primitives may be evaluated |
| Draw custom window controls on every platform | Maximum visual uniformity | Less native, harder to scale and access, and easy to break window-manager behavior | Rejected |
| Platform-adaptive semantic CSS with native host boundaries | One product contract, controlled adaptation, incremental migration | Requires disciplined token ownership and cross-platform review | Chosen |

## Ownership

| Area | Primary owner | Required boundary |
|---|---|---|
| Window creation and native appearance | `electron/` main process | No renderer access beyond narrow preload events |
| Preference and resolved theme contracts | shared Desktop types and app hooks | Stored preference is separate from effective appearance |
| Foundation tokens and motion | `src/styles/foundation/` | Semantic values only |
| Workbench chrome | shell components and `src/styles/shell/` | No feature-domain state |
| Surface styling | each feature surface and `src/styles/surfaces/` | No cross-surface cascade overrides |
| Shared interactive primitives | existing shared UI modules | Extract only repeated behavior and accessibility |
| Visual regression evidence | Desktop test and release tooling | Cover macOS and Windows before removing the flag |

## Migration and rollback

1. Introduce the resolved appearance contract and a disabled
   `desktop.visualSystemV2` setting.
2. Create the ordered style modules while leaving current selectors active.
3. Migrate one dependency-ordered surface per small PR.
4. Capture old/new screenshots, interaction traces, accessibility evidence,
   and state-preservation checks for that surface.
5. Enable the setting for development and opt-in preview use.
6. Complete macOS and Windows review before making it the default.
7. Remove compatibility selectors only after all supported modes and surfaces
   pass the release gate.

Rollback disables the new setting and restores the previous manifest order.
No migration PR may combine a visual change with a runtime authority, browser
engine, terminal transport, or orchestration change.

## Delivery taskboard

| ID | Slice | State | Acceptance evidence |
|---|---|---|---|
| D26-0 | Approve this decision and its native-boundary policy | **Complete** | User approval recorded on 2026-07-30 |
| D26-1 | Add System/Light/Dark/High Contrast resolution, migration, preload event, and matching startup canvas | **Complete** | Preference migration tests, Electron/renderer typechecks, production source build, and live System/Light/High Contrast switching on macOS |
| D26-2 | Add foundation modules and make `theme.css` an ordered compatibility manifest | **Complete** | Literal-color audit, current-source build, all-token and 15-style parity in Dark/Light/High Contrast, and an 8-pixel difference across 4.3 million screenshot pixels |
| D26-3 | Migrate window shell, activity bar, sidebar, top controls, views rail, and dock | **Complete** | Reversible preview, full macOS shell review, rail/dock state preservation, and owner approval complete; Windows remains part of D26-9 |
| D26-4 | Migrate Chat and composer, including visible queue/steer states | **Complete** | Current-source Electron review at normal and increased zoom; deterministic running-turn trace verified visible Queue, Steer, Queued, and Steer pending states |
| D26-5 | Migrate views panels and Settings to shared headers, tabs, rows, and actions | **Complete** | Inactive panels retain state; one bounded native `agent-event` listener survives startup and panel reopen; keyboard, zoom, and high-contrast review complete |
| D26-6 | Migrate Editor and Files and address measured tree/editor rendering bottlenecks | **Complete** | 25,000-file projection bounded to 46 rows; shared expansion survived Files/Editor switching; lazy Monaco, edit/preview, and High Contrast reviewed live |
| D26-7 | Migrate Terminal and Browser chrome without changing PTY or browser authority | **Complete** | Live native Z shell command; browser toolbar/tabs reviewed with keyboard navigation; background-agent focus isolation tests pass |
| D26-8a | Migrate Track board, alternate layouts, menus, and detail drawer | **Complete** | Board, List, and detail drawer reviewed live in Dark and High Contrast; semantic-token contract and current-source build pass |
| D26-8b | Migrate Atlas, workflows, meetings, and review surfaces | **Complete** | Current-source Dark review covers Atlas first-open framing, workflow test-run success, PR list and CI detail, Meetings library/detail, Meeting Track, and Teams; semantic-token and typecheck contracts pass |
| D26-9 | Complete accessibility, performance, and cross-platform release gate; remove compatibility flag | In progress | macOS and Windows approval, accessibility evidence, budgets met, rollback tested |

Human review checkpoints:

1. **Shell checkpoint after D26-3** — complete on 2026-07-30; window hierarchy,
   platform behavior, and navigation density were approved.
2. **Core workbench checkpoint after D26-6** — Chat, composer, Settings,
   Editor, and Files together. Settings and shared panels are ready for this
   combined checkpoint.
3. **Release checkpoint after D26-9** — macOS and Windows modes before the
   compatibility flag or old selectors are removed.

Resolved verification finding: the merged-source macOS app emitted a
`MaxListenersExceededWarning` after registering 11 `agent-event` listeners on
fresh startup. D26-5 now multiplexes renderer subscribers through one bounded
native listener, detaches it after the final unsubscribe, and covers reopen
cycles with regression tests without increasing the emitter limit.

D26-6 performance evidence: the file explorer now projects a sorted flat row
model and virtualizes trees above 240 visible rows. A representative 25,000-file
fixture indexed and flattened in 24 ms on the release workstation, with no more
than 46 React rows in a 720-pixel viewport. The current-source macOS app retained
the same expanded directory when switching from Files to Editor and after
closing and reopening the panel. Monaco remains a separate lazy chunk; visual
migration now uses flat workbench tabs, an integrated explorer, native control
states, and a dedicated High Contrast Monaco theme. The enlarged Editor was
reviewed live in preview and editable Monaco modes before Dark mode and the
normal panel width were restored.

## Consequences

### Positive

- Desktop gains an explicit meaning of native behavior instead of accumulating
  platform-specific exceptions.
- Styling ownership becomes discoverable and reviewable by surface.
- Theme, accessibility, and performance become versioned product contracts.
- Visual changes can ship in small PRs without resetting the workbench or
  changing runtime authority.

### Costs

- Compatibility CSS will temporarily coexist with the new modules.
- Every major slice needs live review on macOS and Windows.
- Token discipline and visual characterization add work before visible
  redesign reaches every surface.
- A native-feeling result will still be an Electron renderer for application
  content; it will not reproduce every operating-system control.

## Non-goals

- Rewriting Desktop as separate native applications.
- Replacing Monaco, the host PTY, or the embedded browser engine.
- Changing tools, profiles, personas, orchestration, or model behavior.
- Redesigning Dashboard as part of the Desktop styling migration.
- Combining visual cleanup with unrelated package or runtime restructuring.
- Drawing fake platform window controls.

## Approval record

The user approved this ADR on 2026-07-30. The approval includes:

1. System appearance as the default for new installations;
2. native/default Windows and Linux frames for the initial migration;
3. the platform-adaptive semantic token approach;
4. the small-PR taskboard and three human review checkpoints; and
5. preserving the current runtime, PTY, browser, editor, and panel-state
   boundaries while styling changes proceed.
