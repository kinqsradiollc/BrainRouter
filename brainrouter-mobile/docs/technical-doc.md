# Technical Documentation — BrainRouter Mobile (React Native / Expo)

> Proposed architecture for the mobile port. Grounded in [investigation-summary.md](investigation-summary.md). Decisions are **[DECISION]**; assumptions **[ASSUMPTION]**; recommendations **[REC]**.
> **Locked choices:** Expo (managed) · MVP-first · new `brainrouter-mobile/` package.

---

## 1. The central architecture decision

**[DECISION] The mobile app is a thin client to a remote `brainrouter-core` host. The agent runtime does NOT run on the device.**

Why (from the audit): `@kinqs/brainrouter-core` is a Node runtime — `child_process` (shell/git/tests), `node:fs` (all durable state), streaming `fetch` to `/chat/completions`, stdio MCP. React Native (Hermes/JSC) supports none of these, and the agent's purpose (editing files / running builds in a checkout) has no on-device analogue. The desktop already proves the renderer is transport-agnostic: it touches Node/Electron only through the `window.brainrouter` bridge, and `devBridge.ts` already swaps that bridge for a non-Electron mock.

```
┌─────────────────────────────┐         WebSocket (TLS + Bearer)        ┌────────────────────────────────────┐
│  brainrouter-mobile (Expo)  │ ◄──────────────────────────────────────►│  brainrouter-host  (NET-NEW)        │
│  • RN UI (ported renderer)  │   AgentCommand  ───────────────────►     │  • WS/SSE server                    │
│  • RemoteTransport ─────────┼──   ◄───────────────────  AgentEvent     │  • wraps createHostCore (Electron-  │
│  • Zustand + TanStack Query │   query / query-result (req/resp)        │    free, already exists)            │
│  • @kinqs/brainrouter-      │                                          │  • runs @kinqs/brainrouter-core     │
│    agent-protocol (verbatim)│                                          │    where the workspace lives        │
└─────────────────────────────┘                                          └────────────────────────────────────┘
```

The protocol is already the right shape: `@kinqs/brainrouter-agent-protocol` is transport-agnostic, has zero runtime deps (RN-safe), and its `EventEnvelope.seq` exists explicitly for "gap detection over lossy transports." We reuse it **verbatim** as the network contract.

---

## 2. Two deliverables in Phase 3

| # | Deliverable | What | Effort |
|---|---|---|---|
| 1 | **`brainrouter-mobile/`** | The Expo app (this package) | bulk of the UI work |
| 2 | **`brainrouter-host`** (net-new, **[REC]** a new package under `packages/` or `brainrouter-host/`) | A thin WS/SSE server that wraps the existing, Electron-free `createHostCore` (`brainrouter-desktop/electron/hostCore.ts`) + spawns `brainrouter-core`. Swaps the transport from Electron `parentPort` to a socket. | small — it's a transport adapter, not new agent logic |

> The host shim reuses `createHostCore(send, handle, spawnAgent)` directly — those are already injected dependencies, so we provide socket-backed `send`/`handle` and the same `spawnAgent`. The per-workspace pool logic (`hostPoolPolicy.ts`) and the FS/git/terminal query handlers (`host.ts`) move server-side unchanged. **[ASSUMPTION]** we can import the desktop's `hostCore`/`host` modules (or lift them into a shared package); if not, they are copied into `brainrouter-host` with the Electron-specific `parentPort` calls replaced. The team already runs a remote HTTP MCP server (memory, :3747), so the operational pattern exists.

This document specifies deliverable #1 in depth; deliverable #2's contract is in §7.

---

## 3. Stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime/build | **Expo (managed) SDK 52+**, EAS Build/Update | [DECISION]; OTA updates, prebuilt modules, no native toolchain needed for MVP |
| Language | **TypeScript (strict)** | matches the entire repo; enables sharing types verbatim |
| Navigation | **React Navigation v7** (native-stack + bottom-tabs + modal) | [DECISION] prompt-specified; the standard, Expo-friendly |
| Global state | **Zustand** | [DECISION] tiny, RN-proven; the desktop has *no* state lib (hooks+refs) so we're free to choose; Zustand maps the event-bus → UI cleanly without the desktop's giant context objects |
| Server cache (query/req-resp) | **TanStack Query v5** | [REC] the `query`/`query-result` calls are request/response reads → caching, refetch-on-focus, retries for free; streaming `onEvent` data lives in Zustand |
| Transport | **`react-native` WebSocket** (built-in) + reconnection wrapper | [DECISION] the AgentCommand/AgentEvent stream is bidirectional → WS; `query` rides the same socket via correlation ids (mirrors desktop) |
| Storage (prefs) | **`expo-secure-store`** (host+token) + **MMKV** (UI prefs) | secure for credentials; MMKV is fast sync KV → drop-in for the desktop's localStorage |
| Markdown | **`react-native-markdown-display`** | replaces `react-markdown` |
| Code/syntax | **`react-native-syntax-highlighter`** | replaces Prism/`react-syntax-highlighter`; same engine |
| SVG (icons/ring) | **`react-native-svg`** | ports `icons.tsx` + `ContextRing` 1:1 |
| Notifications | **`expo-notifications`** | US-25 push for approvals/turn-complete |
| Attachments | **`expo-image-picker` / `expo-document-picker`** | US-16 |
| Bottom sheets | **`@gorhom/bottom-sheet`** | all the desktop popovers/menus → native sheets |
| Lists | **`@shopify/flash-list`** | [REC] long transcripts/sessions perf |
| Testing | **Jest + React Native Testing Library**; **Detox** (e2e, v1) | matches repo's vitest/jest discipline |

