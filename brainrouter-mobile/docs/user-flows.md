# User Flows — BrainRouter Mobile

> Screen-to-screen journeys with Mermaid diagrams. Each flow has a unique ID, the screens ([ui-spec.md](ui-spec.md)) and stories ([user-stories.md](user-stories.md)) it covers, and a milestone. Screen IDs in `()` reference the UI spec. Prototypes: `flow-UF-01.html` … `flow-UF-14.html`.

---

## UF-01 · First-run pairing → projects — *MVP*
**Covers:** US-01, US-02 · **Screens:** S-01 → AppTabs → S-02

```mermaid
flowchart TD
    A[Launch app] --> B{Paired host stored?}
    B -- no --> C[S-01 Connect screen]
    C --> D[Enter URL + token / Scan QR]
    D --> E{Connect}
    E -- error --> C2[Show error + Retry]
    C2 --> D
    E -- ok --> F[Store host in SecureStore]
    F --> G[S-02 Chats: projects + sessions]
    B -- yes --> H{Socket reachable?}
    H -- yes --> G
    H -- no --> I[Global 'Reconnecting…' banner]
    I --> J{Backoff reconnect}
    J -- ok --> G
    J -- fail --> C
```
**Steps:** launch → if no stored host, S-01 → enter/scan credentials → connect (errors retry) → persist → land on projects. On relaunch with a stored host, auto-reconnect with a banner; persistent failure routes back to S-01.

---

## UF-02 · Resume a session & manage it — *MVP*
**Covers:** US-03, US-05, US-06 · **Screens:** S-02 → S-03 / S-24

```mermaid
flowchart TD
    A[S-02 Chats] --> B[Tap project to expand]
    B --> C[Session list: status/title/age/turns]
    C --> D[Tap session]
    D --> E[S-03 Session: skeleton → transcript]
    C --> F[Long-press session]
    F --> G[S-24 Actions sheet]
    G --> H[Pin / Rename / Fork / Complete / Archive / Delete / Export]
    H --> I{Destructive?}
    I -- yes --> J[Confirm]
    I -- no --> K[Apply optimistically]
    J --> K
    K --> A
```

---

## UF-03 · Core loop: send turn → live work → tool approval — *MVP* (the heart of the app)
**Covers:** US-08, US-09, US-10, US-12, US-14, US-15, US-16, US-26 · **Screens:** S-03, S-04, S-05, S-08, S-23

```mermaid
flowchart TD
    A[S-03 Session] --> B[Type message / set Mode·Model·Effort via S-04]
    B --> C{Slash command?}
    C -- yes --> C1[Local command picker → run] --> A
    C -- no --> D[Send turn 'start-turn']
    D --> E[Live stream: assistant delta + reasoning + tool cards]
    E --> F{interaction-request?}
    F -- yes --> G[Banner: 'Agent needs you' → S-05 Approval]
    G --> H{Allow once / Always / Deny}
    H --> I[Send interaction-response]
    I --> E
    F -- no --> J{Still running?}
    J -- yes, want to stop --> K[Tap Stop 'interrupt'] --> L[Interrupted state] --> A
    J -- completes --> M[turn-complete: changeset / plan / tokens update]
    M --> N[Tap ContextRing → S-23 usage] 
    M --> A
    E --> O[Tap a tool card → S-08 detail]
```
**Notes:** approvals fail closed on the 5-min broker timeout (US-12). Token/context updates land on `turn-complete`/`tokens-updated`.

---

## UF-04 · Plan review & approval — *MVP*
**Covers:** US-11 · **Screens:** S-03 → S-06

```mermaid
flowchart TD
    A[Agent emits plan-update] --> B[Inline PlanCard in S-03]
    B --> C[Tap → S-06 Plan]
    C --> D[Read items + acceptance + version history]
    D --> E{Decision}
    E -- approve --> F[plan-record-decision: approved] --> G[Agent proceeds]
    E -- request changes --> H[Enter feedback] --> I[Launch revision task] --> J[New plan version] --> D
```

---

## UF-05 · Answer the agent's question — *MVP*
**Covers:** US-13 · **Screens:** S-03 → S-05

```mermaid
flowchart TD
    A[interaction-request: choice] --> B[Banner in S-03]
    B --> C[S-05 Question sheet]
    C --> D{Single or multi-select}
    D --> E[Pick option(s)]
    E --> F[Submit → interaction-response]
    F --> G[Agent continues] 
    C --> H[Dismiss] --> I[Broker treats per rules / re-ask]
```

---

## UF-06 · Review changes → commit/push (with gate) — *MVP*
**Covers:** US-18, US-19, US-21 · **Screens:** S-03 → S-07 → S-13

```mermaid
flowchart TD
    A[S-03 → ChangeSummary bar] --> B[S-07 Changes]
    B --> C[Tap file → unified diff read]
    B --> D[Enter commit message]
    D --> E[Tap Commit/Push]
    E --> F{Review gate clean?}
    F -- yes --> G[Commit/push succeeds → status updates]
    F -- no --> H[S-13 Gate sheet]
    H --> I{Choice}
    I -- run review --> J[S-11 Review]
    I -- bypass --> K[Commit without review] --> G
    I -- cancel --> B
```

---

## UF-07 · Run code review → triage a finding — *MVP*
**Covers:** US-20 · **Screens:** S-11 → S-12

