# Federation

BrainRouter 0.4.0 turns the brain into a **shared memory plane**: any
MCP-aware host (BrainRouter CLI, Claude Code, Codex, Cursor, Gemini
CLI, …) that points at the same brain with the same `userId`
automatically participates. This doc covers what's live today (Stage 2:
presence + telemetry) and the lifecycle semantics you need to understand
when something looks "missing" or "stale."

Wiring a host up is covered in [`mcp-install.md`](mcp-install.md). Stage
1 hardening — WAL mode, per-client install snippets, `workspaceTag` —
is documented inline in [`memory-engine.md`](memory-engine.md) and the
0.4.0 changelog.

## Stage 2 at a glance — presence + telemetry

| Surface | What it shows |
|---|---|
| **`/agents --remote`** (CLI) | One-shot table of peer sessions: client kind, sessionKey prefix, last heartbeat age, workspace, optional usage. |
| **`/agents --remote --watch`** | Bounded re-poll: 10 ticks × 2 s ≈ 20 s, then auto-exits with a "re-run to keep watching" hint. The Ink REPL owns SIGINT, so we can't rely on Ctrl-C to break out — the bound is deliberate. |
| **`/agents --remote --usage`** | Adds TOKENS / USD columns sourced from each peer's `/tokens` snapshot. |
| **`/agents --remote --include-stale`** | Surfaces sessions whose last heartbeat is 2–5 min old (not yet swept). |
| **`/agents --remote --json`** | Pipe-friendly output for `jq` / status bars / CI. |
| **Live sessions widget** (dashboard Overview page) | Same data, polled every 10 s; tokens/USD column on by default. |

## Stage 3 at a glance — cross-CLI messaging

| Surface | What it does |
|---|---|
| **`/dm <sessionKey \| prefix> <message>`** | Point-to-point text. Recipient sees a banner (📨) above their next prompt within ~5 s. |
| **`/broadcast <message>`** | Text to every active peer under your userId. |
| **`/broadcast <clientKind>:* <message>`** | Pattern broadcast — `/broadcast claude-code:* please pull latest`. |
| **Incoming banner** | Background poll (5 s) renders incoming `text`-kind messages above the active prompt. No render hook, no chat UI — just visibility. |

What Stage 3 deliberately **does not do yet**:

- **SSE push.** The spec calls for an SSE-fed view; the current
  implementation is a 5 s poll. Latency: ≤ 5 s instead of ≤ 250 ms.
  SSE plumbing through the Streamable HTTP MCP transport is a bigger
  surface than belongs in this stage. Tracked as a 0.4.1 follow-up.
- **Render non-text kinds.** The schema reserves `tool-result`,
  `memory-ref`, `goal-handoff`, and `delegate` as `kind` values so
  Stage 4 (cross-vendor `delegate_task`) and CLI Multi-Agent Phase 2
  (cross-session goal handoff) can carry structured payloads. Stage
  3 CLIs only surface `text`; the other kinds sit in the inbox until
  a consumer ships.
- **Cross-user messaging.** Inbox rows are scoped by `(userId,
  toSessionKey)`. A user can only address peers under their own
  BrainRouter key — federation is intentionally not a chat fabric
  across the multi-tenant boundary.

## Addressing model — three forms

`session_send` and the CLI surfaces all accept the same three address
shapes:

| Form | Meaning | Example |
|---|---|---|
| Exact `<sessionKey>` (or a 12-char prefix from `/agents --remote`) | Point-to-point. | `/dm abcdef0123ab hi` |
| `<clientKind>:*` | Broadcast to every active peer of that kind. | `/broadcast codex:* heads up` |
| `*` (or omit the pattern in `/broadcast`) | Broadcast to every active peer under your userId. | `/broadcast deploying main` |

Broadcast forms **only reach sessions whose last heartbeat is within
the active window (2 min)**. Sending into the past has no useful
semantics — a stale peer can't read its inbox while it's swept.
Point-to-point send writes the row even if the recipient is currently
inactive, so a message that lands during a momentary blip will still
be visible when the peer's next heartbeat lands and its inbox poller
fires.

## Inbox lifecycle

