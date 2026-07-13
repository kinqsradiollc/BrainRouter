# BrainRouter interface system

This file is the design contract for the BrainRouter dashboard and desktop app. New UI should follow it before introducing new colors, navigation patterns, spacing rules, or component variants.

## Product idea

BrainRouter is an agent operations workspace. It helps people plan, build, connect, remember, and verify work across desktop, CLI, dashboard, and MCP surfaces.

Memory is a core capability, not the entire product identity. Product copy and navigation must also represent:

- agent chat and code execution;
- project and task tracking;
- plans, requirements, and workflows;
- model/provider routing and specialist workers;
- connectors, MCP servers, hooks, and automations;
- permissions, approvals, and sandbox policy;
- durable knowledge, recall, evidence, and persona;
- diff, review, verification, and CI signals.

## Design character

The interface is precise, tool-first, and calm. It uses graphite-black surfaces, white-alpha dividers, compact controls, restrained neutral emphasis, and motion that explains state. The product should feel like an instrument used for long work sessions—not a generic marketing template and not a neon “AI” dashboard.

The visual direction takes useful cues from modern agent workspaces: disciplined dark surfaces, compact rails, live product previews, and clear transitions between states. BrainRouter’s identity comes from its routing model, typography, geometry, and mark—not from filling the workspace with color. The default product shell is monochrome; color is evidence or a rare brand signature.

## Shared tokens

Dashboard and desktop must resolve to these perceptual values even when their variable names differ.

| Role                | Value                   | Use                                                     |
| ------------------- | ----------------------- | ------------------------------------------------------- |
| Canvas              | `#07070B`               | App and public page background                          |
| Raised surface      | `#0B0C12`               | Cards, modal body, composer                             |
| Overlay surface     | `#12131B`               | Selected rows, menus, inputs                            |
| Primary text        | `#FAFAFA`               | Titles, active controls, key values                     |
| Secondary text      | `#A1A1AA`               | Body copy and standard labels                           |
| Muted text          | `#85858F`               | Metadata and helper copy; keep small labels above 4.5:1 |
| Divider             | `rgba(255,255,255,.10)` | Default borders                                         |
| Strong divider      | `rgba(255,255,255,.14)` | Hover/focus/important boundaries                        |
| Selection fill      | `rgba(216,219,226,.08)` | Active navigation and segmented controls                |
| Interaction accent  | `#D8DBE2`               | Focus, selected controls, primary actions               |
| Build / agent work  | `#B8BEC8`               | Rare diagrams and data visualization only               |
| Plan / review       | `#B9B1AF`               | Rare diagrams and data visualization only               |
| Knowledge / explore | `#ADB9BC`               | Rare diagrams and data visualization only               |
| Automation          | `#B2B9AD`               | Rare diagrams and data visualization only               |
| Success             | `#22C55E`               | Confirmed healthy/complete state                        |
| Warning             | `#EAB308`               | Attention without failure                               |
| Danger              | `#EF4444`               | Destructive actions and failures                        |

The BrainRouter mark may use the violet-to-pink brand gradient in marketing. Authenticated product surfaces, navigation, composers, cards, avatars, and buttons stay neutral. Data visualizations may use desaturated series colors when labels and shapes also distinguish them.

### Color grammar

- White and cool gray carry interaction hierarchy: selected navigation, focus, primary actions, and readable boundaries.
- Product areas do not receive permanent colors. Build, Track, Knowledge, and Automation are distinguished by labels, icons, location, and layout.
- Green, yellow, and red are reserved for factual success, warning, and failure states. Never use them to decorate a product destination.
- Desaturated series colors are allowed in charts, graphs, diffs, or timelines where several datasets must be distinguished. Always pair them with labels, shapes, or patterns.
- Ambient color is off in authenticated work surfaces. Marketing may use one low-opacity brand light, never multiple competing auras.
- Dashboard and desktop use the same neutral interaction hierarchy and the same factual status meanings.

## Typography

- Use Geist for dashboard interface text and Geist Mono for code, identifiers, measurements, and compact metadata.
- Dashboard loads the bundled `geist` package. Desktop uses the native platform UI stack for reliable offline Electron rendering, with Geist Mono or the platform monospace stack for code.
- Page titles: `24px / 32px`, weight 600, `-0.02em` tracking.
- Section titles: `16–20px`, weight 500–600.
- Body: `13–14px / 20–22px` in product UI; `16px / 25px` for marketing lead copy.
- Metadata: `10–12px`, muted, with mono used only when the content behaves like data.
- Large marketing display type may reach `76px`, with tight tracking and balanced wrapping.
- Use sentence case. Avoid title case on every label and avoid all-caps except short eyebrow labels.

