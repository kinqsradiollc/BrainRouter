import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    upsertEngineeringMemory: vi.fn(),
  },
}));

import { memoryEngine } from "../memory/engine.js";
import {
  handleMemoryCreateRequirement,
  memoryCreateRequirementToolSchema,
} from "../tools/capture/memory_create_requirement.js";

function parseToolText<T>(result: any): T {
  return JSON.parse(result.content[0].text);
}

describe("memory_create_requirement tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.upsertEngineeringMemory).mockReset();
    vi.mocked(memoryEngine.upsertEngineeringMemory).mockReturnValue({ id: "cognitive_manual_req1" } as never);
  });

  it("schema declares title required + the provenance id inputs", () => {
    expect(memoryCreateRequirementToolSchema.name).toBe("memory_create_requirement");
    expect(memoryCreateRequirementToolSchema.inputSchema.required).toContain("title");
    const props = memoryCreateRequirementToolSchema.inputSchema.properties;
    for (const k of ["requirementId", "workflowId", "taskId", "artifactId"]) {
      expect(props).toHaveProperty(k);
    }
  });

  it("creates a task_state record and threads provenance ids into metadata", async () => {
    const result = await handleMemoryCreateRequirement(
      {
        title: "Persona anchor must precede federation context",
        description: "The CLI briefing injects Core Identity first.",
        acceptanceCriteria: ["Anchor is the first briefing block", "Federation context follows"],
        requirementId: "req_abc123",
        workflowId: "wf_42",
        taskId: "task_7",
        artifactId: "art_9",
        sessionKey: "sess:persona",
      },
      { defaultUserId: "u1" },
    );

    expect(memoryEngine.upsertEngineeringMemory).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(memoryEngine.upsertEngineeringMemory).mock.calls[0][0];
    expect(arg.userId).toBe("u1");
    expect(arg.type).toBe("task_state");
    expect(arg.sessionKey).toBe("sess:persona");
    // Content carries the title + criteria.
    expect(arg.content).toContain("Persona anchor must precede federation context");
    expect(arg.content).toContain("- Anchor is the first briefing block");
    // PROVENANCE — every supplied id links the memory back, in the metadata bag.
    expect(arg.metadata).toEqual({
      kind: "requirement",
      requirementId: "req_abc123",
      workflowId: "wf_42",
      taskId: "task_7",
      artifactId: "art_9",
    });

    const out = parseToolText<{ recordId: string; requirementId: string; provenance: Record<string, string> }>(result);
    expect(out.recordId).toBe("cognitive_manual_req1");
    expect(out.requirementId).toBe("req_abc123");
    expect(out.provenance.workflowId).toBe("wf_42");
  });

  it("omits unset provenance ids from metadata (only kind when none supplied)", async () => {
    await handleMemoryCreateRequirement({ title: "A bare requirement" }, { defaultUserId: "u1" });
    const arg = vi.mocked(memoryEngine.upsertEngineeringMemory).mock.calls[0][0];
    expect(arg.metadata).toEqual({ kind: "requirement" });
  });

  it("rejects a too-short title (returns an isError result, no record written)", async () => {
    const result: any = await handleMemoryCreateRequirement({ title: "x" }, { defaultUserId: "u1" });
    expect(result.isError).toBe(true);
    expect(memoryEngine.upsertEngineeringMemory).not.toHaveBeenCalled();
  });
});