| State | Visibility |
|---|---|
| **Undelivered** | Visible to the recipient via `session_inbox_read`. Never swept — survives until the recipient acks it. |
| **Delivered** | Acked. Hidden from default reads. Surfaced via `includeDelivered: true`. Swept after 1 hour. |

The CLI's inbox poll fires `session_inbox_read` without `peek: true`,
so reading auto-acks. Callers that need at-least-once-delivery (e.g.
a recovering CLI replaying its inbox after a crash) call `peek: true`
and then `session_inbox_ack` only for the ids they've actually
persisted. The two-step flow is intentional — losing a banner because
the REPL crashed mid-render is worse UX than seeing it twice.

What Stage 3 deliberately **does not do yet**: send messages between
peers as a chat UI, hand off goals, or route delegated work across
vendors. Those are Stage 4 (cross-vendor `delegate_task` over the
same `kind` enum) and the post-0.4.0 plan in
[`FULL_TASKS.MD` §4.3](../FULL_TASKS.MD).

## What it's useful for right now

- **Multi-window awareness.** Three repos, three terminals. You forgot
  which one had the long-running `npm test`. Glance at `--remote
  --watch` — the session still bumping its heartbeat is alive; the
  silent ones aren't doing anything.
- **Cost accountability.** `--remote --usage` rolls up token / USD
  spend across every federated session under your key, not just the
  one you're typing in. Catches the "wait, why was today $40?" before
  it becomes the monthly bill.
- **Federation sanity check.** Just installed BrainRouter MCP in
  Claude Code or Codex and want proof both ends see the same brain?
  Start a session there. If it appears in your CLI's `/agents
  --remote`, you wired it right. If it doesn't, the
  [install primer](mcp-install.md#federation-primer-040) walks you
  through the API-key / userId chain.
- **CI hygiene.** A headless `brainrouter run` in CI heartbeats
  exactly like an interactive session. After the job, `--remote
  --include-stale --json` proves it ever connected and tells you what
  it spent. Pipe to `jq` to assert in your pipeline.

## How registration actually happens

The CLI auto-registers — you never call `session_register` by hand.

```
brainrouter REPL boots
  → MCP client connects to the brain
  → attachFederation() lists the brain's tools
    → if session_register + session_heartbeat are both present:
        call session_register once  (mints / reuses sessionKey)
        kick off setInterval(heartbeat, 30s)
    → else (pre-0.4.0 brain):
        no-op; CLI keeps working unchanged
