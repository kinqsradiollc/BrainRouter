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

## Stage 2 at a glance — what you get today

| Surface | What it shows |
|---|---|
| **`/agents --remote`** (CLI) | One-shot table of peer sessions: client kind, sessionKey prefix, last heartbeat age, workspace, optional usage. |
| **`/agents --remote --watch`** | Bounded re-poll: 10 ticks × 2 s ≈ 20 s, then auto-exits with a "re-run to keep watching" hint. The Ink REPL owns SIGINT, so we can't rely on Ctrl-C to break out — the bound is deliberate. |
| **`/agents --remote --usage`** | Adds TOKENS / USD columns sourced from each peer's `/tokens` snapshot. |
| **`/agents --remote --include-stale`** | Surfaces sessions whose last heartbeat is 2–5 min old (not yet swept). |
| **`/agents --remote --json`** | Pipe-friendly output for `jq` / status bars / CI. |
| **Live sessions widget** (dashboard Overview page) | Same data, polled every 10 s; tokens/USD column on by default. |

What Stage 2 deliberately **does not do yet**: send messages between
peers, hand off goals, or route delegated work across vendors. Those
are Stage 3 (`session_inbox`, `session_send`, broadcast) and Stage 4
(cross-vendor `delegate_task`), tracked in
[`FULL_TASKS.MD` §4.3](../FULL_TASKS.MD) and the post-0.4.0 plan.

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

- MCP tools: `session_register`, `session_heartbeat`, `session_list`
  ([`brainrouter/src/tools/active_sessions.ts`](../brainrouter/src/tools/active_sessions.ts)).
- REST: `GET /api/sessions`
  ([`brainrouter/src/api/routes/sessions.ts`](../brainrouter/src/api/routes/sessions.ts)).
- SDK: `BrainRouterClient.getRemoteSessions()`.
- React hook: `useActiveSessions(client, { includeUsage, pollIntervalMs })`.
- CLI runtime module:
  [`brainrouter-cli/src/runtime/federationRegistration.ts`](../brainrouter-cli/src/runtime/federationRegistration.ts).
- Schema:
  [`brainrouter/src/memory/store/sqlite.ts`](../brainrouter/src/memory/store/sqlite.ts)
  — `active_sessions` table, composite PK `(session_key, user_id)`.
- Tests:
  [`active-sessions.test.ts`](../brainrouter/src/__tests__/active-sessions.test.ts) (MCP-tool unit),
  [`active-sessions.node-test.ts`](../brainrouter/src/__tests__/active-sessions.node-test.ts) (store integration),
  [`federation-registration.test.ts`](../brainrouter-cli/src/tests/federation-registration.test.ts) (CLI lifecycle).
