# UX Enhancement Recommendations — Desktop → Mobile

> Where desktop patterns (hover, right-click, multi-window, dense layouts, keyboard-first) don't map to a phone, this document proposes **mobile-native** replacements and explains each. Grounded in [investigation-summary.md](investigation-summary.md) §11. Every item ties a real desktop pattern to a concrete mobile solution.
> Tags: **[CRITICAL]** changes the core experience · **[REC]** recommended · **[ASSUMPTION]** needs validation.

---

## 1. Multi-pane workbench → tab bar + stack + sheets — **[CRITICAL]**
**Desktop:** Sidebar + ChatThread + Environment column (316px) + ViewsRail (tabbed panels) + Terminal dock — all visible at once, toggled from `TopbarRight`.
**Mobile problem:** a phone shows one surface at a time; simultaneous panes are impossible and resizable docks have no touch analogue.
**Solution:** a 4-tab bottom navigator (Chats · Activity · Review · Settings); panels become **routes** (Changes, Plan, Files) or **bottom sheets** (Context, pickers). The desktop's "open this panel beside the chat" becomes "push this screen" or "open this sheet."
**Why:** matches platform convention, keeps each screen focused, and preserves the desktop's *information* without its *density*. The Environment column's contents (git/branch/CI/tasks) redistribute to the Changes screen, the Activity tab, and the chat header.

## 2. Hover-only actions & `title=` tooltips → always-visible + long-press + tap-to-expand — **[CRITICAL]**
**Desktop:** message-row copy/fork strips appear on hover; code blocks reveal a copy button on hover; **exact values live in `title=` tooltips** (ContextRing token counts, session status, heatmap cells).
**Mobile problem:** touch has no hover — these affordances would be invisible/unreachable, and tooltip-only data would be lost.
**Solution:** (a) primary actions become **always-visible** compact icon buttons; (b) secondary actions move to a **long-press action sheet**; (c) tooltip data becomes **tap-to-expand** (tap the ContextRing → S-23 breakdown; tap a status chip → detail).
**Why:** nothing load-bearing can hide behind hover; long-press is the established mobile "more" gesture.

## 3. Right-click & nested flyout menus → action sheets — **[REC]**
**Desktop:** the per-chat `ctx-menu` (pixel-positioned, with hover-flyout submenus for "Open in" / "Move to group") and the custom Track dropdown.
**Mobile problem:** no right-click; nested hover flyouts don't work on touch.
**Solution:** **action sheets** (`@gorhom/bottom-sheet`); submenus become a second sheet or an expandable section. Session ⋮ = S-24; review-finding actions = a sheet (S-12).
**Why:** action sheets are the native equivalent and handle long action lists gracefully.

## 4. Command palette (⌘K) → in-composer slash picker + search — **[REC]**
**Desktop:** ⌘K opens a centered fuzzy command palette; slash commands are keyboard-driven with `<kbd>` hints.
**Mobile problem:** no ⌘K; a centered 620px overlay is wrong on a phone.
**Solution:** typing `/` in the composer opens a **filtered command picker** (reusing `commands.ts`/`resolveSlashInput`); a search affordance in the Chats header covers session search (S-22). Keep the catalog, drop the keyboard-first framing.
**Why:** slash-in-composer is already the mental model; it needs no hardware keyboard.