```

Headless `brainrouter run` doesn't currently attach federation — it's a
single-shot agent turn, not a persistent peer. (Spec note: changing
this to register-then-unregister around each run is a 0.4.1 follow-up.)
The REPL path (`brainrouter` with no subcommand) is the one that
populates the registry today.

## Lifecycle — what "active / stale / swept" mean

Heartbeats fire every **30 s**. The brain runs a sweeper every minute
to clean up sessions that have gone silent. That gives four states:

| State | Condition | Default `--remote` view | `--include-stale` |
|---|---|---|---|
| **Active** | Heartbeat ≤ 2 min ago | ✅ Visible, green age. | ✅ Visible. |
| **Stale** | Heartbeat 2–5 min ago | ❌ Hidden. | ✅ Visible, gray age. |
| **Swept** | Heartbeat > 5 min ago | ❌ Gone. | ❌ Gone — row deleted. |
| **Recovered** | Brain restart wiped registry; CLI still running | Reappears within ≤ 30 s | Reappears within ≤ 30 s |

### Why those thresholds?

- **2 min active cutoff** ≈ 4 missed heartbeats — short enough to
  notice a hung process, tolerant of a single network blip.
- **5 min sweep threshold** ≈ 10 missed heartbeats — definitive death
  signal.
- **Sweeper cadence: 1 min** — worst-case lag between "session dies"
  and "row gone" is therefore ~6 minutes (5 min stale + up to 1 min
  for the sweeper to fire).

All three are tunable via `BRAINROUTER_SESSION_SWEEP_*` env vars on the
brain side; the CLI heartbeat cadence (`HEARTBEAT_INTERVAL_MS` in
[`federationRegistration.ts`](../brainrouter-cli/src/runtime/federationRegistration.ts))
is currently a constant.

### Identity is per-process

Every `brainrouter` launch is its own federation session — a fresh
UUID minted in memory, never persisted to disk. **Two terminals open
in the same workspace = two rows in `/agents --remote`.** An earlier
attempt to persist the key per-workspace collapsed concurrent
terminals into a single row (the brain's idempotent
`session_register` saw both calls under the same composite PK and
treated them as one), so we reverted to per-process identity.

The session also rotates whenever you restart the CLI in the same
terminal. To stop that from leaving a 5-min ghost on every restart,
the lifecycle uses two cleanup paths:

1. **Graceful exit (clean `/exit`, REPL EOF, SIGINT, SIGTERM).** The
   REPL's shutdown handler calls `session_unregister` on the brain,
   which deletes the row immediately. The call is guarded by a 1.5 s
   timeout so a slow or dead brain can't hang `/exit`.
2. **Hard kill (`kill -9`, OOM, machine sleep, network partition).**
   No unregister fires. Heartbeats stop. The session falls out of
   the default view after 2 min and the brain's stale-session
   sweeper drops the row after 5 min.

Per-process identity is also why the federation sessionKey is
independent of the agent's *chat* sessionKey (which also rotates per
launch). They serve different lifecycles — chat sessions can fork,
resume, and persist; federation rows are short-lived presence
markers.

### Brain restart

Two layers of recovery kick in:

1. **MCP transport recovery.** The Streamable HTTP transport caches
   the brain's `mcp-session-id`. When the brain restarts, that id is
   permanently invalid — pre-fix, every subsequent tool call failed
   with `Session not found. Send a POST without mcp-session-id to
   initialise`. The CLI now detects that error string in `callTool`,
   rebuilds the transport with the stashed server config, and retries
   the call exactly once. Transparent to the caller; covered by
   [`federation-session-recovery.test.ts`](../brainrouter-cli/src/tests/federation-session-recovery.test.ts).
2. **Registry recovery.** The brain's in-memory registry is gone, but
   your CLI process is still heartbeating. The next heartbeat returns
   `{ updated: false }`. The CLI sees that and **auto-re-registers**.
   You see a 30 s gap in `--watch` and then the session reappears.
   Covered by the
   "re-registers when brain returns updated:false" case in
   [`federation-registration.test.ts`](../brainrouter-cli/src/tests/federation-registration.test.ts).

## Caveat: presence is heartbeat-driven, not authoritative

Because cleanup is heartbeat-driven, **`session_list` is not a reliable
presence oracle within the first 5 minutes after a peer dies**. If you
need certainty that a peer is gone (rather than just stalled), look at
`lastHeartbeatAt` directly via the `--json` output:

```
$ brainrouter
> /agents --remote --json --include-stale
{ "sessions": [
  { "sessionKey": "a1b2...", "clientKind": "codex",
    "lastHeartbeatAt": "2026-05-28T14:31:02.000Z", ... }
] }
```

Stage 3's `session_send` will need to defend against this too —
sending to a session that died 30 s ago should bounce immediately, not
hang waiting for the recipient to deliver.

## End-to-end walkthrough — three federated terminals on one project

A 15-minute exercise that exercises every shipped federation surface
on a real (throwaway) project. Each step lists what to look for so
you can confirm federation is doing what it says.

### Setup (one-time)

```bash
# Brain — leave running in its own terminal
cd /path/to/BrainRouter
git checkout release/0.4.0 && git pull --ff-only
cd brainrouter && npm run build && npm run dev:http   # listens on :3747

# CLI — build + link so `brainrouter` is on PATH
cd ../brainrouter-cli && npm run build && npm link

# Scaffold a real test project
mkdir -p ~/code/portfolio-demo && cd ~/code/portfolio-demo
npm init -y >/dev/null
npm install --save-dev vitest @testing-library/dom jsdom >/dev/null
mkdir -p src/components tests
cat > AGENT.md <<'EOF'
# Portfolio demo

A throwaway project to exercise BrainRouter federation across three
concurrent terminals.

