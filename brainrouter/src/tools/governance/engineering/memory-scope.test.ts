/**
 * A handover note from a personal session must not outrank the repository the
 * question was about.
 *
 * Seen live (session 3cbe409e…): "tell me about the current state of Orbyn"
 * pulled a `handover_note` about a resignation — "advise against accepting the
 * counter-offer, remind to update LinkedIn and Seek profile" — into a codebase
 * session, where the model read it as instructions and had to reason about
 * whether it was a prompt injection. `memory_task_state` searched every record
 * the user had ever written, in any repo, in any session; its description
 * claimed it was "for a repo/session" and its schema had neither parameter.
 */
import { describe, it, expect } from "vitest";
import { memoryEngineeringToolSchemas } from "./memory-engineering.js";
import { preferCallerScope, scopeMatchOf } from "../../../memory/scope.js";

const HERE = { workspaceTag: "ws_orbyn_0001", sessionKey: "sess-orbyn" };

// FTS rows are snake_case; records read by file path are camelCase.
const ftsRow = (id: string, workspace_tag: string | null, session_key = "sess-other") =>
  ({ record_id: id, content: id, type: "handover_note", workspace_tag, session_key });

describe("preferCallerScope", () => {
  it("ranks this session, then this workspace, then untagged, then somewhere else", () => {
    const ranked = preferCallerScope([
      ftsRow("resignation-note", "ws_personal_9999"),
      ftsRow("legacy-untagged", null),
      ftsRow("this-repo", HERE.workspaceTag),
      ftsRow("this-session", "ws_personal_9999", HERE.sessionKey),
    ], HERE);
    expect(ranked.map((hit) => hit.record_id)).toEqual([
      "this-session", "this-repo", "legacy-untagged", "resignation-note",
    ]);
    expect(ranked.map((hit) => hit.scopeMatch)).toEqual([
      "session", "workspace", "untagged", "other-workspace",
    ]);
  });

  it("PREFERS — it never hides: the other workspace's record is still returned", () => {
    const ranked = preferCallerScope([ftsRow("resignation-note", "ws_personal_9999")], HERE);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.scopeMatch).toBe("other-workspace");
  });

  it("reads camelCase records too, and is a no-op when the caller cannot say where it is", () => {
    expect(scopeMatchOf({ workspaceTag: HERE.workspaceTag }, HERE)).toBe("workspace");
    expect(scopeMatchOf({ sessionKey: HERE.sessionKey }, HERE)).toBe("session");
    // No scope from the caller ⇒ nothing can be preferred, and a tagged record
    // is not demoted for it.
    expect(scopeMatchOf({ workspace_tag: "ws_anything" }, {})).toBe("other-workspace");
    expect(scopeMatchOf({ workspace_tag: null }, {})).toBe("untagged");
  });

  it("keeps the search's own relevance order inside a rank", () => {
    const ranked = preferCallerScope(
      ["a", "b", "c"].map((id) => ftsRow(id, HERE.workspaceTag)),
      HERE,
    );
    expect(ranked.map((hit) => hit.record_id)).toEqual(["a", "b", "c"]);
  });
});

describe("the schema stops promising what it does not do", () => {
  it("memory_task_state accepts the scope its description talks about", () => {
    const schema = memoryEngineeringToolSchemas.find((entry) => entry.name === "memory_task_state")!;
    const properties = schema.inputSchema.properties as Record<string, unknown>;
    expect(properties.workspaceTag).toBeDefined();
    expect(properties.sessionKey).toBeDefined();
    // The old description said "for a repo/session" while accepting neither.
    expect(schema.description).toMatch(/workspaceTag and sessionKey/);
    expect(schema.description).toMatch(/spans every workspace/);
  });
});

describe("a workspace with two identities", () => {
  // One checkout, two tags (ADR-015): chat turns under the folder hash, the
  // ingested repository under the remote hash. Both are "here".
  const FOLDER = "ws_folder_hash_0";
  const REPO = "ws_repo_hash_000";

  it("counts either identity as this workspace", () => {
    const ranked = preferCallerScope(
      [ftsRow("elsewhere", "ws_personal_9999"), ftsRow("ingested-file", REPO), ftsRow("chat-turn", FOLDER)],
      { workspaceTags: [FOLDER, REPO] },
    );
    expect(ranked.map((h) => [h.record_id, h.scopeMatch])).toEqual([
      ["ingested-file", "workspace"],
      ["chat-turn", "workspace"],
      ["elsewhere", "other-workspace"],
    ]);
  });

  it("merges a single tag with the list rather than one replacing the other", () => {
    expect(scopeMatchOf(ftsRow("x", REPO), { workspaceTag: FOLDER, workspaceTags: [REPO] })).toBe("workspace");
    expect(scopeMatchOf(ftsRow("x", FOLDER), { workspaceTag: FOLDER, workspaceTags: [REPO] })).toBe("workspace");
  });

  it("the engineering reads accept every identity — none is stripped by the schema", () => {
    const read = memoryEngineeringToolSchemas.find((t) => t.name === "memory_task_state")!;
    expect(Object.keys((read.inputSchema as { properties: object }).properties)).toContain("workspaceTags");
  });
});
