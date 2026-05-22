# `@kinqs/brainrouter-cli`

A memory-native terminal agent. Edits files, runs shell commands,
spawns child agents, and talks to a BrainRouter MCP server for long-term
recall, skills, and capture.

Ships the `brainrouter` binary.

---

## Install

```bash
npm install -g @kinqs/brainrouter-cli
```

**The `-g` flag is critical.** Without it, npm installs into the current
directory's `node_modules/` and the `brainrouter` binary ends up at
`./node_modules/.bin/brainrouter` — not on `$PATH`. Symptom: `brainrouter:
command not found`.

**Sudo caveat.** Whether you need `sudo` depends on your Node install:

| How Node is installed | Use `sudo`? |
|---|---|
| Homebrew (`brew install node`) | ❌ No — global prefix is user-writable |
| nvm / asdf / fnm | ❌ No — same reason |
| System Node on macOS / Linux | ✅ Yes — global prefix is `/usr/local/...` |

Check yours:

```bash
npm config get prefix
```

If the path is under `/Users/...`, `/opt/homebrew/...`, or your home dir
→ no sudo. If it's `/usr/local/...` → use sudo.

Verify the install:

```bash
which brainrouter           # prints the path to the binary
brainrouter --version       # prints 0.3.5
```

---

## Configure

Two configuration surfaces, both one-time:

### 1. The chat LLM and MCP server profile

```bash
brainrouter config          # interactive — set LLM provider, model, key, endpoint
brainrouter login           # interactive — set MCP server URL + API key
```

Both write to `~/.config/brainrouter/config.json`.

For local-model setups (LM Studio / Ollama), point the LLM endpoint at
`http://localhost:1234/v1/chat/completions` or `http://localhost:11434/v1/chat/completions`.

### 2. (Optional) Runtime knobs — `~/.config/brainrouter/cli.env` or `./brainrouter-cli.env`

Only needed if you want to tune sandbox, tool-loop limits, trace logging,
or web-search backend. See the [`.env.example`](.env.example) bundled with
this package for the full list. LLM credentials do **not** go here — they
live in `config.json`.

---

## Run

```bash
brainrouter                 # starts the interactive REPL
brainrouter chat            # same — `chat` is the default subcommand
brainrouter run "summarize the changes in src/"   # one-shot non-interactive
brainrouter agents          # list child agent sessions in this workspace
```

Inside the REPL, type `/help` for the full slash-command list (60+
commands across session / memory / workflow / orchestration / observability
surfaces).

### Offline mode

If the MCP server isn't reachable, the CLI still boots — but only local
tools (file edits, shell, web fetch, `spawn_agent`) work. Memory recall,
capture, and skills are disabled until the server is back. The startup
banner shows `⚠️  OFFLINE MODE` when this happens. Pass `--strict-mcp` to
make the CLI exit instead of degrading.

### Stdio mode

If you'd rather have the CLI spawn the MCP server as a child process
instead of running it separately, use `brainrouter config` → "Set Active
Server Profile" → `default` (the bundled stdio profile). You don't need
to run anything else — the CLI manages the server's lifecycle.

---

## Workspace detection

By default, the CLI uses the nearest project root with `AGENT.md`,
`AGENTS.md`, or `.git`. Override with:

```bash
brainrouter --workspace /absolute/path/to/project
# or
BRAINROUTER_WORKSPACE=/absolute/path/to/project brainrouter
```

Inside the REPL, run `/workspace` to confirm the active root and session key.

---

## What you also probably want

A BrainRouter MCP server for the cognitive memory. The CLI works without
it (offline mode) but you lose recall, capture, and skills:

```bash
npm install -g @kinqs/brainrouter-mcp-server
brainrouter-mcp init                              # one-time: scaffold ~/.config/brainrouter/server.env
$EDITOR ~/.config/brainrouter/server.env          # set BRAINROUTER_LLM_API_KEY, embeddings, etc.
brainrouter-mcp --http --port 3747                # in a separate terminal
```

Then `brainrouter login` and point at `http://localhost:3747/mcp`.

---

## Docs

- **Repo**: <https://github.com/kinqsradiollc/BrainRouter>
- **Memory engine deep-dive**: [BRAINROUTER.md](https://github.com/kinqsradiollc/BrainRouter/blob/main/BRAINROUTER.md)
- **Maintainer runbook**: [SETUP.md](https://github.com/kinqsradiollc/BrainRouter/blob/main/SETUP.md)
- **Bugs / requests**: <https://github.com/kinqsradiollc/BrainRouter/issues>

---

## License

MIT