## Stack

- Plain ESM TypeScript, no framework — a single HTML file with a few
  imported components.
- vitest for tests, jsdom for DOM assertions.
- Accessibility: every section must have a heading and an aria-label.

## Sections

1. Hero (name, tagline, CTA)
2. Projects (3 cards)
3. Contact (mailto link, accessible form labels)
EOF
```

### Step 1 — Terminal A (planner)

```
cd ~/code/portfolio-demo && brainrouter
```

```
> /goal Build the portfolio landing page per AGENT.md. Plan first; ship Hero, Projects, Contact in that order.
> Read AGENT.md, propose a file layout, and capture each architectural decision as a separate memory record.
```

The agent reads `AGENT.md`, proposes a layout, and calls
`memory_capture_turn` 3–4 times. **Look for** the `💾 Captured N records`
line in A's output. That's the data the other terminals are about to
see.

### Step 2 — Terminal B (implementer)

```
cd ~/code/portfolio-demo && brainrouter
```

Before typing a prompt:

```
> /briefing
```

**Look for** a `memory_recall` row in the source-stats table with 3+
records. Those are the architecture decisions A just wrote. You did
not paste them — federation did.

Sanity-check presence:

```
> /agents --remote
```

You should see **two** rows: A and B, same workspace path, heartbeat
< 30 s ago. (If you only see one, the persistent-key collision bug is
back — file an issue.)

Now implement, leaning on what's in memory:

```
> Implement src/components/hero.ts following the architecture decisions in memory. Just the Hero this round.
```

The agent writes `hero.ts` consistent with A's decisions — plain HTML,
no React, aria-label on the section — without you re-stating any of
those constraints.

### Step 3 — Terminal C (tester / watcher)

```
cd ~/code/portfolio-demo && brainrouter
```

```
> /goal Watch tests/landing.spec.ts and report failures back to A and B as they happen. Use /dm.
> Start `npx vitest run` once tests/landing.spec.ts exists; otherwise create a smoke test for the Hero based on the architecture decisions in memory.
```

C will recall the same decisions and write a vitest spec asserting
the `<h1>`, the aria-label, etc.

### Step 4 — Send a directed nudge (Stage 3)

In A:

```
> /agents --remote
# copy the 12-char prefix of C's session