```mermaid
flowchart TD
    A[Review tab S-11] --> B{Findings?}
    B -- none --> C[Empty: 'clean' / Run review]
    C --> D[review-rerun] --> A
    B -- yes --> E[Findings grouped by file]
    E --> F[Tap finding → S-12 detail]
    F --> G[Read code frame + patch]
    G --> H{Action}
    H -- apply suggestion --> I[review-apply-suggestion]
    H -- ask agent to fix --> J[review-fix-finding → chat task]
    H -- resolve/dismiss/ack/dispute/out-of-scope --> K[review-set-finding-status]
    I --> A
    J --> A
    K --> A
```

---

## UF-08 · Monitor dashboard → stop a task — *MVP*
**Covers:** US-22, US-24 · **Screens:** Activity S-10 → S-09

```mermaid
flowchart TD
    A[Activity tab S-10] --> B[Scope: this / all]
    B --> C[Tabs: Running/Finished/Failed/Workflows/Agents/Bash]
    C --> D[Pull-to-refresh globalDashboard]
    C --> E[Tap row → S-09 transcript]
    C --> F[Tap Stop on running row]
    F --> G[interrupt → row → interrupted]
    C --> H[Tap workspace review-gate badge → Review S-11]
```

---

## UF-09 · Inspect a task / workflow transcript — *MVP*
**Covers:** US-23 · **Screens:** S-10 → S-09

```mermaid
flowchart TD
    A[S-10 row] --> B[S-09 Task/Workflow]
    B --> C{Kind}
    C -- task/agent --> D[Header + read-only transcript]
    C -- workflow --> E[Phases + per-agent token table]
    D --> F[Back to Activity]
    E --> F
```

---

## UF-10 · Switch workspace (with trust) — *MVP*
**Covers:** US-07, US-29 · **Screens:** S-18 → S-19 → S-02

```mermaid
flowchart TD
    A[Header switcher → S-18] --> B[Recents list]
    B --> C[Select workspace]
    C --> D{Trusted?}
    D -- yes --> E[openWorkspace → re-scope tabs]
    D -- no --> F[S-19 Trust prompt]
    F --> G{Trust?}
    G -- trust --> H[trustWorkspace] --> E
    G -- cancel --> B
    E --> I[S-02 with new workspace]
```

---

## UF-11 · Configure model & provider — *MVP*
**Covers:** US-27 · **Screens:** Settings S-14 → S-16

```mermaid
flowchart TD
    A[Settings S-14] --> B[Models & providers S-16]
    B --> C[list-models]
    C --> D{Provider configured?}
    D -- no --> E[Add provider + key → sent to host]
    E --> C
    D -- yes --> F[Pick model + capability badges]
    F --> G[set-model: this chat / all chats]
    G --> H[Reflected in composer pill]
```

---

## UF-12 · Push notification → approve from background — *MVP*
**Covers:** US-25, US-12 · **Screens:** notification → S-05

```mermaid
flowchart TD
    A[App backgrounded] --> B[Host emits interaction-request]
    B --> C[Push notification: 'Agent needs approval']
    C --> D[Tap notification]
    D --> E[Deep-link → S-05 Approval]
    E --> F{Allow/Deny}
    F --> G[interaction-response → agent continues]
    C --> H[Ignore] --> I[Broker 5-min timeout → fail closed]
```
*Net-new mobile affordance (Expo Notifications); rationale in [ux-enhancements.md](ux-enhancements.md).*

---

## UF-13 · New chat with a goal — *MVP*
**Covers:** US-04, US-17 · **Screens:** S-02 → S-03

```mermaid
flowchart TD
    A[S-02 → New chat] --> B[S-03 Home empty-state]
    B --> C[Type /goal … or first message]
    C --> D{Goal set?}
    D -- yes --> E[GoalBanner pinned: edit/pause/resume]
    D -- no --> F[Normal turn]
    E --> G[Agent works toward goal across turns]
    F --> G
```

---

## UF-14 · Search a session — *v1*
**Covers:** US-30 · **Screens:** S-03 → S-22

```mermaid
flowchart TD
    A[S-03 overflow → Search] --> B[S-22 Search]
    B --> C[Type query]
    C --> D[search-transcript / search-content]
    D --> E{Hits?}
    E -- none --> F[Empty state]
    E -- yes --> G[Ranked hit rows]
    G --> H[Tap hit → jump to message in S-03]
```

---

## Flow ↔ screen ↔ story matrix

| Flow | Screens | Stories | Milestone |
|---|---|---|---|
| UF-01 | S-01, S-15, S-02 | US-01, US-02 | MVP |
| UF-02 | S-02, S-03, S-24 | US-03, US-05, US-06 | MVP |
| UF-03 | S-03, S-04, S-05, S-08, S-23 | US-08–10, US-12, US-14–16, US-26 | MVP |
| UF-04 | S-03, S-06 | US-11 | MVP |
| UF-05 | S-03, S-05 | US-13 | MVP |
| UF-06 | S-03, S-07, S-13 | US-18, US-19, US-21 | MVP |
| UF-07 | S-11, S-12 | US-20 | MVP |
| UF-08 | S-10, S-09 | US-22, US-24 | MVP |
| UF-09 | S-10, S-09 | US-23 | MVP |
| UF-10 | S-18, S-19, S-02 | US-07, US-29 | MVP |
| UF-11 | S-14, S-16 | US-27 | MVP |
| UF-12 | S-05 (deep link) | US-25, US-12 | MVP |
| UF-13 | S-02, S-03 | US-04, US-17 | MVP |
| UF-14 | S-03, S-22 | US-30 | v1 |
