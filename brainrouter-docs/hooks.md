# Hooks — authoring reference

BrainRouter has two hook subsystems, both per-workspace, both editable
by hand:

| Subsystem | Format | Where it lives | What it does |
| --- | --- | --- | --- |
| **Shell hooks** | JSON | `~/.brainrouter/workspaces/<encoded>/cli/hooks.json` | Runs a shell command at a lifecycle event. `pre-tool` exit != 0 blocks the call. |
| **Hookify rules** | Markdown + YAML frontmatter | `~/.brainrouter/workspaces/<encoded>/hooks/<slug>.md` | No-code matcher over tool args; `warn` surfaces a message, `block` denies the call. |

`<encoded>` is `<workspace-basename>-<sha1[0:8]>` — the CLI prints it on
startup. Pre-2026-05-21 builds kept both stores under
`<workspace>/.brainrouter/`; the first run auto-migrates them.

The slash commands `/hooks` and `/hookify` are the ergonomic front door,
but the on-disk format is stable and meant to be hand-edited or
committed to a dotfiles repo.

---

## Lifecycle events

Shell-hook events (from
[`hooksStore.ts`](../brainrouter-cli/src/state/hooksStore.ts)):

| Event | When it fires | Can block? |
| --- | --- | --- |
| `pre-tool` | Before every tool call. | **Yes** — non-zero exit denies the call. |
| `post-tool` | After a tool returns. | No. |
| `pre-turn` | Before each LLM turn. | No. |
| `post-turn` | After the assistant's final message of a turn. | No. |
| `session-start` | CLI startup. | No. |
| `session-end` | CLI shutdown. | No. |

Hookify events (from
[`hookifyStore.ts`](../brainrouter-cli/src/state/hookifyStore.ts)) are
**tool-shaped**, not lifecycle:

| Event | Triggered by tool | Fields exposed to conditions |
| --- | --- | --- |
| `bash` | `run_command` | `command` |
| `file` | `write_file`, `edit_file`, `apply_patch` | `file_path`, `content` / `new_text`, `old_text` |
| `prompt` | Each user prompt | `user_prompt` |
| `stop` | End of turn | `transcript` |
| `all` | Any of the above | (whatever the source provided) |

---

## Shell hooks — `hooks.json`

Top-level shape:

```json
{
  "hooks": [
    {
      "id": "hook_lq3p_a1b2",
      "event": "pre-tool",
      "command": "scripts/guard-rm.sh",
      "match": "run_command",
      "enabled": true,
      "createdAt": "2026-05-26T10:00:00.000Z"
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable string. `/hooks add` generates one; hand-rolled ids are fine as long as they're unique. |
| `event` | yes | One of the lifecycle events above. |
| `command` | yes | Passed to `execSync` with a 5s timeout. |
| `match` | no | Substring matched against the tool name (`pre-tool` / `post-tool` only). |
| `enabled` | yes | `false` disables without deleting. |
| `createdAt` | yes | ISO-8601 timestamp. Informational. |

The hook command receives three env vars:

- `BRAINROUTER_HOOK_EVENT` — the event name.
- `BRAINROUTER_HOOK_TOOL` — the tool name (empty for non-tool events).
- `BRAINROUTER_HOOK_PAYLOAD` — JSON-encoded tool args.

Anything the command writes to **stderr** becomes the denial reason
surfaced to the model when a `pre-tool` hook exits non-zero.

---

## Hookify rules — `hooks/<slug>.md`

One rule per file. Frontmatter is YAML-ish (parsed by a tiny in-house
reader — keep it flat). Body is the markdown shown to the user when
the rule fires.

```markdown
---
name: block-rm-rf
enabled: true
event: bash
pattern: rm\s+-rf
action: block
---

⚠️ Dangerous `rm -rf` blocked. Double-check the path before retrying.
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Human-readable; shown in `⚠️` warnings. |
| `enabled` | no | Defaults to `true`. |
| `event` | yes | `bash` / `file` / `prompt` / `stop` / `all`. |
| `pattern` | no* | Regex tested against every field value joined by `\n`. |
| `conditions` | no* | List of `{ field, operator, pattern }`. **All** must match. |
| `action` | no | `warn` (default) or `block`. |

