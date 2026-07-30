# 00 — Golden Rules

The highest-priority rules, distilled from every domain. If you remember nothing
else, remember these. Each links to the topical file with the full context.
`⛔` = violating it has caused a real regression or security bug.

---

1. **⛔ Never build a parallel memory/session/workflow-memory system.**
   BrainRouter memory stays central. Every durable fact routes through the
   memory engine. → [`04`](04-memory-engine-and-mcp-server.md),
   [architecture law](../brainrouter-docs/architecture-folder-structure-rules.md)

2. **⛔ Never name external reference projects (or copy their code) in committed
   files.** No product code, docs, UI strings, comments, changelogs, or release
   notes may reference vendored/reference material or internal planning docs.
   Learn from references; ship BrainRouter-native architecture. → [`09`](09-docs-skills-and-plugins.md)

3. **⛔ No AI co-author trailers in commits or PR bodies.** This overrides the
   harness default. Never add `Co-Authored-By: Claude …` or any AI-attribution
   trailer. → [`08`](08-git-release-and-changelog.md)

4. **Every relative import carries an explicit `.js` extension**, even from
   `.ts`/`.tsx`. All Node workspaces are ESM + NodeNext; extensionless relative
   imports fail at runtime. → [`02`](02-code-style-and-conventions.md)

5. **⛔ Import `@kinqs/brainrouter-core` only through curated subsystem
   entrypoints** (`@kinqs/brainrouter-core/agent`, `/config`, and focused
   browser-safe subpaths). Deep `@kinqs/brainrouter-core/dist/**` imports are an
   ESLint **error in every maintained consumer**. → [`01`](01-monorepo-packages-and-boundaries.md)

6. **Don't grow new god files.** When a file gets large, split it into a
   per-concern sibling folder and keep the original path as a thin re-export
   barrel whose public surface is unchanged. Extractions are byte-identical
   behavior moves — say so in the header. → [`03`](03-refactoring-and-god-files.md)

7. **⛔ The MCP dispatcher pins `userId` to the authenticated user.** Never trust
   a client-supplied `userId`; memory tools scope SQL to whatever id they
   receive with no ownership recheck, so new tools must rely on the pin. This is
   the cross-tenant IDOR fix. → [`04`](04-memory-engine-and-mcp-server.md)

8. **⛔ Every persistence path for user text goes through the redaction
   chokepoint, length-capped first** (`.slice(0, 64_000)` then
   `redactSensitiveMemoryText(...)`). New write paths into the cognitive graph
   must wire in the same cap+redact pair. → [`04`](04-memory-engine-and-mcp-server.md)

9. **⛔ All LLM-output JSON parsing goes through `memory/util/llm-json.ts`
   (`extractJsonValue`).** Never a greedy `raw.match(/\[[\s\S]*\]/)` + JSON.parse
   — local models leak role tokens that break it. → [`04`](04-memory-engine-and-mcp-server.md)

10. **⛔ `captureTurn` (and any slow LLM work off a tool call) must never block
    the MCP reply.** Write rows synchronously, dispatch extraction in the
    background (`void … .catch(…)`, status `"deferred"`). → [`04`](04-memory-engine-and-mcp-server.md)

11. **⛔ Always `await` engine methods.** The memory engine is async (Postgres).
    `res.json(memoryEngine.getStats(...))` type-checks but serializes a pending
    Promise as `{}` → dashboard shows 0/NaN/undefined. Grep routes and tools for
    unawaited `memoryEngine.*`. → [`06`](06-desktop-and-dashboard.md)

12. **⛔ Every CLI knob lives under `cli.*` in `config.json`.** Read via
    `getCliKnobs()`; override via `setCliKnobOverride()`. Never add new
    `BRAINROUTER_*` env vars for knobs, and never load `.env` in the CLI. → [`05`](05-cli-and-agent-runtime.md)

13. **⛔ Tool-call pairing is sacred.** Every LLM request is built from
    `sanitizeToolCallPairing(chatHistory)` — never send raw history, or strict
    gateways reject with "tool call result does not follow tool call (2013)". → [`05`](05-cli-and-agent-runtime.md)

14. **Model-adherence problems are fixed with bounded turn-end guardrails in
    core `runTurn.impl.ts`, not more prompting.** Every guard has a hard `*_MAX`
    so a weak model can never loop. → [`05`](05-cli-and-agent-runtime.md)

15. **⛔ Secrets are write-only.** Integration secrets go in `config.json`
    (`cli.*`) or the host `safeStorage` store — never `.env`. No endpoint ever
    returns a secret value; config snapshots pass through `scrubCliSecrets`
    before crossing the bridge. → [`06`](06-desktop-and-dashboard.md)

16. **Model lists come from the endpoint's `GET /models`** — never a hardcoded
    list or model-name placeholder. Version strings come from `version.ts`
    reading `package.json` at runtime — never hardcoded. → [`06`](06-desktop-and-dashboard.md), [`01`](01-monorepo-packages-and-boundaries.md)

17. **⛔ Golden/parity tests pin enumerated surfaces** (roles, agents, providers,
    slash commands). Adding one breaks exact-count/`deepEqual` assertions in
    *other* workspaces. Run the affected cross-workspace parity tests locally
    and require the **full hosted CI suite** before merge. → [`07`](07-testing.md)

18. **Match the file/package you're editing, don't reformat the tree.** Quote
    style and file-naming differ per workspace; Prettier is configured but the
    tree is deliberately not mass-formatted. Never run `prettier --write .`. → [`02`](02-code-style-and-conventions.md)

19. **Every module opens with a purpose header** stating what it owns, why it
    exists, and its invariants; comments explain *why*/tradeoffs, not *what*, and
    carry the task/release tag they implement (`CLI-21`, `MEM-33b`, `CC-P5.2`).
    These headers are the codebase's institutional memory. → [`02`](02-code-style-and-conventions.md)

20. **Slash commands, specs, ADRs, and docs have fixed homes and must be
    indexed.** Commands go in per-domain `tryHandle*` files (never edit
    `repl.ts`); every new deep doc/spec/ADR is linked from
    `brainrouter-docs/README.md`. → [`05`](05-cli-and-agent-runtime.md), [`09`](09-docs-skills-and-plugins.md)

21. **Keep local validation proportional and require full hosted CI before
    merge.** Run focused tests plus lint/typecheck for small slices. Run local
    `npm run verify` (typecheck + lint + test) for cross-cutting/high-risk
    changes, release/publish work, or CI-parity diagnosis; the brain's
    integration tests need reachable pgvector Postgres. → [`07`](07-testing.md)