> /dm <c-prefix> please also add an axe-core a11y test for the Hero and run it once.
```

**Look for in C** within ~5 s:

```
┌─ 📨 from <a-prefix>… (3s ago)
│ please also add an axe-core a11y test for the Hero and run it once.
└─
```

The Stage 3 inbox is informational today — C doesn't auto-react. The
banner is what the user reads to know the message arrived. (Auto-react
on inbound messages is a CLI Multi-Agent Phase 2 / Stage 4 follow-up.)

### Step 5 — Cost rollup + clean exit

```
> /agents --remote --usage --include-stale
```

Three rows, each with its own prompt/completion token counts and USD
total. If you ever wonder *"why did this 30-minute session cost
$1.40?"*, the answer is broken out per session.

Then in any terminal:

```
> /exit
```

Immediately run `/agents --remote` from one of the surviving terminals.
The exited session is **gone within a couple of seconds** — graceful
`session_unregister`, not 5 minutes later via the sweeper. That's the
per-process identity work.

### Bonus — brain restart recovery

In the brain terminal, Ctrl-C the `npm run dev:http` and immediately
restart it. From any CLI, run `/agents --remote`. The first call may
hang briefly while the transport detects the dead session-id; the
second works. The CLIs re-register transparently within ~30 s.

### What you proved works

| Capability | Step | Stage |
|---|---|---|
| Persona auto-injected into every CLI prompt | 1 — agent acts per your captured preferences | Persona (#60) |
| Memory written in A → recalled in B | 2's `/briefing` showing A's records | Stage 1 (#61) |
| Multi-terminal presence + per-session cost | 2's `/agents --remote`, 5's `--usage` | Stage 2 (#63) |
| Per-process identity (no terminal collision) | 2 shows **two** rows, not one | Stage 2 fix |
| Graceful unregister on `/exit` | 5's "gone within seconds" check | Stage 2 fix |
| Text wire between peers | 4's banner appearing in C | Stage 3 (#64) |
| Brain restart recovery | Bonus | Stage 2 fix |

### What's intentionally missing (and where it lands)

- **The recipient doesn't auto-react to a DM.** Stage 3 is a wire, not a workflow. A future change can let the agent loop treat inbound text as a prompt; today the banner is informational.
- **No `delegate_task("codex", …)`.** Stage 4 + CLI Multi-Agent Phase 2. The inbox `kind` enum already reserves `delegate` so when those land they ride the same wire.
- **Banner latency ≤ 5 s, not ≤ 250 ms.** SSE push deferred to 0.4.1.

## Privacy & scope

- **Scoped by `userId`.** A session only sees peers under the same
  BrainRouter userId. Two team members on the same brain don't see
  each other's CLIs unless they share a key.
- **No working-memory leak.** The registry stores `sessionKey`,
  `clientKind`, `workspaceRoot`, heartbeat timestamps, and the
  optional `usage` snapshot — nothing about the actual conversation,
  recalled memories, or tool calls. The federation surface is
  presence, not transcript-sharing.
- **`usage_json` is opt-in.** Hosts that don't report telemetry get a
  NULL there; the CLI populates it from the same shape that powers
  `/tokens` locally.
- **Heartbeats deliberately skip `operation_log`.** Per the audit
  volume guard — 30 s × N peers would explode the audit table without
  carrying useful provenance.

## Reference

### Stage 2 — presence

- MCP tools: `session_register`, `session_heartbeat`, `session_unregister`, `session_list`
  ([`brainrouter/src/tools/active_sessions.ts`](../brainrouter/src/tools/active_sessions.ts)).
- REST: `GET /api/sessions`
  ([`brainrouter/src/api/routes/sessions.ts`](../brainrouter/src/api/routes/sessions.ts)).
- SDK: `BrainRouterClient.getRemoteSessions()`.
- React hook: `useActiveSessions(client, { includeUsage, pollIntervalMs })`.
- Schema:
  [`brainrouter/src/memory/store/sqlite.ts`](../brainrouter/src/memory/store/sqlite.ts)
  — `active_sessions` table, composite PK `(session_key, user_id)`.
- Tests:
  [`active-sessions.test.ts`](../brainrouter/src/__tests__/active-sessions.test.ts) (MCP-tool unit),
  [`active-sessions.node-test.ts`](../brainrouter/src/__tests__/active-sessions.node-test.ts) (store integration).

### Stage 3 — messaging

- MCP tools: `session_send`, `session_inbox_read`, `session_inbox_ack`
  ([`brainrouter/src/tools/session_inbox.ts`](../brainrouter/src/tools/session_inbox.ts)).
- Schema: `session_inbox` table, indexed by `(user_id, to_session_key, created_at)`
  and `delivered_at`. Row mapper:
  [`brainrouter/src/memory/store/sqlite.ts`](../brainrouter/src/memory/store/sqlite.ts).
- CLI surfaces: `/dm`, `/broadcast`
  ([`brainrouter-cli/src/cli/commands/orchestration.ts`](../brainrouter-cli/src/cli/commands/orchestration.ts)).
- Incoming banner renderer:
  [`brainrouter-cli/src/cli/incomingBanner.ts`](../brainrouter-cli/src/cli/incomingBanner.ts).
- Inbox poller (5 s cadence, opt-in via `onInboxText`):
  [`brainrouter-cli/src/runtime/federationRegistration.ts`](../brainrouter-cli/src/runtime/federationRegistration.ts).
- Tests:
  [`session-inbox.test.ts`](../brainrouter/src/__tests__/session-inbox.test.ts) (MCP-tool unit),
  [`session-inbox.node-test.ts`](../brainrouter/src/__tests__/session-inbox.node-test.ts) (store integration with broadcast resolution + sweeper),
  [`incoming-banner.test.ts`](../brainrouter-cli/src/tests/incoming-banner.test.ts),
  [`federation-registration.test.ts`](../brainrouter-cli/src/tests/federation-registration.test.ts) (inbox poll lifecycle).