## 5. Keyboard shortcuts → explicit controls + gestures — **[REC]**
**Desktop:** pervasive shortcuts (⌘1–9 sessions, ⇧⌘D/F/G/E panels, Ctrl+\` terminal, Ctrl/Cmd+Enter approve).
**Mobile problem:** no global hardware keyboard.
**Solution:** every shortcut maps to a visible control or gesture — session switching via the list; panels via routes/sheets; **approve via a prominent button + optional swipe**; ⌘1–9 has no analogue (drop). 
**Why:** discoverability over memorization; the phone audience isn't keyboard-driven.

## 6. Inline approval card → banner + sheet + **push notifications** — **[CRITICAL]**
**Desktop:** approvals appear as an inline card in the thread (you're already watching).
**Mobile problem:** the user is often **not looking at the app** while a remote agent runs; a buried inline card means the agent stalls (and fails closed after 5 min).
**Solution:** (a) a sticky **"Agent needs you"** banner + a dedicated **Approval sheet** (S-05); (b) **`expo-notifications` push** for `interaction-request` and `turn-complete`/`turn-error` (US-25, UF-12) that deep-links straight to the approval; (c) **[REC]** quick actions on the notification itself (Allow once / Deny). **[REC]** gate approvals behind **biometric auth** (Face/Touch ID) since you're authorizing shell/git on a real machine from a pocket device.
**Why:** this is the single biggest mobile improvement — it turns "remote agent" from a liability into the product's reason to exist, and it directly addresses the fail-closed timeout.

## 7. Drag-to-resize columns / swipe-to-hide → fixed drawers & sheets — **[REC]**
**Desktop:** three resizable columns with `onPointerDown` geometry and swipe-to-hide thresholds.
**Mobile problem:** no precise pointer; resizing is fiddly on touch.
**Solution:** fixed-size, dismissible **bottom sheets / drawers** with snap points instead of free resize.
**Why:** snap points give predictable, thumb-friendly sizing.

## 8. Drag-and-drop kanban → tap-to-move status sheets — **[REC]** (future, Track)
**Desktop:** Track board/sprints use HTML5 drag-and-drop.
**Mobile problem:** long-press-drag across columns on a small screen is error-prone.
**Solution:** tap a card → **status picker sheet** to move it; optional long-press-drag as an enhancement.
**Why:** tap-to-move is reliable on touch; DnD becomes a bonus, not a requirement.

## 9. Dense multi-column tables → stacked responsive cards — **[REC]**
**Desktop:** Track list (6-col), members role×capability matrix, diff two-column gutter, WorkflowCard agent table, GFM tables.
**Mobile problem:** wide tables overflow and force horizontal scroll.
**Solution:** **stacked cards** (label-over-value) for record rows; the diff renders as a single-column unified view with +/− line coloring; wide tables get horizontal scroll **only** where columnar comparison is essential (e.g. workflow token table).
**Why:** vertical stacking is readable on narrow viewports; reserve horizontal scroll for genuine tabular data.

## 10. `window.prompt()` inputs → custom input modals — **[REC]**
**Desktop:** editor/plan step annotations use `window.prompt()`.
**Mobile problem:** no `window.prompt` in RN.
**Solution:** a small **input modal** component (title + textarea + Save/Cancel), keyboard-aware.
**Why:** consistent, themed, keyboard-friendly input.

## 11. Blur-to-save / modifier-Enter submit → explicit Save — **[REC]**
**Desktop:** Track detail saves on blur; comments submit on Cmd/Ctrl+Enter.
**Mobile problem:** soft keyboards make blur ambiguous and there's no modifier-Enter.
**Solution:** explicit **Save** buttons and a visible **Send** for comments.
**Why:** avoids accidental/lost saves with mobile keyboards.

## 12. Auto-refresh → pull-to-refresh + live sockets — **[REC]** (mobile-native add)
**Desktop:** panels silently auto-refresh.
**Solution:** **pull-to-refresh** on every list (Chats, Activity, Review) plus live `onEvent` updates; a subtle "updated just now" stamp.
**Why:** pull-to-refresh is the expected manual-refresh gesture and conserves battery vs. aggressive polling.

## 13. Gesture vocabulary — **[REC]** (mobile-native add)
Introduce a consistent gesture set the desktop never had:
- **Swipe between tabs** (Chats↔Activity↔Review).
- **Swipe-to-dismiss** sheets and modals.
- **Long-press** = context actions (sessions, messages, findings).
- **Pull-to-refresh** = manual sync.
- **Swipe on a session row** = quick pin/archive (**[REC]**).
**Why:** gestures replace the lost hover/right-click/keyboard layer with native muscle memory.

## 14. Composer popovers → bottom sheets with previews — **[REC]**
**Desktop:** Mode/Model/Effort/Branch are inline popovers.
**Solution:** **bottom sheets** (S-04) with richer mobile-friendly content — model capability badges as wrapped chips, effort as a labeled segmented control, mode options with one-line effect descriptions.
**Why:** sheets give room to explain choices, which matters more when you can't hover for tooltips.

## 15. Haptics & micro-feedback — **[REC]** (mobile-native add)
Add haptic feedback for: approve/deny, turn-complete, tool failure, pull-to-refresh trigger.
**Why:** confirms consequential remote actions without requiring visual attention.

## 16. Connection-state as a first-class surface — **[CRITICAL]** (mobile-native add)
**Desktop:** the host is in-process; "connection" isn't a concept.
**Mobile reality:** the host is remote and the network is unreliable.
**Solution:** a persistent **Connected / Reconnecting / Offline** indicator; stale data visibly dimmed; a clear offline empty-state; auto-reconnect with `seq` resync.
**Why:** trust. Users must always know whether what they see is live.

## 17. Optimistic UI + skeletons — **[REC]**
Session actions (pin/rename/archive) apply optimistically (desktop already does this with `mergeOptimistic`); every data screen shows skeletons, not spinners-on-blank.
**Why:** perceived speed over a network transport.

---

## Summary table

| # | Desktop pattern | Mobile-native replacement | Tag |
|---|---|---|---|
| 1 | Multi-pane workbench | Tabs + stack + sheets | CRITICAL |
| 2 | Hover actions / tooltips | Always-visible + long-press + tap-to-expand | CRITICAL |
| 3 | Right-click / flyout menus | Action sheets | REC |
| 4 | Command palette ⌘K | In-composer slash picker + search | REC |
| 5 | Keyboard shortcuts | Explicit controls + gestures | REC |
| 6 | Inline approval card | Banner + sheet + **push + biometrics** | CRITICAL |
| 7 | Resizable columns | Fixed snap-point sheets/drawers | REC |
| 8 | DnD kanban | Tap-to-move status sheets | REC |
| 9 | Dense tables | Stacked responsive cards | REC |
| 10 | `window.prompt` | Custom input modal | REC |
| 11 | Blur-to-save | Explicit Save | REC |
| 12 | Auto-refresh | Pull-to-refresh + sockets | REC |
| 13 | (none) | Gesture vocabulary | REC |
| 14 | Composer popovers | Bottom sheets w/ previews | REC |
| 15 | (none) | Haptics | REC |
| 16 | (in-process host) | Connection-state surface | CRITICAL |
| 17 | Partial optimistic | Optimistic UI + skeletons | REC |
