---
name: agent-memory
description: Teaches agents how and when to use BrainRouter's memory engine (including Long-Term L1/L3, Short-Term Working Memory offloads, and Software Engineering-specific tools). Ensures the agent maintains context-awareness while proactively keeping context limits low.
memory_hints: |
  - Extract if the user disables or opts out of memory capture (respect this as a hard rule).
  - Note if the user prefers a specific recall strategy (keyword vs. hybrid).
  - Capture if the user requests the agent to "forget" specific information.
  - Note any sessions where the user explicitly asked for memory context to be surfaced.
  - Ensure working memory offload is triggered for payloads >1,000 tokens.
---

# Agent Memory — Using BrainRouter Memory Tools

## Overview

BrainRouter's memory engine gives you persistent, cross-session awareness of the user. Use it consistently — an agent that doesn't recall context is worse than a stateless one because it appears to ignore the user.

With the new Memory Systems, you have access to:
1. **Long-Term Memory:** Retrieval-Augmented Generation (RAG) based on L1/L3 database entries.
2. **Short-Term Working Memory:** Active task canvases and reference-offloading to keep your prompt context clean and small during long conversations.
3. **Software Engineering Tools:** Structured memory types (e.g., failed attempts, debug traces, file histories, task handovers).

---

## Workflow

1. **Resolve and Start:** Call `mcp_brainrouter_resolve_session` at the beginning of a turn.
2. **Context Setup:** Invoke `memory_recall` and `memory_working_context` to inject long-term and short-term working state.
3. **Payload Inspection:** Look up any referenced `nodeId` from the Mermaid canvas.
4. **Execution & Offloading:** If executing a tool with output >1,000 tokens, offload via `memory_working_offload`.
5. **Citational Signals:** Record memory citation outcomes via `memory_mark_cited`.
6. **Passive or Manual Logging:** Capture the final turn state via passive hooks or manual `memory_capture_turn`.

## The Non-Negotiable Habits

### 1. Before every response — recall memory & check working context
- Call `memory_recall` to get relevant L1 memories and the user L3 persona.
- If in a long-running debugging or coding session, call `memory_working_context` to fetch the high-level Mermaid task canvas and status.

```typescript
memory_recall({
  sessionKey: "<conversation-id>", // ALWAYS USE THE CONVERSATION ID AS SESSION KEY
  query: "<summary of current user message>",
  activeSkill: "<current skill name, if any>"
})
```

### 2. During execution — offload large payloads
- Never paste large tool outputs, build logs, or code blocks (>1,000 tokens) back to the user or into your prompt. 
- Proactively call `memory_working_offload` to save the payload to a reference file. The tool returns a short `nodeId` (e.g., `w1682390-a2ef`) to insert in your workspace context instead.

```typescript
memory_working_offload({
  sessionKey: "<conversation-id>",
  payload: "<large tool output stdout/stderr>",
  title: "Build failure log",
  kind: "tool_output"
})
```

### 3. After every response — capture the turn (unless using passive hooks)
- If passive lifecycle hooks are registered in the host environment, you do not need to call this.
- If hooks are absent, call `memory_capture_turn` to store the conversation segment in L0.

---

## Memory Tool Taxonomy

### 1. Long-Term Memory (RAG)
| Tool | When to Call |
| :--- | :--- |
| `memory_recall` | **Before every response** — retrieves relevant context & persona. |
| `memory_search` | When the automatically recalled context is missing specific past details. Supports `asOf` for point-in-time audits. |
| `memory_contradictions` | Before making major architectural decisions or enforcing tech preferences. |
| `memory_register_skill_hints` | When activating a skill for the first time in a new project. |

### 2. Short-Term Working Memory (Context Reduction)
| Tool | When to Call |
| :--- | :--- |
| `memory_working_context` | At the start of a turn to retrieve the active task state and Mermaid task canvas. |
| `memory_working_offload` | To move a large payload out of the active prompt, returning a short `nodeId` placeholder. |
| `memory_working_reset` | At the end of a session to completely flush working directories. |

### 3. Software Engineering Traces
| Tool | When to Call |
| :--- | :--- |
| `memory_task_state` / `_update` | To read/write structured progress, blockers, and next actions. |
| `memory_failed_attempts` | To check what solutions have already been tried for a bug or problem area, preventing redundant work. |
| `memory_file_history` | To query all historical memories and evidence attached to a specific file or symbol. |
| `memory_debug_trace_save` | To save bug reproduction steps, root cause analysis, and fix summaries. |
| `memory_handover` | To generate a compact continuation note with evidence links. |
| `memory_verify` | To check a memory and update its confidence or status (active, superseded, archived). |

---

## What NOT to Do

- **Never paste outputs >1,000 tokens** directly into conversation. Always offload them.
- **Never skip `memory_recall`** before a response.
- **Never repeat failed approaches** — check `memory_failed_attempts` when debugging.
- **Limit memory tool calls** to a maximum of **3 per turn** to respect the latency budget.

---

## Verification

After applying this skill, confirm:
- [ ] `memory_recall` or `memory_working_context` was called.
- [ ] Large payloads were offloaded via `memory_working_offload`.
- [ ] The injected context was referenced (not ignored).
