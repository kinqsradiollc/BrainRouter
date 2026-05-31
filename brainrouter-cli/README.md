# `@kinqs/brainrouter-cli`

A memory-native terminal agent. Edits files, runs shell commands,
spawns child agents, and talks to a BrainRouter MCP server for long-term
recall, skills, and capture.

Ships the `brainrouter` binary.

## What you get

- **Memory-native recall** — every turn pulls relevant facts, focus scenes,
  persona, lessons, and skills from the connected BrainRouter MCP server.
- **Code retrieval** — `find_related` surfaces semantically related code
  chunks (lexical + symbol-graph + cross-file import edges); the index stays
  fresh as you read and edit.
- **Memory that learns** — captured `lesson` memories reinforce on repeat,
  skills are auto-extracted from successful sessions, and `reflect`
  synthesises higher-level patterns.
- **Multi-agent orchestration** — `spawn_agent` / `delegate` / `route_task`,
  worker threads, agent packs, durable `/workflows`, a transcript debugger,
  and a shared blackboard.
- **Graph intelligence** — PageRank / articulation-point / shortest-path
  analytics over the memory graph.
- **Exec policy** — readonly / workspace / trusted profiles gate shell,
  file writes outside the workspace, child-spawn, and network egress; inspect
  and switch with `/policy`.
- **LSP-backed navigation** — an incremental language-server client powers
  definition / reference lookups in supported languages.
- **Resilience** — post-edit verification, crash checkpoints, and an offline
  prompt queue that auto-replays on reconnect.

Type `/help` in the REPL for the full slash-command surface, or `/policy`,
`/workflows`, `/agents`, `/context` for the orchestration and observability
panels.

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
| Homebrew (`brew install node`) | No — global prefix is user-writable |
| nvm / asdf / fnm | No — same reason |
| System Node on macOS / Linux | Yes — global prefix is `/usr/local/...` |

Check yours: `npm config get prefix`. If the path is under `/Users/...`,
`/opt/homebrew/...`, or your home dir — no sudo. If it's `/usr/local/...` — use sudo.

Verify the install:

```bash
which brainrouter           # prints the path to the binary
brainrouter --version       # prints 0.4.5
```

## Configure

Run `brainrouter` for the first time and the **setup wizard** starts
automatically:

```
Welcome → Theme → Provider → API key → Model → MCP → AGENT.md → Done
```

It writes everything to `~/.config/brainrouter/config.json` — no manual
file editing needed.

To re-run the wizard later: type `/init` inside the REPL.

To change a single setting: use `/config <key> <value>` or the `/config`
home panel. To re-configure the MCP server connection: use `/login`.

For local-model setups (LM Studio / Ollama), point the LLM endpoint at
`http://localhost:1234/v1/chat/completions` or `http://localhost:11434/v1/chat/completions`.

**Runtime knobs** (sandbox, exec policy, trace log, web-search backend,
tool-loop limits, update check, post-edit verification, offline auto-replay,
LSP servers, auto-skill extraction) live under the `cli.*` block of
`config.json` — set them with `/config cli.<key> <value>` or by editing the
file. See
[`brainrouter-docs/configuration.md`](https://github.com/kinqsradiollc/BrainRouter/blob/main/brainrouter-docs/configuration.md)
for the full list.

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

**Offline mode** — if the MCP server isn't reachable, the CLI still boots
with only local tools (file edits, shell, web fetch, `spawn_agent`). Memory
recall, capture, and skills are disabled until the server is back. The
startup banner shows `offline` when this happens. Pass `--strict-mcp` to
make the CLI exit instead of degrading.

**Stdio mode** — to have the CLI spawn the MCP server as a child process
instead of running it separately: open `/config`, go to MCP settings, and
pick the bundled `stdio` profile. The CLI manages the server's lifecycle.

## Exec policy & trust

Every tool call — file edits, shell, child-agent spawns, network fetches — is
gated by one exec policy. Switch the whole posture with `/policy`:

| Profile | Access | Writes outside workspace | Shell | Sandbox |
|---|---|---|---|---|
| `readonly` | read-only | ❌ | ❌ | on |
| `workspace` | full, file tools confined to the workspace | ❌ | ✅ | on |
| `trusted` | full | ✅ | ✅ | off |

```bash
/policy            # show current access mode, sandbox, egress allowlist + profiles
/policy readonly   # apply a profile
```

Individual knobs (`cli.externalDirWrites`, `cli.egressAllowlist`,
`cli.sandbox`) live under `cli.*` in `config.json`. Full reference:
[`brainrouter-docs/policy.md`](https://github.com/kinqsradiollc/BrainRouter/blob/main/brainrouter-docs/policy.md).

## Workspace detection

By default, the CLI uses the nearest project root with `AGENT.md`,
`AGENTS.md`, or `.git`. Override with:

```bash
brainrouter --workspace /absolute/path/to/project
# or
BRAINROUTER_WORKSPACE=/absolute/path/to/project brainrouter
```

Inside the REPL, run `/workspace` to confirm the active root and session key.

## What you also probably want

A BrainRouter MCP server for the cognitive memory. The CLI works without
it (offline mode) but you lose recall, capture, and skills:

```bash
npm install -g @kinqs/brainrouter-mcp-server
brainrouter-mcp init                              # one-time: scaffold ~/.config/brainrouter/server.env
$EDITOR ~/.config/brainrouter/server.env          # set BRAINROUTER_LLM_API_KEY, embeddings, etc.
brainrouter-mcp --http --port 3747                # in a separate terminal
```

Then run `/login` inside the REPL and point at `http://localhost:3747/mcp`.

## Docs

- **Repo**: <https://github.com/kinqsradiollc/BrainRouter>
- **Memory engine deep-dive**: [BRAINROUTER.md](https://github.com/kinqsradiollc/BrainRouter/blob/main/BRAINROUTER.md)
- **Maintainer runbook**: [SETUP.md](https://github.com/kinqsradiollc/BrainRouter/blob/main/SETUP.md)
- **Bugs / requests**: <https://github.com/kinqsradiollc/BrainRouter/issues>

## License

MIT
