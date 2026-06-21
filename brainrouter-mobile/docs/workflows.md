# Workflows — BrainRouter Mobile

> Key end-to-end task workflows, step by step. These compose the screens ([ui-spec.md](ui-spec.md)) and flows ([user-flows.md](user-flows.md)) into the real jobs a Dev does. Each step notes the screen `(S-xx)` and underlying protocol call.

---

## WF-1 · Onboarding (first launch → first chat)
**Goal:** get from install to a working agent conversation. **Flows:** UF-01, UF-13.

1. **Install** the app (TestFlight/Play internal for MVP).
2. **Start a host** on the machine where your code lives — run `brainrouter-host` (the net-new server, [technical-doc.md](technical-doc.md) §7). It prints a URL + pairing QR/token.
3. Launch the app → **Connect** `(S-01)`. Scan the QR (or paste URL + token). → `POST /pair` → device token stored in SecureStore.
4. On success you land on **Chats** `(S-02)` showing the host's projects (`workspaceRecents`).
5. If no project is active, tap the **workspace switcher** → **Project picker** `(S-18)` → choose a folder from the host's known roots. Untrusted? → **Trust prompt** `(S-19)` → Trust (`trustWorkspace`).
6. Tap **＋ New chat** → **Session** `(S-03)` opens on the **Home** empty-state.
7. Type your first message (or `/goal …`) → **Send** (`start-turn`). The agent begins; you watch it stream (WF-2).

*Outcome:* paired, a trusted workspace selected, first turn running.

---

## WF-2 · Daily driver — monitor & approve a running agent
**Goal:** supervise the agent and keep it unblocked, mostly from notifications. **Flows:** UF-03, UF-12, UF-05.

1. The agent runs remotely. You **background the app**.
2. It needs a tool approval → you get a **push notification** "Agent needs approval" (US-25).
3. Tap it → deep-link to the **Approval sheet** `(S-05)`. Review the command/diff preview.
4. **[REC]** authenticate with Face/Touch ID, then **Allow once / Always allow / Deny** → `interaction-response`. (Ignore it and it fails closed after 5 min.)
5. Re-open the app → **Session** `(S-03)`: assistant text + reasoning + **tool cards** stream live; a **"working…"** line shows elapsed time.
6. Tap a **tool card** → **detail** `(S-08)` to inspect output; tap the **ChangeSummary** bar → **Changes** `(S-07)`.
7. If the agent asks a question → **Question sheet** `(S-05)` → pick option(s) → Submit.
8. Need to redirect? Tap **Stop** (`interrupt`), then send a new message.
9. Tap the **ContextRing** in the header → **Context usage** `(S-23)` to watch token/context budget.

*Outcome:* the agent stays unblocked while you're away from the desktop.

---

## WF-3 · Kick off a task with a goal & plan
**Goal:** start a larger task and approve the approach before work begins. **Flows:** UF-13, UF-04.

1. **New chat** `(S-02 → S-03)`.
2. Set **Mode → Plan** via the composer pill `(S-04)` so the agent plans before editing.
3. Send `/goal <objective>` → a **GoalBanner** pins at the top (edit/pause/resume).
4. Send the task prompt. The agent returns a **plan** → inline **PlanCard** → tap → **Plan** `(S-06)`.
5. Read items + acceptance criteria. **Approve** (`plan-record-decision: approved`) or **Request changes** with feedback (launches a revision → new plan version).
6. Switch **Mode → Accept-edits** (or Auto) `(S-04)` and let the agent execute; supervise via WF-2.

*Outcome:* a goal-anchored task with an approved plan.

---

## WF-4 · Review & ship (commit/push with the gate)
**Goal:** review the agent's changes and ship them, respecting the review gate. **Flows:** UF-07, UF-06.

1. Open **Review** tab `(S-11)`. If stale/none, tap **Run review** (`review-rerun`).
2. Findings appear grouped by file. Tap one → **Finding detail** `(S-12)`.
3. Act per finding: **Apply suggestion** (`review-apply-suggestion`), **Ask agent to fix** (`review-fix-finding` → chat task), or **Resolve / Dismiss / Acknowledge / Dispute / Out-of-scope** (`review-set-finding-status`).
4. When findings are clear, open **Changes** `(S-07)`; tap files to read diffs.
5. Enter a **commit message** → **Commit** / **Push**.
6. If the **review gate** blocks (US-21) → **Gate sheet** `(S-13)`: **Run review**, **Open review**, **Commit without review** (bypass), or **Cancel**.
7. On success, status updates (`markActivity` notifies the host of commit/push).

*Outcome:* reviewed changes committed and pushed from the phone.

---

## WF-5 · Triage background work from the dashboard
**Goal:** see everything running across projects and intervene. **Flows:** UF-08, UF-09.

1. Open **Activity** tab `(S-10)`. Set scope **All** to see every workspace (`globalDashboard`).
2. Use the segmented tabs (**Running / Finished / Failed / Workflows / Agents / Bash**) with counts.
3. **Pull-to-refresh** to sync.
4. Tap a row → **Task/Workflow transcript** `(S-09)`: read the sub-agent's transcript, or a workflow's phases + per-agent token table.
5. A runaway task? Tap **Stop** on its row (`interrupt`).
6. See a workspace **review-gate** badge? Tap it → **Review** `(S-11)` for that workspace.

*Outcome:* full visibility and control of background agents.

---

## WF-6 · Configure models, providers & appearance
**Goal:** set up the right LLM and personalize. **Flows:** UF-11.

1. **Settings** tab `(S-14)`.
2. **Models & providers** `(S-16)`: if no provider, **Add provider** + key (sent to the host over the secure channel; keys live host-side). Pick a **model** (capability badges shown); choose scope **This chat / All chats** (`set-model`).
3. **Appearance** `(S-17)`: Theme (Dark / High-contrast), **accent** color, code font, chat text size — applied immediately and persisted.
4. **Connection** `(S-15)`: review host status; **Test connection**; **Forget host** if switching machines.

*Outcome:* the agent uses your chosen model; the app looks the way you like.

---

## WF-7 · Recover from going offline
**Goal:** stay trustworthy across flaky networks. **Flow:** UF-01 (reconnect branch).

1. Network drops → a global **Reconnecting…** banner appears; visible data is **dimmed/stale-marked**.
2. The transport **auto-reconnects** with backoff.
3. On reconnect, the client sends the last `seq` per session → the host **replays missed events** (no gaps).
4. If reconnection keeps failing, you're routed to **Connection** `(S-15)` / **Connect** `(S-01)` to fix the host URL/token.

*Outcome:* the user always knows whether data is live, and missed agent events are recovered.

---

## Workflow → flow → milestone

| Workflow | Flows | Milestone |
|---|---|---|
| WF-1 Onboarding | UF-01, UF-13 | MVP |
| WF-2 Monitor & approve | UF-03, UF-12, UF-05 | MVP |
| WF-3 Goal & plan | UF-13, UF-04 | MVP |
| WF-4 Review & ship | UF-07, UF-06 | MVP |
| WF-5 Dashboard triage | UF-08, UF-09 | MVP |
| WF-6 Settings | UF-11 | MVP |
| WF-7 Reconnect | UF-01 | MVP |