## Spacing and geometry

- Core spacing scale: `4, 8, 12, 16, 20, 24, 32, 48, 64`.
- Product rail: `240px` on dashboard; `220–420px` resizable on desktop.
- Dashboard page gutters: `64px` wide, `32px` medium, `18px` mobile.
- Main content may grow to the available workspace. Long-form text remains bounded to about 65 characters per line.
- Control radius: `6–8px`; cards: `10px`; large panels/modals: `12–14px`.
- Avoid pill shapes except status dots, avatars, and genuinely circular controls.
- Use borders and spacing before shadows. Shadows are reserved for overlays or floating desktop panels.

## Navigation

### Product navigation

Product navigation contains destinations where people do or inspect work: dashboard, chat, projects, reviews, repositories, knowledge, networks, and integrations. A feature must not be placed in Settings merely because it is technical.

Group large rails by intent instead of presenting every destination at equal weight. Prefer visible groups such as Work, Review, Workspace, and Advanced. The command palette must mirror the same names, routes, and grouping. A route may not simultaneously behave as a product destination and a Settings category.

### Settings navigation

Settings is one shell with short categories. Only the selected category or sub-panel is rendered. Never stack every settings form into one scrolling document.

Dashboard categories:

1. Account — profile and API access.
2. Workspace — organizations, projects, and members.
3. Intelligence — models and providers.
4. Notifications — email delivery.
5. Advanced — brand and administration.

Desktop categories:

1. Account — BrainRouter identity, sign-in, organization, and devices.
2. Agent — general behavior, models, permissions, memory, and tools.
3. Automation — auto-planning, runtime, automations, and reviews.
4. Connections — MCP, connectors, extensions, and marketplace.
5. System — usage, appearance, commands, and advanced configuration.

Within a category, use a short secondary tab row. Show one sub-panel at a time. Preserve direct links and command deep-links by mapping them to the correct category and sub-panel. Switching category or sub-panel resets the content viewport to the top; returning to a category may restore its last selected sub-panel, but never its stale scroll position.

Settings search searches setting names, descriptions, and category labels. Command search is a separate tool with its own label. Rarely used raw configuration, CLI aliases, and dangerous execution controls belong behind an Advanced disclosure or a dedicated sub-panel.

### Knowledge architecture

Knowledge is a product workspace, not a Settings section. It should help people understand what BrainRouter knows, where it came from, how it was used, and what needs attention without requiring them to understand retrieval internals.

The dashboard Knowledge hub has five focused categories. Render one category at a time:

1. Overview — explain the notice, organize, recall, and check loop in plain language.
2. Library — saved knowledge, connected sources, current task context, and topic summaries.
3. Quality — supporting evidence, conflicts to review, and recall details.
4. Relationships — activity history, the knowledge map, and related ideas.
5. Profile — agent profile, knowledge review queue, and export archive.

Keep the detailed routes available behind the hub. The hub is an orientation and discovery layer, not a replacement for evidence, history, mapping, or review tools. Sidebar and command-palette state should keep Knowledge active while any of those detailed routes are open.

Lead with user goals in labels and descriptions: “Saved knowledge,” “Current task context,” and “Why this was recalled.” Reserve terms such as vector search, graph traversal, decay, embedding, and retrieval scoring for diagnostics or advanced detail views where the implementation itself is the subject.

## Page composition

Product pages use this order:

1. title, one-sentence description, and at most two primary actions;
2. optional category or view tabs;
3. one dominant work surface;
4. secondary evidence or metadata below or in a side panel.

Cards should communicate grouping or elevation. Do not wrap every block in a card. For dense sets, prefer a shared boundary with dividers between rows.

The public homepage follows a clearer product story:

1. one direct product promise and one primary action;
2. a live workbench preview showing routing between Build, Plan, Knowledge, and Review;
3. asymmetric capability showcases with real product-state details;
4. proof through concrete workflows and connected surfaces;
5. one closing action.

Alternate dense product previews with quiet text space. Avoid a long sequence of identical ruled lists or equal card grids.

## Desktop shell

The desktop app and dashboard share tokens and interaction grammar, but the desktop remains a workbench:

- left rail: BrainRouter identity, Chat/Code/Track switcher, new-task action, projects, sessions, user identity;
- center: task header, conversation or active work view, and composer;
- optional right rail: files, plans, reviews, tools, and other contextual views;
- optional bottom dock: terminal and runtime output;
- pinned top-right controls: environment, layout controls, export, and settings.

The top-right control cluster must remain the last child of `.main`; Electron relies on that DOM order for the drag region. Do not duplicate its controls in the views rail.