---

## 4. Folder structure

```
brainrouter-mobile/
├── app.json / eas.json            # Expo + EAS config
├── package.json
├── tsconfig.json                  # extends repo base; strict
├── index.ts                       # Expo entry
├── docs/                          # (this folder — Phase 1/2 deliverables)
├── prototypes/                    # (Phase 2 HTML prototypes)
└── src/
    ├── transport/                 # ── the port seam #1 ──
    │   ├── BrainRouterTransport.ts   # interface: send / onEvent / query / promise methods
    │   ├── RemoteTransport.ts        # WebSocket impl (reconnect, seq-resync, correlation)
    │   ├── MockTransport.ts          # devBridge.ts analogue for offline UI dev/tests
    │   └── protocol.ts               # re-export @kinqs/brainrouter-agent-protocol types
    ├── storage/                   # ── the port seam #2 ──
    │   └── Storage.ts                # MMKV + SecureStore behind the localStorage-shaped API
    ├── state/                     # Zustand stores
    │   ├── connectionStore.ts        # host, token, status, reconnect
    │   ├── sessionStore.ts           # active session, transcript rows, running set (ports useSessionState)
    │   ├── eventStore.ts             # the onEvent router (ports useAgentEvents handleQueryResult)
    │   ├── workspaceStore.ts         # active workspace, recents, trust
    │   └── uiStore.ts                # panels-as-routes, theme/accent prefs
    ├── domain/                    # ── ported PURE logic (verbatim from desktop) ──
    │   ├── view/                     # all *View.ts (plan, requirements, annotations, artifacts,
    │   │                             #   schedule, review*, projectSessions, sessionDisplay, editorView)
    │   ├── session/                  # sessionOrder, sessionPagination, sessionCache, taskTranscriptRouting
    │   ├── workspace/                # workspaceEvents, dashboard, runningIndicators
    │   ├── parse/                    # track/query (JQL), worktreeParser, thinkParse, slashHighlight, diff parse
    │   ├── commands/                 # commands.ts core (buildCommandList/resolveSlashInput/runCommand)
    │   ├── models/                   # modelCapabilities
    │   ├── ci/                       # ciFormat
    │   ├── permissions/              # track/permissions (RBAC)
    │   └── format.ts                 # ages/rel/tokens (minus DOM download())
    ├── navigation/
    │   ├── RootNavigator.tsx          # ConnectStack | AppTabs
    │   ├── AppTabs.tsx                # Chats · Activity · Review · Settings
    │   └── linking.ts                 # deep links (push → approval/session)
    ├── screens/                    # one per S-xx (see ui-spec.md)
    │   ├── ConnectScreen.tsx          # S-01
    │   ├── ChatsScreen.tsx            # S-02
    │   ├── SessionScreen.tsx          # S-03  (the core)
    │   ├── ChangesScreen.tsx          # S-07
    │   ├── ActivityScreen.tsx         # S-10
    │   ├── ReviewScreen.tsx           # S-11 / S-12
    │   ├── SettingsScreens.tsx        # S-14…S-17
    │   └── …                          # S-08, S-09, v1 screens
    ├── components/
    │   ├── chat/                      # ChatRow renderers, ToolCard, PlanCard, ChangeSummary, Composer
    │   ├── sheets/                    # ApprovalSheet, PlanSheet, ComposerPickers, ProjectPicker, GateSheet
    │   ├── primitives/                # Button, Chip, Card, ListRow, Sheet, Modal, CodeBlock, DiffView,
    │   │                              #   Markdown, ContextRing, ProgressBar, EmptyState, ErrorState, Skeleton
    │   └── Icon.tsx                    # ported icons.tsx → react-native-svg
    ├── theme/
    │   ├── tokens.ts                  # colors/space/radius/type (from theme.css)
    │   └── ThemeProvider.tsx          # dark/hc + runtime accent
    └── lib/
        ├── rid.ts                     # ported
        └── notifications.ts           # expo-notifications wiring
```

