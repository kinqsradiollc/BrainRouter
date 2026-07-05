# Automations — inbound triggers → autonomous agent jobs

*0.4.17 · the `triggers` subsystem (`packages/core/src/triggers/`) + desktop Settings → Automations.*

Automations turn **external events** (a GitHub label or `@mention`, a Slack
message, a GitLab/Jira webhook, a failing CI run) into **autonomous agent jobs**
that do the work and deliver it back as a draft PR + a comment on the thread
that asked. End-to-end, no human in the loop until PR review:

```
webhook delivery
  → signature verify (per provider, mandatory, fail-closed)
  → repo allowlist (owner/name globs; empty = accept-and-drop everything)
  → normalized TriggerEvent
  → resolver (label / @mention / CI-failure / rule match)
  → automation rules (.brainrouter/automations/*.md — on / when / do)
  → fleet job (the existing background queue, isolated worktree)
  → draft PR emitted on a passing build
  → comment back on the source issue/PR/thread (idempotent per delivery id)
```

Everything is **default-deny**: nothing listens until you opt in, the listener
binds loopback until you say otherwise, a provider with no signing secret
rejects every delivery (401 — never "let through"), and an empty repo
allowlist means events verify and then drop.

---

## Setup (desktop — Settings → Automations)

1. **Enable trigger ingress** — the master switch (`cli.triggers.enabled`).
2. **Signing secrets** — paste the webhook secret for each provider you use
   (GitHub / Slack / GitLab / Jira). Write-only: the UI shows only
   `configured` / `not set`, never the value. If blank, the matching
   connector's `webhookSecret` is used.
3. **Allowed repos** — add `owner/name` (globs like `owner/*` work). Only
   listed repos are processed.
4. **Behavior** — set the `@mention` handle the GitHub resolver reacts to
   (default `brainrouter`), and optionally turn on the **CI-failure nudge**
   (one idempotent offer-to-fix comment when CI fails on an open PR).
5. **Listener daemon → Start** — runs the webhook listener inside the desktop
   app while it's open. The same daemon runs headless from a terminal:
   `brainrouter serve --triggers` (identical gates and wiring).
6. Point the provider's webhook at
   `http://<your-endpoint>/triggers/{github|slack|gitlab|jira}/events`
   — see *Reachability* below for what `<your-endpoint>` is.

CLI equivalents: every knob lives under `cli.triggers.*` in
`~/.config/brainrouter/config.json`; `/automations` lists and toggles rules.

## Automation rules — `on` / `when` / `do`

Rules are markdown files in `<workspace>/.brainrouter/automations/*.md` —
committed with the repo, so the team shares them. Frontmatter declares the
match; the body is extra instructions injected into the spawned job:

```markdown
---
name: Fix labeled bugs
on: github.issue.labeled
when: label == 'bug'
do: build
enabled: true
---
Reproduce the bug first; add a regression test before fixing.
```

- **`on`** — `<provider>.<kind>` event name (e.g. `github.issue.labeled`,
  `github.workflow_run.completed`).
- **`when`** — a small safe expression over the event fields (`==`, `!=`,
  `&&`, `||`, dot-path field access; no eval). Empty = unconditional.
- **`do`** — `build` | `fix-ci` | `review` | `custom`.

The desktop lists every rule under Settings → Automations with an
enable/disable toggle (it rewrites the file's `enabled:` frontmatter).

## Are they fully automatic?

Yes — once the daemon is running with a rule (or the built-in label/@mention
resolver) enabled, the whole chain runs unattended: event → job → isolated
worktree → build/fix loop → **draft PR** → comment-back. The human enters at
PR review, by design. Two additional automatic surfaces need **no inbound
network at all**:

- **CI-failure nudge** (`cli.triggers.ciNudge`) — reacts to CI webhook events
  once ingress is up.
- **Suggested tasks** (desktop Tasks panel) — an *outbound* REST scan of your
  repos (failing checks, merge conflicts, reviews awaiting you, labeled
  issues) with one-click ready-to-run prompts. Works with zero listener setup.

## Reachability — what `127.0.0.1` means

The listener binds **loopback (`127.0.0.1:8787`) by default on purpose**: a
webhook receiver is an open network port, and exposing it must be your
explicit choice, not a default. Loopback means only processes on your machine
can reach it — GitHub cannot. Three ways to make it reachable:

1. **Tunnel (recommended for a laptop)** — keep the loopback bind and forward
   a public URL to it, e.g. `cloudflared tunnel --url http://127.0.0.1:8787`
   or `ngrok http 8787`, then use the tunnel URL in the provider's webhook
   config. Signature verification still protects you: only correctly-signed
   deliveries are accepted even on a public URL.
2. **LAN / server bind** — set *Bind host* to `0.0.0.0` (or a specific
   interface) on a machine that's reachable from the provider (self-hosted
   GitLab/Jira on your network, or a VPS running
   `brainrouter serve --triggers`). This is the explicit opt-out of loopback.
3. **No listener at all** — use the outbound surfaces (Suggested tasks panel,
   scheduled agents) if you don't want any inbound port.

## Security model (summary)

| Layer | Guarantee |
|---|---|
| Opt-in | `cli.triggers.enabled` must be explicitly `true`; the daemon refuses to start otherwise |
| Bind | Loopback unless the user names another host |
| Authenticity | Per-provider signature verification, timing-safe, fail-closed (no secret ⇒ every delivery 401) |
| Scope | `owner/name` glob allowlist; empty = nothing processed (202 that never leaks which repos exist) |
| Idempotency | Delivery-id redelivery cache — a re-sent webhook never double-spawns a job |
| Blast radius | Jobs run through the fleet queue in isolated worktrees; results arrive as *draft* PRs |
| Secrets | Signing secrets are write-only in the desktop (scrubbed from every renderer snapshot) |

## Design position

BrainRouter's automations run on a **self-hosted execution plane** with
**bring-your-own-provider** models. "Self-hosted" is about *where the work
runs*, not which model answers: the machine (or server) that holds your
workspaces, memory, and provider keys runs the listener, and jobs execute on
your own fleet queue in your own worktrees. The *model* behind each job is
whatever you configure — any OpenAI-compatible or native provider, **cloud
(OpenAI, Anthropic, Gemini, OpenRouter, …) or local (Ollama, LM Studio)** — so
"self-hosted" does not mean "local-only inference."

The trade-off versus CI-hosted responder bots (which run inside a CI
provider's infrastructure per event) is deliberate: your **code, workspace,
and orchestration** stay on your box (only the prompt/completion round-trip
goes to whatever model provider you chose), jobs reuse your warm local setup
and memory, and the compute/runtime cost is your own hardware (model tokens
are billed by your provider as usual). The price is the reachability step
above when the event source lives on the public internet.