Native window chrome is part of the desktop layout contract. On macOS, the sidebar collapse control is the first application control immediately after the close, minimize, and maximize buttons. Because native controls do not scale with Electron web-content zoom, position this control with an inverse-zoomed window-controls inset; never push it to the far edge of the sidebar. When the sidebar is closed, its reopen control uses the same inset. Desktop icon controls use a `30 × 30px` CSS hit box, and adjacent text controls share the same `30px` height.

The desktop identity comes from the signed-in BrainRouter account when one exists. The operating-system username is only a local fallback. A signed-out desktop remains fully usable; the account row invites sign-in and explains that account authentication is optional except for account-backed OAuth connectors and sync.

Account-backed OAuth is the default connector contract. The normal Connectors surface shows connection health, indexed scope, last sync, and connect/disconnect actions; it must not duplicate repository, PAT, certificate, or Track configuration after OAuth succeeds. Track derives its repository from the active workspace remote and receives the updated work-item list from the completed sync response. A zero-delta sync says that both sides are already in sync; errors and conflicts remain visible instead of looking like an inert button.

PR / Checks always exposes the named **Security review** and **Code review** actions beside the pull request context. The desktop reads `reviews:read` / `reviews:run` capability from the active BrainRouter organization and never infers authority locally. Signed-out, read-only, unavailable-repository, loading, queued, and backend-error states stay visible; unauthorized actions are disabled with an explanation, not silently hidden. The backend remains the final authorization and linked-repository gate.

Window zoom is a product layout state, not a browser afterthought. `⌘+`, `⌘-`, and `⌘0` must preserve one primary vertical scroll surface and must never introduce page-level horizontal scrolling. Composer controls compress in this order: ellipsize long repository/model text, collapse workspace labels to icons, then hide redundant branch/workspace context at the smallest center width. Action controls remain reachable. Settings, Track views, dialogs, and panels use container or viewport breakpoints that still apply at the supported `0.5–2.5×` zoom range.

The empty desktop state should orient users around the active project and possible work. It should surface primary actions and recent tasks before usage statistics.

Use outcome-based start choices rather than internal mode names: build or change code, plan and organize, or ask and explore. Make the dominant action visually clear instead of presenting every mode as an equal card.

Show a compact “Open task context” strip beneath the start choices. It should open project files, saved knowledge, and review context directly in the visible workbench. Context shortcuts are not a second navigation system; they expose inputs BrainRouter can already use for the current task. A shortcut must switch to a workspace mode that can render its destination before opening it.

The primary empty-state action must always produce visible feedback. If Build is already selected, it focuses the composer and establishes a clear start intent instead of re-selecting the current mode.

## CLI shell

The CLI is the terminal expression of the same product, not a separate visual brand. It uses the same semantic color grammar with terminal-safe fallbacks:

- white or bright gray for the active agent and primary selection;
- muted gray for secondary modes and metadata;
- green, yellow, and red only for factual status.

Keep the header compact enough for an 80-column terminal. Lead the welcome screen with task outcomes and useful shortcuts rather than a large ASCII wordmark. Sidebar and picker selection must remain clear without relying on color alone. Plain or reduced-color terminals receive readable text and markers; no essential hierarchy may depend on true color, Unicode width tricks, animation, or background color.

CLI components consume semantic roles from `brainrouter-cli/src/cli/theme/theme.ts`. Do not hardcode surface-specific color names in individual views. Test the shell at 80 and 120 columns and keep snapshot/golden text byte-stable where terminal tooling depends on it.

## Cross-surface parity

Dashboard and Desktop should feel related without forcing identical layout. Keep these mappings stable:

| Product concept    | Dashboard                               | Desktop                              | Shared rule                                             |
| ------------------ | --------------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| Primary navigation | Left product rail                       | Left workbench rail                  | Same naming and semantic tones                          |
| Settings category  | Category rail in profile/settings shell | Category rail in settings window     | One active category and subsection only                 |
| Subsection choice  | Short tab row                           | Short tab row                        | Resets content scroll on change                         |
| Connected account  | Connections provider row/card           | Account-backed connection state      | Never reveal stored credentials                         |
| Connector sync     | OAuth connection and sync health         | Workspace remote and sync result     | No duplicate PAT or repository setup in the normal path |
| PR review actions  | Org review console                       | PR / Checks security and code actions| Backend RBAC and linked-repository gate are authoritative|
| Knowledge scope    | Organization, project, workspace picker | Active account and workspace context | Server validates every scope                            |
| Status             | Inline badge and explanatory text       | Inline badge and explanatory text    | Color never carries meaning alone                       |
| Select/menu        | Styled trigger and popover              | Styled trigger and popover           | Keyboard operation, focus ring, loading/disabled states |
| Motion             | Page/panel reveal                       | Panel/view transition                | Same duration families and reduced-motion behavior      |