**Two seams, everything else flows from them** (matches the audit's recommendation): inject `BrainRouterTransport` and `Storage` wherever the desktop reached `window.brainrouter` / `localStorage`. Pure `domain/**` moves unchanged; bridge-coupled hooks become Zustand stores parameterized by the transport.

---

## 5. State management design

The desktop centralizes all state in `App.tsx` (useState/useRef) + 10 hooks, threaded via giant context objects, with refs mirroring state for the mount-once event listener. On mobile we keep the *logic* but replace the plumbing with **Zustand stores** (no prop-drilling, selectors avoid the stale-closure problem the refs solved).

- **`eventStore`** — the inbound hub. Ports `useAgentEvents.handleQueryResult` (the ~450-line `switch` on `q-*`/event kinds) into a Zustand action `applyEvent(msg)`. The single `transport.onEvent(applyEvent)` subscription replaces `window.brainrouter.onEvent`. Streaming deltas are batched (~16/s, as desktop) before committing to the store to keep FlatList smooth. **This is the #1 reuse win** — the routing logic is pure TS.
- **`sessionStore`** — viewed session, running/stopping, cross-session running set, sidebar sessions + optimistic rows, workspaces, expanded projects. Ports `useSessionState` shape.
- **`workspaceStore`** — active workspace, recents, trust, generation-stamping (ports `workspaceEvents.ts` predicates verbatim).
- **`connectionStore`** — host/token/status; owns the `RemoteTransport` lifecycle.
- **`uiStore`** — theme/accent/font/text-size + "which panel route is open"; persisted via `Storage`.
- **TanStack Query** wraps the request/response `query` calls (`list-sessions`, `changed-files`, `review-current`, `globalDashboard`, `list-models`, …) keyed by `[workspaceRoot, queryName, args]`, with refetch-on-focus and the desktop's staleness windows as `staleTime`.

Selectors are derived with the pure hooks (`useSessionSidebar`, `useComposerDerived`) moved into `domain/` and consumed via Zustand selectors.

---

## 6. The transport layer (client)

```ts
// transport/BrainRouterTransport.ts — the single seam the whole app talks to
export interface BrainRouterTransport {
  send(cmd: AgentCommand): void;                       // start-turn, interrupt, interaction-response, set-model, …
  onEvent(fn: (msg: AgentEventMessage) => void): () => void;
  query<T = unknown>(name: string, args?: unknown): Promise<T>;   // wraps {kind:'query',id,name,args} → query-result
  // promise convenience methods (mirror preload's Layer-1):
  workspaceRecents(): Promise<{current: string|null; recents: string[]}>;
  openWorkspace(root: string): Promise<{opened: boolean; needsTrust?: boolean}>;
  isWorkspaceTrusted(root: string): Promise<{trusted: boolean}>;
  trustWorkspace(root: string): Promise<{trusted: true}>;
  globalDashboard(): Promise<GlobalDashboard>;
  markActivity(root: string, reason: string): Promise<{ok: true}>;
  // … reorderWorkspace, workspaceSessions, trustedWorkspaces (see investigation §7 Layer-1)
  status(): ConnectionStatus;
  onStatus(fn: (s: ConnectionStatus) => void): () => void;
}
```

`RemoteTransport` (WebSocket) responsibilities:
- **Framing:** every message is the existing `AgentEventMessage` / `AgentCommand` JSON; `query` uses a monotonic correlation `id` and resolves the matching `query-result` (exactly as the desktop does).
- **Reconnect:** exponential backoff; on reconnect, send the last seen `seq` per session so the host can replay missed events (`EventEnvelope.seq` gap-detection). While disconnected, surface `Offline` and mark data stale.
- **Auth:** `Authorization: Bearer <token>` on the WS upgrade (or `?token=`), TLS required for non-localhost. **[ASSUMPTION]** host validates the token and authorizes the device.
- **Security note:** the host executes shell/git on the user's machine, so the channel MUST be authenticated + encrypted; mirror the memory server's Bearer/JWT model (investigation §8). Pairing (S-01) provisions the token.

`MockTransport` mirrors `devBridge.ts`: an in-memory implementation for UI development, Storybook, and tests — so screens build without a live host.

---

## 7. The host server contract (deliverable #2, summary)

A minimal spec so Phase 3 can build both ends against one contract:

- **Endpoint:** `wss://<host>/agent` (WS). **[REC]** also `GET /healthz`, `POST /pair` (exchange a short-lived pairing code for a device token).
- **Auth:** Bearer token (issued at pairing); reject unauthenticated upgrades.
- **Messages (verbatim protocol):** client→server = `AgentCommand`; server→client = `AgentEventMessage` (envelope `{seq,ts,sessionKey,workspaceRoot?,event}`).
- **Multiplexing:** `sessionKey` + `workspaceRoot` route to the right `Agent` in the per-workspace pool (reuse `hostPoolPolicy.ts`); the single device connection replaces the desktop's per-window pool.
- **Replay:** accept a `resume {sessionKey, sinceSeq}` to replay missed events on reconnect.
- **Implementation:** wrap `createHostCore({ send: ws.send, handle, spawnAgent })`; the ~140 `query` handlers and FS/git/terminal logic in `host.ts` run server-side unchanged.

---

## 8. Dependency mapping (authoritative)

| Desktop | Mobile | Status |
|---|---|---|
| electron, react-dom, vite | Expo + react-native + Metro | replace |
| `@kinqs/brainrouter-core` | runs on host only | **not ported** (remote) |
| `@kinqs/brainrouter-agent-protocol` | same package, verbatim | **keep** |
| `@kinqs/brainrouter-types` | same package, verbatim | **keep** (avoid value-imports pulling `node:crypto`; mirror `permissions.ts` pattern) |
| monaco-editor | (defer) RN code view / WebView CodeMirror | **future** (S-32) |
| @xterm/xterm | (defer) remote-shell view or omit | **future** (S-33) |
| react-markdown + remark-gfm | react-native-markdown-display | replace |
| react-syntax-highlighter | react-native-syntax-highlighter | replace |
| icons.tsx (SVG) | react-native-svg | port 1:1 |
| theme.css (CSS vars) | theme/tokens.ts | port 1:1 |
| localStorage | MMKV + SecureStore via `Storage` | replace |
| Node fs/path/os/child_process, fs.watch | host-side only | **not ported** |
| dialog folder picker, multi-window, windowSecurity | host roots / single view / TLS+token | re-model / drop |

**Flagged: cannot port directly** — anything in the agent runtime (file edits, shell, git, builds, MCP stdio), the in-app Monaco editor, and the xterm terminal. The first is solved by remoting; the last two are deferred with documented replacements.

---

## 9. Cross-cutting concerns

- **Offline/lossy:** stale-marking + `seq` resync (§6). All durable data is host-owned; the client caches and refetches.
- **Security:** TLS + Bearer; credentials in SecureStore; never store LLM provider keys on device (they live host-side, investigation §8) — provider config edits are RPCs.
- **Theming:** ThemeProvider exposes `tokens.ts`; runtime accent/theme override matches desktop (`App.tsx:581-606`). High-contrast variant supported.
- **Performance:** FlashList for transcript/sessions; batched streaming commits; lazy-load heavy screens.
- **Accessibility:** min 44pt touch targets (replacing dense desktop rows); convert `title=` tooltips to visible labels / long-press info; respect Dynamic Type via the type scale.
- **Deep links / push:** `expo-notifications` + React Navigation `linking` route approvals/turn-complete to S-05/S-03.

---

## 10. Testing strategy

- **Unit (Jest):** the ported `domain/**` (already unit-tested on desktop — bring the tests too: `editorModel.test.ts`, `query.test.ts`, `workspaceEvents.test.ts`, `*View.test.ts`, etc.). These are pure and pass unchanged.
- **Store tests:** `eventStore.applyEvent` against recorded `AgentEvent` fixtures (reuse desktop event shapes).
- **Component (RN Testing Library):** ChatRow renderers, ApprovalSheet, Composer, DiffView.
- **Transport:** `MockTransport`-backed integration of the core loop (send turn → stream → approve).
- **E2E (Detox, v1):** UF-03 (core loop) and UF-06 (commit with gate) against a seeded mock host.

---

## 11. Build & release

- **EAS Build** (iOS + Android), **EAS Update** for OTA JS updates.
- **Channels:** `development` (Expo Dev Client + MockTransport), `preview` (internal), `production`.
- **Config:** host URL is runtime (entered at pairing), not baked in.
- Versioning tracks the desktop's `0.4.x` line; `CHANGELOG.md` updated as features land.

---

## 12. What this enables (and the honest limits)

**Enables:** full **monitor + steer + approve + review** parity with desktop from a phone — the entire agent loop, sessions, plan/diff/review, dashboard, approvals, settings — without shipping a Node runtime to the device.

**Honest limits (documented, not hidden):**
- The app is **useless without a reachable host** — that's inherent to the architecture, not a bug. Pairing UX and host setup docs matter.
- **In-app editing and terminal are deferred** (S-32/S-33); the phone reads code and drives the agent, the desktop/host does heavy editing.
- The **`brainrouter-host` server is net-new** and on the critical path for any functionality — it's small, but it must exist before the app does anything real.
