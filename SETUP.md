# BrainRouter — Setup & Operations Guide

Operational runbook for the maintainer. **First-time setup, daily run,
upgrade, publish, and recovery — everything in one file.** Skim the
table of contents and jump to the section you need.

For end-user install (`npm install -g @brainrouter/cli`), see
[README.md](README.md). For architecture, see
[BRAINROUTER.md](BRAINROUTER.md). For env-var reference, see
[brainrouter-docs/configuration.md](brainrouter-docs/configuration.md).

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [First-time setup](#2-first-time-setup)
3. [Daily run](#3-daily-run)
4. [Upgrading (pull new code)](#4-upgrading-pull-new-code)
5. [Publishing a new release to npm](#5-publishing-a-new-release-to-npm)
6. [Troubleshooting](#6-troubleshooting)
7. [Nuclear options (reset state)](#7-nuclear-options-reset-state)

---

## 1. Prerequisites

| Tool | Min version | How to check | Why |
|---|---|---|---|
| Node.js | 22 | `node -v` | SQLite (`node:sqlite`), `fetch`, `--test` runner |
| npm | 10 | `npm -v` | workspaces, `publishConfig`, `prepack` |
| git | any | `git --version` | clone, branches, tags |
| LM Studio | latest | open the app | local LLM endpoint at `http://localhost:1234/v1` (or use a cloud key instead) |

Optional but recommended:
- **`gh`** (GitHub CLI) — for tagging releases and creating PRs.
- **An OpenAI-compatible API key** — OpenRouter, OpenAI, or Anthropic — if
  you don't want to run a local model in LM Studio.

---

## 2. First-time setup

You'll do this once per machine. It produces a working CLI that can talk
to a local MCP server you also just started.

### 2.1 Clone and build

```bash
git clone https://github.com/kinqsradiollc/BrainRouter.git
cd BrainRouter
npm install
npm run build
```

`npm run build` walks every workspace (`brainrouter`, `brainrouter-cli`,
`brainrouter-dashboard`, `packages/*`). Expect 30–60 seconds the first
time. If the dashboard build complains about a missing port, ignore it —
it only matters at runtime.

### 2.2 Configure the MCP server — `brainrouter/.env`

```bash
cp brainrouter/.env.example brainrouter/.env
$EDITOR brainrouter/.env
```

Minimum fields to set:

```bash
# Cognitive extraction LLM (any OpenAI-compatible endpoint)
BRAINROUTER_LLM_API_KEY=sk-...
BRAINROUTER_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
BRAINROUTER_LLM_MODEL=gpt-4o-mini

# Embeddings — required for vector recall
BRAINROUTER_EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
BRAINROUTER_EMBEDDING_MODEL=text-embedding-3-small
BRAINROUTER_EMBEDDING_DIMENSIONS=1536

# Server auth — change before exposing the server
BRAINROUTER_ADMIN_PASSWORD=change_me_before_use
BRAINROUTER_JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

**Local-model alternative** (LM Studio / Ollama):

```bash
BRAINROUTER_LLM_ENDPOINT=http://localhost:1234/v1/chat/completions
BRAINROUTER_LLM_MODEL=google/gemma-4-e2b   # whatever LM Studio is serving
BRAINROUTER_LLM_API_KEY=sk-local            # LM Studio ignores the value but needs one
```

Everything else (reranker, prewarming, sweep intervals, JWT lifetime) is
commented inline in `.env.example` and safe to leave at defaults.

### 2.3 Configure the CLI — `~/.config/brainrouter/config.json`

The CLI's chat LLM and MCP connection live in `config.json`, **not in
`.env`**. Use the interactive setup:

```bash
# Set up the chat LLM (provider, model, endpoint, API key)
node brainrouter-cli/dist/index.js config

# Point at the MCP server (HTTP transport, default port 3747)
node brainrouter-cli/dist/index.js login
```

`config` walks you through choosing OpenAI / Anthropic / local. `login`
asks for the MCP URL (defaults to `http://localhost:3747/mcp`) and an
API key (any non-empty string is fine for a local dev server until you
set `BRAINROUTER_ADMIN_PASSWORD` and rotate).

To inspect what got saved:

```bash
cat ~/.config/brainrouter/config.json
```

You should see an `llm` block (provider, apiKey, model, endpoint) plus
at least one server profile under `servers` and an `activeServer` field.

### 2.4 Verify

```bash
# Terminal A — start the MCP server (cognitive memory engine)
cd brainrouter && npm run start:http

# Terminal B — start the CLI in another terminal
cd /path/to/BrainRouter
npm run cli
```

Expected CLI banner:

```
🧠 BRAINROUTER TERMINAL AGENT CLIENT v0.3.4
Midnight Ledger / Obsidian Surface theme active.
Workspace root: /path/to/your/project
brainrouter[shell]>
```

If you see `⚠️  OFFLINE MODE`, the CLI couldn't reach the MCP server.
Jump to [§6 Troubleshooting](#6-troubleshooting).

Sanity-check from inside the REPL:

```
/doctor       # config, connectivity, memory-extraction health
/status       # active server, LLM config, DB stats
/tools        # local + MCP tools the agent can call
```

Setup is done.

---

## 3. Daily run

You almost always need **two terminals** open: one for the MCP server,
one for the CLI. Optionally a third for the dashboard.

### 3.1 Start the MCP server (Terminal A)

```bash
cd brainrouter
npm run start:http   # HTTP on :3747
```

Leave it running. The server writes logs to stderr.

Alternative — stdio mode (CLI spawns the server as a child instead):
switch `activeServer` in `~/.config/brainrouter/config.json` to a stdio
profile (the default one is `default`). The CLI will spawn
`node brainrouter/dist/index.js` itself; you don't run anything in
Terminal A. **Tradeoff:** stdio dies when the CLI dies, so memory state
isn't shared across CLI restarts.

### 3.2 Start the CLI (Terminal B)

```bash
npm run cli                                  # from repo root
# OR
node brainrouter-cli/dist/index.js          # equivalent
```

Inside the REPL:

| Command | Use |
|---|---|
| `/help` | Full slash-command reference. |
| `/doctor` | Validate everything is wired up. |
| `/permissions [read\|write\|shell]` | Adjust agent access level (default: `shell`). Shift+Tab cycles. |
| `/tools` | What tools the agent has loaded this turn. |
| `/memory <q>` / `/recall <q>` | Search long-term memory. |
| `/scenes` / `/working` / `/briefing` | Inspect cognitive state. |
| `/spawn <role> <prompt>` | Delegate to a child agent. |
| `/yolo on` | Auto-approve `run_command` shell calls. |
| `/exit` | Quit cleanly. |

### 3.3 (Optional) Start the dashboard (Terminal C)

```bash
cd brainrouter-dashboard
npm install   # only the first time
npm run dev   # Next.js dev server on :3000
```

Open <http://localhost:3000>. Surfaces: `/chat` for hosted chat,
`/memories`, `/scenes`, `/contradictions`, `/recall-inspector`,
`/working-memory`, `/timeline`, `/persona`, `/hooks`, `/users`,
`/profile`.

Log in with the admin email/password you set in
`brainrouter/.env`'s `BRAINROUTER_ADMIN_EMAIL` / `BRAINROUTER_ADMIN_PASSWORD`.

### 3.4 Stop everything

`Ctrl-C` in each terminal. The MCP server flushes pending writes to
`~/.brainrouter/memory.db` cleanly.

---

## 4. Upgrading (pull new code)

When you pull a change from `main` (or someone else does), follow this
sequence. The build script clears `dist/` so stale artifacts can't
linger.

```bash
git pull
npm install      # picks up any new workspace deps
npm run build    # rebuild every workspace
```

If you had the MCP server or CLI running, stop them with `Ctrl-C` and
restart them — neither has a hot-reload watcher in production mode.

If you want to develop against the MCP server with live reload, use
`npm run dev:http` in `brainrouter/` instead of `npm run start:http` —
that uses `tsx watch` and restarts on save.

### 4.1 Schema migrations

The MCP server runs SQLite migrations automatically on startup. If a
migration fails, the server refuses to start with a loud error. To
diagnose:

```bash
node -e "const db = require('node:sqlite').DatabaseSync; const d = new db(process.env.HOME + '/.brainrouter/memory.db'); console.log(d.prepare('SELECT version FROM migration_state').all());"
```

If you need to nuke the DB and re-migrate from scratch, see
[§7 Nuclear options](#7-nuclear-options-reset-state).

---

## 5. Publishing a new release to npm

We publish 4 packages: [`@brainrouter/cli`](https://www.npmjs.com/package/@brainrouter/cli),
[`@brainrouter/mcp-server`](https://www.npmjs.com/package/@brainrouter/mcp-server),
[`@brainrouter/sdk`](https://www.npmjs.com/package/@brainrouter/sdk),
[`@brainrouter/types`](https://www.npmjs.com/package/@brainrouter/types).
The dashboard and React hooks stay private.

### 5.1 Pre-flight

```bash
# Make sure main is clean and current
git status
git pull

# Run the full test suite
cd brainrouter-cli && npm test && cd ..
cd brainrouter      && npm test && cd ..   # (when MCP tests exist)

# Rebuild every workspace from clean dist
npm run build
```

All three must be green before continuing.

### 5.2 Bump versions

Choose a version per [semver](https://semver.org/):

- **Patch** (`0.3.4 → 0.3.5`) — bug fixes, no breaking changes.
- **Minor** (`0.3.4 → 0.4.0`) — new features, backward-compatible.
- **Major** (`0.3.4 → 1.0.0`) — breaking API changes.

Update **every** `package.json` AND the hardcoded version strings in
source. There are 7 `package.json` files and 5 source-code references:

```bash
# 7 package.json files
brainrouter/package.json
brainrouter-cli/package.json
brainrouter-dashboard/package.json
packages/hooks/package.json
packages/sdk/package.json
packages/types/package.json
package.json                    # the monorepo root

# 5 source-code references
brainrouter-cli/src/index.ts            # `.version('0.3.X')`
brainrouter-cli/src/runtime/mcpClient.ts # client metadata
brainrouter-cli/src/cli/repl.ts          # banner string
brainrouter-cli/src/agent/agent.ts       # 2× User-Agent strings
brainrouter/src/index.ts                 # MCP server metadata
```

Also bump the workspace-dep version pins in the 4 publishable packages —
e.g. `"@brainrouter/types": "^0.3.4"` → `"^0.3.5"` — so a fresh install
from npm pulls the right inter-package versions.

Quick sanity grep to catch stragglers:

```bash
grep -rn "0\.3\.4" brainrouter brainrouter-cli packages --include="*.ts" --include="*.json" | grep -v node_modules | grep -v dist
```

### 5.3 Update CHANGELOG and ROADMAP

Add a `## [X.Y.Z] - YYYY-MM-DD` section to [CHANGELOG.md](CHANGELOG.md)
with the user-facing changes. Move the "Up Next" line into "Recently
Completed" in [ROADMAP.md](ROADMAP.md) if the release ships something
listed there.

### 5.4 Dry-pack and inspect

```bash
# Per package — confirm size and file list before publishing for real
cd packages/types && npm pack --dry-run 2>&1 | grep "npm notice"
cd ../sdk         && npm pack --dry-run 2>&1 | grep "npm notice"
cd ../../brainrouter      && npm pack --dry-run 2>&1 | grep "npm notice"
cd ../brainrouter-cli     && npm pack --dry-run 2>&1 | grep "npm notice"
```

Look for:
- Right `name`, `version`, `filename`.
- No `*.test.*` files (CLI has a `prepack` hook that strips them).
- No `.env`, `node_modules/`, or stray credentials.
- Sensible package size — CLI ≈ 170 kB, MCP ≈ 450 kB, sdk/types tiny.

### 5.5 Publish in dependency order

```bash
npm login              # one-time per session
npm whoami             # confirm you're authenticated as the right user
```

**Two zsh gotchas — read before you paste the publish commands:**

1. **Inline `#` comments don't work in zsh interactive mode.** zsh treats
   `# anything` as positional args, not a comment, unless you've enabled
   `setopt interactive_comments` (not the default). The commands below
   deliberately have NO inline comments — paste them as-is.
2. **2FA is required.** The `@brainrouter` scope expects a TOTP code per
   publish (mode `auth-and-publish`). Either pass `--otp=XXXXXX` on each
   command (paste a fresh code from your authenticator each time), or
   omit the flag and npm will prompt interactively.

```bash
# From the monorepo root. Run one at a time, fresh OTP per command.
cd packages/types && npm publish --otp=PASTE_CODE
cd ../sdk && npm publish --otp=PASTE_CODE
cd ../../brainrouter && npm publish --otp=PASTE_CODE
cd ../brainrouter-cli && npm publish --otp=PASTE_CODE
```

The order matters because each package's `dependencies` reference real
semver of the prior ones; publishing in dependency order guarantees the
registry resolves cleanly.

Each `package.json` has `publishConfig.access: public` (required because
`@brainrouter/*` is a scoped namespace — npm defaults scoped packages to
restricted). You don't need `--access public` on the command line.

#### 5.5.1 Avoiding the per-publish OTP friction

Two options to skip the OTP prompts:

**Option A — switch 2FA to `auth-only` mode** (one OTP per login, then
publishes use the cached session):

```bash
npm profile set otp-mode auth-only --otp=PASTE_CODE
```

**Option B — granular access token with 2FA bypass** (best for
CI/automation). At <https://www.npmjs.com/settings/YOUR_USERNAME/tokens>
create a token with:

- Permissions: **Read and write**
- Packages scope: **`@brainrouter/*`**
- "Bypass 2FA for this token": **✓**

Then:

```bash
export NPM_TOKEN=npm_...        # or store in ~/.npmrc with //registry.npmjs.org/:_authToken=...
# Now `npm publish` works with no OTP prompt
```

### 5.6 Tag and push

```bash
git add -A
git commit -m "release: 0.3.X"
git tag "v0.3.X"
git push
git push --tags
```

If you use the GitHub CLI:

```bash
gh release create "v0.3.X" --title "0.3.X" --notes-from-tag
```

### 5.7 Verify it landed

```bash
npm view @brainrouter/cli version            # should print the new version
npx @brainrouter/cli@latest --version        # smoke test
```

### 5.8 Rolling back a bad publish

npm allows unpublishing within 72 hours, but it breaks anyone who already
pulled. Prefer publishing a patch over a deprecation:

```bash
# Bump patch, fix the bug, re-publish — preferred path
npm version patch && npm publish

# Last resort within 72h, if no users yet
npm unpublish @brainrouter/cli@0.3.X
```

After 72 hours `npm deprecate @brainrouter/cli@0.3.X "reason"` is the
right move.

---

## 6. Troubleshooting

### 6.1 "Failed to connect to MCP server: fetch failed"

The CLI couldn't reach the MCP server on the configured profile. Causes,
in order of likelihood:

1. **MCP server isn't running.** Start it: `cd brainrouter && npm run start:http`.
2. **Wrong port.** Check `~/.config/brainrouter/config.json` — the
   `local-http` profile should point at `http://localhost:3747/mcp`.
3. **Port conflict.** `lsof -i :3747` to see what's holding it. Stop
   the offender or change the port via `BRAINROUTER_PORT=…` and update
   the profile URL.
4. **You wanted offline mode anyway.** The CLI keeps running with local
   tools only — that's intentional. Pass `--strict-mcp` if you'd rather
   the CLI exit hard.

### 6.2 "💾 Captured turn → 0 cognitive records extracted"

The MCP child is alive but its cognitive extractor isn't running. Almost
always means the LLM API key didn't reach the child process.

```bash
# Check that brainrouter/.env has a real value
grep BRAINROUTER_LLM_API_KEY brainrouter/.env

# Restart the MCP server so it picks up the .env change
# (Ctrl-C in Terminal A, then `npm run start:http` again)
```

If you're using a local model (LM Studio), make sure LM Studio is
actually running and serving the model named in `BRAINROUTER_LLM_MODEL`.

### 6.3 "Tool list_dir completed: …" but no output visible

Small chat models sometimes forget to echo content. The CLI now renders
a short preview for `list_dir`, `grep_search`, `glob_files` regardless.
If you want full output, just ask the agent: "show me the result of
that list_dir verbatim."

### 6.4 Dashboard login fails with "Invalid credentials"

The seeded admin lives at `BRAINROUTER_ADMIN_EMAIL` /
`BRAINROUTER_ADMIN_PASSWORD` in `brainrouter/.env`. If you changed the
.env after first boot, the existing DB still has the old admin row.
Reset it:

```bash
cd brainrouter
node scripts/setup-admin.js --reset --email <new-email>
```

### 6.5 "EADDRINUSE: address already in use :::3747"

Another MCP server (or another process) is on that port. Find and stop
it, or pick a different port:

```bash
lsof -i :3747            # see what's there
kill <PID>               # stop it cleanly
# OR
BRAINROUTER_PORT=3748 npm run start:http   # use a different port
# then update ~/.config/brainrouter/config.json → servers.local-http.url
```

### 6.6 Workspace deps fail to resolve after `git pull`

Symptoms: `Cannot find module '@brainrouter/sdk'` or similar. Solution:

```bash
npm install           # rebuilds the workspace symlink tree
npm run build         # rebuild dist trees so the symlinks have targets
```

If still broken:

```bash
rm -rf node_modules package-lock.json
npm install
npm run build
```

### 6.7 Tests fail with "Cannot find module 'dist/agent.test.js'"

The build cleared dist but the test runner can't see fresh artifacts.
Re-run the test (which builds + runs):

```bash
cd brainrouter-cli && npm test
```

---

## 7. Nuclear options (reset state)

Use only when nothing else has worked. **These delete data.** Back up
first if you care.

### 7.1 Reset the CLI's local config

```bash
rm -rf ~/.config/brainrouter
# Re-run brainrouter-cli/dist/index.js login + config to recreate
```

### 7.2 Reset cognitive memory (memory.db)

```bash
# Stops everything, then nukes the SQLite database
rm ~/.brainrouter/memory.db
# Restart the MCP server — it'll re-run migrations and seed a fresh admin
cd brainrouter && npm run start:http
```

You lose all captured memories, focus scenes, contradictions, persona,
and skill prewarming history.

### 7.3 Reset per-workspace CLI state

CLI state lives at `~/.brainrouter/workspaces/<encoded-path>/cli/` — one
folder per project. Each has `tasks.json`, transcripts, goal state.

```bash
# Nuke a specific workspace
rm -rf ~/.brainrouter/workspaces/<encoded-path>

# OR nuke all CLI workspace state
rm -rf ~/.brainrouter/workspaces
```

The next CLI launch re-creates the folder for whatever workspace you
start in. You lose plan history, session transcripts, and goal state.

### 7.4 Re-bootstrap the whole stack

```bash
# From repo root
git pull
rm -rf node_modules package-lock.json
rm -rf brainrouter/dist brainrouter-cli/dist packages/*/dist
rm -rf brainrouter-dashboard/.next brainrouter-dashboard/node_modules
rm ~/.brainrouter/memory.db
rm -rf ~/.config/brainrouter

npm install
npm run build

cp brainrouter/.env.example brainrouter/.env
# Re-edit brainrouter/.env (§2.2)
# Re-run config + login (§2.3)
```

This is the closest you can get to "uninstall + reinstall" without
touching `~/.brainrouter/` data you might want to keep. If you also want
to drop the global state directory:

```bash
rm -rf ~/.brainrouter
```

That removes the SQLite DB, all workspace state, every cached persona,
and the migration state. The next MCP start re-creates it.

---

## Appendix: ports and paths

| Port | What | Configurable via |
|---|---|---|
| 3747 | MCP HTTP server | `BRAINROUTER_PORT` |
| 3000 | Dashboard (Next.js) | `next.config.ts` / env |
| 1234 | LM Studio (if local) | LM Studio app settings |

| Path | What |
|---|---|
| `~/.config/brainrouter/config.json` | CLI's chat LLM + MCP server profiles |
| `~/.brainrouter/memory.db` | SQLite cognitive memory store |
| `~/.brainrouter/workspaces/<encoded>/cli/` | Per-workspace CLI state (tasks, transcripts, goals) |
| `brainrouter/.env` | MCP server config (cognitive engine LLM, embeddings, auth) |
| `brainrouter-cli/.env` (optional) | CLI runtime knobs (sandbox, trace, web-search) |
| `<workspace>/.brainrouter/cli/workflows/` | Durable spec/tasks/walkthrough artifacts |
| `<workspace>/.brainrouter/cli/sessions/` | Session transcripts (committable) |

---

## Appendix: useful one-liners

```bash
# Tail MCP server logs while it's running
cd brainrouter && npm run start:http 2>&1 | tee mcp.log

# Run a single agent turn non-interactively
node brainrouter-cli/dist/index.js run "summarize the changes in src/"

# List child agent sessions in this workspace
node brainrouter-cli/dist/index.js agents

# Inspect the SQLite memory.db
sqlite3 ~/.brainrouter/memory.db ".tables"
sqlite3 ~/.brainrouter/memory.db "SELECT COUNT(*) FROM cognitive_records;"

# Tail the trace log (if BRAINROUTER_TRACE_LOG is set)
tail -f $BRAINROUTER_TRACE_LOG

# Test that a chat-completion endpoint is alive
curl -s $BRAINROUTER_LLM_ENDPOINT -H "Authorization: Bearer $BRAINROUTER_LLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$BRAINROUTER_LLM_MODEL"'","messages":[{"role":"user","content":"hi"}]}' | head -c 500
```