When a feature exists in both applications, align its nouns, status model, empty/error copy, and semantic color before aligning pixels. Platform-specific controls are acceptable only when they preserve the same behavior and information hierarchy.

## Controls and states

- Buttons and rows need hover, pressed, focus-visible, disabled, loading, empty, success, and error states where applicable.
- Hover/active transitions use `150–200ms` and change background, border, color, opacity, or a subtle transform.
- Focus-visible uses a high-contrast one- or two-pixel ring. Never remove keyboard focus without a replacement.
- Primary buttons are light on dark. Ghost buttons use transparent backgrounds and white-alpha borders.
- Destructive actions are quiet until hovered; confirmation is required when loss is irreversible.
- Use inline status messages. Do not use `window.alert()` for form feedback.

## Motion

Motion communicates entrance, selection, progress, and continuity. It must never be required to understand or operate the interface.

| Token     | Duration    | Use                                      |
| --------- | ----------- | ---------------------------------------- |
| Immediate | `120ms`     | Press, hover, focus, compact menus       |
| Interface | `180ms`     | Tab changes, panel entry, card lift      |
| Reveal    | `500–650ms` | Homepage sections and hero composition   |
| Ambient   | `6–12s`     | Low-opacity routing pulses or aura drift |

- Animate `transform` and `opacity` by default. Avoid continuously animating blur, large gradients, or layout properties.
- Stagger related homepage or empty-state items by `60–100ms`.
- Crossfade product-preview states in about `500ms`; pause or calm the preview on hover and keyboard focus.
- Dense workbench views use only short keyed transitions. Do not continuously move content while a person is reading or coding.
- Under `prefers-reduced-motion: reduce`, remove ambient loops, reveal content immediately, and preserve the final state.

## Settings form rules

- A settings panel should fit in a typical desktop viewport whenever its content allows.
- Put advanced or rarely used values behind a disclosure or separate sub-panel.
- Keep labels and controls aligned; descriptions wrap under the label, not under the control.
- Long connector catalogs use provider tabs or a searchable picker. Render only the active provider form.
- Secret fields are write-only or masked by default and never echoed back from the server.
- Settings use a stable category rail and a short subsection bar. Only the active subsection is mounted in the scrolling content viewport.
- If a subsection still exceeds one typical viewport, split its advanced or infrequent controls into a disclosure or another subsection.
- On narrow windows the category rail may become a compact selector, but the active-subsection rule remains unchanged.

## Responsive behavior

- At tablet width, collapse asymmetric marketing grids to one column and reduce page gutters.
- At mobile width, dashboard navigation becomes a drawer; settings category tabs become a vertical stack.
- Desktop workbench panels compress or collapse according to existing container rules; do not introduce a separate mobile information architecture inside Electron.
- Use `min-height: 100dvh` for browser full-height layouts. Electron may use its fixed root height.

## Accessibility

- Use semantic landmarks (`header`, `nav`, `main`, `section`, `aside`) and one page-level heading.
- Every icon-only action needs an accessible label and tooltip.
- Tabs use `role="tablist"`, `role="tab"`, and `aria-selected`.
- Maintain at least 4.5:1 contrast for body text and 3:1 for large text and UI boundaries.
- Preserve logical keyboard order through rail, header, active work surface, and composer.
- Respect reduced motion; no required information may depend on animation.

## Content voice

Write directly and specifically. Name the task, state, or consequence. Avoid AI marketing clichés, exclamation marks in status messages, and memory-only descriptions of BrainRouter.

Preferred: “Connect repositories and knowledge sources.”

Avoid: “Seamlessly unlock next-generation cognitive intelligence.”

## Change checklist

Before shipping UI work:

- Does it follow the shared token table?
- Is the feature in product navigation or Settings for the right reason?
- Does Settings show one category and one sub-panel at a time?
- Does changing a Settings panel start at the top and keep advanced detail out of the primary path?
- Are dashboard and desktop controls visually and behaviorally consistent?
- Do both apps keep navigation, cards, composers, and primary work surfaces neutral?
- Is color limited to factual status, data visualization, or the explicit brand mark?
- Are loading, empty, error, focus, hover, and disabled states present?
- Does the page work at wide, tablet, and narrow widths?
- Does desktop remain overflow-free and balanced at `0.5`, `0.8`, `1`, `1.25`, `1.5`, `2`, and `2.5×` zoom?
- Does signed-in identity come from BrainRouter, with an optional sign-in prompt when signed out?
- Is the copy product-wide and task-centric?
- Did both applications typecheck/build, and was the rendered result inspected?