\* Provide either `pattern` *or* `conditions`. A rule with neither
never fires.

Condition operators: `regex_match`, `contains`, `equals`,
`not_contains`, `starts_with`, `ends_with`. The `field` name must
match a key the event exposes (see the table above).

---

## Worked examples

### 1 — Block `rm -rf` at the pre-tool gate (shell hook)

`hooks.json`:

```json
{
  "hooks": [
    {
      "id": "guard_rm_rf",
      "event": "pre-tool",
      "command": "node -e \"const p=JSON.parse(process.env.BRAINROUTER_HOOK_PAYLOAD||'{}'); if(/rm\\s+-rf/.test(p.command||'')){process.stderr.write('rm -rf is not allowed in this workspace');process.exit(1)}\"",
      "match": "run_command",
      "enabled": true,
      "createdAt": "2026-05-26T10:00:00.000Z"
    }
  ]
}
```

The shell hook inspects `BRAINROUTER_HOOK_PAYLOAD` and exits 1 when the
command contains `rm -rf`. The stderr text becomes the denial reason.

For this specific case a hookify rule is shorter — see the
`block-rm-rf.md` snippet in the *Hookify rules* section above. Reach
for the shell-hook variant only when you need behaviour the matcher
can't express (HTTP calls, file lookups, multi-step checks).

### 2 — Surface `npm test` failures at end of turn

`hooks.json`:

```json
{
  "hooks": [
    {
      "id": "post_turn_tests",
      "event": "post-turn",
      "command": "npm test --silent || echo \"⚠️  tests failing\" >&2",
      "enabled": true,
      "createdAt": "2026-05-26T10:00:00.000Z"
    }
  ]
}
```

`post-turn` hooks are informational — a non-zero exit does **not**
block anything. Use stderr to surface a one-line warning. Keep the
command fast: the 5s timeout is a hard ceiling.

### 3 — Flag commits missing a ticket prefix (hookify rule)

`hooks/require-ticket-prefix.md`:

```markdown
---
name: require-ticket-prefix
enabled: true
event: bash
conditions:
  - field: command
    operator: regex_match
    pattern: ^git commit .*-m
  - field: command
    operator: regex_match
    pattern: -m\s+["'](?!(?:[A-Z]+-\d+|chore|docs|release))
action: warn
---

Commit message looks like it's missing a ticket prefix (`PROJ-123:`)
or an allow-listed type (`chore`, `docs`, `release`). Double-check
before pushing.
```

Both conditions must match: the command must be a `git commit -m …`
**and** the message body must not start with a ticket id or one of the
allow-listed prefixes. `warn` surfaces the body as a chat-side `⚠️`
without blocking the commit.

---

## Debugging

- **Why did a rule fire?** Hookify warnings render in the tool-result
  summary as `⚠️ <rule name>: <message>`. Block reasons are surfaced
  as the tool error: `Hookify rule "<name>" blocked this <event>
  operation: <message>`.
- **List + toggle**: `/hooks list`, `/hooks disable <id>`,
  `/hookify list`, `/hookify disable <id>`. Disabling is preferred
  over deleting while you're iterating.
- **Where's the file?** `/hooks path` and `/hookify path` print the
  absolute path. You can also `cd ~/.brainrouter/workspaces/<encoded>/`.
- **Malformed rule files**: the loader silently skips files it can't
  parse, so a typo in frontmatter looks like the rule "isn't firing".
  Run `/hookify list` — missing entries point at the broken file.

## Limits

- Hooks run **synchronously** in the agent loop. Keep them under the
  5-second timeout; long-running checks belong in CI, not here.
- No shell escaping is performed on hook commands — they're handed
  straight to `execSync`. Quote arguments yourself.
- Hookify regexes use the JS `RegExp` engine; invalid patterns
  silently fail to match (the rule won't fire). Test with `node -e
  "new RegExp('your-pattern')"` if in doubt.
- Only `pre-tool` shell hooks can deny. Every other event is advisory.
- Hookify `block` denies the tool call but does **not** stop the turn
  — the model sees the error and can retry with adjusted args.
