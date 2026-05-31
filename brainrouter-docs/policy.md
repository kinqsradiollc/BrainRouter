# Exec policy & the trust model

BrainRouter's CLI gates **every** tool call — local file edits, shell,
child-agent spawns, network fetches, MCP calls — through one execution policy
(POLICY-1/2/3, 0.4.4). The policy is the single answer to *"is the agent
allowed to do this right now?"*. This page is the reference for what each knob
does and how the bundled profiles compose them.

The decision primitives live in
[`execPolicy.ts`](../brainrouter-cli/src/runtime/execPolicy.ts); the curated
bundles in
[`policyProfiles.ts`](../brainrouter-cli/src/runtime/policyProfiles.ts).
Inspect or switch the live posture with `/policy` (see below).

## The knobs

| Knob | Values | What it gates |
|---|---|---|
| **Access mode** | `read` · `write` · `shell` | The capability ceiling. `read` = read-only tools only. `write` = adds file edits + child-agent spawns. `shell` = adds command execution. |
| **Sandbox** | `on` · `off` | Whether shell commands run inside the OS sandbox wrapper (when available). |
| **External-dir writes** | `deny` · `ask` · `allow` | Whether the structured file tools (`write_file` / `edit_file` / `apply_patch`) may write **outside** the workspace root. Path containment is enforced by realpath, so symlink escapes are caught. |
| **Egress allowlist** | list of hosts (`[]` = unrestricted) | Per-host gate on outbound `fetch_url`. An **empty** list means all hosts are permitted; a non-empty list denies any host not on it. |

How a given tool maps to a gated action:

| Action kind | Tools | Allowed when |
|---|---|---|
| `read_only` | recall/MCP reads, `wait_*`, `list_agents`, `route_task`, `read_agent_transcript`, observation tools | always |
| `file_edit` | `write_file`, `edit_file`, `apply_patch` | access mode `write` or `shell` (+ external-dir gate for out-of-workspace paths) |
| `child_write` | `spawn_agent(s)`, `spawn_worker_thread`, `task_agent`, `delegate_*` | access mode `write` or `shell` |
| `shell` | `run_command` (and the `!` escape) | access mode `shell` only |
| `network` | `fetch_url` | always (then filtered by the egress allowlist) |
| `bg` | detaching a turn | always (detachment doesn't change capability) |

> Note: `network`/MCP calls are **not** access-mode gated — recall and capture
> work in every mode — but `fetch_url` is still subject to the egress
> allowlist. And `shell` is a deliberately separate trust from file writes: a
> shell can write anywhere, so `workspace` keeps shell available while still
> confining the *structured* file tools to the workspace.

## Bundled profiles

Apply a whole posture in one move with `/policy <name>`:

| Profile | Access mode | File edits (in workspace) | File writes (outside workspace) | Shell | Child spawn / delegate | Sandbox | Network egress |
|---|---|---|---|---|---|---|---|
| **readonly** | `read` | ❌ denied | ❌ denied | ❌ denied | ❌ denied | on | unrestricted¹ |
| **workspace** | `shell` | ✅ allowed | ❌ denied | ✅ allowed | ✅ allowed | on | unrestricted¹ |
| **trusted** | `shell` | ✅ allowed | ✅ allowed | ✅ allowed | ✅ allowed | off | unrestricted¹ |

¹ All three profiles ship with an **empty** egress allowlist (unrestricted).
Egress is an independent knob — set `cli.egressAllowlist` in `config.json` (or
via `/config cli.egressAllowlist …`) to confine outbound fetches under any
profile.

- **readonly** — investigation only. No file writes, no shell, no child spawns.
  Safe for untrusted repos or "look, don't touch" sessions.
- **workspace** *(default-friendly)* — full capability, but the structured file
  tools are confined to the workspace root; writes outside are denied. Shell is
  available (and can of course write anywhere — that's the explicit trust you
  grant by allowing shell).
- **trusted** — full capability with external-directory writes allowed and the
  sandbox off. Use only in environments you fully control.

## Inspecting & switching at runtime

```text
/policy            # show the current access mode, sandbox, external-write
                   # mode, egress allowlist, and the available profiles
/policy readonly   # apply the readonly profile
/policy workspace  # apply the workspace profile
/policy trusted    # apply the trusted profile
```

Individual knobs are also settable without switching profiles — they all live
under `cli.*` in `config.json`:

```text
/config cli.externalDirWrites ask
/config cli.egressAllowlist api.openai.com,api.anthropic.com
/config cli.sandbox on
```

See [configuration.md](configuration.md) for the full `cli.*` knob list.
